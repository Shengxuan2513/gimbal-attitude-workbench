import { sixAxisViewport, bindChartNavigation, yRange, formatChartTime } from './chartNavigation';
import type { AlignedCommandSeries } from '../data/commandMotionParser';
import type { SixAxisEskfResult } from '../filters/sixAxisEskf';

const PAD_LEFT = 56;
const PAD_RIGHT = 18;
const PAD_TOP = 24;
const PAD_BOTTOM = 22;

export class SixAxisEskfCharts {
  private canvases: {
    roll: HTMLCanvasElement;
    pitch: HTMLCanvasElement;
    yaw: HTMLCanvasElement;
    weight: HTMLCanvasElement;
  };
  private a0: SixAxisEskfResult | null = null;
  private a4: SixAxisEskfResult | null = null;
  private alignedCommand: AlignedCommandSeries | null = null;
  private resizeObserver: ResizeObserver;

  constructor(canvases: {
    roll: HTMLCanvasElement;
    pitch: HTMLCanvasElement;
    yaw: HTMLCanvasElement;
    weight: HTMLCanvasElement;
  }) {
    this.canvases = canvases;
    this.resizeObserver = new ResizeObserver(() => this.renderAll());
    const redraw = () => this.renderAll();
    for (const c of Object.values(canvases)) {
      this.resizeObserver.observe(c.parentElement ?? c);
      bindChartNavigation(c, redraw, 56, 18);
    }
  }

  public update(
    a0: SixAxisEskfResult | null,
    a4: SixAxisEskfResult | null,
    alignedCommand: AlignedCommandSeries | null = null
  ): void {
    this.a0 = a0;
    this.a4 = a4;
    this.alignedCommand = alignedCommand;
    this.renderAll();
  }

  public renderAll(): void {
    this.renderCompare(this.canvases.roll, 'ESKF Roll 横滚角 (°)', 'rollDeg');
    this.renderCompare(this.canvases.pitch, 'ESKF Pitch 俯仰角 (°)', 'pitchDeg');
    this.renderCompare(this.canvases.yaw, 'ESKF Yaw 相对偏航角 (° · 无磁存在积分漂移)', 'yawDeg');
    this.renderWeight(this.canvases.weight);
  }

  private renderCompare(
    canvas: HTMLCanvasElement,
    title: string,
    field: 'rollDeg' | 'pitchDeg' | 'yawDeg'
  ): void {
    const parent = canvas.parentElement;
    const cssW = Math.max(240, parent ? parent.clientWidth : canvas.clientWidth);
    const cssH = Math.max(125, parent ? parent.clientHeight : canvas.clientHeight);
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

    if (!this.a0 || !this.a4 || this.a0.times.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12.5px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('导入或加载六轴数据后自动运行 A0 标准 ESKF 与 A4 双侧 Huber ESKF 对比', PAD_LEFT, PAD_TOP + plotH / 2);
      ctx.restore();
      return;
    }

    const times = this.a0.times;
    const arr0 = this.a0[field];
    const arr4 = this.a4[field];
    const cmdArr = this.alignedCommand ? this.alignedCommand[field] : null;
    const tMin = sixAxisViewport.start;
    const tMax = sixAxisViewport.end;
    const tSpan = Math.max(1e-6, tMax - tMin);

    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < times.length; i++) {
      if (arr0[i] < yMin) yMin = arr0[i];
      if (arr0[i] > yMax) yMax = arr0[i];
      if (arr4[i] < yMin) yMin = arr4[i];
      if (arr4[i] > yMax) yMax = arr4[i];
      const cv = cmdArr ? cmdArr[i] : null;
      if (cv !== null) {
        if (cv < yMin) yMin = cv;
        if (cv > yMax) yMax = cv;
      }
    }
    if (Math.abs(yMax - yMin) < 2) {
      const m = 0.5 * (yMin + yMax);
      yMin = m - 1.5;
      yMax = m + 1.5;
    } else {
      const pad = (yMax - yMin) * 0.12;
      yMin -= pad;
      yMax += pad;
    }

    const toX = (t: number) => PAD_LEFT + ((t - tMin) / tSpan) * plotW;
    [yMin, yMax] = yRange(canvas, yMin, yMax);
    const toY = (v: number) => PAD_TOP + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = yMin + (i / 4) * (yMax - yMin);
      const y = toY(val);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(val.toFixed(1), PAD_LEFT - 6, y);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.clip();

    // A0 Standard ESKF (emerald dashed)
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const x = toX(times[i]);
      const y = toY(arr0[i]);
      if (i === 0 || Math.abs(arr0[i] - arr0[i - 1]) > 180) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // A4 Two-sided Huber ESKF (purple solid)
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2.0;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const x = toX(times[i]);
      const y = toY(arr4[i]);
      if (i === 0 || Math.abs(arr4[i] - arr4[i - 1]) > 180) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Optional Host Command Trajectory (amber dotted)
    if (cmdArr) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < times.length; i++) {
        const cv = cmdArr[i];
        if (cv === null) {
          started = false;
          continue;
        }
        const x = toX(times[i]);
        const y = toY(cv);
        if (!started || (i > 0 && cmdArr[i - 1] !== null && Math.abs(cv - cmdArr[i - 1]!) > 180)) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, PAD_LEFT + 6, 5);

    ctx.strokeStyle = '#334155';
    ctx.strokeRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.restore();
  }

  private renderWeight(canvas: HTMLCanvasElement): void {
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
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, cssW, cssH);

    const plotW = Math.max(20, cssW - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(20, cssH - PAD_TOP - PAD_BOTTOM);

    if (!this.a4 || this.a4.times.length === 0) {
      ctx.restore();
      return;
    }

    const times = this.a4.times;
    const wy = this.a4.wyMean;
    const wx = this.a4.wxMean;
    const tMin = sixAxisViewport.start;
    const tMax = sixAxisViewport.end;
    const tSpan = Math.max(1e-6, tMax - tMin);

    const toX = (t: number) => PAD_LEFT + ((t - tMin) / tSpan) * plotW;
    const [low, high] = yRange(canvas, 0, 1.05);
    const toY = (v: number) => PAD_TOP + (1 - (v - low) / (high - low)) * plotH;

    ctx.strokeStyle = '#1e293b';
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const val of [low, (low + high) / 2, high]) {
      const y = toY(val);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(val.toFixed(1), PAD_LEFT - 6, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 6; i++) {
      const t = tMin + (i / 6) * tSpan;
      const x = toX(t);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${formatChartTime(t)}s`, x, PAD_TOP + plotH + 5);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.clip();

    // W_x mean (sky blue)
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const x = toX(times[i]);
      const y = toY(wx[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // W_y mean (amber)
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const x = toX(times[i]);
      const y = toY(wy[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('A4 双侧 Huber 均值权重（黄=观测侧 W_y，蓝=状态侧 W_x）', PAD_LEFT + 6, 5);

    ctx.strokeStyle = '#334155';
    ctx.strokeRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.restore();
  }

  public dispose(): void {
    this.resizeObserver.disconnect();
  }
}
