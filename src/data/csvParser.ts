import { radToDeg, wrapAngle180 } from '../math/angles';
import type { AttitudeDataset, CsvImportConfig } from '../types/attitude';

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  totalDataRows: number;
}

export interface CsvParseResult {
  ok: true;
  dataset: AttitudeDataset;
}

export interface CsvParseError {
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

export interface MappingValidationStatus {
  complete: boolean;
  missingLabels: string[];
  message: string;
}

export function evaluateMappingCompleteness(
  hasHeaders: boolean,
  mapping: Pick<CsvImportConfig, 'timeCol' | 'rollCol' | 'pitchCol' | 'yawCol'>
): MappingValidationStatus {
  if (!hasHeaders) {
    return { complete: false, missingLabels: [], message: '' };
  }
  const missingLabels: string[] = [];
  if (!mapping.timeCol) missingLabels.push('时间列');
  if (!mapping.rollCol) missingLabels.push('Roll 列');
  if (!mapping.pitchCol) missingLabels.push('Pitch 列');
  if (!mapping.yawCol) missingLabels.push('Yaw 列');

  if (missingLabels.length > 0) {
    return {
      complete: false,
      missingLabels,
      message: `请先完成必要列映射：缺少 ${missingLabels.join('、')}（不可将转速或加速度列作为角度）。`,
    };
  }
  return { complete: true, missingLabels: [], message: '' };
}

export function previewCsv(text: string, maxRows = 6): CsvPreview {
  const lines = splitLines(text);
  if (lines.length === 0) {
    return { headers: [], rows: [], totalDataRows: 0 };
  }
  const headers = parseCsvLine(lines[0].raw);
  const dataLines = lines.slice(1);
  const rows = dataLines.slice(0, maxRows).map((l) => parseCsvLine(l.raw));
  return {
    headers,
    rows,
    totalDataRows: dataLines.length,
  };
}

const NON_ANGLE_COL_RE = /(rpm|vel|velocity|speed|rate|gyro|acc|accel|omega|速度|角速度|加速度|转速)/i;

export function guessDefaultMapping(headers: string[]): Partial<CsvImportConfig> {
  const findCol = (patterns: RegExp[], excludeNonAngle = false): string => {
    const candidates = excludeNonAngle
      ? headers.filter((h) => !NON_ANGLE_COL_RE.test(h))
      : headers;
    for (const p of patterns) {
      const hit = candidates.find((h) => p.test(h));
      if (hit) return hit;
    }
    return '';
  };

  const timeCol = findCol([/^time/i, /^t(_|$)/i, /^ts(_|$)/i, /elapsed/i, /timestamp/i, /时间/]);
  const rollCol = findCol([/roll/i, /横滚/, /^r(_|$)/i, /^phi(_|$)/i], true);
  const pitchCol = findCol([/pitch/i, /俯仰/, /^p(_|$)/i, /^theta(_|$)/i], true);
  const yawCol = findCol([/yaw/i, /heading/i, /偏航/, /^y(_|$)/i, /^psi(_|$)/i], true);

  const timeUnit = /ms/i.test(timeCol) ? 'ms' : 's';
  const angleUnit = /rad/i.test(rollCol + pitchCol + yawCol) ? 'rad' : 'deg';

  return {
    timeCol,
    rollCol,
    pitchCol,
    yawCol,
    timeUnit,
    angleUnit,
  };
}

export function parseAndValidateCsv(
  text: string,
  filename: string,
  config: CsvImportConfig
): CsvParseResult | CsvParseError {
  const lines = splitLines(text);
  if (lines.length < 2) {
    return {
      ok: false,
      errors: ['CSV 文件至少需要包含 1 行表头和 1 行数据。'],
    };
  }

  const headers = parseCsvLine(lines[0].raw);

  const unmapped: string[] = [];
  if (!config.timeCol) unmapped.push('时间列');
  if (!config.rollCol) unmapped.push('横滚(Roll)列');
  if (!config.pitchCol) unmapped.push('俯仰(Pitch)列');
  if (!config.yawCol) unmapped.push('偏航(Yaw)列');
  if (unmapped.length > 0) {
    return {
      ok: false,
      errors: [`存在未映射列（${unmapped.join('、')}），请先选择有效的角度/时间列（不可将转速或加速度列作为角度）。`],
    };
  }

  const timeIdx = headers.indexOf(config.timeCol);
  const rollIdx = headers.indexOf(config.rollCol);
  const pitchIdx = headers.indexOf(config.pitchCol);
  const yawIdx = headers.indexOf(config.yawCol);

  const missingCols: string[] = [];
  if (timeIdx < 0) missingCols.push(`时间列 "${config.timeCol}"`);
  if (rollIdx < 0) missingCols.push(`横滚列 "${config.rollCol}"`);
  if (pitchIdx < 0) missingCols.push(`俯仰列 "${config.pitchCol}"`);
  if (yawIdx < 0) missingCols.push(`偏航列 "${config.yawCol}"`);

  if (missingCols.length > 0) {
    return {
      ok: false,
      errors: [`第 1 行表头未找到映射列：${missingCols.join('、')}。`],
    };
  }

  const errors: string[] = [];
  const rawTimesSec: number[] = [];
  const roll: number[] = [];
  const pitch: number[] = [];
  const yaw: number[] = [];
  const rawRows: string[][] = [];

  const requiredMaxIdx = Math.max(timeIdx, rollIdx, pitchIdx, yawIdx);
  let prevTimeSec: number | null = null;
  let prevRelTime: number | null = null;

  for (let i = 1; i < lines.length; i++) {
    const { lineNum, raw } = lines[i];
    if (raw.trim() === '') {
      errors.push(`第 ${lineNum} 行：存在空行或缺失数据，请删除空行或补全数值。`);
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

    const checks: Array<{ label: string; str: string }> = [
      { label: `时间(${config.timeCol})`, str: cells[timeIdx] },
      { label: `横滚(${config.rollCol})`, str: cells[rollIdx] },
      { label: `俯仰(${config.pitchCol})`, str: cells[pitchIdx] },
      { label: `偏航(${config.yawCol})`, str: cells[yawIdx] },
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

    const [tRaw, rRaw, pRaw, yRaw] = parsedVals;

    // Unit conversion
    const tSec = config.timeUnit === 'ms' ? tRaw / 1000 : tRaw;
    const toDeg = (v: number) => (config.angleUnit === 'rad' ? radToDeg(v) : v);
    const rDeg = toDeg(rRaw) * config.axisSigns.roll;
    const pDeg = toDeg(pRaw) * config.axisSigns.pitch;
    const yDeg = toDeg(yRaw) * config.axisSigns.yaw;

    // Re-check finiteness after unit conversion
    if (
      !Number.isFinite(tSec) ||
      !Number.isFinite(rDeg) ||
      !Number.isFinite(pDeg) ||
      !Number.isFinite(yDeg)
    ) {
      errors.push(`第 ${lineNum} 行：单位换算后出现非有限数值（溢出或无效）。`);
      if (errors.length >= 15) break;
      continue;
    }

    // Strict monotonicity check on raw seconds AND relative seconds (full precision, no rounding)
    const relTime = rawTimesSec.length === 0 ? 0 : tSec - rawTimesSec[0];
    if (!Number.isFinite(relTime)) {
      errors.push(`第 ${lineNum} 行：减去首帧时间后发生数值溢出（${cells[timeIdx]}），无法生成有限时间轴。`);
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

    roll.push(wrapAngle180(rDeg));
    pitch.push(wrapAngle180(pDeg));
    yaw.push(wrapAngle180(yDeg));
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

  return {
    ok: true,
    dataset: {
      id: `csv-${Date.now()}`,
      filename,
      sourceLabel: '来源待确认的姿态角',
      isDemo: false,
      times,
      roll,
      pitch,
      yaw,
      convention: {
        frameLabel: '右手系 · X向前 Y向左 Z向上（待确认）',
        rotationOrder: config.rotationOrder,
        axisSigns: { ...config.axisSigns },
        confirmed: false,
      },
      importConfig: { ...config },
      rawSource: {
        headers,
        rows: rawRows,
      },
    },
  };
}
