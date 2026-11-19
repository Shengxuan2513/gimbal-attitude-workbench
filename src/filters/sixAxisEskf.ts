/**
 * Six-Axis Mag-Less Error-State Kalman Filter (ESKF)
 * Implements A0 (Standard 1-step ESKF) and A4 (Two-sided Whitened Huber IRLS ESKF)
 * strictly following docs/algorithm-six-axis.md:
 * - Nominal state: (q_bar [qw, qx, qy, qz] Hamilton scalar-first, b_g_bar [3] rad/s)
 * - Error state: 6-DOF right-multiplicative [delta_theta(3), delta_bg(3)]^T
 * - Observation: m = 3 body-frame specific force z = f_m^b (m/s^2), h(q) = -R(q)^T g^n
 * - Mag-less initialization: gravity tilt for Roll/Pitch, relative zero Yaw (psi_0 = 0)
 */

import { radToDeg } from '../math/angles';
import type { SixAxisDataset } from '../types/sixAxis';

export const GRAVITY_M_S2 = 9.80665;

export type SixAxisRunStatus = 'SIX_AXIS_NOMINAL' | 'PROPAGATE_ONLY_DYNAMIC_ACC';

export interface SixAxisEskfParams {
  /** Gyro white noise PSD S_g (rad^2/s) - uncalibrated provisional value */
  sg: number;
  /** Gyro bias random walk PSD S_bg (rad^2/s^3) - uncalibrated provisional value */
  sbg: number;
  /** Accelerometer specific force variance R_a ((m/s^2)^2) - uncalibrated provisional value */
  ra: number;
  /** Initial attitude error variance (rad^2) */
  p0Theta: number;
  /** Initial gyro bias error variance ((rad/s)^2) */
  p0Bg: number;
  /** State-side Huber threshold mu_x (dimensionless) */
  muX: number;
  /** Observation-side Huber threshold mu_y (dimensionless) */
  muY: number;
}

export const DEFAULT_SIX_AXIS_ESKF_PARAMS: SixAxisEskfParams = {
  sg: 1e-4,
  sbg: 1e-7,
  ra: 0.04,
  p0Theta: 0.02,
  p0Bg: 1e-4,
  muX: 2.0,
  muY: 2.0,
};

export interface SixAxisEskfResult {
  name: string;
  times: number[];
  rollDeg: number[];
  pitchDeg: number[];
  yawDeg: number[];
  quaternions: Array<[number, number, number, number]>;
  biasRadS: Array<[number, number, number]>;
  wyMean: number[];
  wxMean: number[];
  eyNorm: number[];
  iterations: number[];
  statuses: SixAxisRunStatus[];
  params: SixAxisEskfParams;
}

// ==================== Quaternion & SO(3) Helpers ====================

