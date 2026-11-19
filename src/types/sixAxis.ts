import type { RawSourceRecord, TimeUnit } from './attitude';

export type GyroUnit = 'rad_s' | 'deg_s';
export type AccelUnit = 'm_s2' | 'g';
export type SixAxisTimeBase = 'device_sample' | 'host_rx' | 'unknown';

export interface AxisSigns3 {
  x: 1 | -1;
  y: 1 | -1;
  z: 1 | -1;
}

export interface SixAxisImportConfig {
  timeCol: string;
  gxCol: string;
  gyCol: string;
  gzCol: string;
  axCol: string;
  ayCol: string;
  azCol: string;
  timeUnit: TimeUnit | '';
  gyroUnit: GyroUnit | '';
  accelUnit: AccelUnit | '';
  gyroSigns: AxisSigns3;
  accelSigns: AxisSigns3;
  timeBase: SixAxisTimeBase;
  /** User explicitly confirms columns are body-frame angular rate & specific force (not rpm / linear accel) */
  confirmedPhysicalMeaning: boolean;
}

export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
  std: number;
}

export interface SixAxisProgramChecks {
  sampleCount: number;
  durationSec: number;
  dtMin: number;
  dtMed: number;
  dtMax: number;
  allFinite: boolean;
  strictlyIncreasingTime: boolean;
  accelNormMean: number;
  accelNormStd: number;
  accelNormMin: number;
  accelNormMax: number;
  channels: {
    gx: ChannelStats;
    gy: ChannelStats;
    gz: ChannelStats;
    ax: ChannelStats;
    ay: ChannelStats;
    az: ChannelStats;
  };
  summaryBadge: string;
}

export interface SixAxisDataset {
  id: string;
  filename: string;
  isSimulatedSample: boolean;
  sourceStatusLabel: string;
  /** Seconds relative to first frame (strictly increasing) */
  times: number[];
  /** Body-frame angular velocity in rad/s */
  gx: number[];
  gy: number[];
  gz: number[];
  /** Body-frame specific force in m/s^2 */
  ax: number[];
  ay: number[];
  az: number[];
  importConfig: SixAxisImportConfig;
  rawSource: RawSourceRecord;
  programChecks: SixAxisProgramChecks;
}
