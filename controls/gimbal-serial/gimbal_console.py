"""
Interactive gimbal control console with:
1. Quick single-axis jog (manual centering / fine-tuning)
2. Symmetric single-axis forward-then-reverse step
3. Preset 5-cycle / 7-cycle & custom periodic sinusoidal trajectories
4. On-site live motion parameter editor with strict safety bounds

Reuses gimbal_safety.py: default is offline dry-run (simulated, no device
connection), no top-level hardware side effects on import, motion lockout on
any stop/ACK failure, and nested try/finally port closure.
"""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass, field
from datetime import datetime
import math
from pathlib import Path
import random
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from gimbal_safety import (
    ClockProtocol,
    FakeClock,
    FakeSerial,
    GimbalSession,
    RealMonotonicClock,
    SafetyLockoutError,
    SerialProtocol,
    open_serial_port,
    validate_real_mode_config,
)

DEFAULT_PORT: Optional[str] = None
BAUDRATE = 115200
VALID_AXES = ("yaw", "roll", "pitch")
VALID_PATTERNS = ("sync", "circle", "fig8", "rand")
PATTERN_LABELS = {
    "sync": "三轴同相正弦",
    "circle": "空间画圆/椭圆",
    "fig8": "李萨如8字",
    "rand": "真随机多谐波",
}

HARD_MAX_SPEED_RPM = 5.0
HARD_MAX_JOG_DURATION_S = 5.0
HARD_MAX_CYCLES = 20
HARD_MAX_AMPLITUDE_DEG = {
    "yaw": 25.0,
    "roll": 20.0,
    "pitch": 20.0,
}


@dataclass
class ConsoleMotionParams:
    # Jog parameters
    jog_speed_rpm: float = 1.0
    jog_duration_s: float = 0.5
    # Periodic trajectory parameters
    period_s: float = 5.0
    cycles: int = 5
    ramp_s: float = 1.0
    command_interval_s: float = 0.10
    log_interval_s: float = 0.50
    pattern: str = "sync"
    amplitudes_deg: Dict[str, float] = field(
        default_factory=lambda: {"yaw": 20.0, "roll": 15.0, "pitch": 15.0}
    )
    random_harmonics: Optional[Dict[str, List[Tuple[int, float, float]]]] = None

    def copy(self) -> "ConsoleMotionParams":
        return ConsoleMotionParams(
            jog_speed_rpm=self.jog_speed_rpm,
            jog_duration_s=self.jog_duration_s,
            period_s=self.period_s,
            cycles=self.cycles,
            ramp_s=self.ramp_s,
            command_interval_s=self.command_interval_s,
            log_interval_s=self.log_interval_s,
            pattern=self.pattern,
            amplitudes_deg=dict(self.amplitudes_deg),
            random_harmonics=(
                {ax: list(terms) for ax, terms in self.random_harmonics.items()}
                if self.random_harmonics is not None
                else None
            ),
        )


def _envelope_and_deriv(elapsed: float, total_time: float, ramp_s: float) -> Tuple[float, float]:
    if ramp_s <= 0.0:
        return 1.0, 0.0
    if elapsed < ramp_s:
        return max(0.0, elapsed / ramp_s), 1.0 / ramp_s
    if elapsed > total_time - ramp_s:
        return max(0.0, (total_time - elapsed) / ramp_s), -1.0 / ramp_s
    return 1.0, 0.0


