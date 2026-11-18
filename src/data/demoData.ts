import positionDerivedCsv from '../../samples/gimbal_20261118_222038_position_derived.csv?raw';
import { wrapAngle180 } from '../math/angles';
import type { AttitudeDataset } from '../types/attitude';
import { parseAndValidateCsv } from './csvParser';

/**
 * Generates an 18-second built-in simulated attitude sequence (~50 Hz, 901 frames).
 * - Smoothly exercises Roll, Pitch, Yaw
 * - Calm pitch plateau around t = 8.0s so a +20° Pitch spike is clearly visible
 * - Smooth Yaw crossing across ±180° between t = 12s and t = 16s
 * - Includes slight realistic timestamp micro-jitter to verify unequal-interval playback
 */
export function createDemoDataset(): AttitudeDataset {
  const durationSec = 18.0;
  const nominalDt = 0.02;
  const count = Math.round(durationSec / nominalDt) + 1;

  const times: number[] = [];
  const roll: number[] = [];
  const pitch: number[] = [];
  const yaw: number[] = [];

  for (let i = 0; i < count; i++) {
    let t = i * nominalDt;
    if (i > 0 && i < count - 1 && Math.abs(t - 8.0) > 0.05) {
      t += 0.0025 * Math.sin(i * 0.73);
    }
    t = Number(t.toFixed(4));
    times.push(t);

    const r =
      18 * Math.sin(0.55 * t) +
      6 * Math.sin(1.25 * t) +
      0.35 * Math.sin(17.3 * t);

    const calmMask = 1 - Math.exp(-Math.pow((t - 8.0) / 1.4, 2));
    const p =
      4.0 +
      14 * Math.sin(0.45 * t) * calmMask +
      0.3 * Math.cos(14.1 * t);

    let rawYaw = 0;
    if (t < 6.0) {
      rawYaw = 22 * Math.sin(0.6 * t);
    } else if (t < 11.0) {
      const u = (t - 6.0) / 5.0;
      rawYaw = 22 * Math.sin(3.6) + u * 145;
    } else {
      const u = t - 11.0;
      rawYaw = 22 * Math.sin(3.6) + 145 + u * 16;
    }
    const y = wrapAngle180(rawYaw + 0.25 * Math.sin(11.7 * t));

    roll.push(Number(r.toFixed(3)));
    pitch.push(Number(p.toFixed(3)));
    yaw.push(Number(y.toFixed(3)));
  }

  return {
    id: 'builtin-demo-18s',
    filename: 'demo_attitude_18s.csv（内置模拟序列）',
    sourceLabel: '内置模拟数据（右手系 X前 Y左 Z上）',
    isDemo: true,
    times,
    roll,
    pitch,
    yaw,
    convention: {
      frameLabel: '右手系 · X向前 Y向左 Z向上',
      rotationOrder: 'ZYX',
      axisSigns: { roll: 1, pitch: 1, yaw: 1 },
      confirmed: true,
    },
  };
}

/**
 * Loads the bundled 50-frame position-derived dataset offline without re-integrating or resampling.
 */
export function createPositionDerivedDataset(): AttitudeDataset {
  const parsed = parseAndValidateCsv(
    positionDerivedCsv,
    'gimbal_20261118_222038_position_derived.csv',
    {
      timeCol: 'time_s',
      rollCol: 'roll_deg',
      pitchCol: 'pitch_deg',
      yawCol: 'yaw_deg',
      timeUnit: 's',
      angleUnit: 'deg',
      rotationOrder: 'ZYX',
      axisSigns: { roll: 1, pitch: 1, yaw: 1 },
    }
  );

  if ('errors' in parsed) {
    throw new Error(`内置新数据解析失败：${parsed.errors.join('; ')}`);
  }

  return {
    ...parsed.dataset,
    id: 'builtin-position-derived-50f',
    sourceLabel: '由速度推算的角位置，轴约定及计算方法待确认',
    isDemo: false,
    convention: {
      frameLabel: '暂用右手系 · X向前 Y向左 Z向上（待确认）',
      rotationOrder: 'ZYX',
      axisSigns: { roll: 1, pitch: 1, yaw: 1 },
      confirmed: false,
    },
  };
}
