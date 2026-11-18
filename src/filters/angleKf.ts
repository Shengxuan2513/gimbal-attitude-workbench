import { periodicAngleDiff, wrapAngle180 } from '../math/angles';
import type {
  AttitudeFilter,
  AxisFrameDiagnostic,
  FilterInput,
  FilterOutput,
  KfFilterOptions,
} from './types';

export const DEFAULT_KF_PARAMS = {
  /** CWNA process noise spectral density (deg^2/s^3) - demo selection */
  q: 40.0,
  /** Base observation variance (deg^2, sigma = 1.5 deg) - demo selection */
  r: 2.25,
  /** Initial state covariance diagonal [angle deg^2, rate (deg/s)^2] - demo selection */
  p0Angle: 4.0,
  p0Rate: 100.0,
  /** Huber dimensionless threshold mu - demo selection */
  mu: 2.0,
  /** Numerical protection floor */
  epsilon: 1e-6,
};

interface AxisKfResult {
  estimates: number[];
  weights: number[];
  diagnostics: AxisFrameDiagnostic[];
}

function runAxisAngleKf(
  times: number[],
  obsDeg: number[],
  useHuber: boolean,
  opts: Required<KfFilterOptions>
): AxisKfResult {
  const n = times.length;
  const estimates = new Array<number>(n);
  const weights = new Array<number>(n);
  const diagnostics = new Array<AxisFrameDiagnostic>(n);

  if (n === 0) {
    return { estimates, weights, diagnostics };
  }

  // Initial state x = [angle_deg, rate_deg_per_s]^T
  let x0 = obsDeg[0];
  let x1 = 0;

  // Initial covariance P0 = diag([p0Angle, p0Rate])
  let p00 = DEFAULT_KF_PARAMS.p0Angle;
  let p01 = 0;
  let p10 = 0;
  let p11 = DEFAULT_KF_PARAMS.p0Rate;

  const { q, r, mu, epsilon } = opts;

  for (let k = 0; k < n; k++) {
    let xPred0: number;
    let xPred1: number;
    let pp00: number;
    let pp01: number;
    let pp10: number;
    let pp11: number;

    if (k === 0) {
      xPred0 = x0;
      xPred1 = x1;
      pp00 = p00;
      pp01 = p01;
      pp10 = p10;
      pp11 = p11;
    } else {
      const dt = times[k] - times[k - 1];
      if (!Number.isFinite(dt) || dt <= 0) {
        throw new Error(`KF 递推检测到非正时间步长 dt=${dt}（第 ${k + 1} 帧）`);
      }

      // State prediction: x_pred = F(dt) * x
      xPred0 = x0 + dt * x1;
      xPred1 = x1;

      // Covariance prediction: P_pred = F(dt) * P * F(dt)^T + Q(dt)
      const fp00 = p00 + dt * p10;
      const fp01 = p01 + dt * p11;
      const fp10 = p10;
      const fp11 = p11;

      const dt2 = dt * dt;
      const dt3 = dt2 * dt;
      const q00 = (q * dt3) / 3;
      const q01 = (q * dt2) / 2;
      const q11 = q * dt;

      pp00 = fp00 + fp01 * dt + q00;
      pp01 = fp01 + q01;
      pp10 = fp10 + fp11 * dt + q01;
      pp11 = fp11 + q11;
    }

    // Shortest periodic innovation: nu = wrapDiff(y_k, x_pred[0])
    const nu = periodicAngleDiff(obsDeg[k], xPred0);

    // Base innovation variance S0 = H * P_pred * H^T + R = pp00 + R
    const s0 = pp00 + r;
    const e = s0 > 0 ? nu / Math.sqrt(s0) : 0;
    const absE = Math.abs(e);

    // Huber weight (exact paper rule: w = 1 if |e| <= mu or e == 0, else mu / |e|)
    let w = 1.0;
    if (useHuber && absE > mu) {
      w = mu / absE;
    }

    // Observation-only downweighting (Psi_x = I): R_eff = R / max(w, epsilon)
    const rEff = r / Math.max(w, epsilon);

    // Kalman gain with R_eff: S = pp00 + R_eff, K = P_pred * H^T / S
    const sEff = pp00 + rEff;
    const k0 = pp00 / sEff;
    const k1 = pp10 / sEff;

    // State update (maintain continuous internal angle)
    x0 = xPred0 + k0 * nu;
    x1 = xPred1 + k1 * nu;

    // Joseph-form covariance update: P = (I - K*H)*P_pred*(I - K*H)^T + K*R_eff*K^T
    // A = I - K*H = [[1 - k0, 0], [-k1, 1]]
    const a00 = 1 - k0;
    const a10 = -k1;

    // A * P_pred
    const ap00 = a00 * pp00;
    const ap01 = a00 * pp01;
    const ap10 = a10 * pp00 + pp10;
    const ap11 = a10 * pp01 + pp11;

    // (A * P_pred) * A^T + K * R_eff * K^T
    let u00 = ap00 * a00 + k0 * rEff * k0;
    let u01 = ap00 * a10 + ap01 + k0 * rEff * k1;
    let u10 = ap10 * a00 + k1 * rEff * k0;
    let u11 = ap10 * a10 + ap11 + k1 * rEff * k1;

    const symErr = Math.abs(u01 - u10);
    const covSymmetric = Number.isFinite(symErr) && symErr <= 1e-9;

    // Symmetrize
    const sym01 = 0.5 * (u01 + u10);
    p00 = u00;
    p01 = sym01;
    p10 = sym01;
    p11 = u11;

    // Positive semi-definiteness check for 2x2 symmetric matrix
    const det = p00 * p11 - sym01 * sym01;
    const covPsd =
      Number.isFinite(p00) &&
      Number.isFinite(p11) &&
      Number.isFinite(sym01) &&
      p00 >= -1e-12 &&
      p11 >= -1e-12 &&
      det >= -1e-10;

    estimates[k] = wrapAngle180(x0);
    weights[k] = w;
    diagnostics[k] = {
      predicted: wrapAngle180(xPred0),
      innovation: nu,
      normalizedResidual: e,
      weight: w,
      rEff,
      pDiag: [p00, p11],
      covSymmetric,
      covPsd,
    };
  }

  return { estimates, weights, diagnostics };
}