function qNormalize(q: [number, number, number, number]): [number, number, number, number] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-15) return [1, 0, 0, 0];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function qMul(
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function expQ(phi: [number, number, number]): [number, number, number, number] {
  const a = Math.hypot(phi[0], phi[1], phi[2]);
  if (a < 1e-8) {
    const a2 = a * a;
    const w = 1 - a2 / 8;
    const s = 0.5 - a2 / 48;
    return qNormalize([w, s * phi[0], s * phi[1], s * phi[2]]);
  }
  const half = 0.5 * a;
  const s = Math.sin(half) / a;
  return [Math.cos(half), s * phi[0], s * phi[1], s * phi[2]];
}

/** R(q): maps body vector b to navigation ENU vector n: v^n = R(q) v^b */
function qToMat3(q: [number, number, number, number]): number[][] {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/** ZYX Euler angles (deg) from R(q) = Rz(yaw) * Ry(pitch) * Rx(roll) */
function qToEulerZyxDeg(q: [number, number, number, number]): [number, number, number] {
  const R = qToMat3(q);
  const sinP = Math.max(-1, Math.min(1, -R[2][0]));
  const pitch = Math.asin(sinP);
  const roll = Math.atan2(R[2][1], R[2][2]);
  const yaw = Math.atan2(R[1][0], R[0][0]);
  return [radToDeg(roll), radToDeg(pitch), radToDeg(yaw)];
}

function eulerZyxRadToQ(roll: number, pitch: number, yaw: number): [number, number, number, number] {
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  return qNormalize([
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ]);
}

function skew(v: [number, number, number]): number[][] {
  return [
    [0, -v[2], v[1]],
    [v[2], 0, -v[0]],
    [-v[1], v[0], 0],
  ];
}

function expR(phi: [number, number, number]): number[][] {
  const a = Math.hypot(phi[0], phi[1], phi[2]);
  const K = skew(phi);
  const K2 = matMul(K, K);
  const c1 = a < 1e-6 ? 1 - (a * a) / 6 : Math.sin(a) / a;
  const c2 = a < 1e-6 ? 0.5 - (a * a) / 24 : (1 - Math.cos(a)) / (a * a);
  return [
    [1 + c1 * K[0][0] + c2 * K2[0][0], c1 * K[0][1] + c2 * K2[0][1], c1 * K[0][2] + c2 * K2[0][2]],
    [c1 * K[1][0] + c2 * K2[1][0], 1 + c1 * K[1][1] + c2 * K2[1][1], c1 * K[1][2] + c2 * K2[1][2]],
    [c1 * K[2][0] + c2 * K2[2][0], c1 * K[2][1] + c2 * K2[2][1], 1 + c1 * K[2][2] + c2 * K2[2][2]],
  ];
}

/** SO(3) right Jacobian J_r(phi) */
export function rightJacobianSO3(phi: [number, number, number]): number[][] {
  const a = Math.hypot(phi[0], phi[1], phi[2]);
  const K = skew(phi);
  const K2 = matMul(K, K);
  const c1 = a < 1e-6 ? 0.5 - (a * a) / 24 : (1 - Math.cos(a)) / (a * a);
  const c2 = a < 1e-6 ? 1 / 6 - (a * a) / 120 : (a - Math.sin(a)) / (a * a * a);
  return [
    [1 - c1 * K[0][0] + c2 * K2[0][0], -c1 * K[0][1] + c2 * K2[0][1], -c1 * K[0][2] + c2 * K2[0][2]],
    [-c1 * K[1][0] + c2 * K2[1][0], 1 - c1 * K[1][1] + c2 * K2[1][1], -c1 * K[1][2] + c2 * K2[1][2]],
    [-c1 * K[2][0] + c2 * K2[2][0], -c1 * K[2][1] + c2 * K2[2][1], 1 - c1 * K[2][2] + c2 * K2[2][2]],
  ];
}

// ==================== Small Dense Linear Algebra ====================

function zeros(r: number, c: number): number[][] {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

function eye(n: number): number[][] {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

function matMul(A: number[][], B: number[][]): number[][] {
  const r = A.length;
  const kLen = B.length;
  const c = B[0].length;
  const out = zeros(r, c);
  for (let i = 0; i < r; i++) {
    for (let k = 0; k < kLen; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < c; j++) {
        out[i][j] += aik * B[k][j];
      }
    }
  }
  return out;
}

function matTranspose(A: number[][]): number[][] {
  const r = A.length;
  const c = A[0].length;
  const out = zeros(c, r);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      out[j][i] = A[i][j];
    }
  }
  return out;
}

function matVec(A: number[][], v: number[]): number[] {
  return A.map((row) => row.reduce((acc, val, j) => acc + val * v[j], 0));
}

function symmetrize(P: number[][]): number[][] {
  const n = P.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[i][j] = 0.5 * (P[i][j] + P[j][i]);
    }
  }
  return out;
}

