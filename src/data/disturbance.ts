import { findNearestFrameIndex, periodicAngleDiff, wrapAngle180 } from '../math/angles';
import type {
  AppliedDisturbance,
  AttitudeDataset,
  DisturbanceConfig,
  SeriesData,
  SourceDeviationStats,
} from '../types/attitude';

export interface DisturbanceResult {
  disturbed: SeriesData;
  applied: AppliedDisturbance | null;
}

/**
 * Always computes the disturbed copy from the original dataset (never accumulates).
 */
export function applyDisturbance(
  dataset: AttitudeDataset,
  config: DisturbanceConfig
): DisturbanceResult {
  const roll = [...dataset.roll];
  const pitch = [...dataset.pitch];
  const yaw = [...dataset.yaw];

  if (!config.enabled) {
    return {
      disturbed: { roll, pitch, yaw },
      applied: null,
    };
  }

  const targetArr = config.axis === 'roll' ? roll : config.axis === 'pitch' ? pitch : yaw;
  const hitIndices: number[] = [];

  if (config.type === 'spike') {
    const idx = findNearestFrameIndex(dataset.times, config.startTime);
    targetArr[idx] = wrapAngle180(targetArr[idx] + config.amplitude);
    hitIndices.push(idx);
    const tHit = dataset.times[idx];
    return {
      disturbed: { roll, pitch, yaw },
      applied: {
        config: { ...config },
        hitIndices,
        hitStartTime: tHit,
        hitEndTime: tHit,
      },
    };
  } else {
    const startT = config.startTime;
    const endT = config.startTime + Math.max(0, config.duration);
    for (let i = 0; i < dataset.times.length; i++) {
      const t = dataset.times[i];
      if (t >= startT && t < endT) {
        targetArr[i] = wrapAngle180(targetArr[i] + config.amplitude);
        hitIndices.push(i);
      }
    }
    return {
      disturbed: { roll, pitch, yaw },
      applied: {
        config: { ...config },
        hitIndices,
        hitStartTime: startT,
        hitEndTime: endT,
      },
    };
  }
}

function calcAxisDeviation(est: number[], ref: number[]): { rmse: number; maxAbs: number } {
  const n = Math.min(est.length, ref.length);
  if (n === 0) return { rmse: 0, maxAbs: 0 };
  let sumSq = 0;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(periodicAngleDiff(est[i], ref[i]));
    sumSq += d * d;
    if (d > maxAbs) maxAbs = d;
  }
  return {
    rmse: Math.sqrt(sumSq / n),
    maxAbs,
  };
}

/**
 * Computes deviation relative to the original log ("相对原日志的偏差").
 */
export function computeDeviationFromOriginal(
  candidate: SeriesData,
  original: SeriesData
): SourceDeviationStats {
  return {
    roll: calcAxisDeviation(candidate.roll, original.roll),
    pitch: calcAxisDeviation(candidate.pitch, original.pitch),
    yaw: calcAxisDeviation(candidate.yaw, original.yaw),
  };
}
