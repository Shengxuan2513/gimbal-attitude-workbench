import type { SixAxisEskfResult } from '../filters/sixAxisEskf';
import { periodicAngleDiff } from '../math/angles';
export function angularDeviation(current: number[], reference: number[]): number[] {
  if (current.length !== reference.length) throw new Error('偏差序列长度不一致');
  return current.map((v,i) => periodicAngleDiff(v,reference[i]));
}
export function comparisonRows(a0: SixAxisEskfResult, a4: SixAxisEskfResult, b0: SixAxisEskfResult, b4: SixAxisEskfResult) {
  return (['rollDeg','pitchDeg','yawDeg'] as const).map(field => ({
    field, standard: a0[field], robust: a4[field],
    standardDeviation: angularDeviation(a0[field], b0[field]),
    robustDeviation: angularDeviation(a4[field], b4[field]),
  }));
}