/** Lower-triangular Cholesky P = L L^T; returns null if not SPD */
function choleskyLower(A: number[][]): number[][] | null {
  const n = A.length;
  const L = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) {
        sum -= L[i][k] * L[j][k];
      }
      if (i === j) {
        if (!Number.isFinite(sum) || sum <= 1e-15) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

function solveLower(L: number[][], b: number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

function solveUpperFromLowerT(L: number[][], y: number[]): number[] {
  const n = L.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function solveSpdCholesky(A: number[][], b: number[]): number[] | null {
  const L = choleskyLower(symmetrize(A));
  if (!L) return null;
  return solveUpperFromLowerT(L, solveLower(L, b));
}

function invertSpdCholesky(A: number[][]): number[][] | null {
  const n = A.length;
  const L = choleskyLower(symmetrize(A));
  if (!L) return null;
  const inv = zeros(n, n);
  for (let col = 0; col < n; col++) {
    const e = new Array<number>(n).fill(0);
    e[col] = 1;
    const x = solveUpperFromLowerT(L, solveLower(L, e));
    for (let row = 0; row < n; row++) inv[row][col] = x[row];
  }
  return inv;
}

// ==================== Physics & Discretization ====================

/** Predicted specific force h(q) = -R(q)^T g^n with g^n = [0, 0, -g0]^T */
function predictAccel(q: [number, number, number, number]): [number, number, number] {
  const R = qToMat3(q);
  // -R^T * [0, 0, -g0]^T = +g0 * R^T[:, 2] = g0 * row 2 of R
  return [GRAVITY_M_S2 * R[2][0], GRAVITY_M_S2 * R[2][1], GRAVITY_M_S2 * R[2][2]];
}

function buildPhiAndQd(
  omegaHat: [number, number, number],
  dt: number,
  sg: number,
  sbg: number
): { phi: number[][]; qd: number[][] } {
  // Exact 1st-level state transition block:
  // Phi_11 = exp(-[omegaHat]_x * dt) = expR(-omegaHat * dt)
  const negOmegaDt: [number, number, number] = [
    -omegaHat[0] * dt,
    -omegaHat[1] * dt,
    -omegaHat[2] * dt,
  ];
  const phi11 = expR(negOmegaDt);
  // Phi_12 = -int_0^dt exp(-[omegaHat]_x * tau) dtau = -J_r(omegaHat * dt) * dt
  const Jr = rightJacobianSO3([omegaHat[0] * dt, omegaHat[1] * dt, omegaHat[2] * dt]);
  const phi = eye(6);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      phi[i][j] = phi11[i][j];
      phi[i][j + 3] = -Jr[i][j] * dt;
    }
  }

  // Qd = int_0^dt Phi(tau) Gc Qc Gc^T Phi(tau)^T dtau via 4-point Gauss-Legendre quadrature
  // Qc = diag(sg*I3, sbg*I3) in R^{6x6}
  const glNodes = [
    -0.8611363115940526,
    -0.3399810435848563,
    0.3399810435848563,
    0.8611363115940526,
  ];
  const glWeights = [
    0.3478548451374538,
    0.6521451548625461,
    0.6521451548625461,
    0.3478548451374538,
  ];

  const qd = zeros(6, 6);
  for (let g = 0; g < 4; g++) {
    const tau = 0.5 * dt * (glNodes[g] + 1);
    const w = 0.5 * dt * glWeights[g];
    const jrTau = rightJacobianSO3([omegaHat[0] * tau, omegaHat[1] * tau, omegaHat[2] * tau]);
    // Phi(tau) * Gc = [[-Phi_11(tau), -Jr(tau)*tau], [0, I3]]
    // Since Phi_11(tau) is orthogonal, Phi_11 * sg * I * Phi_11^T = sg * I
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let jr2 = 0;
        for (let k = 0; k < 3; k++) jr2 += jrTau[i][k] * jrTau[j][k];
        qd[i][j] += w * ((i === j ? sg : 0) + sbg * tau * tau * jr2);
        qd[i][j + 3] += w * (-sbg * tau * jrTau[i][j]);
        qd[j + 3][i] += w * (-sbg * tau * jrTau[i][j]);
      }
      qd[i + 3][i + 3] += w * sbg;
    }
  }
  return { phi, qd: symmetrize(qd) };
}

