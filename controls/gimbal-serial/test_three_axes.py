"""
Three-axis low-speed BGC test with per-axis stop verification, lockout on any
stop/motion failure, dry-run default, and structured exit status.
"""

from __future__ import annotations

import argparse
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
    make_speed_frame,
    open_serial_port,
)

DEFAULT_PORT: Optional[str] = None
BAUDRATE = 115200
TEST_SPEED_RPM = 1.0
MOVE_SECONDS = 1.0
STOP_SECONDS = 1.0


def send_command(
    ser: SerialProtocol,
    yaw: float = 0.0,
    roll: float = 0.0,
    pitch: float = 0.0,
    clock: Optional[ClockProtocol] = None,
    ack_timeout_s: float = 1.0,
) -> bool:
    session = GimbalSession(ser=ser, clock=clock, ack_timeout_s=ack_timeout_s)
    ok, _ = session.send_command(yaw=yaw, roll=roll, pitch=pitch)
    return ok


def stop_all_axes(
    ser: SerialProtocol,
    clock: Optional[ClockProtocol] = None,
    ack_timeout_s: float = 1.0,
) -> bool:
    session = GimbalSession(ser=ser, clock=clock, ack_timeout_s=ack_timeout_s)
    return session.stop_all_axes().ack_received


def test_single_axis(
    session: GimbalSession,
    axis_name: str,
    speed_rpm: float,
    duration_s: float,
    stop_observe_s: float = STOP_SECONDS,
) -> None:
    command = {"yaw": 0.0, "roll": 0.0, "pitch": 0.0}
    command[axis_name] = speed_rpm

    print(f"\n开始测试 {axis_name} 轴：{speed_rpm:.3f}rpm，持续 {duration_s:.2f} 秒")
    ok, send_ts = session.send_command(**command)
    if not ok:
        session.lock(f"{axis_name}轴运动指令未收到有效应答")
        raise RuntimeError(f"{axis_name}轴运动指令未收到正常应答，测试终止")

    # Motion duration starts from actual non-zero send timestamp (not post-ACK)
    remaining = max(0.0, duration_s - (session.clock.monotonic() - send_ts))
    session.clock.sleep(remaining)

    stop_res = session.stop_all_axes()
    if not stop_res.ack_received:
        # Session is already locked by stop_all_axes; raise immediately to block next axis
        raise RuntimeError(f"{axis_name}轴结束停止未收到应答：{stop_res.error}")

    session.clock.sleep(stop_observe_s)


def run_three_axes_test(
    real_mode: bool = False,
    port: Optional[str] = DEFAULT_PORT,
    baudrate: int = BAUDRATE,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    speed_rpm: float = TEST_SPEED_RPM,
    move_seconds: float = MOVE_SECONDS,
    stop_seconds: float = STOP_SECONDS,
    ack_timeout_s: float = 1.0,
    clock: Optional[ClockProtocol] = None,
    input_fn: Optional[Callable[[str], str]] = None,
    fake_serial_factory: Optional[Callable[[], SerialProtocol]] = None,
    real_serial_opener: Optional[Callable[..., SerialProtocol]] = None,
    session_hook: Optional[Callable[[GimbalSession], None]] = None,
) -> MotionRunResult:
    clk = clock if clock is not None else (RealMonotonicClock() if real_mode else FakeClock())
    prompt = input_fn if input_fn is not None else (input if real_mode else (lambda _msg: ""))

    print("=" * 60)
    print("BGC三轴云台低速测试")
    if not real_mode:
        print("【模拟模式（dry-run），不连接真实串口设备】")
    print(f"波特率：{baudrate}，测试速度：{speed_rpm}rpm，单轴运动时间：{move_seconds}秒")
    print("=" * 60)

    if real_mode:
        prompt("请固定云台并确认周围有运动空间，然后按回车开始……")

    ser, resolved_port = open_serial_port(
        real_mode=real_mode,
        port=port,
        baudrate=baudrate,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
        timeout=0.1,
        write_timeout=1.0,
        fake_serial_factory=fake_serial_factory or (lambda: FakeSerial(clock=clk if isinstance(clk, FakeClock) else None)),
        real_serial_opener=real_serial_opener,
    )

    result = MotionRunResult(dry_run=not real_mode, port=resolved_port)
    session = GimbalSession(ser=ser, clock=clk, ack_timeout_s=ack_timeout_s)
    if session_hook is not None:
        session_hook(session)

    try:
        init_stop = session.stop_all_axes()
        result.initial_stop_ok = init_stop.ack_received
        if not init_stop.ack_received:
            result.lockout_triggered = True
            result.lockout_reason = session.lock_reason
            result.error_message = f"初始零速度命令未收到应答，测试终止：{init_stop.error}"
            print(result.error_message)
            return result

        clk.sleep(0.5)

        for axis_name in ("yaw", "roll", "pitch"):
            if real_mode:
                prompt(f"\n准备测试{axis_name}轴。确认运动空间正常后按回车，按Ctrl+C可退出……")
            test_single_axis(
                session=session,
                axis_name=axis_name,
                speed_rpm=speed_rpm,
                duration_s=move_seconds,
                stop_observe_s=stop_seconds,
            )
            print(f"{axis_name}轴测试结束，已收到零速度协议应答（未验证机械实际停止）。")

        result.motion_ok = True
        print("\n三个轴均已测试完成。")

    except KeyboardInterrupt:
        result.interrupted_by_ctrl_c = True
        session.lock("检测到 Ctrl+C")
        result.lockout_triggered = True
        result.lockout_reason = session.lock_reason
        print("\n检测到Ctrl+C，准备停止云台……")
    except SafetyLockoutError as exc:
        result.lockout_triggered = True
        result.lockout_reason = str(exc)
        result.error_message = str(exc)
        print(f"\n安全锁定：{exc}")
    except Exception as exc:
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
            if not final_stop.ack_received:
                result.stop_error_message = final_stop.error or "最终停止命令未收到有效应答"
                print(f"最终停止失败：{result.stop_error_message}。请立即检查云台，必要时切断动力电源。")
        except Exception as stop_exc:
            result.final_stop_attempted = True
            result.final_stop_ack = False
            result.stop_error_message = f"{type(stop_exc).__name__}: {stop_exc}"
            print(f"发送最终停止命令异常：{result.stop_error_message}")
        finally:
            try:
                ser.close()
                result.port_closed = True
                print("串口已关闭，程序结束。")
            except Exception as close_exc:
                result.port_closed = False
                result.close_error_message = f"{type(close_exc).__name__}: {close_exc}"
                print(f"关闭串口失败：{result.close_error_message}")

        result.actions = session.actions

    return result


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="BGC 三轴云台低速测试（默认模拟模式）")
    parser.add_argument("--real", action="store_true", help="显式启用真实串口（默认模拟）")
    parser.add_argument("--port", type=str, default=None, help="显式指定串口号（禁止盲用COM4）")
    parser.add_argument("--baudrate", type=int, default=BAUDRATE)
    parser.add_argument("--confirm-real", action="store_true", help="确认打开真实串口")
    parser.add_argument("--confirm-port-verified", action="store_true", help="确认候选端口已物理核对")
    args = parser.parse_args(argv)

    res = run_three_axes_test(
        real_mode=args.real,
        port=args.port,
        baudrate=args.baudrate,
        confirm_real=args.confirm_real,
        confirm_port_verified=args.confirm_port_verified,
    )
    return res.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
