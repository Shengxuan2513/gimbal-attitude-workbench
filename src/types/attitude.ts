import type { FilterDiagnostics } from '../filters/types';

export type AxisKey = 'roll' | 'pitch' | 'yaw';

export type RotationOrder = 'ZYX' | 'XYZ' | 'ZXY' | 'YXZ' | 'YZX' | 'XZY';

export type TimeUnit = 's' | 'ms';
export type AngleUnit = 'deg' | 'rad';

export type DataSourceId = 'raw' | 'disturbed' | 'filter_standard' | 'filter_robust';

export type DisturbanceType = 'spike' | 'interval';

export interface AxisSigns {
  roll: 1 | -1;
  pitch: 1 | -1;
  yaw: 1 | -1;
}

export interface AttitudeConvention {
  frameLabel: string;
  rotationOrder: RotationOrder;
  axisSigns: AxisSigns;
  confirmed: boolean;
}

export interface CsvImportConfig {
  timeCol: string;
  rollCol: string;
  pitchCol: string;
  yawCol: string;
  timeUnit: TimeUnit;
  angleUnit: AngleUnit;
  rotationOrder: RotationOrder;
  axisSigns: AxisSigns;
}

export interface RawSourceRecord {
  headers: string[];
  /** Preserved raw string rows (excluding header) from the imported CSV */
  rows: string[][];
}

export interface AttitudeDataset {
  id: string;
  filename: string;
  sourceLabel: string;
  isDemo: boolean;
  /** Seconds relative to first frame (strictly increasing, full precision) */
  times: number[];
  /** Degrees (already normalized with axisSigns once at import time) */
  roll: number[];
  /** Degrees (already normalized with axisSigns once at import time) */
  pitch: number[];
  /** Degrees (already normalized with axisSigns once at import time) */
  yaw: number[];
  convention: AttitudeConvention;
  importConfig?: CsvImportConfig;
  rawSource?: RawSourceRecord;
}

export interface DisturbanceConfig {
  enabled: boolean;
  type: DisturbanceType;
  axis: AxisKey;
  startTime: number;
  amplitude: number;
  duration: number;
}

export interface AppliedDisturbance {
  config: DisturbanceConfig;
  /** Sample indices modified by the disturbance */
  hitIndices: number[];
  /** Exact timestamp of the hit frame (for spike) or [start, end] range (for interval) */
  hitStartTime: number;
  hitEndTime: number;
}

export interface SeriesData {
  roll: number[];
  pitch: number[];
  yaw: number[];
  weights?: {
    roll: number[];
    pitch: number[];
    yaw: number[];
  };
  diagnostics?: FilterDiagnostics;
  paramsSummary?: string;
}

export interface AxisDeviationStats {
  rmse: number;
  maxAbs: number;
}

export interface SourceDeviationStats {
  roll: AxisDeviationStats;
  pitch: AxisDeviationStats;
  yaw: AxisDeviationStats;
}
