import type { WitMotionBinInspection } from '../data/witMotionBin';
import type { RawSourceRecord } from './attitude';

export type SixAxisTimeUnit = 's' | 'ms' | 'hms';
export type GyroUnit = 'rad_s' | 'deg_s';
export type AccelUnit = 'm_s2' | 'g';
export type SixAxisTimeBase = 'onchip_hms' | 'device_sample' | 'host_rx' | 'unknown';

export interface AxisSigns3 {
  x: 1 | -1;
  y: 1 | -1;
  z: 1 | -1;
}

export interface SixAxisImportConfig {
  timeCol: string;
  /** Optional computer/host time column preserved for traceability (never used for deduplication) */
  hostTimeCol?: string;
  gxCol: string;
  gyCol: string;
  gzCol: string;
  axCol: string;
  ayCol: string;
  azCol: string;
  timeUnit: SixAxisTimeUnit | '';
  gyroUnit: GyroUnit | '';
  accelUnit: AccelUnit | '';
  gyroSigns: AxisSigns3;
  accelSigns: AxisSigns3;
  timeBase: SixAxisTimeBase;
  /** User explicitly confirms columns are body-frame angular rate & specific force (not rpm / linear accel / module attitude) */
  confirmedPhysicalMeaning: boolean;
}

export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
  std: number;
}

export interface SixAxisProgramChecks {
  totalCsvRows: number;
  validCompleteGroups: number;
  excludedCount: number;
  excludedReasons: string[];
  sampleCount: number;
  durationSec: number;
  dtMin: number;
  dtMed: number;
  dtMax: number;
  effectiveHz: number;
  gapCount: number;
  gapDetails: string[];
  midnightRolloverCount: number;
  duplicateHostTimeCount: number;
  allFinite: boolean;
  strictlyIncreasingTime: boolean;
  binVerified: boolean;
  timeSourceLabel: string;
  unconfirmedItems: string[];
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
  /** Seconds relative to first valid complete group (strictly increasing) */
  times: number[];
  /** Preserved raw primary time strings for traceability */
  rawTimeStrings: string[];
  /** Preserved raw computer/host time strings for traceability */
  rawHostTimeStrings: string[];
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
  binInspection: WitMotionBinInspection | null;
  programChecks: SixAxisProgramChecks;
}