function resolveOptions(options?: KfFilterOptions): Required<KfFilterOptions> {
  return {
    q: options?.q ?? DEFAULT_KF_PARAMS.q,
    r: options?.r ?? DEFAULT_KF_PARAMS.r,
    mu: options?.mu ?? DEFAULT_KF_PARAMS.mu,
    epsilon: options?.epsilon ?? DEFAULT_KF_PARAMS.epsilon,
  };
}

export const standardAngleKfFilter: AttitudeFilter = {
  id: 'kf_standard_demo',
  name: '标准角度KF（简化演示）',
  shortName: '标准角度KF(演示)',
  category: 'standard',
  isDemo: true,
  description:
    '每轴独立状态 x=[θ, ω]^T、CWNA 离散过程噪声 Q(dt)、真实 dt 递推与 Joseph 协方差更新（简化演示）。',
  run(input: FilterInput, options?: KfFilterOptions): FilterOutput {
    const opts = resolveOptions(options);
    const rRes = runAxisAngleKf(input.times, input.roll, false, opts);
    const pRes = runAxisAngleKf(input.times, input.pitch, false, opts);
    const yRes = runAxisAngleKf(input.times, input.yaw, false, opts);

    return {
      roll: rRes.estimates,
      pitch: pRes.estimates,
      yaw: yRes.estimates,
      weights: {
        roll: rRes.weights,
        pitch: pRes.weights,
        yaw: yRes.weights,
      },
      diagnostics: {
        roll: rRes.diagnostics,
        pitch: pRes.diagnostics,
        yaw: yRes.diagnostics,
      },
      paramsSummary: `演示选值: q=${opts.q}, R=${opts.r}, P0=diag(${DEFAULT_KF_PARAMS.p0Angle},${DEFAULT_KF_PARAMS.p0Rate})`,
    };
  },
};

export const huberAngleKfFilter: AttitudeFilter = {
  id: 'kf_huber_demo',
  name: 'Huber鲁棒角度KF（简化演示）',
  shortName: 'Huber角度KF(演示)',
  category: 'robust',
  isDemo: true,
  description:
    '参考文档的简化实现（仅观测降权 Ψx=I）：基于归一化创新 e=ν/√S0 与 Huber 权重 w=min(1, μ/|e|) 调整 R_eff=R/max(w,ε) 并用 Joseph 形式更新。',
  run(input: FilterInput, options?: KfFilterOptions): FilterOutput {
    const opts = resolveOptions(options);
    const rRes = runAxisAngleKf(input.times, input.roll, true, opts);
    const pRes = runAxisAngleKf(input.times, input.pitch, true, opts);
    const yRes = runAxisAngleKf(input.times, input.yaw, true, opts);

    return {
      roll: rRes.estimates,
      pitch: pRes.estimates,
      yaw: yRes.estimates,
      weights: {
        roll: rRes.weights,
        pitch: pRes.weights,
        yaw: yRes.weights,
      },
      diagnostics: {
        roll: rRes.diagnostics,
        pitch: pRes.diagnostics,
        yaw: yRes.diagnostics,
      },
      paramsSummary: `参考文档简化实现(Ψx=I) · 演示选值: μ=${opts.mu.toFixed(2)}, q=${opts.q}, R=${opts.r}, ε=${opts.epsilon}`,
    };
  },
};
