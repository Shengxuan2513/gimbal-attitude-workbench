export interface WitMotionBinInspection {
  filename: string;
  totalBytes: number;
  timePacketCount: number;
  accelPacketCount: number;
  gyroPacketCount: number;
  anglePacketCount: number;
  magPacketCount: number;
  badChecksumCount: number;
  truncatedTailBytes: number;
  truncatedTailPacketType: string | null;
  completeGroupCount: number;
  notes: string[];
}

const PACKET_TYPE_NAMES: Record<number, string> = {
  0x50: '0x50 (片上时间包)',
  0x51: '0x51 (加速度包)',
  0x52: '0x52 (角速度包)',
  0x53: '0x53 (角度包)',
  0x54: '0x54 (磁场包)',
};

export function inspectWitMotionBin(
  bytes: Uint8Array,
  filename = 'data_0.bin'
): WitMotionBinInspection {
  let i = 0;
  let timePacketCount = 0;
  let accelPacketCount = 0;
  let gyroPacketCount = 0;
  let anglePacketCount = 0;
  let magPacketCount = 0;
  let badChecksumCount = 0;
  let truncatedTailBytes = 0;
  let truncatedTailPacketType: string | null = null;

  while (i < bytes.length) {
    if (bytes[i] !== 0x55) {
      i++;
      continue;
    }

    if (i + 11 > bytes.length) {
      truncatedTailBytes = bytes.length - i;
      const t = i + 1 < bytes.length ? bytes[i + 1] : -1;
      truncatedTailPacketType =
        t >= 0 ? (PACKET_TYPE_NAMES[t] ?? `0x${t.toString(16)}`) : '未知包头';
      break;
    }

    let sum = 0;
    for (let k = 0; k < 10; k++) {
      sum += bytes[i + k];
    }
    if ((sum & 0xff) !== bytes[i + 10]) {
      badChecksumCount++;
      i++;
      continue;
    }

    const type = bytes[i + 1];
    if (type === 0x50) timePacketCount++;
    else if (type === 0x51) accelPacketCount++;
    else if (type === 0x52) gyroPacketCount++;
    else if (type === 0x53) anglePacketCount++;
    else if (type === 0x54) magPacketCount++;

    i += 11;
  }

  const completeGroupCount = Math.min(timePacketCount, accelPacketCount, gyroPacketCount);
  const notes: string[] = [];
  if (badChecksumCount > 0) {
    notes.push(`检测到 ${badChecksumCount} 次校验和失败。`);
  }
  if (truncatedTailBytes > 0) {
    notes.push(
      `文件尾部存在 ${truncatedTailBytes} 字节截断包（${truncatedTailPacketType ?? '未知'}）。`
    );
  }
  if (timePacketCount !== accelPacketCount || accelPacketCount !== gyroPacketCount) {
    notes.push(
      `三类包数量不一致：时间=${timePacketCount}，加速度=${accelPacketCount}，角速度=${gyroPacketCount}，完整组=${completeGroupCount}。`
    );
  }

  return {
    filename,
    totalBytes: bytes.length,
    timePacketCount,
    accelPacketCount,
    gyroPacketCount,
    anglePacketCount,
    magPacketCount,
    badChecksumCount,
    truncatedTailBytes,
    truncatedTailPacketType,
    completeGroupCount,
    notes,
  };
}
