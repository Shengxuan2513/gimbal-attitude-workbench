/**
 * Independent interface for the full IMU Attitude EKF (quaternion nominal state + 6-DOF error/bias covariance).
 *
 * IMPORTANT:
 * - Nominal state uses a 4-element unit quaternion q = [w, x, y, z] + 3-axis gyro bias b_g.
 * - Error-state covariance is 6x6: [delta_theta (3), delta_b_g (3)] (never cramming quaternion into 6-dim state).
 * - Requires confirmed body-frame gyroscope, accelerometer, and magnetometer measurements.
 * - Must NOT be enabled with position-only logs, rpm, or differentiated angular velocity.
 */

export interface ImuEkfInput {
  times: number[];
  /** Body-frame angular rate [wx, wy, wz] in rad/s */
  gyroRadS?: Array<[number, number, number]>;
  /** Body-frame specific force [ax, ay, az] in m/s^2 */
  accelMS2?: Array<[number, number, number]>;
  /** Body-frame magnetic field [mx, my, mz] */
  mag?: Array<[number, number, number]>;
}

export interface ImuEkfAvailability {
  available: boolean;
  reason: string;
}

export interface ImuEkfOutput {
  quaternions: Array<[number, number, number, number]>;
  gyroBiasRadS: Array<[number, number, number]>;
  errorCovDiag6: Array<[number, number, number, number, number, number]>;
}

export interface ImuAttitudeEkf {
  id: string;
  name: string;
  checkAvailability(input: ImuEkfInput): ImuEkfAvailability;
  run(input: ImuEkfInput): ImuEkfOutput;
}

export const fullImuAttitudeEkfPlaceholder: ImuAttitudeEkf = {
  id: 'full_imu_attitude_ekf',
  name: '完整IMU姿态EKF（四元数名义状态 + 6维误差/零偏协方差）',
  checkAvailability(input: ImuEkfInput): ImuEkfAvailability {
    const hasGyro = Array.isArray(input.gyroRadS) && input.gyroRadS.length === input.times.length;
    const hasAccel = Array.isArray(input.accelMS2) && input.accelMS2.length === input.times.length;
    if (!hasGyro || !hasAccel) {
      return {
        available: false,
        reason:
          '当前数据缺少已确认的机体系陀螺仪、加速度计（及磁力计）原始观测，完整IMU姿态EKF接口已保留但不可用（禁止用rpm或角速度微分替代）。',
      };
    }
    return {
      available: false,
      reason: '完整IMU姿态EKF尚待确认四元数约定、机体系、零偏模型与噪声参数后再接入。',
    };
  },
  run(input: ImuEkfInput): ImuEkfOutput {
    const status = this.checkAvailability(input);
    throw new Error(status.reason);
  },
};
