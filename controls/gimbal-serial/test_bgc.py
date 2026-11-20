"""
Single-axis low-speed BGC test with safe entrypoints, axis/direction/speed/duration
CLI parameters, lockout, bounded retries, and guaranteed nested try/finally cleanup.
Default execution is offline dry-run (simulated, no device connection).
"""

from __future__ import annotations

import argparse
import math
from typing import Callable, Optional, Sequence

from gimbal_safety import (
    ClockProtocol,
    FakeClock,
    FakeSerial,
    GimbalSession,
    MotionRunResult,
    RealMonotonicClock,
    SafetyLockoutError,
    SerialProtocol,
    open_serial_port,
    validate_real_mode_config,
)

DEFAULT_PORT: Optional[str] = None
BAUDRATE = 115200
VALID_AXES = ("yaw", "roll", "pitch")
MAX_STEP_SPEED_RPM = 5.0
MAX_STEP_DURATION_S = 5.0


def validate_step_params(axis: str, speed_rpm: float, duration_s: float) -> str:
    clean_axis = axis.strip().lower()
    if clean_axis not in VALID_AXES:
        raise ValueError(f"无效轴名称 '{axis}'，必须为 {VALID_AXES} 之一")
    if not math.isfinite(speed_rpm) or abs(speed_rpm) > MAX_STEP_SPEED_RPM or speed_rpm == 0.0:
        raise ValueError(
            f"单步速度 {speed_rpm} rpm 无效：必须为非零有限数且绝对值不超过 {MAX_STEP_SPEED_RPM} rpm"
        )
    if not math.isfinite(duration_s) or duration_s <= 0.0 or duration_s > MAX_STEP_DURATION_S:
        raise ValueError(
            f"单步时长 {duration_s} s 无效：必须位于 (0, {MAX_STEP_DURATION_S}] 秒范围内"
        )
    return clean_axis


