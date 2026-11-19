import { degToRad } from '../math/angles';
import type {
  ChannelStats,
  SixAxisDataset,
  SixAxisImportConfig,
  SixAxisProgramChecks,
} from '../types/sixAxis';
import { previewCsv } from './csvParser';
import type { WitMotionBinInspection } from './witMotionBin';

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

/**
 * Parses HH:mm:ss.SSS or YYYY-MM-DD HH:mm:ss.SSS into seconds-of-day.
 * Intentionally ignores calendar date validity (e.g. "2000-00-00 00:36:31.640").
 */
export function parseHmsTimestampSec(rawStr: string): number | null {
  const m = rawStr
    .trim()
    .match(/^(?:\d{4}-\d{2}-\d{2}\s+)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (
    !Number.isInteger(hh) ||
    !Number.isInteger(mm) ||
    !Number.isFinite(ss) ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59 ||
    ss < 0 ||
    ss >= 60
  ) {
    return null;
  }
  return hh * 3600 + mm * 60 + ss;
}

const EXCLUDE_SIX_AXIS_RE =
  /(rpm|pos|position|angle|roll|pitch|yaw|deg_s2|linear|lin_acc|角度|位置|转速|磁场|温度|气压|高度|经度|纬度|四元数)/i;

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

  // Prioritize on-chip time over computer time for WitMotion CSVs
  const onchipTimeCol = findCol([/片上时间/]);
  const hostTimeCol = findCol([/^时间$/]);
  const genericTimeCol = findCol([
    /^time/i,
    /^t(_|$)/i,
    /^ts(_|$)/i,
    /elapsed/i,
    /timestamp/i,
    /^时间$/,
  ]);
  const timeCol = onchipTimeCol || genericTimeCol;

  const gxCol = findCol([/^gx(_|$)/i, /gyro_?x/i, /wx(_|$)/i, /omega_?x/i, /角速度X/i], true);
  const gyCol = findCol([/^gy(_|$)/i, /gyro_?y/i, /wy(_|$)/i, /omega_?y/i, /角速度Y/i], true);
  const gzCol = findCol([/^gz(_|$)/i, /gyro_?z/i, /wz(_|$)/i, /omega_?z/i, /角速度Z/i], true);
  const axCol = findCol([/^ax(_|$)/i, /acc(el)?_?x/i, /^fx(_|$)/i, /加速度X/i], true);
  const ayCol = findCol([/^ay(_|$)/i, /acc(el)?_?y/i, /^fy(_|$)/i, /加速度Y/i], true);
  const azCol = findCol([/^az(_|$)/i, /acc(el)?_?z/i, /^fz(_|$)/i, /加速度Z/i], true);

  let timeUnit: SixAxisImportConfig['timeUnit'] = '';
  if (onchipTimeCol) timeUnit = 'hms';
  else if (/ms/i.test(timeCol)) timeUnit = 'ms';
  else if (/(_s$|^time_s$|^t_s$)/i.test(timeCol)) timeUnit = 's';

  const gyroJoined = `${gxCol} ${gyCol} ${gzCol}`;
  let gyroUnit: SixAxisImportConfig['gyroUnit'] = '';
  if (/rad/i.test(gyroJoined)) gyroUnit = 'rad_s';
  else if (/deg|°\/s/i.test(gyroJoined)) gyroUnit = 'deg_s';

  const accelJoined = `${axCol} ${ayCol} ${azCol}`;
  let accelUnit: SixAxisImportConfig['accelUnit'] = '';
  if (/m_?s2|mps2|m\/s/i.test(accelJoined)) accelUnit = 'm_s2';
  else if (/(\(g\)|_g$|\bg\b)/i.test(accelJoined)) accelUnit = 'g';

  return {
    timeCol,
    hostTimeCol: hostTimeCol || undefined,
    gxCol,
    gyCol,
    gzCol,
    axCol,
    ayCol,
    azCol,
    timeUnit,
    gyroUnit,
    accelUnit,
    timeBase: onchipTimeCol ? 'onchip_hms' : undefined,
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

  // Check duplicate column mappings across the 7 required channels
  const cols = [
    config.timeCol,
    config.gxCol,
    config.gyCol,
    config.gzCol,
    config.axCol,
    config.ayCol,
    config.azCol,
  ].filter(Boolean);
  if (new Set(cols).size !== cols.length) {
    missingItems.push('存在重复映射的列（7 个通道须各自独立）');
  }

  if (missingItems.length > 0) {
    return {
      complete: false,
      missingItems,
      message: `请先完成六轴必要配置：${missingItems.join('、')}。`,
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
  isSimulatedSample = false,
  binInspection: WitMotionBinInspection | null = null
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

  const hostTimeIdx = config.hostTimeCol ? headers.indexOf(config.hostTimeCol) : -1;
  const [timeIdx, gxIdx, gyIdx, gzIdx, axIdx, ayIdx, azIdx] = indices;
  const requiredMaxIdx = Math.max(...indices);

  const errors: string[] = [];
  const rawTimesSec: number[] = [];
  const rawTimeStrings: string[] = [];
  const rawHostTimeStrings: string[] = [];
  const gx: number[] = [];
  const gy: number[] = [];
  const gz: number[] = [];
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  const rawRows: string[][] = [];

  let prevTimeSec: number | null = null;
  let prevRelTime: number | null = null;
  let prevHmsOfDay: number | null = null;
  let prevTimeStr = '';
  let rolloverOffsetSec = 0;
  let midnightRolloverCount = 0;
  let duplicateHostTimeCount = 0;

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

    const timeStr = cells[timeIdx];
    const hostStr = hostTimeIdx >= 0 ? (cells[hostTimeIdx] ?? '') : '';
    if (
      hostTimeIdx >= 0 &&
      rawHostTimeStrings.length > 0 &&
      hostStr !== '' &&
      hostStr === rawHostTimeStrings[rawHostTimeStrings.length - 1]
    ) {
      duplicateHostTimeCount++;
    }

    let tSec = NaN;
    if (timeStr === '') {
      errors.push(`第 ${lineNum} 行：时间(${config.timeCol}) 为空值。`);
      if (errors.length >= 15) break;
      continue;
    }

    if (config.timeUnit === 'hms') {
      const hmsSec = parseHmsTimestampSec(timeStr);
      if (hmsSec === null) {
        errors.push(`第 ${lineNum} 行：无法解析时分秒时间戳（"${timeStr}"）。`);
        if (errors.length >= 15) break;
        continue;
      }
      if (prevHmsOfDay !== null && hmsSec < prevHmsOfDay) {
        // Only treat as midnight rollover if crossing 23:50:00 -> 00:10:00
        if (prevHmsOfDay >= 23 * 3600 + 50 * 60 && hmsSec <= 10 * 60) {
          rolloverOffsetSec += 86400;
          midnightRolloverCount++;
        } else if (hmsSec <= 10 * 60 && prevHmsOfDay < 23 * 3600 + 50 * 60) {
          errors.push(
            `第 ${lineNum} 行：片上时间从 "${prevTimeStr}" 跳回 "${timeStr}"（疑似设备重启或时钟复位，不按跨日处理）。`
          );
          if (errors.length >= 15) break;
          continue;
        } else {
          errors.push(
            `第 ${lineNum} 行：片上时间逆序（"${timeStr}" 小于上一行 "${prevTimeStr}"）。`
          );
          if (errors.length >= 15) break;
          continue;
        }
      }
      prevHmsOfDay = hmsSec;
      tSec = hmsSec + rolloverOffsetSec;
    } else {
      const tNum = Number(timeStr);
      if (!Number.isFinite(tNum)) {
        errors.push(`第 ${lineNum} 行：时间(${config.timeCol}) 不是有效有限数字（"${timeStr}"）。`);
        if (errors.length >= 15) break;
        continue;
      }
      tSec = config.timeUnit === 'ms' ? tNum / 1000 : tNum;
    }

    const sixChecks = [
      { label: `gx(${config.gxCol})`, str: cells[gxIdx] },
      { label: `gy(${config.gyCol})`, str: cells[gyIdx] },
      { label: `gz(${config.gzCol})`, str: cells[gzIdx] },
      { label: `ax(${config.axCol})`, str: cells[axIdx] },
      { label: `ay(${config.ayCol})`, str: cells[ayIdx] },
      { label: `az(${config.azCol})`, str: cells[azIdx] },
    ];

    const parsedSix: number[] = [];
    let rowValid = true;
    for (const c of sixChecks) {
      if (c.str === '') {
        errors.push(`第 ${lineNum} 行：${c.label} 为空值。`);
        rowValid = false;
      } else {
        const num = Number(c.str);
        if (!Number.isFinite(num)) {
          errors.push(`第 ${lineNum} 行：${c.label} 不是有效有限数字（"${c.str}"）。`);
          rowValid = false;
        } else {
          parsedSix.push(num);
        }
      }
    }

    if (!rowValid) {
      if (errors.length >= 15) break;
      continue;
    }

    const [gxRaw, gyRaw, gzRaw, axRaw, ayRaw, azRaw] = parsedSix;
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
      errors.push(`第 ${lineNum} 行：减去首帧时间后发生数值溢出（"${timeStr}"）。`);
      if (errors.length >= 15) break;
      continue;
    }

    if (prevTimeSec !== null && prevRelTime !== null) {
      if (tSec === prevTimeSec || relTime === prevRelTime) {
        errors.push(`第 ${lineNum} 行：时间戳与上一行重复（"${timeStr}"）。`);
        if (errors.length >= 15) break;
        continue;
      }
      if (tSec < prevTimeSec || relTime < prevRelTime) {
        errors.push(`第 ${lineNum} 行：时间戳逆序（"${timeStr}" 小于上一行 "${prevTimeStr}"）。`);
        if (errors.length >= 15) break;
        continue;
      }
    }

    prevTimeSec = tSec;
    prevRelTime = relTime;
    prevTimeStr = timeStr;
    rawTimesSec.push(tSec);
    rawTimeStrings.push(timeStr);
    rawHostTimeStrings.push(hostStr);
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

  const totalCsvRows = rawTimesSec.length;
  let validCount = totalCsvRows;
  const excludedReasons: string[] = [];

  if (binInspection) {
    if (binInspection.badChecksumCount > 0) {
      excludedReasons.push(
        `配套 ${binInspection.filename} 存在 ${binInspection.badChecksumCount} 次校验失败。`
      );
    }
    if (binInspection.completeGroupCount < totalCsvRows) {
      const diff = totalCsvRows - binInspection.completeGroupCount;
      validCount = Math.max(0, binInspection.completeGroupCount);
      excludedReasons.push(
        `配套 ${binInspection.filename} 完整三元组数为 ${binInspection.completeGroupCount}（时间包 ${binInspection.timePacketCount}、加速度包 ${binInspection.accelPacketCount}、角速度包 ${binInspection.gyroPacketCount}${binInspection.truncatedTailBytes > 0 ? `，尾部截断 ${binInspection.truncatedTailBytes} 字节 ${binInspection.truncatedTailPacketType ?? ''}` : ''}），已排除尾部 ${diff} 条不完整记录，未用上一帧角速度补齐。`
      );
    }
  }

  if (validCount < 2) {
    return {
      ok: false,
      errors: [
        `有效完整六轴组数不足（仅 ${validCount} 组），无法形成时间序列。${excludedReasons.join(' ')}`,
      ],
    };
  }

  const times = rawTimesSec.slice(0, validCount).map((t) => t - rawTimesSec[0]);
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || (i > 0 && times[i] <= times[i - 1])) {
      return {
        ok: false,
        errors: [`第 ${i + 2} 行：最终时间轴非有限或非严格递增（t=${times[i]}）。`],
      };
    }
  }

  const gxValid = gx.slice(0, validCount);
  const gyValid = gy.slice(0, validCount);
  const gzValid = gz.slice(0, validCount);
  const axValid = ax.slice(0, validCount);
  const ayValid = ay.slice(0, validCount);
  const azValid = az.slice(0, validCount);
  const timeStringsValid = rawTimeStrings.slice(0, validCount);
  const hostStringsValid = rawHostTimeStrings.slice(0, validCount);

  // Interval distribution & gap detection
  const dts: number[] = [];
  for (let i = 1; i < times.length; i++) {
    dts.push(times[i] - times[i - 1]);
  }
  const sortedDts = [...dts].sort((a, b) => a - b);
  const dtMin = sortedDts.length > 0 ? sortedDts[0] : 0;
  const dtMax = sortedDts.length > 0 ? sortedDts[sortedDts.length - 1] : 0;
  const dtMed =
    sortedDts.length === 0
      ? 0
      : sortedDts.length % 2 === 1
        ? sortedDts[sortedDts.length >> 1]
        : 0.5 * (sortedDts[(sortedDts.length >> 1) - 1] + sortedDts[sortedDts.length >> 1]);
  const effectiveHz = dtMed > 0 ? 1 / dtMed : 0;

  const gapDetails: string[] = [];
  if (dtMed > 0) {
    for (let i = 0; i < dts.length; i++) {
      if (dts[i] > 1.5 * dtMed + 1e-6) {
        gapDetails.push(
          `第 ${i + 1}→${i + 2} 帧 (t=${times[i].toFixed(3)}s→${times[i + 1].toFixed(3)}s, Δt=${dts[i].toFixed(4)}s)`
        );
      }
    }
  }

  const norms = times.map((_, idx) =>
    Math.hypot(axValid[idx], ayValid[idx], azValid[idx])
  );
  const normStats = calcChannelStats(norms);

  const timeSourceLabel =
    config.timeBase === 'onchip_hms'
      ? '片上时间 (HH:mm:ss.SSS)'
      : config.timeBase === 'device_sample'
        ? '设备采样时间戳'
        : config.timeBase === 'host_rx'
          ? '上位机接收时间（含串口抖动）'
          : '待核实时间源';

  const unconfirmedItems: string[] = [
    '轴向与安装旋转矩阵未完成实机标定（仅按导入方向符号暂用）',
    '设备内部采样与串口输出是否严格硬件同步尚未核实（间隔均匀不等于硬件同步）',
    '静止偏置/噪声参数 (S_g, S_bg, R_a) 尚未标定',
    '无独立姿态真值参考（模块自带姿态角列不可作为真值）',
  ];
  if (!binInspection) {
    unconfirmedItems.unshift('仅导入 CSV（未提供配套 .bin，未验证二进制包边界与通道同步）');
  }

  const excludedCount = totalCsvRows - validCount;
  const programChecks: SixAxisProgramChecks = {
    totalCsvRows,
    validCompleteGroups: validCount,
    excludedCount,
    excludedReasons,
    sampleCount: validCount,
    durationSec: times[times.length - 1] ?? 0,
    dtMin,
    dtMed,
    dtMax,
    effectiveHz,
    gapCount: gapDetails.length,
    gapDetails,
    midnightRolloverCount,
    duplicateHostTimeCount,
    allFinite: true,
    strictlyIncreasingTime: true,
    binVerified: Boolean(binInspection),
    timeSourceLabel,
    unconfirmedItems,
    accelNormMean: normStats.mean,
    accelNormStd: normStats.std,
    accelNormMin: normStats.min,
    accelNormMax: normStats.max,
    channels: {
      gx: calcChannelStats(gxValid),
      gy: calcChannelStats(gyValid),
      gz: calcChannelStats(gzValid),
      ax: calcChannelStats(axValid),
      ay: calcChannelStats(ayValid),
      az: calcChannelStats(azValid),
    },
    summaryBadge: binInspection
      ? '格式、显式条件与配套 .bin 完整性检查通过（不代表安装轴向或硬件同步已标定）'
      : '格式与显式条件通过（仅 CSV：未验证二进制完整性与硬件同步）',
  };

  return {
    ok: true,
    dataset: {
      id: `six-axis-${Date.now()}`,
      filename,
      isSimulatedSample,
      sourceStatusLabel: isSimulatedSample
        ? '模拟六轴样例（仅格式演示，非实测数据）'
        : binInspection
          ? '本地导入六轴原始 CSV + 配套 .bin（来源及安装标定待确认）'
          : '本地导入六轴原始 CSV（仅 CSV，来源及同步待确认）',
      times,
      rawTimeStrings: timeStringsValid,
      rawHostTimeStrings: hostStringsValid,
      gx: gxValid,
      gy: gyValid,
      gz: gzValid,
      ax: axValid,
      ay: ayValid,
      az: azValid,
      importConfig: {
        ...config,
        gyroSigns: { ...config.gyroSigns },
        accelSigns: { ...config.accelSigns },
      },
      rawSource: {
        headers,
        rows: rawRows.slice(0, validCount),
      },
      binInspection,
      programChecks,
    },
  };
}

