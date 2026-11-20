"""
Periodic sinusoidal speed-command runner with dry-run default, motion lockout,
nested try/finally cleanup, separated log-save vs safe-stop reporting, and
non-zero exit code on stop/log failures.

NOTE: Sine trajectory math and CSV log column definitions are preserved unchanged.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
import math
from pathlib import Path
from typing import Callable, Optional, Sequence

from gimbal_safety import (
    ACK_FRAME,
    ClockProtocol,
    FakeClock,
    FakeSerial,
    GimbalSession,
    MotionRunResult,
    RealMonotonicClock,
    SafetyLockoutError,
    SerialProtocol,
    make_speed_frame,
    open_serial_port,
)

DEFAULT_PORT: Optional[str] = None
BAUDRATE = 115200

AMPLITUDE_DEG = {
    "yaw": 20.0,
    "roll": 15.0,
    "pitch": 15.0,
}

MAX_AMPLITUDE_DEG = {
    "yaw": 20.0,
    "roll": 15.0,
    "pitch": 15.0,
}

PERIOD_S = 5.0
CYCLES = 5
RAMP_S = 1.0

COMMAND_INTERVAL_S = 0.10
LOG_INTERVAL_S = 0.50
ACK_TIMEOUT_S = 0.20

MAX_SPEED_RPM = 5.0


def create_log_path() -> Path:
    program_dir = Path(__file__).resolve().parent
    time_text = datetime.now().strftime("%Y%m%d_%H%M%S")
    return program_dir / f"云台三轴速度加速度位置记录_{time_text}.csv"


def validate_configuration() -> None:
    if PERIOD_S < 2.0:
        raise ValueError("周期过短，请将PERIOD_S设置为不小于2秒")
    if not isinstance(CYCLES, int) or CYCLES <= 0:
        raise ValueError("CYCLES必须是正整数")
    if RAMP_S < 0:
        raise ValueError("RAMP_S不能小于0")
    if COMMAND_INTERVAL_S <= 0:
        raise ValueError("COMMAND_INTERVAL_S必须大于0")
    if LOG_INTERVAL_S <= 0:
        raise ValueError("LOG_INTERVAL_S必须大于0")

    total_time = PERIOD_S * CYCLES
    if 2 * RAMP_S >= total_time:
        raise ValueError("起止渐变时间之和必须小于总运行时间")

    omega = 2.0 * math.pi / PERIOD_S
    print("各轴运动参数：")
    for axis, amplitude in AMPLITUDE_DEG.items():
        if not 0.0 <= amplitude <= MAX_AMPLITUDE_DEG[axis]:
            raise ValueError(f"{axis}轴幅值应位于0～{MAX_AMPLITUDE_DEG[axis]}°范围内")
        peak_rpm = abs(amplitude) * omega / 6.0
        if peak_rpm > MAX_SPEED_RPM:
            raise ValueError(
                f"{axis}轴理论峰值速度为{peak_rpm:.3f}rpm，超过程序限制的{MAX_SPEED_RPM:.3f}rpm。"
                "请减小角度幅值或增大运动周期"
            )
        print(f"{axis:5s}：名义幅值±{amplitude:.1f}°，理论峰值速度{peak_rpm:.3f}rpm")


def run_periodic_motion(
    real_mode: bool = False,
    port: Optional[str] = DEFAULT_PORT,
    baudrate: int = BAUDRATE,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    cycles: int = CYCLES,
    log_path: Optional[Path] = None,
    clock: Optional[ClockProtocol] = None,
    input_fn: Optional[Callable[[str], str]] = None,
    log_opener: Optional[Callable[[Path], object]] = None,
    fake_serial_factory: Optional[Callable[[], SerialProtocol]] = None,
    real_serial_opener: Optional[Callable[..., SerialProtocol]] = None,
    session_hook: Optional[Callable[[GimbalSession], None]] = None,
) -> MotionRunResult:
    validate_configuration()

    clk = clock if clock is not None else (RealMonotonicClock() if real_mode else FakeClock())
    prompt = input_fn if input_fn is not None else (input if real_mode else (lambda _msg: ""))
    total_time = PERIOD_S * cycles
    resolved_log_path = log_path if log_path is not None else create_log_path()

    print("\n运行配置：")
    if not real_mode:
        print("【模拟模式（dry-run），不连接真实串口设备】")
    print(f"波特率：{baudrate}，周期：{PERIOD_S:.1f}秒，循环次数：{cycles}，预计运行时间：{total_time:.1f}秒")
    print(f"数据保存位置：{resolved_log_path}")
    print("\n注意：保存的是根据上位机速度指令计算的速度、角加速度和相对角位置，不是云台实际测量值。")

    if real_mode:
        prompt("确认后按回车开始；直接关闭窗口可取消……")

    ser, resolved_port = open_serial_port(
        real_mode=real_mode,
        port=port,
        baudrate=baudrate,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
        timeout=0,
        fake_serial_factory=fake_serial_factory or (lambda: FakeSerial(clock=clk if isinstance(clk, FakeClock) else None)),
        real_serial_opener=real_serial_opener,
    )

    result = MotionRunResult(dry_run=not real_mode, port=resolved_port, log_saved_ok=False)
    session = GimbalSession(ser=ser, clock=clk, ack_timeout_s=ACK_TIMEOUT_S)
    if session_hook is not None:
        session_hook(session)

    log_file = None
    try:
        try:
            log_file = (
                log_opener(resolved_log_path)
                if log_opener is not None
                else open(resolved_log_path, mode="w", newline="", encoding="utf-8-sig")
            )
            writer = csv.writer(log_file)
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
            log_file.flush()
            result.log_saved_ok = True
        except Exception as log_exc:
            result.log_saved_ok = False
            session.lock(f"日志初始化失败：{log_exc}")
            result.lockout_triggered = True
            result.lockout_reason = session.lock_reason
            result.error_message = f"日志写入异常：{type(log_exc).__name__}: {log_exc}"
            print(result.error_message)
            return result

        init_stop = session.stop_all_axes()
        result.initial_stop_ok = init_stop.ack_received
        if not init_stop.ack_received:
            result.lockout_triggered = True
            result.lockout_reason = session.lock_reason
            result.error_message = f"初始零速度命令未收到正常应答：{init_stop.error}"
            print(result.error_message)
            return result

        clk.sleep(0.5)

        start_time = clk.monotonic()
        next_log_time = 0.0
        previous_elapsed: Optional[float] = None
        previous_speeds_deg_s: Optional[dict] = None
        positions_deg = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}
        accelerations_deg_s2 = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}

        print("开始周期性往复运动，按Ctrl+C可停止。\n")

        while True:
            loop_start = clk.monotonic()
            elapsed = loop_start - start_time
            if elapsed >= total_time:
                break

            phase = 2.0 * math.pi * elapsed / PERIOD_S
            if RAMP_S > 0:
                speed_scale = min(
                    1.0,
                    elapsed / RAMP_S,
                    max(0.0, (total_time - elapsed) / RAMP_S),
                )
            else:
                speed_scale = 1.0

            speeds_rpm = {}
            for axis, amplitude in AMPLITUDE_DEG.items():
                angular_speed_deg_s = (
                    amplitude
                    * (2.0 * math.pi / PERIOD_S)
                    * math.sin(phase + math.pi / 2.0)
                    * speed_scale
                )
                speeds_rpm[axis] = angular_speed_deg_s / 6.0

            current_speeds_deg_s = {axis: speeds_rpm[axis] * 6.0 for axis in AMPLITUDE_DEG}
            if previous_elapsed is not None and previous_speeds_deg_s is not None:
                dt = elapsed - previous_elapsed
                if dt > 0:
                    for axis in AMPLITUDE_DEG:
                        prev_v = previous_speeds_deg_s[axis]
                        cur_v = current_speeds_deg_s[axis]
                        accelerations_deg_s2[axis] = (cur_v - prev_v) / dt
                        positions_deg[axis] += (prev_v + cur_v) * 0.5 * dt

            previous_elapsed = elapsed
            previous_speeds_deg_s = current_speeds_deg_s.copy()

            ok, _ = session.send_command(**speeds_rpm)
            if not ok:
                session.lock("运动命令未收到正常应答")
                result.lockout_triggered = True
                result.lockout_reason = session.lock_reason
                result.error_message = "运动命令未收到正常应答，程序终止"
                print(result.error_message)
                return result

            if elapsed >= next_log_time:
                writer.writerow(
                    [
                        f"{elapsed:.3f}",
                        f"{speeds_rpm['yaw']:.6f}",
                        f"{speeds_rpm['roll']:.6f}",
                        f"{speeds_rpm['pitch']:.6f}",
                        f"{accelerations_deg_s2['yaw']:.6f}",
                        f"{accelerations_deg_s2['roll']:.6f}",
                        f"{accelerations_deg_s2['pitch']:.6f}",
                        f"{positions_deg['yaw']:.6f}",
                        f"{positions_deg['roll']:.6f}",
                        f"{positions_deg['pitch']:.6f}",
                    ]
                )
                log_file.flush()
                result.log_saved_ok = True
                next_log_time = elapsed + LOG_INTERVAL_S

            remaining = COMMAND_INTERVAL_S - (clk.monotonic() - loop_start)
            if remaining > 0:
                clk.sleep(remaining)

        result.motion_ok = True
        print("\n设定循环已完成")

    except KeyboardInterrupt:
        result.interrupted_by_ctrl_c = True
        session.lock("检测到Ctrl+C")
        result.lockout_triggered = True
        result.lockout_reason = session.lock_reason
        print("\n检测到Ctrl+C，准备停止云台")
    except SafetyLockoutError as exc:
        result.lockout_triggered = True
        result.lockout_reason = str(exc)
        result.error_message = str(exc)
        print(f"\n安全锁定：{exc}")
    except Exception as exc:
        if "log" in str(exc).lower() or isinstance(exc, OSError):
            result.log_saved_ok = False
        session.lock(f"{type(exc).__name__}: {exc}")
        result.lockout_triggered = True
        result.lockout_reason = session.lock_reason
        result.error_message = f"{type(exc).__name__}: {exc}"
        print(f"\n程序异常：{result.error_message}")
    finally:
        try:
            final_stop = session.stop_all_axes()
            result.final_stop_attempted = final_stop.attempted
            result.final_stop_ack = final_stop.ack_received
            if final_stop.ack_received:
                print("安全停止状态：已发送三轴零速度命令并收到协议应答（未验证机械实际停止）。")
            else:
                result.stop_error_message = final_stop.error or "退出停止命令未收到有效应答"
                print(f"安全停止失败：{result.stop_error_message}（请立即检查云台，必要时切断电源）")
        except Exception as stop_exc:
            result.final_stop_attempted = True
            result.final_stop_ack = False
            result.stop_error_message = f"{type(stop_exc).__name__}: {stop_exc}"
            print(f"退出停止命令发送失败：{result.stop_error_message}")
        finally:
            try:
                ser.close()
                result.port_closed = True
                print("串口已关闭")
            except Exception as close_exc:
                result.port_closed = False
                result.close_error_message = f"{type(close_exc).__name__}: {close_exc}"
                print(f"关闭串口失败：{result.close_error_message}")

            if log_file is not None:
                try:
                    log_file.close()
                except Exception:
                    result.log_saved_ok = False

        print(f"日志保存状态：{'成功' if result.log_saved_ok else '失败'}（{resolved_log_path}）")
        result.actions = session.actions

    return result


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="BGC 周期正弦指令测试（默认模拟模式）")
    parser.add_argument("--real", action="store_true", help="显式启用真实串口（默认模拟）")
    parser.add_argument("--port", type=str, default=None, help="显式指定串口号（禁止盲用COM4）")
    parser.add_argument("--baudrate", type=int, default=BAUDRATE)
    parser.add_argument("--confirm-real", action="store_true", help="确认打开真实串口")
    parser.add_argument("--confirm-port-verified", action="store_true", help="确认候选端口已物理核对")
    args = parser.parse_args(argv)

    res = run_periodic_motion(
        real_mode=args.real,
        port=args.port,
        baudrate=args.baudrate,
        confirm_real=args.confirm_real,
        confirm_port_verified=args.confirm_port_verified,
    )
    return res.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