/** Mag-less stationary tilt initialization (Yaw = 0 relative zero) */
export function initializeSixAxisFromTilt(
  ax: number[],
  ay: number[],
  az: number[],
  times: number[]
): [number, number, number, number] {
  let count = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < times.length && count < 50 && times[i] <= 0.5; i++) {
    sx += ax[i];
    sy += ay[i];
    sz += az[i];
    count++;
  }
  if (count === 0) {
    sx = ax[0];
    sy = ay[0];
    sz = az[0];
    count = 1;
  }
  const fx = sx / count;
  const fy = sy / count;
  const fz = sz / count;
  const roll0 = Math.atan2(fy, fz);
  const pitch0 = Math.atan2(-fx, Math.hypot(fy, fz));
  return eulerZyxRadToQ(roll0, pitch0, 0.0);
}

function huberLoss(e: number, mu: number): number {
  const ae = Math.abs(e);
  return ae <= mu ? 0.5 * e * e : mu * ae - 0.5 * mu * mu;
}

function huberWeight(e: number, mu: number): number {
  const ae = Math.abs(e);
  if (ae <= mu || ae === 0) return 1.0;
  return mu / ae;
}

// ==================== A0 Standard 1-Step ESKF & A4 Two-Sided Huber ESKF ====================

function runSixAxisEskfCore(
  dataset: SixAxisDataset,
  useHuber: boolean,
  params: SixAxisEskfParams
): SixAxisEskfResult {
  const { times, gx, gy, gz, ax, ay, az } = dataset;
  const n = times.length;

  const rollDeg = new Array<number>(n);
  const pitchDeg = new Array<number>(n);
  const yawDeg = new Array<number>(n);
  const quaternions = new Array<[number, number, number, number]>(n);
  const biasRadS = new Array<[number, number, number]>(n);
  const wyMean = new Array<number>(n).fill(1);
  const wxMean = new Array<number>(n).fill(1);
  const eyNorm = new Array<number>(n).fill(0);
  const iterations = new Array<number>(n).fill(1);
  const statuses = new Array<SixAxisRunStatus>(n).fill('SIX_AXIS_NOMINAL');

  if (n === 0) {
    return {
      name: useHuber ? '双侧白化Huber六轴ESKF（A4）' : '标准六轴ESKF（A0对照）',
      times: [],
      rollDeg,
      pitchDeg,
      yawDeg,
      quaternions,
      biasRadS,
      wyMean,
      wxMean,
      eyNorm,
      iterations,
      statuses,
      params,
    };
  }

  let qBar = initializeSixAxisFromTilt(ax, ay, az, times);
  let bgBar: [number, number, number] = [0, 0, 0];
  let P = zeros(6, 6);
  for (let i = 0; i < 3; i++) {
    P[i][i] = params.p0Theta;
    P[i + 3][i + 3] = params.p0Bg;
  }

  const Ra = zeros(3, 3);
  Ra[0][0] = params.ra;
  Ra[1][1] = params.ra;
  Ra[2][2] = params.ra;
  const Lr = choleskyLower(Ra)!;

  for (let k = 0; k < n; k++) {
    let qPred = qBar;
    let bgPred = bgBar;
    let PPred = P;

    if (k > 0) {
      const dt = times[k] - times[k - 1];
      const omegaHat: [number, number, number] = [
        gx[k] - bgBar[0],
        gy[k] - bgBar[1],
        gz[k] - bgBar[2],
      ];
      qPred = qNormalize(qMul(qBar, expQ([omegaHat[0] * dt, omegaHat[1] * dt, omegaHat[2] * dt])));
      bgPred = [bgBar[0], bgBar[1], bgBar[2]];
      const { phi, qd } = buildPhiAndQd(omegaHat, dt, params.sg, params.sbg);
      PPred = symmetrize(matMul(matMul(phi, P), matTranspose(phi)));
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) PPred[i][j] += qd[i][j];
      }
    }

    const z: [number, number, number] = [ax[k], ay[k], az[k]];

    if (!useHuber) {
      // A0: Standard 1-step ESKF
      const h0 = predictAccel(qPred);
      const nu = [z[0] - h0[0], z[1] - h0[1], z[2] - h0[2]];
      const H0 = zeros(3, 6);
      const hx = skew(h0);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) H0[i][j] = hx[i][j];
      }

      const HP = matMul(H0, PPred);
      const S = symmetrize(matMul(HP, matTranspose(H0)));
      for (let i = 0; i < 3; i++) S[i][i] += params.ra;

      // Solve S * K^T = H0 * PPred
      const KT: number[][] = zeros(3, 6);
      let solveOk = true;
      for (let col = 0; col < 6; col++) {
        const rhs = [HP[0][col], HP[1][col], HP[2][col]];
        const sol = solveSpdCholesky(S, rhs);
        if (!sol) {
          solveOk = false;
          break;
        }
        KT[0][col] = sol[0];
        KT[1][col] = sol[1];
        KT[2][col] = sol[2];
      }

      const ey = solveLower(Lr, nu);
      eyNorm[k] = Math.hypot(ey[0], ey[1], ey[2]);

      if (!solveOk) {
        qBar = qPred;
        bgBar = bgPred;
        P = PPred;
        statuses[k] = 'PROPAGATE_ONLY_DYNAMIC_ACC';
      } else {
        const K = matTranspose(KT);
        const dx = matVec(K, nu);
        const dTheta: [number, number, number] = [dx[0], dx[1], dx[2]];
        const I6 = eye(6);
        const KH = matMul(K, H0);
        const A = zeros(6, 6);
        for (let i = 0; i < 6; i++) {
          for (let j = 0; j < 6; j++) A[i][j] = I6[i][j] - KH[i][j];
        }
        const PDelta = symmetrize(
          matMul(matMul(A, PPred), matTranspose(A))
        );
        const KRKT = matMul(matMul(K, Ra), KT);
        for (let i = 0; i < 6; i++) {
          for (let j = 0; j < 6; j++) PDelta[i][j] += KRKT[i][j];
        }

        qBar = qNormalize(qMul(qPred, expQ(dTheta)));
        bgBar = [bgPred[0] + dx[3], bgPred[1] + dx[4], bgPred[2] + dx[5]];

        const T = eye(6);
        const Jr = rightJacobianSO3(dTheta);
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) T[i][j] = Jr[i][j];
        }
        P = symmetrize(matMul(matMul(T, PDelta), matTranspose(T)));
      }
    } else {
      // A4: Two-sided whitened Huber IRLS in fixed prior tangent space
      const Lp = choleskyLower(PPred);
      if (!Lp) {
        qBar = qPred;
        bgBar = bgPred;
        P = PPred;
        statuses[k] = 'PROPAGATE_ONLY_DYNAMIC_ACC';
      } else {
        let xi = [0, 0, 0, 0, 0, 0];
        let iterUsed = 0;
        let failed = false;
        let lastWx = [1, 1, 1, 1, 1, 1];
        let lastWy = [1, 1, 1];
        let lastEy = [0, 0, 0];
        let finalA = zeros(6, 6);
        let finalB = zeros(3, 3);
        let finalH = zeros(3, 6);

        const evalState = (xiVec: number[]) => {
          const phi: [number, number, number] = [xiVec[0], xiVec[1], xiVec[2]];
          const q = qNormalize(qMul(qPred, expQ(phi)));
          const hq = predictAccel(q);
          const r = [z[0] - hq[0], z[1] - hq[1], z[2] - hq[2]];
          const ex = solveLower(Lp, xiVec);
          const ey = solveLower(Lr, r);
          let J = 0;
          const wx = ex.map((v) => {
            J += huberLoss(v, params.muX);
            return huberWeight(v, params.muX);
          });
          const wy = ey.map((v) => {
            J += huberLoss(v, params.muY);
            return huberWeight(v, params.muY);
          });
          return { phi, q, hq, r, ex, ey, wx, wy, J };
        };

        for (let it = 0; it < 15; it++) {
          iterUsed = it + 1;
          const st = evalState(xi);
          lastWx = st.wx;
          lastWy = st.wy;
          lastEy = st.ey;

          const Jr = rightJacobianSO3(st.phi);
          const H = zeros(3, 6);
          const hxJr = matMul(skew(st.hq), Jr);
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) H[i][j] = hxJr[i][j];
          }

          // A = Lp^-T * diag(wx) * Lp^-1, B = Lr^-T * diag(wy) * Lr^-1
          // Compute Lp^-1 columns: solve Lp * col = e_j
          const LpInv = zeros(6, 6);
          for (let col = 0; col < 6; col++) {
            const e = new Array<number>(6).fill(0);
            e[col] = 1;
            const c = solveLower(Lp, e);
            for (let row = 0; row < 6; row++) LpInv[row][col] = c[row];
          }
          const WxLpInv = zeros(6, 6);
          for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) WxLpInv[i][j] = st.wx[i] * LpInv[i][j];
          }
          const A = symmetrize(matMul(matTranspose(LpInv), WxLpInv));

          const LrInv = zeros(3, 3);
          for (let col = 0; col < 3; col++) {
            const e = [0, 0, 0];
            e[col] = 1;
            const c = solveLower(Lr, e);
            for (let row = 0; row < 3; row++) LrInv[row][col] = c[row];
          }
          const WyLrInv = zeros(3, 3);
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) WyLrInv[i][j] = st.wy[i] * LrInv[i][j];
          }
          const B = symmetrize(matMul(matTranspose(LrInv), WyLrInv));

          finalA = A;
          finalB = B;
          finalH = H;

          const HT = matTranspose(H);
          const HTB = matMul(HT, B);
          const HTBH = matMul(HTB, H);
          const LHS = zeros(6, 6);
          for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) LHS[i][j] = A[i][j] + HTBH[i][j];
          }

          const HTBr = matVec(HTB, st.r);
          const Axi = matVec(A, xi);
          const rhs = HTBr.map((v, i) => v - Axi[i]);
          const grad = Axi.map((v, i) => v - HTBr[i]);

          const eta = solveSpdCholesky(LHS, rhs);
          if (!eta || eta.some((v) => !Number.isFinite(v))) {
            failed = true;
            break;
          }

          const etaThetaNorm = Math.hypot(eta[0], eta[1], eta[2]);
          if (etaThetaNorm < 1e-9 && Math.hypot(eta[3], eta[4], eta[5]) < 1e-10) {
            break;
          }

          let s = etaThetaNorm > 0.1 ? 0.1 / etaThetaNorm : 1.0;
          const dirDeriv = grad.reduce((acc, g, i) => acc + g * eta[i], 0);
          let accepted = false;
          let nextXi = xi;
          let nextJ = st.J;

          for (let bt = 0; bt < 12; bt++) {
            const cand = xi.map((v, i) => v + s * eta[i]);
            const candSt = evalState(cand);
            if (Number.isFinite(candSt.J) && candSt.J <= st.J + 1e-4 * s * dirDeriv) {
              nextXi = cand;
              nextJ = candSt.J;
              accepted = true;
              break;
            }
            s *= 0.5;
          }

          if (!accepted) {
            failed = true;
            break;
          }

          const dPhi = Math.hypot(nextXi[0] - xi[0], nextXi[1] - xi[1], nextXi[2] - xi[2]);
          const dBeta = Math.hypot(nextXi[3] - xi[3], nextXi[4] - xi[4], nextXi[5] - xi[5]);
          const relJ = Math.abs(st.J - nextJ) / Math.max(1, st.J);
          xi = nextXi;

          // Local domain guard: 30 deg = pi/6 rad
          if (Math.hypot(xi[0], xi[1], xi[2]) > Math.PI / 6) {
            failed = true;
            break;
          }

          if (dPhi < 1e-7 && dBeta < 1e-8 && relJ <= 1e-6) {
            break;
          }
        }

        iterations[k] = iterUsed;
        eyNorm[k] = Math.hypot(lastEy[0], lastEy[1], lastEy[2]);

        if (failed) {
          qBar = qPred;
          bgBar = bgPred;
          P = PPred;
          statuses[k] = 'PROPAGATE_ONLY_DYNAMIC_ACC';
        } else {
          const phiStar: [number, number, number] = [xi[0], xi[1], xi[2]];
          qBar = qNormalize(qMul(qPred, expQ(phiStar)));
          bgBar = [bgPred[0] + xi[3], bgPred[1] + xi[4], bgPred[2] + xi[5]];

          const HT = matTranspose(finalH);
          const HInfo = symmetrize(matMul(matMul(HT, finalB), finalH));
          for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) HInfo[i][j] += finalA[i][j];
          }
          const Cxi = invertSpdCholesky(HInfo);
          if (!Cxi) {
            qBar = qPred;
            bgBar = bgPred;
            P = PPred;
            statuses[k] = 'PROPAGATE_ONLY_DYNAMIC_ACC';
          } else {
            const T = eye(6);
            const JrStar = rightJacobianSO3(phiStar);
            for (let i = 0; i < 3; i++) {
              for (let j = 0; j < 3; j++) T[i][j] = JrStar[i][j];
            }
            P = symmetrize(matMul(matMul(T, Cxi), matTranspose(T)));
            wxMean[k] = lastWx.reduce((a, b) => a + b, 0) / lastWx.length;
            wyMean[k] = lastWy.reduce((a, b) => a + b, 0) / lastWy.length;
          }
        }
      }
    }

    const [rD, pD, yD] = qToEulerZyxDeg(qBar);
    rollDeg[k] = rD;
    pitchDeg[k] = pD;
    yawDeg[k] = yD;
    quaternions[k] = qBar;
    biasRadS[k] = bgBar;
  }

  return {
    name: useHuber ? '双侧白化Huber六轴ESKF（A4）' : '标准六轴ESKF（A0对照）',
    times: [...times],
    rollDeg,
    pitchDeg,
    yawDeg,
    quaternions,
    biasRadS,
    wyMean,
    wxMean,
    eyNorm,
    iterations,
    statuses,
    params,
  };
}