def run_single_axis_test(
    real_mode: bool = False,
    port: Optional[str] = DEFAULT_PORT,
    baudrate: int = BAUDRATE,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    axis: str = "yaw",
    speed_rpm: float = 1.0,
    duration_s: float = 1.0,
    ack_timeout_s: float = 1.0,
    clock: Optional[ClockProtocol] = None,
    input_fn: Optional[Callable[[str], str]] = None,
    fake_serial_factory: Optional[Callable[[], SerialProtocol]] = None,
    real_serial_opener: Optional[Callable[..., SerialProtocol]] = None,
    session_hook: Optional[Callable[[GimbalSession], None]] = None,
) -> MotionRunResult:
    clean_axis = validate_step_params(axis=axis, speed_rpm=speed_rpm, duration_s=duration_s)
    validate_real_mode_config(
        real_mode=real_mode,
        port=port,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
    )
    clk = clock if clock is not None else (RealMonotonicClock() if real_mode else FakeClock())
    prompt = input_fn if input_fn is not None else input

    mode_label = "实机模式（将连接真实串口）" if real_mode else "模拟模式（dry-run），不连接真实串口设备"
    print("=" * 60)
    print(f"BGC 单轴单步测试【{mode_label}】")
    print(
        f"参数摘要：轴={clean_axis} | 速度={speed_rpm:+.3f} rpm | 时长={duration_s:.2f} s | "
        f"端口={port if real_mode else 'SIMULATED'} | 波特率={baudrate}"
    )
    print("停止方式：先发零速度校验应答 → 执行单次运动 → 结束及异常均发送三轴零速度并关闭串口")
    print("=" * 60)

    if real_mode:
        prompt("请确认急停可用、机械余量充足且以上参数无误，按回车执行本次动作（Ctrl+C 取消）……")

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

    result = MotionRunResult(dry_run=not real_mode, port=resolved_port)
    session = GimbalSession(ser=ser, clock=clk, ack_timeout_s=ack_timeout_s)
    if session_hook is not None:
        session_hook(session)

    try:
        print("先发送三轴零速度指令")
        init_stop = session.stop_all_axes()
        result.initial_stop_ok = init_stop.ack_received
        if not init_stop.ack_received:
            result.lockout_triggered = True
            result.lockout_reason = session.lock_reason
            result.error_message = f"初始停止失败，禁止发送非零速度：{init_stop.error}"
            print(result.error_message)
            return result

        clk.sleep(0.5)

        cmd = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}
        cmd[clean_axis] = speed_rpm
        print(f"{clean_axis} 轴以 {speed_rpm:+.3f} rpm 测试 {duration_s:.2f} 秒")
        motion_ok, send_ts = session.send_command(**cmd)
        if not motion_ok:
            session.lock("运动指令未收到有效协议应答")
            result.lockout_triggered = True
            result.lockout_reason = session.lock_reason
            result.error_message = "运动指令未收到有效应答，中止流程"
            print(result.error_message)
            return result

        # Motion budget starts from actual non-zero send timestamp (ACK latency not added on top)
        remaining = max(0.0, duration_s - (clk.monotonic() - send_ts))
        clk.sleep(remaining)
        result.motion_ok = True

    except KeyboardInterrupt:
        result.interrupted_by_ctrl_c = True
        session.lock("检测到 Ctrl+C")
        result.lockout_triggered = True
        result.lockout_reason = session.lock_reason
        print("\n检测到 Ctrl+C，准备停止云台……")
    except SafetyLockoutError as exc:
        result.lockout_triggered = True
        result.lockout_reason = str(exc)
        result.error_message = str(exc)
        print(f"安全锁定：{exc}")
    except Exception as exc:
        session.lock(f"{type(exc).__name__}: {exc}")
        result.lockout_triggered = True
        result.lockout_reason = session.lock_reason
        result.error_message = f"{type(exc).__name__}: {exc}"
        print(f"程序异常：{result.error_message}")
    finally:
        try:
            print("测试结束，发送三轴零速度指令")
            final_stop = session.stop_all_axes()
            result.final_stop_attempted = final_stop.attempted
            result.final_stop_ack = final_stop.ack_received
            if not final_stop.ack_received:
                result.stop_error_message = final_stop.error or "最终停止未收到应答"
                print(
                    f"最终停止失败：{result.stop_error_message}"
                    "（请立即人工检查并准备切断动力电源）"
                )
        except Exception as stop_exc:
            result.final_stop_attempted = True
            result.final_stop_ack = False
            result.stop_error_message = f"{type(stop_exc).__name__}: {stop_exc}"
            print(f"最终停止异常：{result.stop_error_message}")
        finally:
            try:
                ser.close()
                result.port_closed = True
            except Exception as close_exc:
                result.port_closed = False
                result.close_error_message = f"{type(close_exc).__name__}: {close_exc}"
                print(f"关闭串口失败：{result.close_error_message}")

        result.actions = session.actions

    return result


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="BGC 单轴单步安全测试（默认模拟模式）")
    parser.add_argument("--axis", type=str, default="yaw", choices=VALID_AXES, help="目标轴：yaw / roll / pitch")
    parser.add_argument("--speed", type=float, default=1.0, help="目标速度 (rpm，支持正负方向，默认 +1.0)")
    parser.add_argument("--duration", type=float, default=1.0, help="持续时长 (s，默认 1.0)")
    parser.add_argument("--real", action="store_true", help="显式启用真实串口（默认模拟）")
    parser.add_argument("--port", type=str, default=None, help="显式指定串口号（禁止盲用COM4）")
    parser.add_argument("--baudrate", type=int, default=BAUDRATE)
    parser.add_argument("--confirm-real", action="store_true", help="确认打开真实串口")
    parser.add_argument("--confirm-port-verified", action="store_true", help="确认候选端口已物理核对")
    args = parser.parse_args(argv)

    res = run_single_axis_test(
        real_mode=args.real,
        port=args.port,
        baudrate=args.baudrate,
        confirm_real=args.confirm_real,
        confirm_port_verified=args.confirm_port_verified,
        axis=args.axis,
        speed_rpm=args.speed,
        duration_s=args.duration,
    )
    return res.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
