import { degToRad, periodicAngleDiff, radToDeg, wrapAngle180 } from '../math/angles';
import type { AttitudeFilter, FilterInput, FilterOutput } from './types';

function computeMedianDt(times: number[]): number {
  if (times.length < 2) return 0.02;
  const dts: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    if (Number.isFinite(dt) && dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return 0.02;
  dts.sort((a, b) => a - b);
  const mid = dts.length >> 1;
  return dts.length % 2 === 1 ? dts[mid] : 0.5 * (dts[mid - 1] + dts[mid]);
}

/**
 * Circular weighted mean of angles in degrees over a time-based window.
 * Uses sin/cos projection so ±180° wrap-around never produces artificial 360° jumps.
 */
function circularGaussianSmooth(
  times: number[],
  valuesDeg: number[],
  sigmaSec: number,
  extraWeights?: number[]
): number[] {
  const n = times.length;
  if (n === 0) return [];
  const out = new Array<number>(n);
  const halfWindowSec = sigmaSec * 3.0;
  const twoSigmaSq = 2 * sigmaSec * sigmaSec;

  const sinVals = valuesDeg.map((v) => Math.sin(degToRad(v)));
  const cosVals = valuesDeg.map((v) => Math.cos(degToRad(v)));

  let leftPtr = 0;
  let rightPtr = 0;

  for (let i = 0; i < n; i++) {
    const ti = times[i];
    while (leftPtr < i && ti - times[leftPtr] > halfWindowSec) {
      leftPtr++;
    }
    while (rightPtr + 1 < n && times[rightPtr + 1] - ti <= halfWindowSec) {
      rightPtr++;
    }

    let sumSin = 0;
    let sumCos = 0;
    let sumW = 0;

    for (let j = leftPtr; j <= rightPtr; j++) {
      const dt = times[j] - ti;
      const kernelW = Math.exp(-(dt * dt) / twoSigmaSq);
      const measW = extraWeights ? extraWeights[j] : 1;
      const w = kernelW * measW;
      sumSin += w * sinVals[j];
      sumCos += w * cosVals[j];
      sumW += w;
    }

    if (sumW < 1e-12 || (Math.abs(sumSin) < 1e-12 && Math.abs(sumCos) < 1e-12)) {
      out[i] = wrapAngle180(valuesDeg[i]);
    } else {
      out[i] = wrapAngle180(radToDeg(Math.atan2(sumSin, sumCos)));
    }
  }

  return out;
}

/**
 * Compute local circular median baseline using a time window,
 * guaranteeing at least a 5-sample neighborhood (when available) so sparse logs
 * (e.g. dt ~ 0.5s) always have real neighbors.
 */
function localPeriodicBaseline(times: number[], valuesDeg: number[], halfWinSec: number): number[] {
  const n = times.length;
  const baseline = new Array<number>(n);
  let leftPtr = 0;
  let rightPtr = 0;

  for (let i = 0; i < n; i++) {
    const ti = times[i];
    while (leftPtr < i && ti - times[leftPtr] > halfWinSec) {
      leftPtr++;
    }
    while (rightPtr + 1 < n && times[rightPtr + 1] - ti <= halfWinSec) {
      rightPtr++;
    }

    // Ensure at least ±2 neighbors when dataset has enough frames
    const effLeft = Math.min(leftPtr, Math.max(0, i - 2));
    const effRight = Math.max(rightPtr, Math.min(n - 1, i + 2));

    let sumSin = 0;
    let sumCos = 0;
    for (let j = effLeft; j <= effRight; j++) {
      const r = degToRad(valuesDeg[j]);
      sumSin += Math.sin(r);
      sumCos += Math.cos(r);
    }
    const refDeg = radToDeg(Math.atan2(sumSin, sumCos));
    const diffs: number[] = [];
    for (let j = effLeft; j <= effRight; j++) {
      diffs.push(periodicAngleDiff(valuesDeg[j], refDeg));
    }
    diffs.sort((a, b) => a - b);
    const mid = diffs.length >> 1;
    const medDiff =
      diffs.length % 2 === 1 ? diffs[mid] : 0.5 * (diffs[mid - 1] + diffs[mid]);
    baseline[i] = wrapAngle180(refDeg + medDiff);
  }

  return baseline;
}

/**
 * Compute robust measurement weights from periodic residuals.
 */
function computeRobustWeights(
  times: number[],
  valuesDeg: number[],
  thresholdDeg: number,
  halfWinSec: number
): number[] {
  const baseline = localPeriodicBaseline(times, valuesDeg, halfWinSec);
  const n = valuesDeg.length;
  const weights = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const res = Math.abs(periodicAngleDiff(valuesDeg[i], baseline[i]));
    if (res <= thresholdDeg) {
      weights[i] = 1.0;
    } else {
      const ratio = thresholdDeg / res;
      weights[i] = Math.max(0.02, ratio * ratio);
    }
  }
  return weights;
}

