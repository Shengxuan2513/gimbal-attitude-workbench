import { degToRad } from '../math/angles';
import type { ChannelStats, SixAxisDataset, SixAxisImportConfig, SixAxisProgramChecks } from '../types/sixAxis';
import { previewCsv } from './csvParser';

export const STANDARD_GRAVITY_M_S2 = 9.80665;

export const SIX_AXIS_TEMPLATE_CSV = [
  'time_s,gx_rad_s,gy_rad_s,gz_rad_s,ax_m_s2,ay_m_s2,az_m_s2',
  '0.000,0.000000,0.000000,0.000000,0.000000,0.000000,9.806650',
  '0.020,0.000000,0.000000,0.000000,0.000000,0.000000,9.806650',
  '0.040,0.000000,0.000000,0.000000,0.000000,0.000000,9.806650',
].join('\n');

export interface SixAxisMappingStatus {
  complete: boolean;
  missingItems: string[];
  message: string;
}

export interface SixAxisParseSuccess {
  ok: true;
  dataset: SixAxisDataset;
}

export interface SixAxisParseError {
  ok: false;
  errors: string[];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitLines(text: string): { lineNum: number; raw: string }[] {
  const clean = stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.map((raw, idx) => ({ lineNum: idx + 1, raw }));
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

const EXCLUDE_SIX_AXIS_RE = /(rpm|pos|position|angle|roll|pitch|yaw|deg_s2|linear|lin_acc|位置|角度|转速)/i;

export function guessSixAxisMapping(headers: string[]): Partial<SixAxisImportConfig> {
  const findCol = (patterns: RegExp[], excludeNonImu = false): string => {
    const candidates = excludeNonImu
      ? headers.filter((h) => !EXCLUDE_SIX_AXIS_RE.test(h))
      : headers;
    for (const p of patterns) {
      const hit = candidates.find((h) => p.test(h));
      if (hit) return hit;
    }
    return '';
  };

  const timeCol = findCol([/^time/i, /^t(_|$)/i, /^ts(_|$)/i, /elapsed/i, /timestamp/i, /时间/]);
  const gxCol = findCol([/^gx(_|$)/i, /gyro_?x/i, /wx(_|$)/i, /omega_?x/i], true);
  const gyCol = findCol([/^gy(_|$)/i, /gyro_?y/i, /wy(_|$)/i, /omega_?y/i], true);
  const gzCol = findCol([/^gz(_|$)/i, /gyro_?z/i, /wz(_|$)/i, /omega_?z/i], true);
  const axCol = findCol([/^ax(_|$)/i, /acc(el)?_?x/i, /^fx(_|$)/i], true);
  const ayCol = findCol([/^ay(_|$)/i, /acc(el)?_?y/i, /^fy(_|$)/i], true);
  const azCol = findCol([/^az(_|$)/i, /acc(el)?_?z/i, /^fz(_|$)/i], true);

  let timeUnit: SixAxisImportConfig['timeUnit'] = '';
  if (/ms/i.test(timeCol)) timeUnit = 'ms';
  else if (/(_s$|^time_s$|^t_s$)/i.test(timeCol)) timeUnit = 's';

  const gyroJoined = `${gxCol} ${gyCol} ${gzCol}`;
  let gyroUnit: SixAxisImportConfig['gyroUnit'] = '';
  if (/rad/i.test(gyroJoined)) gyroUnit = 'rad_s';
  else if (/deg/i.test(gyroJoined)) gyroUnit = 'deg_s';

  const accelJoined = `${axCol} ${ayCol} ${azCol}`;
  let accelUnit: SixAxisImportConfig['accelUnit'] = '';
  if (/m_?s2|mps2/i.test(accelJoined)) accelUnit = 'm_s2';
  else if (/(_g$|\bg\b)/i.test(accelJoined)) accelUnit = 'g';

  return {
    timeCol,
    gxCol,
    gyCol,
    gzCol,
    axCol,
    ayCol,
    azCol,
    timeUnit,
    gyroUnit,
    accelUnit,
  };
}

export function evaluateSixAxisCompleteness(
  hasHeaders: boolean,
  config: Pick<
    SixAxisImportConfig,
    | 'timeCol'
    | 'gxCol'
    | 'gyCol'
    | 'gzCol'
    | 'axCol'
    | 'ayCol'
    | 'azCol'
    | 'timeUnit'
    | 'gyroUnit'
    | 'accelUnit'
    | 'confirmedPhysicalMeaning'
  >
): SixAxisMappingStatus {
  if (!hasHeaders) {
    return { complete: false, missingItems: [], message: '' };
  }

  const missingItems: string[] = [];
  if (!config.timeCol) missingItems.push('时间列');
  if (!config.gxCol) missingItems.push('gx 列');
  if (!config.gyCol) missingItems.push('gy 列');
  if (!config.gzCol) missingItems.push('gz 列');
  if (!config.axCol) missingItems.push('ax 列');
  if (!config.ayCol) missingItems.push('ay 列');
  if (!config.azCol) missingItems.push('az 列');
  if (!config.timeUnit) missingItems.push('时间单位');
  if (!config.gyroUnit) missingItems.push('角速度单位');
  if (!config.accelUnit) missingItems.push('比力单位');
  if (!config.confirmedPhysicalMeaning) missingItems.push('物理含义确认勾选');

  if (missingItems.length > 0) {
    return {
      complete: false,
      missingItems,
      message: `请先完成六轴必要配置：缺少 ${missingItems.join('、')}。`,
    };
  }
  return { complete: true, missingItems: [], message: '' };
}

function calcChannelStats(arr: number[]): ChannelStats {
  const n = arr.length;
  if (n === 0) return { min: 0, max: 0, mean: 0, std: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    sumSq += d * d;
  }
  return { min, max, mean, std: Math.sqrt(sumSq / n) };
}

export function parseAndValidateSixAxisCsv(
  text: string,
  filename: string,
  config: SixAxisImportConfig,
  isSimulatedSample = false
): SixAxisParseSuccess | SixAxisParseError {
  const lines = splitLines(text);
  if (lines.length < 2) {
    return {
      ok: false,
      errors: ['六轴 CSV 文件至少需要包含 1 行表头和 1 行数据。'],
    };
  }

  const completeness = evaluateSixAxisCompleteness(true, config);
  if (!completeness.complete) {
    return {
      ok: false,
      errors: [completeness.message],
    };
  }

  const headers = parseCsvLine(lines[0].raw);
  const colEntries: Array<{ key: string; col: string }> = [
    { key: '时间列', col: config.timeCol },
    { key: 'gx 列', col: config.gxCol },
    { key: 'gy 列', col: config.gyCol },
    { key: 'gz 列', col: config.gzCol },
    { key: 'ax 列', col: config.axCol },
    { key: 'ay 列', col: config.ayCol },
    { key: 'az 列', col: config.azCol },
  ];

  const indices: number[] = [];
  const missingCols: string[] = [];
  for (const item of colEntries) {
    const idx = headers.indexOf(item.col);
    if (idx < 0) missingCols.push(`${item.key} "${item.col}"`);
    indices.push(idx);
  }
  if (missingCols.length > 0) {
    return {
      ok: false,
      errors: [`第 1 行表头未找到映射列：${missingCols.join('、')}。`],
    };
  }

  const [timeIdx, gxIdx, gyIdx, gzIdx, axIdx, ayIdx, azIdx] = indices;
  const requiredMaxIdx = Math.max(...indices);

  const errors: string[] = [];
  const rawTimesSec: number[] = [];
  const gx: number[] = [];
  const gy: number[] = [];
  const gz: number[] = [];
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  const rawRows: string[][] = [];

  let prevTimeSec: number | null = null;
  let prevRelTime: number | null = null;

  for (let i = 1; i < lines.length; i++) {
    const { lineNum, raw } = lines[i];
    if (raw.trim() === '') {
      errors.push(`第 ${lineNum} 行：存在空行或缺失数据。`);
      if (errors.length >= 15) break;
      continue;
    }

    const cells = parseCsvLine(raw);
    if (cells.length <= requiredMaxIdx) {
      errors.push(
        `第 ${lineNum} 行：列数不足（实际 ${cells.length} 列，至少需要 ${requiredMaxIdx + 1} 列）。`
      );
      if (errors.length >= 15) break;
      continue;
    }

    const checks = [
      { label: `时间(${config.timeCol})`, str: cells[timeIdx] },
      { label: `gx(${config.gxCol})`, str: cells[gxIdx] },
      { label: `gy(${config.gyCol})`, str: cells[gyIdx] },
      { label: `gz(${config.gzCol})`, str: cells[gzIdx] },
      { label: `ax(${config.axCol})`, str: cells[axIdx] },
      { label: `ay(${config.ayCol})`, str: cells[ayIdx] },
      { label: `az(${config.azCol})`, str: cells[azIdx] },
    ];

    const parsedVals: number[] = [];
    let rowValid = true;
    for (const c of checks) {
      if (c.str === '') {
        errors.push(`第 ${lineNum} 行：${c.label} 为空值。`);
        rowValid = false;
      } else {
        const num = Number(c.str);
        if (!Number.isFinite(num)) {
          errors.push(`第 ${lineNum} 行：${c.label} 不是有效有限数字（"${c.str}"）。`);
          rowValid = false;
        } else {
          parsedVals.push(num);
        }
      }
    }

    if (!rowValid) {
      if (errors.length >= 15) break;
      continue;
    }

    const [tRaw, gxRaw, gyRaw, gzRaw, axRaw, ayRaw, azRaw] = parsedVals;

    const tSec = config.timeUnit === 'ms' ? tRaw / 1000 : tRaw;
    const toRadS = (v: number) => (config.gyroUnit === 'deg_s' ? degToRad(v) : v);
    const toMS2 = (v: number) => (config.accelUnit === 'g' ? v * STANDARD_GRAVITY_M_S2 : v);

    const gxVal = toRadS(gxRaw) * config.gyroSigns.x;
    const gyVal = toRadS(gyRaw) * config.gyroSigns.y;
    const gzVal = toRadS(gzRaw) * config.gyroSigns.z;
    const axVal = toMS2(axRaw) * config.accelSigns.x;
    const ayVal = toMS2(ayRaw) * config.accelSigns.y;
    const azVal = toMS2(azRaw) * config.accelSigns.z;

    if (
      !Number.isFinite(tSec) ||
      !Number.isFinite(gxVal) ||
      !Number.isFinite(gyVal) ||
      !Number.isFinite(gzVal) ||
      !Number.isFinite(axVal) ||
      !Number.isFinite(ayVal) ||
      !Number.isFinite(azVal)
    ) {
      errors.push(`第 ${lineNum} 行：单位换算后出现非有限数值。`);
      if (errors.length >= 15) break;
      continue;
    }

    const relTime = rawTimesSec.length === 0 ? 0 : tSec - rawTimesSec[0];
    if (!Number.isFinite(relTime)) {
      errors.push(`第 ${lineNum} 行：减去首帧时间后发生数值溢出（${cells[timeIdx]}）。`);
      if (errors.length >= 15) break;
      continue;
    }

    if (prevTimeSec !== null && prevRelTime !== null) {
      if (tSec === prevTimeSec || relTime === prevRelTime) {
        errors.push(`第 ${lineNum} 行：时间戳与上一行重复（${cells[timeIdx]}）。`);
        if (errors.length >= 15) break;
        continue;
      }
      if (tSec < prevTimeSec || relTime < prevRelTime) {
        errors.push(`第 ${lineNum} 行：时间戳逆序（${cells[timeIdx]} 小于上一行）。`);
        if (errors.length >= 15) break;
        continue;
      }
    }

    prevTimeSec = tSec;
    prevRelTime = relTime;
    rawTimesSec.push(tSec);
    rawRows.push(cells);

    gx.push(gxVal);
    gy.push(gyVal);
    gz.push(gzVal);
    ax.push(axVal);
    ay.push(ayVal);
    az.push(azVal);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const t0 = rawTimesSec[0];
  const times = rawTimesSec.map((t) => t - t0);
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || (i > 0 && times[i] <= times[i - 1])) {
      return {
        ok: false,
        errors: [`第 ${i + 2} 行：最终时间轴非有限或非严格递增（t=${times[i]}）。`],
      };
    }
  }

  // Programmatic checks
  const dts: number[] = [];
  for (let i = 1; i < times.length; i++) {
    dts.push(times[i] - times[i - 1]);
  }
  dts.sort((a, b) => a - b);
  const dtMin = dts.length > 0 ? dts[0] : 0;
  const dtMax = dts.length > 0 ? dts[dts.length - 1] : 0;
  const dtMed =
    dts.length === 0
      ? 0
      : dts.length % 2 === 1
        ? dts[dts.length >> 1]
        : 0.5 * (dts[(dts.length >> 1) - 1] + dts[dts.length >> 1]);

  const norms = times.map((_, idx) =>
    Math.hypot(ax[idx], ay[idx], az[idx])
  );
  const normStats = calcChannelStats(norms);

  const programChecks: SixAxisProgramChecks = {
    sampleCount: times.length,
    durationSec: times[times.length - 1] ?? 0,
    dtMin,
    dtMed,
    dtMax,
    allFinite: true,
    strictlyIncreasingTime: true,
    accelNormMean: normStats.mean,
    accelNormStd: normStats.std,
    accelNormMin: normStats.min,
    accelNormMax: normStats.max,
    channels: {
      gx: calcChannelStats(gx),
      gy: calcChannelStats(gy),
      gz: calcChannelStats(gz),
      ax: calcChannelStats(ax),
      ay: calcChannelStats(ay),
      az: calcChannelStats(az),
    },
    summaryBadge: '格式与显式条件通过（不代表传感器来源已验证、时间已硬件同步或噪声已标定）',
  };

  return {
    ok: true,
    dataset: {
      id: `six-axis-${Date.now()}`,
      filename,
      isSimulatedSample,
      sourceStatusLabel: isSimulatedSample
        ? '模拟六轴样例（仅格式演示，非实测数据）'
        : '待核实来源的六轴原始 CSV（格式与显式条件通过）',
      times,
      gx,
      gy,
      gz,
      ax,
      ay,
      az,
      importConfig: {
        ...config,
        gyroSigns: { ...config.gyroSigns },
        accelSigns: { ...config.accelSigns },
      },
      rawSource: {
        headers,
        rows: rawRows,
      },
      programChecks,
    },
  };
}

/**
 * Generates a clearly-labeled simulated 6-axis IMU sample (50 Hz, 5s) purely for format & UI demonstration.
 */
export function createSimulatedSixAxisDataset(): SixAxisDataset {
  const rows = ['time_s,gx_rad_s,gy_rad_s,gz_rad_s,ax_m_s2,ay_m_s2,az_m_s2'];
  const n = 251;
  for (let i = 0; i < n; i++) {
    const t = Number((i * 0.02).toFixed(4));
    const gx = 0.15 * Math.sin(1.2 * t);
    const gy = 0.10 * Math.cos(0.9 * t);
    const gz = 0.05 * Math.sin(0.6 * t);
    const roll = 0.12 * Math.sin(1.2 * t);
    const pitch = 0.10 * Math.cos(0.9 * t);
    const ax = -STANDARD_GRAVITY_M_S2 * Math.sin(pitch);
    const ay = STANDARD_GRAVITY_M_S2 * Math.sin(roll) * Math.cos(pitch);
    const az = STANDARD_GRAVITY_M_S2 * Math.cos(roll) * Math.cos(pitch);
    rows.push(
      [
        t.toFixed(3),
        gx.toFixed(6),
        gy.toFixed(6),
        gz.toFixed(6),
        ax.toFixed(6),
        ay.toFixed(6),
        az.toFixed(6),
      ].join(',')
    );
  }

  const parsed = parseAndValidateSixAxisCsv(
    rows.join('\n'),
    'simulated_six_axis_demo_template.csv',
    {
      timeCol: 'time_s',
      gxCol: 'gx_rad_s',
      gyCol: 'gy_rad_s',
      gzCol: 'gz_rad_s',
      axCol: 'ax_m_s2',
      ayCol: 'ay_m_s2',
      azCol: 'az_m_s2',
      timeUnit: 's',
      gyroUnit: 'rad_s',
      accelUnit: 'm_s2',
      gyroSigns: { x: 1, y: 1, z: 1 },
      accelSigns: { x: 1, y: 1, z: 1 },
      timeBase: 'unknown',
      confirmedPhysicalMeaning: true,
    },
    true
  );

  if ('errors' in parsed) {
    throw new Error(`模拟六轴样例生成失败：${parsed.errors.join('; ')}`);
  }
  return parsed.dataset;
}

export { previewCsv };
