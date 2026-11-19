import type {
  AppliedDisturbance,
  AttitudeDataset,
  AxisKey,
  DisturbanceConfig,
  SeriesData,
} from '../types/attitude';
import type { AxisFrameDiagnostic } from './types';

export interface TriAxisDiagnosticsExportInput {
  dataset: AttitudeDataset;
  filterMode: 'kf' | 'smooth';
  filterName: string;
  paramsSummary: string;
  disturbanceConfig: DisturbanceConfig;
  appliedDisturbance: AppliedDisturbance | null;
  disturbedSeries: SeriesData;
  robustSeries: SeriesData;
}

export function formatAxisKfDiagnosticSummary(
  frameIdx: number,
  timeSec: number,
  axis: AxisKey,
  obsDeg: number,
  estDeg: number,
  diag: AxisFrameDiagnostic,
  allAxesValid: boolean
): string {
  const axisName = axis === 'roll' ? 'Roll' : axis === 'pitch' ? 'Pitch' : 'Yaw';
  return (
    `Huber诊断(第${frameIdx + 1}帧, t=${timeSec.toFixed(3)}s, ${axisName}): ` +
    `obs=${obsDeg.toFixed(2)}°, pred=${diag.predicted.toFixed(2)}°, est=${estDeg.toFixed(2)}°, ` +
    `ν=${diag.innovation >= 0 ? '+' : ''}${diag.innovation.toFixed(2)}°, ` +
    `e=${diag.normalizedResidual >= 0 ? '+' : ''}${diag.normalizedResidual.toFixed(2)}, ` +
    `w=${diag.weight.toFixed(3)}, R_eff=${diag.rEff.toFixed(2)}, ` +
    `P_diag=(${diag.pDiag[0].toFixed(2)},${diag.pDiag[1].toFixed(2)}) · ` +
    `对称/半正定=${allAxesValid ? '正常' : '异常'}`
  );
}

export function buildTriAxisDiagnosticsCsv(
  input: TriAxisDiagnosticsExportInput
): string | null {
  if (input.filterMode !== 'kf' || !input.robustSeries.diagnostics) {
    return null;
  }

  const { dataset, filterName, paramsSummary, disturbanceConfig, appliedDisturbance, disturbedSeries, robustSeries } =
    input;
  const diag = robustSeries.diagnostics;
  const times = dataset.times;

  const distDesc = appliedDisturbance
    ? `${disturbanceConfig.type} axis=${disturbanceConfig.axis} start=${disturbanceConfig.startTime}s amp=${disturbanceConfig.amplitude}deg dur=${disturbanceConfig.duration}s hit=[${appliedDisturbance.hitStartTime},${appliedDisturbance.hitEndTime}] count=${appliedDisturbance.hitIndices.length}`
    : 'none';

  const lines: string[] = [
    `# algorithm: ${filterName}`,
    `# params: ${paramsSummary}`,
    `# source_file: ${dataset.filename}`,
    `# source_label: ${dataset.sourceLabel}`,
    `# convention: ${dataset.convention.frameLabel} | order=${dataset.convention.rotationOrder} | signs=(R:${dataset.convention.axisSigns.roll},P:${dataset.convention.axisSigns.pitch},Y:${dataset.convention.axisSigns.yaw})`,
    `# disturbance: ${distDesc}`,
    'frame_idx,time_s,axis,obs_deg,pred_deg,est_deg,nu_deg,e,w,r_eff_deg2,p_angle_deg2,p_rate_deg2_s2,cov_symmetric,cov_psd',
  ];

  const axes: AxisKey[] = ['roll', 'pitch', 'yaw'];
  for (let i = 0; i < times.length; i++) {
    for (const axis of axes) {
      const d = diag[axis][i];
      const obs = disturbedSeries[axis][i];
      const est = robustSeries[axis][i];
      lines.push(
        [
          i + 1,
          times[i],
          axis,
          obs.toFixed(6),
          d.predicted.toFixed(6),
          est.toFixed(6),
          d.innovation.toFixed(6),
          d.normalizedResidual.toFixed(6),
          d.weight.toFixed(6),
          d.rEff.toFixed(6),
          d.pDiag[0].toFixed(6),
          d.pDiag[1].toFixed(6),
          d.covSymmetric,
          d.covPsd,
        ].join(',')
      );
    }
  }

  return lines.join('\n');
}