export function buildNormalizedSixAxisCsv(dataset: SixAxisDataset): string {
  const lines = ['time_s,gx_rad_s,gy_rad_s,gz_rad_s,ax_m_s2,ay_m_s2,az_m_s2'];
  for (let i = 0; i < dataset.times.length; i++) {
    lines.push(
      [
        dataset.times[i].toFixed(6),
        dataset.gx[i].toFixed(6),
        dataset.gy[i].toFixed(6),
        dataset.gz[i].toFixed(6),
        dataset.ax[i].toFixed(6),
        dataset.ay[i].toFixed(6),
        dataset.az[i].toFixed(6),
      ].join(',')
    );
  }
  return lines.join('\n');
}

export function buildSixAxisQualityReport(dataset: SixAxisDataset): string {
  const chk = dataset.programChecks;
  const report = {
    sourceFile: dataset.filename,
    isSimulatedSample: dataset.isSimulatedSample,
    sourceStatusLabel: dataset.sourceStatusLabel,
    note: '转换结果仅作单位与时间基准规范化，不构成独立真值，亦不改变原始测量文件。',
    counts: {
      totalCsvRows: chk.totalCsvRows,
      validCompleteGroups: chk.validCompleteGroups,
      excludedCount: chk.excludedCount,
      excludedReasons: chk.excludedReasons,
      duplicateHostTimeCount: chk.duplicateHostTimeCount,
      midnightRolloverCount: chk.midnightRolloverCount,
    },
    timing: {
      timeSourceLabel: chk.timeSourceLabel,
      durationSec: Number(chk.durationSec.toFixed(6)),
      dtMinSec: Number(chk.dtMin.toFixed(6)),
      dtMedSec: Number(chk.dtMed.toFixed(6)),
      dtMaxSec: Number(chk.dtMax.toFixed(6)),
      effectiveHz: Number(chk.effectiveHz.toFixed(3)),
      gapCount: chk.gapCount,
      gapDetails: chk.gapDetails,
    },
    binInspection: dataset.binInspection,
    importConfig: dataset.importConfig,
    unconfirmedItems: chk.unconfirmedItems,
    accelNormMS2: {
      mean: Number(chk.accelNormMean.toFixed(4)),
      std: Number(chk.accelNormStd.toFixed(4)),
      min: Number(chk.accelNormMin.toFixed(4)),
      max: Number(chk.accelNormMax.toFixed(4)),
    },
  };
  return JSON.stringify(report, null, 2);
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