def generate_random_harmonics(
    params: ConsoleMotionParams,
    rng: Optional[random.Random] = None,
) -> Dict[str, List[Tuple[int, float, float]]]:
    """Generate per-axis (k, scaled_amp_deg, phase_rad) using true OS entropy by default.

    Guarantees:
    - Exact return to 0 deg at t = total_time (integer harmonics + envelope w(t)*dtheta(t))
    - Peak angle <= params.amplitudes_deg[axis]
    - Peak speed <= HARD_MAX_SPEED_RPM (5.0 rpm)
    """
    gen = rng if rng is not None else random.SystemRandom()
    total_time = params.period_s * params.cycles
    omega0 = 2.0 * math.pi / total_time
    max_speed_deg_s = HARD_MAX_SPEED_RPM * 6.0
    k_pool = [2, 3, 4, 5, 6, 7, 8]
    sample_n = 400
    result: Dict[str, List[Tuple[int, float, float]]] = {}

    for axis in VALID_AXES:
        target_amp = params.amplitudes_deg.get(axis, 0.0)
        if target_amp <= 0.0:
            result[axis] = []
            continue

        chosen_ks = sorted(gen.sample(k_pool, k=4))
        raw_terms = [
            (k, gen.uniform(0.4, 1.0), gen.uniform(0.0, 2.0 * math.pi))
            for k in chosen_ks
        ]

        max_pos = 0.0
        max_vel = 0.0
        for i in range(sample_n + 1):
            t = total_time * i / sample_n
            w, dw = _envelope_and_deriv(t, total_time, params.ramp_s)
            dtheta = sum(
                amp * (math.sin(k * omega0 * t + phi) - math.sin(phi))
                for k, amp, phi in raw_terms
            )
            ddtheta = sum(
                amp * (k * omega0) * math.cos(k * omega0 * t + phi)
                for k, amp, phi in raw_terms
            )
            pos_t = abs(w * dtheta)
            vel_t = abs(dw * dtheta + w * ddtheta)
            if pos_t > max_pos:
                max_pos = pos_t
            if vel_t > max_vel:
                max_vel = vel_t

        scale_factor = min(
            target_amp / max_pos if max_pos > 1e-9 else 0.0,
            max_speed_deg_s / max_vel if max_vel > 1e-9 else 0.0,
        )
        result[axis] = [
            (k, amp * scale_factor, phi) for k, amp, phi in raw_terms
        ]

    return result


def _axis_freq_multipliers(pattern: str) -> Dict[str, float]:
    if pattern == "circle":
        return {"yaw": 1.0, "roll": 1.0, "pitch": 0.5}
    if pattern == "fig8":
        return {"yaw": 1.0, "roll": 1.0, "pitch": 2.0}
    return {"yaw": 1.0, "roll": 1.0, "pitch": 1.0}


def compute_pattern_speeds_rpm(
    params: ConsoleMotionParams,
    elapsed: float,
    scale: float,
) -> Dict[str, float]:
    if params.pattern == "rand":
        if params.random_harmonics is None:
            raise ValueError("rand 模式缺少 random_harmonics 系数")
        total_time = params.period_s * params.cycles
        omega0 = 2.0 * math.pi / total_time
        w, dw = _envelope_and_deriv(elapsed, total_time, params.ramp_s)
        speeds: Dict[str, float] = {}
        for axis in VALID_AXES:
            terms = params.random_harmonics.get(axis, [])
            dtheta = sum(
                amp * (math.sin(k * omega0 * elapsed + phi) - math.sin(phi))
                for k, amp, phi in terms
            )
            ddtheta = sum(
                amp * (k * omega0) * math.cos(k * omega0 * elapsed + phi)
                for k, amp, phi in terms
            )
            vel_deg_s = dw * dtheta + w * ddtheta
            speeds[axis] = max(-HARD_MAX_SPEED_RPM, min(HARD_MAX_SPEED_RPM, vel_deg_s / 6.0))
        return speeds

    omega = 2.0 * math.pi / params.period_s
    phase = omega * elapsed
    ay = params.amplitudes_deg["yaw"]
    ar = params.amplitudes_deg["roll"]
    ap = params.amplitudes_deg["pitch"]

    if params.pattern == "circle":
        return {
            "yaw": (ay * omega * math.cos(phase) * scale) / 6.0,
            "roll": (ar * omega * math.cos(phase) * scale) / 6.0,
            "pitch": (0.5 * ap * omega * math.sin(phase) * scale) / 6.0,
        }
    if params.pattern == "fig8":
        return {
            "yaw": (ay * omega * math.cos(phase) * scale) / 6.0,
            "roll": (ar * omega * math.cos(phase) * scale) / 6.0,
            "pitch": (ap * (2.0 * omega) * math.cos(2.0 * phase) * scale) / 6.0,
        }
    return {
        axis: (params.amplitudes_deg[axis] * omega * math.cos(phase) * scale) / 6.0
        for axis in VALID_AXES
    }


