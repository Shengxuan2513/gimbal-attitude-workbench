import type { SixAxisDataset } from '../types/sixAxis';
export interface SoftwareInterference { start: number; end: number; amplitude: number; channel: 'ax'; count: number }
export function injectSoftwarePulse(base: SixAxisDataset): { dataset: SixAxisDataset; interference: SoftwareInterference } {
  const t0 = base.times[0], span = base.times.at(-1)! - t0;
  const start = t0 + span * .4, end = start + Math.max(.02, Math.min(.2, span * .1));
  const ax = base.ax.slice(); let count = 0;
  base.times.forEach((t, i) => { if (i > 0 && t >= start && t <= end) { ax[i] += 3; count++; } });
  if (!count) throw new Error('记录采样不足，无法在预设时间窗内注入干扰。');
  return { dataset: { ...base, id: base.id + '-software-pulse', filename: base.filename + ' [软件注入]', sourceStatusLabel: '软件注入（非真实外部干扰）', ax },
    interference: {start, end, amplitude: 3, channel: 'ax', count} };
}
