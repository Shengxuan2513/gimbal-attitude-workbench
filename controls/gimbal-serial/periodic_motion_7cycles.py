"""
7-cycle periodic sinusoidal speed-command runner (5.0 s/cycle x 7 = 35.0 s).
Nominal amplitudes: Yaw ±20°, Roll ±15°, Pitch ±15° (other parameters identical
to periodic_motion.py). Default execution is offline dry-run (simulated).
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional, Sequence

import periodic_motion as pm


PERIOD_S = 5.0
CYCLES = 7
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


def run_seven_cycles(
    real_mode: bool = False,
    port: Optional[str] = None,
    baudrate: int = pm.BAUDRATE,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    log_path: Optional[Path] = None,
):
    pm.PERIOD_S = PERIOD_S
    pm.CYCLES = CYCLES
    pm.AMPLITUDE_DEG = dict(AMPLITUDE_DEG)
    pm.MAX_AMPLITUDE_DEG = dict(MAX_AMPLITUDE_DEG)
    return pm.run_periodic_motion(
        real_mode=real_mode,
        port=port,
        baudrate=baudrate,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
        cycles=CYCLES,
        log_path=log_path,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="BGC 7周期正弦指令测试（5s×7=35s，默认模拟模式）")
    parser.add_argument("--real", action="store_true", help="显式启用真实串口（默认模拟）")
    parser.add_argument("--port", type=str, default=None, help="显式指定串口号（禁止盲用COM4）")
    parser.add_argument("--baudrate", type=int, default=pm.BAUDRATE)
    parser.add_argument("--confirm-real", action="store_true", help="确认打开真实串口")
    parser.add_argument("--confirm-port-verified", action="store_true", help="确认候选端口已物理核对")
    args = parser.parse_args(argv)

    res = run_seven_cycles(
        real_mode=args.real,
        port=args.port,
        baudrate=args.baudrate,
        confirm_real=args.confirm_real,
        confirm_port_verified=args.confirm_port_verified,
    )
    return res.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
