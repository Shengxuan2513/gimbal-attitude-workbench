import { previewCsv } from './csvParser';
import type { SixAxisDataset } from '../types/sixAxis';

export interface SensorAttitude { rollDeg: number[]; pitchDeg: number[]; yawDeg: number[] }

export function readSensorAttitude(text: string, dataset: SixAxisDataset): SensorAttitude | null {
  const csv = previewCsv(text, Number.MAX_SAFE_INTEGER);
  const cols = ['角度X(°)', '角度Y(°)', '角度Z(°)'].map(h => csv.headers.indexOf(h));
  const timeCol = csv.headers.indexOf(dataset.importConfig.timeCol);
  if (cols.some(c => c < 0) || timeCol < 0 || csv.rows.length < dataset.times.length) return null;
  const values = [[], [], []] as number[][];
  for (let i = 0; i < dataset.times.length; i++) {
    if (csv.rows[i][timeCol] !== dataset.rawTimeStrings[i]) return null;
    for (let j = 0; j < 3; j++) {
      const raw = csv.rows[i][cols[j]];
      if (!raw?.trim() || !Number.isFinite(Number(raw))) return null;
      values[j].push(Number(raw));
    }
  }
  const yaw0 = values[2][0];
  return { rollDeg: values[0], pitchDeg: values[1], yawDeg: values[2].map(v => ((v - yaw0 + 180) % 360 + 360) % 360 - 180) };
}