def validate_console_params(params: ConsoleMotionParams) -> None:
    if (
        not math.isfinite(params.jog_speed_rpm)
        or params.jog_speed_rpm <= 0.0
        or params.jog_speed_rpm > HARD_MAX_SPEED_RPM
    ):
        raise ValueError(
            f"点动速度 {params.jog_speed_rpm} rpm 无效，必须位于 (0, {HARD_MAX_SPEED_RPM}] rpm"
        )
    if (
        not math.isfinite(params.jog_duration_s)
        or params.jog_duration_s <= 0.0
        or params.jog_duration_s > HARD_MAX_JOG_DURATION_S
    ):
        raise ValueError(
            f"点动时长 {params.jog_duration_s} s 无效，必须位于 (0, {HARD_MAX_JOG_DURATION_S}] s"
        )
    if not math.isfinite(params.period_s) or params.period_s < 2.0:
        raise ValueError("周期 period_s 必须 >= 2.0 s")
    if not isinstance(params.cycles, int) or params.cycles <= 0 or params.cycles > HARD_MAX_CYCLES:
        raise ValueError(f"循环次数 cycles 必须为 1～{HARD_MAX_CYCLES} 的整数")
    if not math.isfinite(params.ramp_s) or params.ramp_s < 0.0:
        raise ValueError("起止渐变时间 ramp_s 不能小于 0")

    if params.pattern not in VALID_PATTERNS:
        raise ValueError(f"无效运动模式 {params.pattern!r}，可选：{', '.join(VALID_PATTERNS)}")

    total_time = params.period_s * params.cycles
    if 2.0 * params.ramp_s >= total_time:
        raise ValueError("起止渐变时间之和 (2 * ramp_s) 必须小于总运行时间 (period_s * cycles)")

    omega = 2.0 * math.pi / params.period_s
    freq_mult = _axis_freq_multipliers(params.pattern)
    for axis in VALID_AXES:
        amp = params.amplitudes_deg.get(axis, 0.0)
        max_amp = HARD_MAX_AMPLITUDE_DEG[axis]
        if not math.isfinite(amp) or amp < 0.0 or amp > max_amp:
            raise ValueError(f"{axis} 轴幅值 {amp}° 超出允许范围 [0, {max_amp}°]")
        if params.pattern != "rand":
            peak_rpm = abs(amp) * (omega * freq_mult[axis]) / 6.0
            if peak_rpm > HARD_MAX_SPEED_RPM:
                raise ValueError(
                    f"{axis} 轴理论峰值速度 {peak_rpm:.3f} rpm 超过安全上限 {HARD_MAX_SPEED_RPM:.3f} rpm，"
                    "请减小幅值或增大周期"
                )


def execute_jog(
    session: GimbalSession,
    axis: str,
    direction: int,
    speed_rpm: float,
    duration_s: float,
) -> bool:
    if axis not in VALID_AXES:
        raise ValueError(f"无效轴名：{axis}")
    if direction not in (-1, 1):
        raise ValueError("方向必须为 +1 或 -1")

    cmd = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}
    cmd[axis] = direction * speed_rpm
    print(f"[点动] {axis} 轴 {cmd[axis]:+.3f} rpm，持续 {duration_s:.2f} s")
    ok, send_ts = session.send_command(**cmd)
    if not ok:
        session.lock(f"{axis} 轴点动指令未收到有效应答")
        return False

    remaining = max(0.0, duration_s - (session.clock.monotonic() - send_ts))
    session.clock.sleep(remaining)
    stop_res = session.stop_all_axes()
    return stop_res.ack_received


