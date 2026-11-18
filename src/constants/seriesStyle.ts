import type { DataSourceId } from '../types/attitude';

export interface SeriesStyle {
  id: DataSourceId;
  label: string;
  shortLabel: string;
  color: string;
  lineDash: number[];
  lineWidth: number;
  dashDesc: string;
}

export const SERIES_STYLES: Record<DataSourceId, SeriesStyle> = {
  raw: {
    id: 'raw',
    label: '原日志',
    shortLabel: '原日志',
    color: '#60a5fa',
    lineDash: [],
    lineWidth: 2,
    dashDesc: '实线',
  },
  disturbed: {
    id: 'disturbed',
    label: '受扰数据',
    shortLabel: '受扰数据',
    color: '#f97316',
    lineDash: [7, 4],
    lineWidth: 1.9,
    dashDesc: '虚线',
  },
  filter_standard: {
    id: 'filter_standard',
    label: '标准角度KF（简化演示）',
    shortLabel: '标准KF(演示)',
    color: '#34d399',
    lineDash: [2, 3],
    lineWidth: 2.1,
    dashDesc: '点线',
  },
  filter_robust: {
    id: 'filter_robust',
    label: 'Huber鲁棒角度KF（简化演示）',
    shortLabel: 'Huber KF(演示)',
    color: '#c084fc',
    lineDash: [9, 3, 2, 3],
    lineWidth: 2.2,
    dashDesc: '点划线',
  },
};

export const SERIES_ORDER: DataSourceId[] = [
  'raw',
  'disturbed',
  'filter_standard',
  'filter_robust',
];

export const CURSOR_COLOR = '#facc15';
export const DISTURBANCE_MARKER_COLOR = '#ef4444';
