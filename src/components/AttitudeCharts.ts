import {
  CURSOR_COLOR,
  DISTURBANCE_MARKER_COLOR,
  SERIES_ORDER,
  SERIES_STYLES,
} from '../constants/seriesStyle';
import { findNearestFrameIndex } from '../math/angles';
import type { AppliedDisturbance, AxisKey, DataSourceId, SeriesData } from '../types/attitude';

export interface ChartDataInput {
  times: number[];
  seriesMap: Partial<Record<DataSourceId, SeriesData>>;
  visibleSeries: Record<DataSourceId, boolean>;
  currentIndex: number;
  appliedDisturbance: AppliedDisturbance | null;
}

interface ChartConfig {
  axis: AxisKey;
  title: string;
  canvas: HTMLCanvasElement;
}

const PAD_LEFT = 56;
const PAD_RIGHT = 18;
const PAD_TOP = 24;
const PAD_BOTTOM = 24;

export class AttitudeCharts {
  private charts: ChartConfig[] = [];
  private data: ChartDataInput | null = null;
  private hoverIndex: number | null = null;
  private isDragging = false;
  private onSelectFrame: (idx: number) => void;
  private resizeObserver: ResizeObserver;

  constructor(
    canvases: { roll: HTMLCanvasElement; pitch: HTMLCanvasElement; yaw: HTMLCanvasElement },
    onSelectFrame: (idx: number) => void
  ) {
    this.onSelectFrame = onSelectFrame;
    this.charts = [
      { axis: 'roll', title: 'Roll 横滚角 (°)', canvas: canvases.roll },
      { axis: 'pitch', title: 'Pitch 俯仰角 (°)', canvas: canvases.pitch },
      { axis: 'yaw', title: 'Yaw 偏航角 (°)', canvas: canvases.yaw },
    ];

    this.resizeObserver = new ResizeObserver(() => this.renderAll());
    for (const c of this.charts) {
      this.resizeObserver.observe(c.canvas.parentElement ?? c.canvas);
      this.bindEvents(c.canvas);
    }
  }