def execute_symmetric_step(
    session: GimbalSession,
    axis: str,
    speed_rpm: float,
    duration_s: float,
    pause_s: float = 0.5,
) -> bool:
    if not execute_jog(session, axis=axis, direction=1, speed_rpm=speed_rpm, duration_s=duration_s):
        return False
    session.clock.sleep(pause_s)
    return execute_jog(session, axis=axis, direction=-1, speed_rpm=speed_rpm, duration_s=duration_s)


def execute_periodic_trajectory(
    session: GimbalSession,
    params: ConsoleMotionParams,
    log_path: Optional[Path] = None,
) -> tuple[bool, Optional[Path]]:
    validate_console_params(params)
    active_params = params.copy()
    if active_params.pattern == "rand" and active_params.random_harmonics is None:
        active_params.random_harmonics = generate_random_harmonics(active_params)
    total_time = active_params.period_s * active_params.cycles
    resolved_log = (
        log_path
        if log_path is not None
        else Path(__file__).resolve().parent
        / f"云台控制台指令记录_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    )

    print(
        f"[周期轨迹:{PATTERN_LABELS[params.pattern]}] 周期={params.period_s:.1f}s × {params.cycles} 周期 = {total_time:.1f}s | "
        f"幅值(Y/R/P)=±{params.amplitudes_deg['yaw']:.1f}°/±{params.amplitudes_deg['roll']:.1f}°/±{params.amplitudes_deg['pitch']:.1f}°"
    )
    print(f"[日志] 保存至：{resolved_log}（上位机指令估算值，非实测真值）")

    with open(resolved_log, mode="w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "elapsed_s",
                "yaw_rpm",
                "roll_rpm",
                "pitch_rpm",
                "yaw_accel_deg_s2",
                "roll_accel_deg_s2",
                "pitch_accel_deg_s2",
                "yaw_position_deg",
                "roll_position_deg",
                "pitch_position_deg",
            ]
        )
        f.flush()

        start_time = session.clock.monotonic()
        next_log = 0.0
        prev_elapsed: Optional[float] = None
        prev_speeds: Optional[Dict[str, float]] = None
        pos = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}
        acc = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}

        while True:
            loop_start = session.clock.monotonic()
            elapsed = loop_start - start_time
            if elapsed >= total_time:
                break

            if params.ramp_s > 0:
                scale = min(
                    1.0,
                    elapsed / params.ramp_s,
                    max(0.0, (total_time - elapsed) / params.ramp_s),
                )
            else:
                scale = 1.0

            speeds_rpm = compute_pattern_speeds_rpm(active_params, elapsed, scale)
            cur_deg_s = {axis: speeds_rpm[axis] * 6.0 for axis in VALID_AXES}

            if prev_elapsed is not None and prev_speeds is not None:
                dt = elapsed - prev_elapsed
                if dt > 0:
                    for axis in VALID_AXES:
                        acc[axis] = (cur_deg_s[axis] - prev_speeds[axis]) / dt
                        pos[axis] += 0.5 * (prev_speeds[axis] + cur_deg_s[axis]) * dt
            prev_elapsed = elapsed
            prev_speeds = cur_deg_s

            ok, _ = session.send_command(**speeds_rpm)
            if not ok:
                session.lock("周期轨迹运动指令未收到有效应答")
                return False, resolved_log

            if elapsed >= next_log:
                writer.writerow(
                    [
                        f"{elapsed:.3f}",
                        f"{speeds_rpm['yaw']:.6f}",
                        f"{speeds_rpm['roll']:.6f}",
                        f"{speeds_rpm['pitch']:.6f}",
                        f"{acc['yaw']:.6f}",
                        f"{acc['roll']:.6f}",
                        f"{acc['pitch']:.6f}",
                        f"{pos['yaw']:.6f}",
                        f"{pos['roll']:.6f}",
                        f"{pos['pitch']:.6f}",
                    ]
                )
                f.flush()
                next_log = elapsed + params.log_interval_s

            rem = params.command_interval_s - (session.clock.monotonic() - loop_start)
            if rem > 0:
                session.clock.sleep(rem)

    stop_res = session.stop_all_axes()
    return stop_res.ack_received, resolved_log


