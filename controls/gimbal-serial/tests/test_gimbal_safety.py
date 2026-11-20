import importlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import serial  # noqa: E402

import gimbal_safety  # noqa: E402
from gimbal_safety import (  # noqa: E402
    ACK_FRAME,
    BgcProtocolReceiver,
    FakeClock,
    FakeSerial,
    GimbalSession,
    SafetyConfigError,
    SafetyLockoutError,
    is_zero_speed_frame,
    validate_real_mode_config,
)
import periodic_motion  # noqa: E402
import read_com4  # noqa: E402
import test_bgc  # noqa: E402
import test_three_axes  # noqa: E402


def forbid_real_serial(*_args, **_kwargs):
    raise AssertionError("FORBIDDEN: 测试中禁止打开任何真实串口！")


class GimbalSafetyOfflineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._serial_patcher = patch.object(serial, "Serial", side_effect=forbid_real_serial)
        self._serial_patcher.start()

    def tearDown(self) -> None:
        self._serial_patcher.stop()

    def test_imports_have_no_hardware_side_effects(self) -> None:
        code = (
            "import unittest.mock as m, serial; "
            "p = m.patch.object(serial, 'Serial', side_effect=AssertionError('REAL_SERIAL_OPENED')); "
            "p.start(); "
            "import gimbal_safety, read_com4, test_bgc, test_three_axes, periodic_motion; "
            "p.stop()"
        )
        proc = subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)

    def test_default_dry_run_never_calls_real_serial(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            log_file = Path(td) / "dry_run.csv"
            self.assertEqual(read_com4.main([]), 0)
            self.assertEqual(test_bgc.main([]), 0)
            self.assertEqual(test_three_axes.main([]), 0)
            res = periodic_motion.run_periodic_motion(
                real_mode=False,
                cycles=1,
                log_path=log_file,
                clock=FakeClock(),
            )
            self.assertEqual(res.exit_code, 0)
            self.assertTrue(res.dry_run)
            self.assertEqual(res.port, "SIMULATED")
            self.assertTrue(res.log_saved_ok)
            self.assertFalse(res.mechanical_stop_verified)

    def test_real_mode_guards_reject_missing_unconfirmed_com4_com10(self) -> None:
        with self.assertRaises(SafetyConfigError):
            validate_real_mode_config(real_mode=True, port=None, confirm_real=True)
        with self.assertRaises(SafetyConfigError):
            validate_real_mode_config(real_mode=True, port="COM9", confirm_real=False)
        with self.assertRaises(SafetyConfigError):
            validate_real_mode_config(real_mode=True, port="COM4", confirm_real=True)
        with self.assertRaises(SafetyConfigError):
            validate_real_mode_config(
                real_mode=True,
                port="COM10",
                confirm_real=True,
                confirm_port_verified=False,
            )

    def test_fragmented_ack_noise_consecutive_and_timeout(self) -> None:
        rx = BgcProtocolReceiver()
        # Noise + fragmented AA 51 | 55
        self.assertFalse(rx.feed(b"\x00\xFF\x12\xAA\x51"))
        self.assertTrue(rx.feed(b"\x55\xAA\x51"))
        # Second consecutive ACK completes on next 0x55
        self.assertTrue(rx.feed(b"\x55"))

        # Timeout test on FakeSerial with auto_ack=False
        clk = FakeClock()
        ser = FakeSerial(clock=clk, auto_ack=False, read_step_s=0.05)
        session = GimbalSession(ser=ser, clock=clk, ack_timeout_s=0.2)
        ok, _ = session.send_command(yaw=1.0)
        self.assertFalse(ok)

    def test_normal_single_three_axes_and_periodic_completion(self) -> None:
        clk1 = FakeClock()
        ser1 = FakeSerial(clock=clk1, auto_ack=True)
        r1 = test_bgc.run_single_axis_test(clock=clk1, fake_serial_factory=lambda: ser1)
        self.assertEqual(r1.exit_code, 0)
        self.assertTrue(r1.initial_stop_ok and r1.motion_ok and r1.final_stop_ack and r1.port_closed)
        self.assertFalse(r1.mechanical_stop_verified)

        clk3 = FakeClock()
        ser3 = FakeSerial(clock=clk3, auto_ack=True)
        r3 = test_three_axes.run_three_axes_test(clock=clk3, fake_serial_factory=lambda: ser3)
        self.assertEqual(r3.exit_code, 0)
        self.assertEqual(len(ser3.nonzero_frames), 3)
        self.assertTrue(r3.port_closed)

    def test_initial_stop_failure_zero_nonzero_commands(self) -> None:
        # test_bgc
        clk = FakeClock()
        ser = FakeSerial(clock=clk, auto_ack=False)
        res = test_bgc.run_single_axis_test(clock=clk, fake_serial_factory=lambda: ser)
        self.assertEqual(len(ser.nonzero_frames), 0)
        self.assertFalse(res.initial_stop_ok)
        self.assertTrue(res.lockout_triggered)
        self.assertTrue(res.port_closed)
        self.assertEqual(res.exit_code, 1)

        # test_three_axes
        clk3 = FakeClock()
        ser3 = FakeSerial(clock=clk3, auto_ack=False)
        res3 = test_three_axes.run_three_axes_test(clock=clk3, fake_serial_factory=lambda: ser3)
        self.assertEqual(len(ser3.nonzero_frames), 0)
        self.assertEqual(res3.exit_code, 1)
        self.assertTrue(res3.port_closed)

        # periodic_motion
        with tempfile.TemporaryDirectory() as td:
            clkp = FakeClock()
            serp = FakeSerial(clock=clkp, auto_ack=False)
            resp = periodic_motion.run_periodic_motion(
                cycles=1,
                log_path=Path(td) / "init_fail.csv",
                clock=clkp,
                fake_serial_factory=lambda: serp,
            )
            self.assertEqual(len(serp.nonzero_frames), 0)
            self.assertEqual(resp.exit_code, 1)
            self.assertTrue(resp.port_closed)

    def test_three_axes_first_axis_stop_failure_blocks_next_axes(self) -> None:
        clk = FakeClock()

        def on_write(frame: bytes, s: FakeSerial, idx: int) -> None:
            # idx 0: initial stop (ACK)
            # idx 1: yaw nonzero (ACK)
            # idx 2 & 3: yaw end stop attempts (NO ACK!)
            if idx in (0, 1):
                s.rx_buffer.extend(ACK_FRAME)

        ser = FakeSerial(clock=clk, on_write=on_write)
        res = test_three_axes.run_three_axes_test(clock=clk, fake_serial_factory=lambda: ser)
        # Only yaw nonzero command was sent; roll and pitch must NEVER run
        self.assertEqual(len(ser.nonzero_frames), 1)
        self.assertTrue(res.lockout_triggered)
        self.assertTrue(res.port_closed)
        self.assertEqual(res.exit_code, 1)

    def test_motion_io_error_final_stop_io_error_still_closes_port(self) -> None:
        clk = FakeClock()

        def on_write(frame: bytes, s: FakeSerial, idx: int) -> None:
            if idx == 0:
                s.rx_buffer.extend(ACK_FRAME)

        ser = FakeSerial(clock=clk, on_write=on_write)

        def raise_write(frame: bytes, idx: int):
            if idx >= 1:
                return OSError("模拟串口写入失败")
            return None

        ser.raise_on_write = raise_write
        res = test_bgc.run_single_axis_test(clock=clk, fake_serial_factory=lambda: ser)
        self.assertTrue(res.port_closed)
        self.assertEqual(ser.closed_count, 1)
        self.assertFalse(res.final_stop_ack)
        self.assertIsNotNone(res.stop_error_message)
        self.assertEqual(res.exit_code, 1)

    def test_periodic_final_stop_no_ack_returns_nonzero_even_when_log_saved(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            clk = FakeClock()
            # Track non-zero count; once motion finishes, stop failing ACKs on zero frames
            motion_started = {"flag": False}

            def on_write(frame: bytes, s: FakeSerial, idx: int) -> None:
                if not is_zero_speed_frame(frame):
                    motion_started["flag"] = True
                    s.rx_buffer.extend(ACK_FRAME)
                elif not motion_started["flag"]:
                    s.rx_buffer.extend(ACK_FRAME)
                # Final stop (zero frame after motion_started) gets NO ACK

            ser = FakeSerial(clock=clk, on_write=on_write)
            res = periodic_motion.run_periodic_motion(
                cycles=1,
                log_path=Path(td) / "stop_no_ack.csv",
                clock=clk,
                fake_serial_factory=lambda: ser,
            )
            self.assertTrue(res.log_saved_ok)
            self.assertTrue(res.final_stop_attempted)
            self.assertFalse(res.final_stop_ack)
            self.assertTrue(res.port_closed)
            self.assertEqual(res.exit_code, 1)

    def test_ctrl_c_and_log_error_cleanup(self) -> None:
        # Ctrl+C during periodic_motion
        with tempfile.TemporaryDirectory() as td:
            clk = FakeClock()

            def on_write(frame: bytes, s: FakeSerial, idx: int) -> None:
                s.rx_buffer.extend(ACK_FRAME)
                if idx == 3:
                    raise KeyboardInterrupt()

            ser = FakeSerial(clock=clk, on_write=on_write)
            res = periodic_motion.run_periodic_motion(
                cycles=1,
                log_path=Path(td) / "ctrl_c.csv",
                clock=clk,
                fake_serial_factory=lambda: ser,
            )
            self.assertTrue(res.interrupted_by_ctrl_c)
            self.assertTrue(res.final_stop_attempted)
            self.assertTrue(res.final_stop_ack)
            self.assertTrue(res.port_closed)
            self.assertEqual(res.exit_code, 1)

        # Log write OSError
        clk2 = FakeClock()
        ser2 = FakeSerial(clock=clk2, auto_ack=True)

        def bad_log_opener(_path: Path):
            raise OSError("磁盘只读")

        res2 = periodic_motion.run_periodic_motion(
            cycles=1,
            log_path=Path("ignored.csv"),
            clock=clk2,
            log_opener=bad_log_opener,
            fake_serial_factory=lambda: ser2,
        )
        self.assertFalse(res2.log_saved_ok)
        self.assertEqual(len(ser2.nonzero_frames), 0)
        self.assertTrue(res2.port_closed)
        self.assertEqual(res2.exit_code, 1)

    def test_lockout_cannot_be_bypassed(self) -> None:
        clk = FakeClock()
        ser = FakeSerial(clock=clk, auto_ack=True)
        session = GimbalSession(ser=ser, clock=clk)
        session.lock("模拟故障锁定")
        with self.assertRaises(SafetyLockoutError):
            session.send_command(yaw=1.0)
        # Zero-speed stop is still permitted when locked
        ok, _ = session.send_command(yaw=0.0)
        self.assertTrue(ok)

    def test_ack_latency_does_not_extend_motion_duration_budget(self) -> None:
        clk = FakeClock()

        def on_write(frame: bytes, s: FakeSerial, idx: int) -> None:
            # Delay ACK by 0.4s via empty reads before queuing ACK
            if idx == 0:
                s.rx_buffer.extend(ACK_FRAME)
            elif idx == 1:
                # Simulate 0.4s ACK latency by advancing clock in write_delay or empty reads
                clk.advance(0.4)
                s.rx_buffer.extend(ACK_FRAME)
            else:
                s.rx_buffer.extend(ACK_FRAME)

        ser = FakeSerial(clock=clk, on_write=on_write)
        session = GimbalSession(ser=ser, clock=clk, ack_timeout_s=1.0)
        session.stop_all_axes()
        test_three_axes.test_single_axis(
            session=session,
            axis_name="yaw",
            speed_rpm=1.0,
            duration_s=1.0,
            stop_observe_s=0.5,
        )
        # write_timestamps[1] is yaw nonzero start; write_timestamps[2] is yaw stop
        motion_elapsed = ser.write_timestamps[2] - ser.write_timestamps[1]
        self.assertAlmostEqual(motion_elapsed, 1.0, places=6)

    def test_single_axis_step_cli_axis_direction_duration_and_guards(self) -> None:
        # Roll negative direction via run_single_axis_test
        clk = FakeClock()
        ser = FakeSerial(clock=clk, auto_ack=True)
        res = test_bgc.run_single_axis_test(
            axis="roll",
            speed_rpm=-1.0,
            duration_s=0.5,
            clock=clk,
            fake_serial_factory=lambda: ser,
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(len(ser.nonzero_frames), 1)
        # -1.0 rpm -> -100 -> 0xFF9C in roll slot (bytes 4..6)
        self.assertEqual(ser.nonzero_frames[0], gimbal_safety.make_speed_frame(roll_rpm=-1.0))

        # CLI dry-run with --axis pitch --speed -0.5 --duration 0.5
        self.assertEqual(
            test_bgc.main(["--axis", "pitch", "--speed", "-0.5", "--duration", "0.5"]),
            0,
        )

        # Invalid speed / duration rejected
        with self.assertRaises(ValueError):
            test_bgc.validate_step_params("yaw", 0.0, 1.0)
        with self.assertRaises(ValueError):
            test_bgc.validate_step_params("yaw", 10.0, 1.0)
        with self.assertRaises(ValueError):
            test_bgc.validate_step_params("yaw", 1.0, 0.0)

        # Real mode still blocked without --confirm-real even with step args
        with self.assertRaises(SafetyConfigError):
            test_bgc.main(["--real", "--port", "COM10", "--axis", "yaw", "--speed", "-1.0", "--duration", "0.5"])


if __name__ == "__main__":
    unittest.main()