export function runStandardSixAxisEskf(
  dataset: SixAxisDataset,
  params: SixAxisEskfParams = DEFAULT_SIX_AXIS_ESKF_PARAMS
): SixAxisEskfResult {
  return runSixAxisEskfCore(dataset, false, params);
}

export function runHuberSixAxisEskf(
  dataset: SixAxisDataset,
  params: SixAxisEskfParams = DEFAULT_SIX_AXIS_ESKF_PARAMS
): SixAxisEskfResult {
  return runSixAxisEskfCore(dataset, true, params);
}

export function buildSixAxisEskfComparisonCsv(
  dataset: SixAxisDataset,
  a0: SixAxisEskfResult,
  a4: SixAxisEskfResult
): string {
  const lines = [
    `# source: ${dataset.filename} | ${dataset.sourceStatusLabel}`,
    `# params: sg=${a4.params.sg}, sbg=${a4.params.sbg}, ra=${a4.params.ra}, mu_x=${a4.params.muX}, mu_y=${a4.params.muY} (provisional uncalibrated values)`,
    '# note: Yaw is relative to initial zero reference and drifts without magnetometer; no independent ground truth',
    'frame_idx,time_s,a0_roll_deg,a0_pitch_deg,a0_yaw_deg,a4_roll_deg,a4_pitch_deg,a4_yaw_deg,a4_wy_mean,a4_wx_mean,a4_ey_norm,a4_iters,a4_status',
  ];
  for (let i = 0; i < dataset.times.length; i++) {
    lines.push(
      [
        i + 1,
        dataset.times[i].toFixed(6),
        a0.rollDeg[i].toFixed(4),
        a0.pitchDeg[i].toFixed(4),
        a0.yawDeg[i].toFixed(4),
        a4.rollDeg[i].toFixed(4),
        a4.pitchDeg[i].toFixed(4),
        a4.yawDeg[i].toFixed(4),
        a4.wyMean[i].toFixed(4),
        a4.wxMean[i].toFixed(4),
        a4.eyNorm[i].toFixed(4),
        a4.iterations[i],
        a4.statuses[i],
      ].join(',')
    );
  }
  return lines.join('\n');
}
