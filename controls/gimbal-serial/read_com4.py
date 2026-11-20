"""
Passive serial monitor (legacy filename kept for compatibility).

WARNING: COM4 is a Bluetooth serial port on this system and must NOT be blindly
opened. Default execution is offline dry-run (simulated, no device connection).
"""

from __future__ import annotations

import argparse
from typing import Callable, Optional, Sequence

from gimbal_safety import (
    ClockProtocol,
    FakeSerial,
    RealMonotonicClock,
    SerialProtocol,
    open_serial_port,
)

DEFAULT_PORT: Optional[str] = None
BAUDRATE = 9600


def listen_serial(
    real_mode: bool = False,
    port: Optional[str] = DEFAULT_PORT,
    baudrate: int = BAUDRATE,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    max_iterations: Optional[int] = None,
    clock: Optional[ClockProtocol] = None,
    fake_serial_factory: Optional[Callable[[], SerialProtocol]] = None,
    real_serial_opener: Optional[Callable[..., SerialProtocol]] = None,
) -> int:
    clk = clock if clock is not None else RealMonotonicClock()
    if not real_mode:
        print("【模拟模式（dry-run），不连接真实串口设备】")
        if max_iterations is None:
            max_iterations = 5

    ser, resolved_port = open_serial_port(
        real_mode=real_mode,
        port=port,
        baudrate=baudrate,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
        timeout=0.5,
        fake_serial_factory=fake_serial_factory or (lambda: FakeSerial()),
        real_serial_opener=real_serial_opener,
    )
    print(f"已打开 {resolved_port}，波特率 {baudrate}")
    print("正在监听，按 Ctrl+C 停止。")
    print("-" * 60)

    interrupted = False
    close_failed = False
    try:
        iters = 0
        while max_iterations is None or iters < max_iterations:
            iters += 1
            count = ser.in_waiting
            data = ser.read(count if count > 0 else 1)
            if data:
                hex_data = data.hex(" ").upper()
                print(f"[{clk.monotonic():.3f}s] {len(data):3d}字节：{hex_data}")
            else:
                clk.sleep(0.01)
    except KeyboardInterrupt:
        interrupted = True
        print("\n监听已停止。")
    finally:
        try:
            ser.close()
            print("串口已关闭。")
        except Exception as close_exc:
            close_failed = True
            print(f"关闭串口失败：{close_exc}")

    return 1 if (interrupted or close_failed) else 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="串口只读监听工具（默认模拟模式）")
    parser.add_argument("--real", action="store_true", help="显式启用真实串口（默认模拟）")
    parser.add_argument("--port", type=str, default=None, help="显式指定串口号（禁止盲用COM4）")
    parser.add_argument("--baudrate", type=int, default=BAUDRATE)
    parser.add_argument("--confirm-real", action="store_true", help="确认打开真实串口")
    parser.add_argument(
        "--confirm-port-verified",
        action="store_true",
        help="确认候选端口已完成物理核对",
    )
    args = parser.parse_args(argv)
    return listen_serial(
        real_mode=args.real,
        port=args.port,
        baudrate=args.baudrate,
        confirm_real=args.confirm_real,
        confirm_port_verified=args.confirm_port_verified,
    )


if __name__ == "__main__":
    raise SystemExit(main())