  private bindEvents(canvas: HTMLCanvasElement): void {
    const pickFrame = (clientX: number) => {
      if (!this.data || this.data.times.length === 0) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const plotW = Math.max(1, rect.width - PAD_LEFT - PAD_RIGHT);
      const ratio = Math.max(0, Math.min(1, (x - PAD_LEFT) / plotW));
      const tMin = this.data.times[0];
      const tMax = this.data.times[this.data.times.length - 1];
      const targetT = tMin + ratio * (tMax - tMin);
      return findNearestFrameIndex(this.data.times, targetT);
    };

    canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      canvas.setPointerCapture(e.pointerId);
      const idx = pickFrame(e.clientX);
      if (idx !== null) this.onSelectFrame(idx);
    });

    canvas.addEventListener('pointermove', (e) => {
      const idx = pickFrame(e.clientX);
      if (this.isDragging && idx !== null) {
        this.onSelectFrame(idx);
      }
      if (idx !== this.hoverIndex) {
        this.hoverIndex = idx;
        this.renderAll();
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      this.isDragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    });

    canvas.addEventListener('pointerleave', () => {
      this.hoverIndex = null;
      this.renderAll();
    });
  }

  public update(data: ChartDataInput): void {
    this.data = data;
    this.renderAll();
  }

  public renderAll(): void {
    for (const c of this.charts) {
      this.renderChart(c);
    }
  }

  private renderChart(chart: ChartConfig): void {
    const { canvas, axis, title } = chart;
    const parent = canvas.parentElement;
    const cssW = Math.max(240, parent ? parent.clientWidth : canvas.clientWidth);
    const cssH = Math.max(115, parent ? parent.clientHeight : canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, cssW, cssH);

    const plotW = Math.max(20, cssW - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(20, cssH - PAD_TOP - PAD_BOTTOM);

    if (!this.data || this.data.times.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('暂无数据', PAD_LEFT, PAD_TOP + plotH / 2);
      ctx.restore();
      return;
    }

    const { times, seriesMap, visibleSeries, currentIndex, appliedDisturbance } = this.data;
    const tMin = times[0];
    const tMax = times[times.length - 1];
    const tSpan = Math.max(1e-6, tMax - tMin);

    // Compute Y bounds across visible series
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const id of SERIES_ORDER) {
      if (!visibleSeries[id]) continue;
      const s = seriesMap[id];
      if (!s) continue;
      const arr = s[axis];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -30;
      yMax = 30;
    }
    if (Math.abs(yMax - yMin) < 4) {
      const mid = 0.5 * (yMin + yMax);
      yMin = mid - 5;
      yMax = mid + 5;
    } else {
      const pad = (yMax - yMin) * 0.12;
      yMin -= pad;
      yMax += pad;
    }

    const toX = (t: number) => PAD_LEFT + ((t - tMin) / tSpan) * plotW;
    const toY = (v: number) => PAD_TOP + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // Grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    const yTicks = 4;
    ctx.font = '11px Consolas, "Segoe UI", monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= yTicks; i++) {
      const val = yMin + (i / yTicks) * (yMax - yMin);
      const y = toY(val);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
      ctx.fillText(val.toFixed(0), PAD_LEFT - 6, y);
    }

    // Zero reference line if in range
    if (yMin < 0 && yMax > 0) {
      const y0 = toY(0);
      ctx.strokeStyle = '#334155';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y0);
      ctx.lineTo(PAD_LEFT + plotW, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // X time ticks
    const xTicks = Math.min(10, Math.max(4, Math.floor(plotW / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xTicks; i++) {
      const t = tMin + (i / xTicks) * tSpan;
      const x = toX(t);
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, PAD_TOP + plotH);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${t.toFixed(1)}s`, x, PAD_TOP + plotH + 5);
    }

    // Disturbance marker (interval band or spike pin)
    if (appliedDisturbance && appliedDisturbance.config.axis === axis) {
      if (appliedDisturbance.config.type === 'interval') {
        const x1 = toX(Math.max(tMin, appliedDisturbance.hitStartTime));
        const x2 = toX(Math.min(tMax, appliedDisturbance.hitEndTime));
        ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
        ctx.fillRect(x1, PAD_TOP, Math.max(2, x2 - x1), plotH);
        ctx.strokeStyle = DISTURBANCE_MARKER_COLOR;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, PAD_TOP);
        ctx.lineTo(x1, PAD_TOP + plotH);
        ctx.moveTo(x2, PAD_TOP);
        ctx.lineTo(x2, PAD_TOP + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (appliedDisturbance.hitIndices.length > 0) {
        const hitIdx = appliedDisturbance.hitIndices[0];
        const xHit = toX(times[hitIdx]);
        ctx.strokeStyle = DISTURBANCE_MARKER_COLOR;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xHit, PAD_TOP);
        ctx.lineTo(xHit, PAD_TOP + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        const distVal = seriesMap.disturbed?.[axis][hitIdx];
        if (distVal !== undefined) {
          const yHit = toY(distVal);
          ctx.fillStyle = DISTURBANCE_MARKER_COLOR;
          ctx.beginPath();
          ctx.moveTo(xHit, yHit - 6);
          ctx.lineTo(xHit + 5, yHit);
          ctx.lineTo(xHit, yHit + 6);
          ctx.lineTo(xHit - 5, yHit);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Clip plot area for curves
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.clip();

    // Draw series in order
    for (const id of SERIES_ORDER) {
      if (!visibleSeries[id]) continue;
      const s = seriesMap[id];
      if (!s) continue;
      const arr = s[axis];
      const style = SERIES_STYLES[id];

      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.lineWidth;
      ctx.setLineDash(style.lineDash);

      ctx.beginPath();
      for (let i = 0; i < times.length; i++) {
        const x = toX(times[i]);
        const y = toY(arr[i]);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          // Break line if angle wraps across ±180° (> 180° step) so plot stays clean
          if (Math.abs(arr[i] - arr[i - 1]) > 180) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Hover crosshair
    if (this.hoverIndex !== null && this.hoverIndex >= 0 && this.hoverIndex < times.length) {
      const xHover = toX(times[this.hoverIndex]);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xHover, PAD_TOP);
      ctx.lineTo(xHover, PAD_TOP + plotH);
      ctx.stroke();
    }

    // Current time cursor (distinct solid bright yellow line + dots)
    const clampedIdx = Math.max(0, Math.min(times.length - 1, currentIndex));
    const xCur = toX(times[clampedIdx]);
    ctx.strokeStyle = CURSOR_COLOR;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(xCur, PAD_TOP);
    ctx.lineTo(xCur, PAD_TOP + plotH);
    ctx.stroke();

    for (const id of SERIES_ORDER) {
      if (!visibleSeries[id]) continue;
      const s = seriesMap[id];
      if (!s) continue;
      const yCur = toY(s[axis][clampedIdx]);
      ctx.fillStyle = SERIES_STYLES[id].color;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(xCur, yCur, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Title & current frame readout in top-left of chart
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, PAD_LEFT + 6, 5);

    const rawVal = seriesMap.raw?.[axis][clampedIdx];
    if (rawVal !== undefined) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px Consolas, monospace';
      const hoverSuffix =
        this.hoverIndex !== null
          ? `  |  悬停 t=${times[this.hoverIndex].toFixed(3)}s`
          : '';
      ctx.fillText(
        `当前 t=${times[clampedIdx].toFixed(3)}s · 原日志=${rawVal.toFixed(2)}°${hoverSuffix}`,
        PAD_LEFT + 125,
        6
      );
    }

    // Plot border
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD_LEFT, PAD_TOP, plotW, plotH);

    ctx.restore();
  }

  public dispose(): void {
    this.resizeObserver.disconnect();
  }
}
