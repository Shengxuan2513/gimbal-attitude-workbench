"""
Offline-safe BGC gimbal serial transport, protocol framing, monotonic clock,
motion lockout, and FakeSerial test harness.

IMPORTANT LIMITATIONS:
- Byte-level ACK (AA 51 55) only confirms serial byte acknowledgement; it does
  NOT prove mechanical stop or full official protocol compliance.
- Software duration timers are NOT a hardware watchdog or disconnect protection.
- Forced process termination (SIGKILL/power loss/USB disconnect) bypasses Python
  finally blocks; hardware e-stop and controller watchdog remain required.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Callable, List, Optional, Protocol, Tuple


ACK_FRAME = b"\xAA\x51\x55"
ZERO_SPEED_FRAME = b"\xAA\x51\x00\x00\x00\x00\x00\x00\x55"


class SafetyLockoutError(RuntimeError):
    """Raised when motion is attempted after a safety lockout has been triggered."""


class SafetyConfigError(ValueError):
    """Raised when real-serial mode is requested with missing/unsafe configuration."""


class ClockProtocol(Protocol):
    def monotonic(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...


class SerialProtocol(Protocol):
    @property
    def in_waiting(self) -> int: ...
    def reset_input_buffer(self) -> None: ...
    def write(self, data: bytes) -> int: ...
    def flush(self) -> None: ...
    def read(self, size: int = 1) -> bytes: ...
    def close(self) -> None: ...


class RealMonotonicClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)


class FakeClock:
    """Deterministic monotonic clock for offline tests."""

    def __init__(self, initial: float = 0.0) -> None:
        self._now = float(initial)

    def monotonic(self) -> float:
        return self._now

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            self._now += float(seconds)

    def advance(self, seconds: float) -> None:
        if seconds > 0:
            self._now += float(seconds)


class BgcProtocolReceiver:
    """
    Incremental receive buffer for BGC AA 51 55 byte-level ACK frames.
    Handles fragmented packets, leading noise, and consecutive packets within a
    bounded buffer. Does NOT claim full official protocol validation.
    """

    def __init__(self, max_buffer: int = 4096) -> None:
        self.buffer = bytearray()
        self.max_buffer = max_buffer

    def reset(self) -> None:
        self.buffer.clear()

    def feed(self, data: bytes) -> bool:
        if data:
            self.buffer.extend(data)
            if len(self.buffer) > self.max_buffer:
                # Keep only the tail to avoid unbounded memory growth on noise
                del self.buffer[: len(self.buffer) - self.max_buffer]

        idx = self.buffer.find(ACK_FRAME)
        if idx >= 0:
            # Consume up through the matched ACK frame so consecutive ACKs work cleanly
            del self.buffer[: idx + len(ACK_FRAME)]
            return True
        return False


def make_speed_frame(
    yaw_rpm: float = 0.0,
    roll_rpm: float = 0.0,
    pitch_rpm: float = 0.0,
) -> bytes:
    """
    Build BGC 3-axis speed frame:
    AA 51 + yaw(i16be) + roll(i16be) + pitch(i16be) + 55
    """
    values: List[int] = []
    for speed in (yaw_rpm, roll_rpm, pitch_rpm):
        if not -60.0 <= speed <= 60.0:
            raise ValueError("速度必须位于-60～60rpm范围内")
        values.append(round(speed * 100))
    payload = b"".join(v.to_bytes(2, byteorder="big", signed=True) for v in values)
    return b"\xAA\x51" + payload + b"\x55"


def is_zero_speed_frame(frame: bytes) -> bool:
    return frame == ZERO_SPEED_FRAME


class FakeSerial:
    """
    In-memory simulated serial port for offline testing and dry-run mode.
    """

    def __init__(
        self,
        clock: Optional[FakeClock] = None,
        on_write: Optional[Callable[[bytes, "FakeSerial", int], None]] = None,
        auto_ack: bool = True,
        write_delay_s: float = 0.0,
        read_step_s: float = 0.01,
    ) -> None:
        self.clock = clock
        self.on_write = on_write
        self.auto_ack = auto_ack
        self.write_delay_s = write_delay_s
        self.read_step_s = read_step_s

        self.is_open = True
        self.closed_count = 0
        self.rx_buffer = bytearray()
        self.written_frames: List[bytes] = []
        self.nonzero_frames: List[bytes] = []
        self.stop_frames: List[bytes] = []
        self.write_timestamps: List[float] = []

        self.raise_on_write: Optional[Callable[[bytes, int], Optional[BaseException]]] = None
        self.raise_on_read: Optional[Callable[[int], Optional[BaseException]]] = None
        self.raise_on_flush: Optional[Callable[[int], Optional[BaseException]]] = None
        self.raise_on_close: Optional[BaseException] = None
        self._read_calls = 0

    @property
    def in_waiting(self) -> int:
        return len(self.rx_buffer)

    def reset_input_buffer(self) -> None:
        if not self.is_open:
            raise RuntimeError("串口已关闭")
        self.rx_buffer.clear()

    def queue_rx(self, data: bytes) -> None:
        self.rx_buffer.extend(data)

    def write(self, data: bytes) -> int:
        if not self.is_open:
            raise RuntimeError("串口已关闭")
        idx = len(self.written_frames)
        if self.raise_on_write is not None:
            exc = self.raise_on_write(data, idx)
            if exc is not None:
                raise exc

        self.written_frames.append(data)
        if is_zero_speed_frame(data):
            self.stop_frames.append(data)
        else:
            self.nonzero_frames.append(data)

        if self.clock is not None:
            if self.write_delay_s > 0:
                self.clock.advance(self.write_delay_s)
            self.write_timestamps.append(self.clock.monotonic())

        if self.on_write is not None:
            self.on_write(data, self, idx)
        elif self.auto_ack:
            self.rx_buffer.extend(ACK_FRAME)

        return len(data)

    def flush(self) -> None:
        if not self.is_open:
            raise RuntimeError("串口已关闭")
        if self.raise_on_flush is not None:
            exc = self.raise_on_flush(len(self.written_frames))
            if exc is not None:
                raise exc

    def read(self, size: int = 1) -> bytes:
        if not self.is_open:
            raise RuntimeError("串口已关闭")
        self._read_calls += 1
        if self.raise_on_read is not None:
            exc = self.raise_on_read(self._read_calls)
            if exc is not None:
                raise exc

        if len(self.rx_buffer) == 0:
            if self.clock is not None and self.read_step_s > 0:
                self.clock.advance(self.read_step_s)
            return b""

        take = min(max(1, size), len(self.rx_buffer))
        out = bytes(self.rx_buffer[:take])
        del self.rx_buffer[:take]
        return out

    def close(self) -> None:
        self.closed_count += 1
        self.is_open = False
        if self.raise_on_close is not None:
            raise self.raise_on_close


@dataclass
class StopAttemptResult:
    attempted: bool
    ack_received: bool
    attempts: int
    mechanical_stop_verified: bool = False
    error: Optional[str] = None


@dataclass
class MotionRunResult:
    dry_run: bool
    port: str
    initial_stop_ok: bool = False
    motion_ok: bool = False
    final_stop_attempted: bool = False
    final_stop_ack: bool = False
    mechanical_stop_verified: bool = False
    port_closed: bool = False
    interrupted_by_ctrl_c: bool = False
    log_saved_ok: Optional[bool] = None
    lockout_triggered: bool = False
    lockout_reason: Optional[str] = None
    error_message: Optional[str] = None
    stop_error_message: Optional[str] = None
    close_error_message: Optional[str] = None
    actions: List[dict] = field(default_factory=list)

    @property
    def exit_code(self) -> int:
        if (
            self.initial_stop_ok
            and self.motion_ok
            and self.final_stop_ack
            and self.port_closed
            and not self.interrupted_by_ctrl_c
            and (self.log_saved_ok is None or self.log_saved_ok)
        ):
            return 0
        return 1


def validate_real_mode_config(
    real_mode: bool,
    port: Optional[str],
    confirm_real: bool,
    confirm_port_verified: bool = False,
) -> Tuple[bool, str]:
    """
    Guard against accidental real serial connection.
    Default is always dry-run (simulation, no device connection).
    """
    if not real_mode:
        return False, "SIMULATED"

    if not confirm_real:
        raise SafetyConfigError(
            "启用真实串口模式必须显式传入 --confirm-real 确认，禁止自动连接。"
        )
    if not port or not str(port).strip():
        raise SafetyConfigError(
            "启用真实串口模式必须显式指定 --port（禁止自动选择或猜测端口）。"
        )
    clean_port = str(port).strip().upper()
    if clean_port == "COM4":
        raise SafetyConfigError(
            "COM4 已识别为蓝牙串口，禁止自动或默认连接 COM4。"
        )
    if clean_port == "COM10" and not confirm_port_verified:
        raise SafetyConfigError(
            "COM10 仅为 USB-SERIAL CH340 候选端口，尚未物理确认；请先物理核对后传入 --confirm-port-verified。"
        )
    return True, clean_port


def open_serial_port(
    real_mode: bool = False,
    port: Optional[str] = None,
    baudrate: int = 115200,
    confirm_real: bool = False,
    confirm_port_verified: bool = False,
    timeout: float = 0.1,
    write_timeout: float = 1.0,
    fake_serial_factory: Optional[Callable[[], SerialProtocol]] = None,
    real_serial_opener: Optional[Callable[..., SerialProtocol]] = None,
) -> Tuple[SerialProtocol, str]:
    """
    Open either FakeSerial (default dry-run) or an explicitly confirmed real serial port.
    """
    is_real, resolved_port = validate_real_mode_config(
        real_mode=real_mode,
        port=port,
        confirm_real=confirm_real,
        confirm_port_verified=confirm_port_verified,
    )
    if not is_real:
        ser = fake_serial_factory() if fake_serial_factory is not None else FakeSerial()
        return ser, "SIMULATED"

    if real_serial_opener is not None:
        ser = real_serial_opener(
            port=resolved_port,
            baudrate=baudrate,
            timeout=timeout,
            write_timeout=write_timeout,
        )
        return ser, resolved_port

    import serial  # Lazy import so module import never touches pyserial unless real_mode=True

    ser = serial.Serial(
        port=resolved_port,
        baudrate=baudrate,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=timeout,
        write_timeout=write_timeout,
    )
    return ser, resolved_port


class GimbalSession:
    """
    Safe session controller enforcing:
    - Motion lockout after any failure or stop failure
    - Monotonic timeouts & bounded retries
    - Incremental ACK buffering
    - Clear distinction between attempted send, protocol ACK, and mechanical stop
    """

    def __init__(
        self,
        ser: SerialProtocol,
        clock: Optional[ClockProtocol] = None,
        ack_timeout_s: float = 1.0,
        poll_sleep_s: float = 0.005,
        max_stop_attempts: int = 2,
    ) -> None:
        self.ser = ser
        self.clock: ClockProtocol = clock if clock is not None else RealMonotonicClock()
        self.ack_timeout_s = ack_timeout_s
        self.poll_sleep_s = poll_sleep_s
        self.max_stop_attempts = max(1, max_stop_attempts)
        self.receiver = BgcProtocolReceiver()
        self.locked = False
        self.lock_reason: Optional[str] = None
        self.actions: List[dict] = []

    def lock(self, reason: str) -> None:
        self.locked = True
        if self.lock_reason is None:
            self.lock_reason = reason

    def send_command(
        self,
        yaw: float = 0.0,
        roll: float = 0.0,
        pitch: float = 0.0,
        ack_timeout_s: Optional[float] = None,
        allow_when_locked: bool = False,
    ) -> Tuple[bool, float]:
        frame = make_speed_frame(yaw_rpm=yaw, roll_rpm=roll, pitch_rpm=pitch)
        is_stop = is_zero_speed_frame(frame)

        if not is_stop and self.locked and not allow_when_locked:
            raise SafetyLockoutError(f"安全锁定已触发，禁止发送非零速度指令：{self.lock_reason}")

        self.receiver.reset()
        self.ser.reset_input_buffer()
        send_ts = self.clock.monotonic()
        self.ser.write(frame)
        self.ser.flush()

        self.actions.append(
            {
                "kind": "STOP" if is_stop else "MOTION",
                "frame_hex": frame.hex(" ").upper(),
                "clock": send_ts,
            }
        )
        print("发送：", frame.hex(" ").upper())

        timeout = self.ack_timeout_s if ack_timeout_s is None else ack_timeout_s
        deadline = self.clock.monotonic() + timeout
        raw_rx = bytearray()

        while self.clock.monotonic() < deadline:
            waiting = self.ser.in_waiting
            data = self.ser.read(waiting if waiting > 0 else 1)
            if data:
                raw_rx.extend(data)
                if self.receiver.feed(data):
                    print("收到协议层字节应答：AA 51 55（不代表机械已实际停止）")
                    return True, send_ts
            else:
                self.clock.sleep(self.poll_sleep_s)

        print("未收到正常应答。原始接收：", raw_rx.hex(" ").upper())
        return False, send_ts

    def stop_all_axes(
        self,
        max_attempts: Optional[int] = None,
        ack_timeout_s: Optional[float] = None,
    ) -> StopAttemptResult:
        attempts_limit = self.max_stop_attempts if max_attempts is None else max(1, max_attempts)
        last_error: Optional[str] = None
        attempted = False

        for attempt in range(1, attempts_limit + 1):
            attempted = True
            print(f"停止（第 {attempt}/{attempts_limit} 次尝试）：三轴速度全部设为0")
            try:
                ok, _ = self.send_command(
                    yaw=0.0,
                    roll=0.0,
                    pitch=0.0,
                    ack_timeout_s=ack_timeout_s,
                    allow_when_locked=True,
                )
                if ok:
                    return StopAttemptResult(
                        attempted=True,
                        ack_received=True,
                        attempts=attempt,
                        mechanical_stop_verified=False,
                    )
                last_error = "零速度命令未收到有效协议应答"
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"

        self.lock(last_error or "停止命令失败")
        return StopAttemptResult(
            attempted=attempted,
            ack_received=False,
            attempts=attempts_limit,
            mechanical_stop_verified=False,
            error=last_error,
        )
