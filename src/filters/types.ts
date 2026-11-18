export interface FilterInput {
  /** Strictly increasing timestamps in seconds relative to first frame */
  times: number[];
  /** Observed Roll angles in degrees */
  roll: number[];
  /** Observed Pitch angles in degrees */
  pitch: number[];
  /** Observed Yaw angles in degrees */
  yaw: number[];
}

export interface AxisFrameDiagnostic {
  /** Predicted angle wrapped to (-180, 180] deg */
  predicted: number;
  /** Shortest periodic innovation nu = wrapDiff(obs, pred) in deg */
  innovation: number;
  /** Dimensionless normalized residual e = nu / sqrt(S0) */
  normalizedResidual: number;
  /** Measurement weight w in (0, 1] (1 for standard KF; Huber w for robust KF) */
  weight: number;
  /** Effective observation variance R_eff = R / max(w, epsilon) in deg^2 */
  rEff: number;
  /** Posterior covariance diagonal [P_angle (deg^2), P_rate ((deg/s)^2)] */
  pDiag: [number, number];
  /** Whether posterior covariance passed symmetry check */
  covSymmetric: boolean;
  /** Whether posterior covariance passed positive semi-definiteness check */
  covPsd: boolean;
}

export interface FilterDiagnostics {
  roll: AxisFrameDiagnostic[];
  pitch: AxisFrameDiagnostic[];
  yaw: AxisFrameDiagnostic[];
}

export interface KfFilterOptions {
  /** CWNA process noise spectral density q in deg^2/s^3 (demo engineering value) */
  q?: number;
  /** Base observation variance R in deg^2 (demo engineering value) */
  r?: number;
  /** Huber normalized residual threshold mu, dimensionless (demo engineering value) */
  mu?: number;
  /** Numerical protection floor for weight denominator */
  epsilon?: number;
}

export interface FilterOutput {
  /** Estimated Roll angles in degrees */
  roll: number[];
  /** Estimated Pitch angles in degrees */
  pitch: number[];
  /** Estimated Yaw angles in degrees */
  yaw: number[];
  /** Optional per-frame measurement weights in [0, 1] */
  weights?: {
    roll: number[];
    pitch: number[];
    yaw: number[];
  };
  /** Optional per-frame KF/Huber diagnostics */
  diagnostics?: FilterDiagnostics;
  /** Human-readable active parameters */
  paramsSummary?: string;
}

export interface AttitudeFilter {
  id: string;
  name: string;
  shortName: string;
  category: 'standard' | 'robust';
  isDemo: boolean;
  description: string;
  run(input: FilterInput, options?: KfFilterOptions): FilterOutput;
}
