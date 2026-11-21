export type SixAxisSeriesKey =
  | 'a0'
  | 'a4'
  | 'cmd'
  | 'wy'
  | 'wx'
  | 'rawX'
  | 'rawY'
  | 'rawZ';

export type SixAxisLineVisibility = Record<SixAxisSeriesKey, boolean>;

export interface SixAxisSeriesMeta {
  key: SixAxisSeriesKey;
  label: string;
  color: string;
  group: 'eskf' | 'raw';
}

export const SIX_AXIS_SERIES_META: SixAxisSeriesMeta[] = [
  { key: 'a0', label: '标准 ESKF (绿)', color: '#34d399', group: 'eskf' },
  { key: 'a4', label: '鲁棒 ESKF (紫)', color: '#c084fc', group: 'eskf' },
  { key: 'cmd', label: '指令估算 (黄)', color: '#fbbf24', group: 'eskf' },
  { key: 'wy', label: '观测权重 Wy (黄)', color: '#fbbf24', group: 'eskf' },
  { key: 'wx', label: '状态权重 Wx (蓝)', color: '#60a5fa', group: 'eskf' },
  { key: 'rawX', label: 'X 轴 (红)', color: '#f87171', group: 'raw' },
  { key: 'rawY', label: 'Y 轴 (绿)', color: '#4ade80', group: 'raw' },
  { key: 'rawZ', label: 'Z 轴 (蓝)', color: '#60a5fa', group: 'raw' },
];

export function createDefaultSixAxisVisibility(): SixAxisLineVisibility {
  return {
    a0: true,
    a4: true,
    cmd: true,
    wy: true,
    wx: true,
    rawX: true,
    rawY: true,
    rawZ: true,
  };
}

let state: SixAxisLineVisibility = createDefaultSixAxisVisibility();
const listeners = new Set<(v: SixAxisLineVisibility) => void>();

export function getSixAxisVisibility(): SixAxisLineVisibility {
  return { ...state };
}

export function setSixAxisSeriesVisible(key: SixAxisSeriesKey, visible: boolean): void {
  if (state[key] === visible) return;
  state = { ...state, [key]: visible };
  const snapshot = getSixAxisVisibility();
  for (const fn of listeners) fn(snapshot);
}

export function toggleSixAxisSeries(key: SixAxisSeriesKey): boolean {
  const next = !state[key];
  setSixAxisSeriesVisible(key, next);
  return next;
}

export function resetSixAxisVisibility(): void {
  state = createDefaultSixAxisVisibility();
  const snapshot = getSixAxisVisibility();
  for (const fn of listeners) fn(snapshot);
}

export function onSixAxisVisibilityChange(fn: (v: SixAxisLineVisibility) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
