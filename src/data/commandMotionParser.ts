export interface HostCommandTrajectory {
  filename: string;
  times: number[];
  yawDeg: number[];
  rollDeg: number[];
  pitchDeg: number[];
  yawRpm?: number[];
  rollRpm?: number[];
  pitchRpm?: number[];
}

export interface AlignedCommandSeries {
  rollDeg: (number | null)[];
  pitchDeg: (number | null)[];
  yawDeg: (number | null)[];
  overlapCount: number;
}

export interface CommandTrackingMetrics {
  overlapCount: number;
  rmseDeg: number;
  maxAbsErrorDeg: number;
}

function wrapDeg180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180 && deg > 0) d = 180;
  return d;
}

export function parseHostCommandCsv(text: string, filename: string): HostCommandTrajectory {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length < 2) {
    throw new Error('上位机指令 CSV 至少需要表头和 1 行数据');
  }

  const headers = lines[0].split(',').map((h) => h.trim());
  const idxTime = headers.indexOf('elapsed_s');
  const idxYaw = headers.indexOf('yaw_position_deg');
  const idxRoll = headers.indexOf('roll_position_deg');
  const idxPitch = headers.indexOf('pitch_position_deg');
  if (idxTime < 0 || idxYaw < 0 || idxRoll < 0 || idxPitch < 0) {
    throw new Error(
      '上位机指令 CSV 缺少必要列：elapsed_s, yaw_position_deg, roll_position_deg, pitch_position_deg'
    );
  }

  const idxYawRpm = headers.indexOf('yaw_rpm');
  const idxRollRpm = headers.indexOf('roll_rpm');
  const idxPitchRpm = headers.indexOf('pitch_rpm');
  const hasRpm = idxYawRpm >= 0 && idxRollRpm >= 0 && idxPitchRpm >= 0;

  const times: number[] = [];
  const yawDeg: number[] = [];
  const rollDeg: number[] = [];
  const pitchDeg: number[] = [];
  const yawRpm: number[] = [];
  const rollRpm: number[] = [];
  const pitchRpm: number[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < headers.length) {
      throw new Error(`第 ${i + 1} 行列数不足（预期 ${headers.length} 列，实际 ${cols.length} 列）`);
    }
    const t = Number(cols[idxTime]);
    const y = Number(cols[idxYaw]);
    const r = Number(cols[idxRoll]);
    const p = Number(cols[idxPitch]);
    if (![t, y, r, p].every(Number.isFinite)) {
      throw new Error(`第 ${i + 1} 行存在非有限数值`);
    }
    if (times.length > 0 && t <= times[times.length - 1]) {
      throw new Error(`第 ${i + 1} 行 elapsed_s (${t}) 未严格递增`);
    }
    times.push(t);
    yawDeg.push(y);
    rollDeg.push(r);
    pitchDeg.push(p);

    if (hasRpm) {
      const yr = Number(cols[idxYawRpm]);
      const rr = Number(cols[idxRollRpm]);
      const pr = Number(cols[idxPitchRpm]);
      if ([yr, rr, pr].every(Number.isFinite)) {
        yawRpm.push(yr);
        rollRpm.push(rr);
        pitchRpm.push(pr);
      }
    }
  }

  return {
    filename,
    times,
    yawDeg,
    rollDeg,
    pitchDeg,
    ...(hasRpm && yawRpm.length === times.length ? { yawRpm, rollRpm, pitchRpm } : {}),
  };
}

function interpAt(times: number[], values: number[], t: number): number | null {
  if (times.length === 0 || t < times[0] || t > times[times.length - 1]) {
    return null;
  }
  if (times.length === 1) return values[0];
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  if (span <= 0) return values[lo];
  const alpha = (t - times[lo]) / span;
  return values[lo] + alpha * (values[hi] - values[lo]);
}

export function alignCommandToSensorTimes(
  sensorTimes: number[],
  eskf: { rollDeg: number[]; pitchDeg: number[]; yawDeg: number[] },
  cmd: HostCommandTrajectory,
  timeOffsetSec: number,
  alignInitialZero: boolean
): AlignedCommandSeries {
  const n = sensorTimes.length;
  const rollDeg: (number | null)[] = new Array(n).fill(null);
  const pitchDeg: (number | null)[] = new Array(n).fill(null);
  const yawDeg: (number | null)[] = new Array(n).fill(null);

  let firstOverlapIdx = -1;
  for (let i = 0; i < n; i++) {
    const tCmd = sensorTimes[i] - timeOffsetSec;
    const r = interpAt(cmd.times, cmd.rollDeg, tCmd);
    const p = interpAt(cmd.times, cmd.pitchDeg, tCmd);
    const y = interpAt(cmd.times, cmd.yawDeg, tCmd);
    if (r !== null && p !== null && y !== null) {
      rollDeg[i] = r;
      pitchDeg[i] = p;
      yawDeg[i] = y;
      if (firstOverlapIdx < 0) firstOverlapIdx = i;
    }
  }

  let overlapCount = 0;
  if (firstOverlapIdx >= 0) {
    const rBias = alignInitialZero ? eskf.rollDeg[firstOverlapIdx] - rollDeg[firstOverlapIdx]! : 0;
    const pBias = alignInitialZero ? eskf.pitchDeg[firstOverlapIdx] - pitchDeg[firstOverlapIdx]! : 0;
    const yBias = alignInitialZero ? eskf.yawDeg[firstOverlapIdx] - yawDeg[firstOverlapIdx]! : 0;

    for (let i = 0; i < n; i++) {
      if (rollDeg[i] !== null) {
        rollDeg[i] = rollDeg[i]! + rBias;
        pitchDeg[i] = pitchDeg[i]! + pBias;
        yawDeg[i] = yawDeg[i]! + yBias;
        overlapCount++;
      }
    }
  }

  return { rollDeg, pitchDeg, yawDeg, overlapCount };
}

export function computeCommandTrackingMetrics(
  sensorDeg: number[],
  alignedCmdDeg: (number | null)[]
): CommandTrackingMetrics | null {
  let count = 0;
  let sumSq = 0;
  let maxAbs = 0;
  const n = Math.min(sensorDeg.length, alignedCmdDeg.length);
  for (let i = 0; i < n; i++) {
    const cmd = alignedCmdDeg[i];
    if (cmd === null || !Number.isFinite(sensorDeg[i])) continue;
    const err = Math.abs(wrapDeg180(sensorDeg[i] - cmd));
    sumSq += err * err;
    if (err > maxAbs) maxAbs = err;
    count++;
  }
  if (count === 0) return null;
  return {
    overlapCount: count,
    rmseDeg: Math.sqrt(sumSq / count),
    maxAbsErrorDeg: maxAbs,
  };
}
