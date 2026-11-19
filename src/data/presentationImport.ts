import { parseAndValidateSixAxisCsv } from './sixAxisParser';
import type { WitMotionBinInspection } from './witMotionBin';
import type { SixAxisImportConfig } from '../types/sixAxis';

export function importPresentationCsv(text: string, filename: string, bin: WitMotionBinInspection | null = null) {
  const config: SixAxisImportConfig = {
    timeCol: '片上时间()', hostTimeCol: '时间',
    gxCol: '角速度X(°/s)', gyCol: '角速度Y(°/s)', gzCol: '角速度Z(°/s)',
    axCol: '加速度X(g)', ayCol: '加速度Y(g)', azCol: '加速度Z(g)',
    timeUnit: 'hms', gyroUnit: 'deg_s', accelUnit: 'g',
    gyroSigns: { x: 1, y: 1, z: 1 }, accelSigns: { x: 1, y: 1, z: 1 },
    timeBase: 'onchip_hms', confirmedPhysicalMeaning: true,
  };
  return parseAndValidateSixAxisCsv(text, filename, config, false, bin);
}
