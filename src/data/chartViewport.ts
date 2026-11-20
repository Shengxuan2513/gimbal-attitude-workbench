export class TimeViewport {
  min = 0; max = 1; start = 0; end = 1;
  private key = '';
  private listeners = new Set<() => void>();
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const fn of this.listeners) fn(); }
  setDomain(times: number[], key: string): void {
    if (!times.length) return;
    const min = times[0], max = times.at(-1)!;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    if (key === this.key && min === this.min && max === this.max) return;
    this.key = key; this.min = min; this.max = max; this.reset();
  }
  reset(): void { this.start = this.min; this.end = this.max; this.emit(); }
  zoom(factor: number, anchor = .5): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    anchor = Math.max(0, Math.min(1, anchor));
    const old = this.end - this.start, span = Math.max((this.max - this.min) / 10000, Math.min(this.max - this.min, old * factor));
    this.set(this.start + old * anchor - span * anchor, span);
  }
  pan(delta: number): void { if (Number.isFinite(delta)) this.set(this.start + delta, this.end - this.start); }
  private set(start: number, span: number): void { this.start = Math.max(this.min, Math.min(this.max - span, start)); this.end = this.start + span; this.emit(); }
  at(fraction: number): number { return this.start + Math.max(0, Math.min(1, fraction)) * (this.end - this.start); }
}