export const standardSmoothingFilter: AttitudeFilter = {
  id: 'demo_standard_smoothing',
  name: '普通角度平滑（演示算法）',
  shortName: '普通滤波(演示)',
  category: 'standard',
  isDemo: true,
  description:
    '自适应采样间隔的高斯加权圆周均值平滑（演示算法），处理 ±180° 周期边界，对大尖峰和区间偏移无抗差能力。',
  run(input: FilterInput): FilterOutput {
    const dtMed = computeMedianDt(input.times);
    const sigmaSec = Math.max(0.18, dtMed * 1.15);
    return {
      roll: circularGaussianSmooth(input.times, input.roll, sigmaSec),
      pitch: circularGaussianSmooth(input.times, input.pitch, sigmaSec),
      yaw: circularGaussianSmooth(input.times, input.yaw, sigmaSec),
      paramsSummary: `dt_med=${dtMed.toFixed(3)}s, σ=${sigmaSec.toFixed(2)}s`,
    };
  },
};

export const robustResidualFilter: AttitudeFilter = {
  id: 'demo_robust_residual',
  name: '残差限幅鲁棒平滑（演示算法）',
  shortName: '鲁棒滤波(演示)',
  category: 'robust',
  isDemo: true,
  description:
    '自适应采样间隔的局部中值基线与周期角差残差限幅平滑（演示算法），对单帧尖峰自动降权并输出各帧测量权重。',
  run(input: FilterInput): FilterOutput {
    const dtMed = computeMedianDt(input.times);
    const thresholdDeg = 3.0;
    const baselineHalfWinSec = Math.max(0.45, dtMed * 2.2);
    const sigmaSec = Math.max(0.22, dtMed * 1.15);

    const wRoll = computeRobustWeights(input.times, input.roll, thresholdDeg, baselineHalfWinSec);
    const wPitch = computeRobustWeights(input.times, input.pitch, thresholdDeg, baselineHalfWinSec);
    const wYaw = computeRobustWeights(input.times, input.yaw, thresholdDeg, baselineHalfWinSec);

    return {
      roll: circularGaussianSmooth(input.times, input.roll, sigmaSec, wRoll),
      pitch: circularGaussianSmooth(input.times, input.pitch, sigmaSec, wPitch),
      yaw: circularGaussianSmooth(input.times, input.yaw, sigmaSec, wYaw),
      weights: {
        roll: wRoll,
        pitch: wPitch,
        yaw: wYaw,
      },
      paramsSummary: `dt_med=${dtMed.toFixed(3)}s, 半窗=${baselineHalfWinSec.toFixed(2)}s, 阈值=${thresholdDeg.toFixed(1)}°, σ=${sigmaSec.toFixed(2)}s`,
    };
  },
};

export const DEMO_FILTERS: AttitudeFilter[] = [standardSmoothingFilter, robustResidualFilter];
