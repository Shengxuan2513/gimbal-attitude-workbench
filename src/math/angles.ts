import * as THREE from 'three';
import type { RotationOrder } from '../types/attitude';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD2DEG;
}

/**
 * Wrap angle in degrees to (-180, 180].
 */
export function wrapAngle180(deg: number): number {
  if (deg > -180 && deg <= 180) return deg;
  let d = (((deg + 180) % 360) + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Shortest signed periodic angular difference (a - b) in [-180, 180] degrees.
 * Avoids treating 179° -> -179° as a 358° jump.
 */
export function periodicAngleDiff(aDeg: number, bDeg: number): number {
  return ((((aDeg - bDeg + 180) % 360) + 360) % 360) - 180;
}

/**
 * Build an active 4x4 rotation matrix in the right-handed aerospace frame:
 * X forward, Y left, Z up.
 *
 * Angles passed here are ALREADY in the unified internal coordinate convention
 * (axis sign conversion is applied once at import time, never repeated here).
 *
 * For rotationOrder = 'ZYX': R = Rz(yaw) * Ry(pitch) * Rx(roll).
 */
export function buildActiveRotationMatrix(
  rollDeg: number,
  pitchDeg: number,
  yawDeg: number,
  order: RotationOrder
): THREE.Matrix4 {
  const rx = degToRad(rollDeg);
  const ry = degToRad(pitchDeg);
  const rz = degToRad(yawDeg);

  const Rx = new THREE.Matrix4().makeRotationX(rx);
  const Ry = new THREE.Matrix4().makeRotationY(ry);
  const Rz = new THREE.Matrix4().makeRotationZ(rz);

  const map: Record<'X' | 'Y' | 'Z', THREE.Matrix4> = {
    X: Rx,
    Y: Ry,
    Z: Rz,
  };

  const result = new THREE.Matrix4().identity();
  for (const ch of order) {
    result.multiply(map[ch as 'X' | 'Y' | 'Z']);
  }
  return result;
}

/**
 * Find the nearest sample index in a strictly increasing times array.
 * Ties break toward the earlier index.
 */
export function findNearestFrameIndex(times: number[], targetTime: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (targetTime <= times[0]) return 0;
  if (targetTime >= times[n - 1]) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= targetTime) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const distLo = Math.abs(targetTime - times[lo]);
  const distHi = Math.abs(times[hi] - targetTime);
  return distLo <= distHi ? lo : hi;
}
