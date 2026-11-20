import { sixAxisViewport, bindChartNavigation, yRange, formatChartTime } from './chartNavigation';
import type { SixAxisDataset } from '../types/sixAxis';

const PAD_LEFT = 62;
const PAD_RIGHT = 18;
const PAD_TOP = 24;
const PAD_BOTTOM = 24;

interface ChannelChartSpec {
  canvas: HTMLCanvasElement;
  title: string;
  unit: string;
  keys: Array<{ key: 'gx' | 'gy' | 'gz' | 'ax' | 'ay' | 'az'; label: string; color: string }>;
}

export class SixAxisCharts {
  private specs: ChannelChartSpec[];
  private dataset: SixAxisDataset | null = null;
  private resizeObserver: ResizeObserver;

  constructor(canvases: { gyro: HTMLCanvasElement; accel: HTMLCanvasElement }) {
    this.specs = [
      {
        canvas: canvases.gyro,
        title: '机体系原始三轴角速度 ω_b (rad/s)',
        unit: 'rad/s',
        keys: [
          { key: 'gx', label: 'gx', color: '#f87171' },
          { key: 'gy', label: 'gy', color: '#4ade80' },
          { key: 'gz', label: 'gz', color: '#60a5fa' },
        ],
      },
      {
        canvas: canvases.accel,
        title: '机体系原始三轴比力 f_b (m/s²)',
        unit: 'm/s²',
        keys: [
          { key: 'ax', label: 'ax', color: '#f87171' },
          { key: 'ay', label: 'ay', color: '#4ade80' },
          { key: 'az', label: 'az', color: '#60a5fa' },
        ],
      },
    ];

    this.resizeObserver = new ResizeObserver(() => this.renderAll());
    const redraw = () => this.renderAll();
    for (const s of this.specs) {
      this.resizeObserver.observe(s.canvas.parentElement ?? s.canvas);
      bindChartNavigation(s.canvas, redraw, 62, 18);
    }
  }

  public update(dataset: SixAxisDataset | null): void {
    this.dataset = dataset;
    this.renderAll();
  }

  public renderAll(): void {
    for (const s of this.specs) {
      this.renderOne(s);
    }
  }

  private renderOne(spec: ChannelChartSpec): void {
    const { canvas, title, keys } = spec;
    const parent = canvas.parentElement;
    const cssW = Math.max(260, parent ? parent.clientWidth : canvas.clientWidth);
    const cssH = Math.max(150, parent ? parent.clientHeight : canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, cssW, cssH);

    const plotW = Math.max(20, cssW - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(20, cssH - PAD_TOP - PAD_BOTTOM);

    if (!this.dataset || this.dataset.times.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('尚未导入六轴原始 CSV（请点击「导入六轴原始 CSV」或「加载模拟六轴样例」）', PAD_LEFT, PAD_TOP + plotH / 2);
      ctx.restore();
      return;
    }

    const times = this.dataset.times;
    const tMin = sixAxisViewport.start;
    const tMax = sixAxisViewport.end;
    const tSpan = Math.max(1e-6, tMax - tMin);

    let yMin = Infinity;
    let yMax = -Infinity;
    for (const k of keys) {
      const arr = this.dataset[k.key];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] < yMin) yMin = arr[i];
        if (arr[i] > yMax) yMax = arr[i];
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -1;
      yMax = 1;
    }
    if (Math.abs(yMax - yMin) < 1e-4) {
      yMin -= 1;
      yMax += 1;
    } else {
      const pad = (yMax - yMin) * 0.12;
      yMin -= pad;
      yMax += pad;
    }

    const toX = (t: number) => PAD_LEFT + ((t - tMin) / tSpan) * plotW;
    [yMin, yMax] = yRange(canvas, yMin, yMax);
    const toY = (v: number) => PAD_TOP + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const val = yMin + (i / yTicks) * (yMax - yMin);
      const y = toY(val);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(val.toFixed(2), PAD_LEFT - 6, y);
    }

    const xTicks = Math.min(8, Math.max(4, Math.floor(plotW / 100)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xTicks; i++) {
      const t = tMin + (i / xTicks) * tSpan;
      const x = toX(t);
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, PAD_TOP + plotH);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${formatChartTime(t)}s`, x, PAD_TOP + plotH + 5);
    }

    // Curves
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.clip();

    for (const k of keys) {
      const arr = this.dataset[k.key];
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      for (let i = 0; i < times.length; i++) {
        const x = toX(times[i]);
        const y = toY(arr[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Title & Legend
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, PAD_LEFT + 6, 5);

    let lx = PAD_LEFT + 250;
    ctx.font = '11px Consolas, monospace';
    for (const k of keys) {
      ctx.fillStyle = k.color;
      ctx.fillRect(lx, 9, 12, 3);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(k.label, lx + 16, 5);
      lx += 52;
    }

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.restore();
  }

  public dispose(): void {
    this.resizeObserver.disconnect();
  }
}