def edit_params_interactively(
    current: ConsoleMotionParams,
    input_fn: Callable[[str], str],
) -> ConsoleMotionParams:
    candidate = current.copy()
    print("\n--- 现场修改运动参数（直接回车保留当前值） ---")

    def ask_float(label: str, cur: float) -> float:
        raw = input_fn(f"{label} [当前 {cur}]: ").strip()
        return cur if raw == "" else float(raw)

    def ask_int(label: str, cur: int) -> int:
        raw = input_fn(f"{label} [当前 {cur}]: ").strip()
        return cur if raw == "" else int(raw)

    def ask_str(label: str, cur: str) -> str:
        raw = input_fn(f"{label} [当前 {cur}]: ").strip().lower()
        return cur if raw == "" else raw

    try:
        candidate.jog_speed_rpm = ask_float("点动速度 (rpm, <=5.0)", candidate.jog_speed_rpm)
        candidate.jog_duration_s = ask_float("点动时长 (s, <=5.0)", candidate.jog_duration_s)
        candidate.period_s = ask_float("周期时长 period_s (s, >=2.0)", candidate.period_s)
        candidate.cycles = ask_int(f"循环次数 cycles (1~{HARD_MAX_CYCLES})", candidate.cycles)
        candidate.ramp_s = ask_float("起止渐变时间 ramp_s (s)", candidate.ramp_s)
        candidate.amplitudes_deg["yaw"] = ask_float(
            f"Yaw 幅值 (°，<= {HARD_MAX_AMPLITUDE_DEG['yaw']})", candidate.amplitudes_deg["yaw"]
        )
        candidate.amplitudes_deg["roll"] = ask_float(
            f"Roll 幅值 (°，<= {HARD_MAX_AMPLITUDE_DEG['roll']})", candidate.amplitudes_deg["roll"]
        )
        candidate.amplitudes_deg["pitch"] = ask_float(
            f"Pitch 幅值 (°，<= {HARD_MAX_AMPLITUDE_DEG['pitch']})", candidate.amplitudes_deg["pitch"]
        )
        candidate.pattern = ask_str("周期花样 (sync=同相 / circle=画圆 / fig8=8字 / rand=真随机)", candidate.pattern)
        candidate.random_harmonics = None
        validate_console_params(candidate)
        print("参数已更新并校验通过。")
        return candidate
    except Exception as exc:
        print(f"参数修改被拒绝（已保留原参数）：{exc}")
        return current


def print_console_menu(params: ConsoleMotionParams, resolved_port: str, locked: bool) -> None:
    omega = 2.0 * math.pi / params.period_s
    freq_mult = _axis_freq_multipliers(params.pattern)
    py = abs(params.amplitudes_deg["yaw"]) * (omega * freq_mult["yaw"]) / 6.0
    pr = abs(params.amplitudes_deg["roll"]) * (omega * freq_mult["roll"]) / 6.0
    pp = abs(params.amplitudes_deg["pitch"]) * (omega * freq_mult["pitch"]) / 6.0
    print("\n" + "=" * 72)
    print(
        f"云台交互式控制台 | 端口={resolved_port} | 状态={'[已锁定]' if locked else '[正常]'} | "
        f"花样={params.pattern}({PATTERN_LABELS[params.pattern]})"
    )
    print(
        f"当前参数：点动={params.jog_speed_rpm:.2f}rpm×{params.jog_duration_s:.2f}s | "
        f"周期={params.period_s:.1f}s×{params.cycles}圈({params.period_s*params.cycles:.1f}s) | "
        f"渐变={params.ramp_s:.1f}s"
    )
    print(
        f"幅值/峰值：Yaw=±{params.amplitudes_deg['yaw']:.1f}°({py:.2f}rpm) | "
        f"Roll=±{params.amplitudes_deg['roll']:.1f}°({pr:.2f}rpm) | "
        f"Pitch=±{params.amplitudes_deg['pitch']:.1f}°({pp:.2f}rpm)"
    )
    print("-" * 72)
    print("  [板块1 点动]  y+/y- Yaw正反  |  r+/r- Roll正反  |  p+/p- Pitch正反  |  s 立即停止")
    print("  [板块2 往复]  sym <yaw|roll|pitch>   执行单轴正向→停→反向")
    print("  [板块3 周期]  run5 (5周期) | run7 (7周期) | circle (画圆) | fig8 (8字) | rand (真随机) | run (当前参数)")
    print("  [板块4 调参]  set  现场修改上述所有运动参数（含花样）")
    print("  [退出]        q / exit")
    print("=" * 72)


def run_console(
    real_mode: bool = False,
    port: Optional[str] = DEFAULT_PORT,
    baudrate: int = BAUDRATE,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    clock: Optional[ClockProtocol] = None,
    input_fn: Optional[Callable[[str], str]] = None,
    fake_serial_factory: Optional[Callable[[], SerialProtocol]] = None,
    real_serial_opener: Optional[Callable[..., SerialProtocol]] = None,
    log_dir: Optional[Path] = None,
) -> int:
    validate_real_mode_config(
        real_mode=real_mode,
        port=port,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
    )
    clk = clock if clock is not None else (RealMonotonicClock() if real_mode else FakeClock())
    prompt = input_fn if input_fn is not None else input

    if not real_mode:
        print("【模拟模式（dry-run），不连接真实串口设备】")

    ser, resolved_port = open_serial_port(
        real_mode=real_mode,
        port=port,
        baudrate=baudrate,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
        timeout=0.1,
        write_timeout=1.0,
        fake_serial_factory=fake_serial_factory
        or (lambda: FakeSerial(clock=clk if isinstance(clk, FakeClock) else None)),
        real_serial_opener=real_serial_opener,
    )

    session = GimbalSession(ser=ser, clock=clk, ack_timeout_s=0.5)
    params = ConsoleMotionParams()
    exit_code = 0

    try:
        init_stop = session.stop_all_axes()
        if not init_stop.ack_received:
            print(f"初始停止未收到应答，安全锁定：{init_stop.error}")
            return 1

        while True:
            print_console_menu(params, resolved_port, session.locked)
            try:
                cmd_raw = prompt("请输入指令> ").strip().lower()
            except EOFError:
                break

            if cmd_raw in ("q", "quit", "exit"):
                break
            if cmd_raw == "":
                continue

            try:
                if cmd_raw == "s":
                    res = session.stop_all_axes()
                    print(f"停止结果：ack={res.ack_received}")
                elif cmd_raw in ("y+", "y-", "r+", "r-", "p+", "p-"):
                    axis_map = {"y": "yaw", "r": "roll", "p": "pitch"}
                    direction = 1 if cmd_raw[1] == "+" else -1
                    ok = execute_jog(
                        session,
                        axis=axis_map[cmd_raw[0]],
                        direction=direction,
                        speed_rpm=params.jog_speed_rpm,
                        duration_s=params.jog_duration_s,
                    )
                    if not ok:
                        print("点动或停止未收到应答，已锁定。")
                elif cmd_raw.startswith("sym"):
                    parts = cmd_raw.split()
                    axis = parts[1] if len(parts) > 1 else "yaw"
                    ok = execute_symmetric_step(
                        session,
                        axis=axis,
                        speed_rpm=params.jog_speed_rpm,
                        duration_s=params.jog_duration_s,
                    )
                    if not ok:
                        print("对称往复未正常完成，已锁定。")
                elif cmd_raw == "set":
                    params = edit_params_interactively(params, prompt)
                elif cmd_raw in ("run", "run5", "run7", "circle", "fig8", "rand"):
                    run_p = params.copy()
                    if cmd_raw == "run5":
                        run_p.pattern = "sync"
                        run_p.cycles = 5
                        run_p.period_s = 5.0
                        run_p.amplitudes_deg = {"yaw": 20.0, "roll": 15.0, "pitch": 15.0}
                    elif cmd_raw == "run7":
                        run_p.pattern = "sync"
                        run_p.cycles = 7
                        run_p.period_s = 5.0
                        run_p.amplitudes_deg = {"yaw": 20.0, "roll": 15.0, "pitch": 15.0}
                    elif cmd_raw == "circle":
                        run_p.pattern = "circle"
                        run_p.cycles = 5
                        run_p.period_s = 5.0
                        run_p.amplitudes_deg = {"yaw": 20.0, "roll": 0.0, "pitch": 15.0}
                    elif cmd_raw == "fig8":
                        run_p.pattern = "fig8"
                        run_p.cycles = 4
                        run_p.period_s = 7.0
                        run_p.amplitudes_deg = {"yaw": 20.0, "roll": 0.0, "pitch": 15.0}
                    elif cmd_raw == "rand":
                        run_p.pattern = "rand"
                        run_p.cycles = 5
                        run_p.period_s = 5.0
                        run_p.amplitudes_deg = {"yaw": 20.0, "roll": 15.0, "pitch": 15.0}
                        run_p.random_harmonics = None
                    lpath = (
                        (log_dir / f"console_{cmd_raw}.csv")
                        if log_dir is not None
                        else None
                    )
                    ok, saved = execute_periodic_trajectory(session, run_p, log_path=lpath)
                    print(f"周期运行结束：ok={ok}，日志={saved}")
                else:
                    print(f"未知指令：{cmd_raw}")
            except SafetyLockoutError as exc:
                print(f"拒绝执行（安全锁定中）：{exc}")
                exit_code = 1
            except Exception as exc:
                print(f"指令执行异常：{exc}")
                exit_code = 1

    except KeyboardInterrupt:
        print("\n检测到 Ctrl+C，准备停止云台……")
        exit_code = 1
    finally:
        try:
            final_stop = session.stop_all_axes()
            if not final_stop.ack_received:
                print(f"退出停止失败：{final_stop.error}")
                exit_code = 1
        except Exception as stop_exc:
            print(f"退出停止异常：{stop_exc}")
            exit_code = 1
        finally:
            try:
                ser.close()
                print("串口已关闭。")
            except Exception as close_exc:
                print(f"关闭串口失败：{close_exc}")
                exit_code = 1

    return exit_code


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="BGC 交互式云台控制台（默认模拟模式）")
    parser.add_argument("--real", action="store_true", help="显式启用真实串口（默认模拟）")
    parser.add_argument("--port", type=str, default=None, help="显式指定串口号（禁止盲用COM4）")
    parser.add_argument("--baudrate", type=int, default=BAUDRATE)
    parser.add_argument("--confirm-real", action="store_true", help="确认打开真实串口")
    parser.add_argument("--confirm-port-verified", action="store_true", help="确认候选端口已物理核对")
    args = parser.parse_args(argv)

    return run_console(
        real_mode=args.real,
        port=args.port,
        baudrate=args.baudrate,
        confirm_real=args.confirm_real,
        confirm_port_verified=args.confirm_port_verified,
    )


if __name__ == "__main__":
    raise SystemExit(main())
