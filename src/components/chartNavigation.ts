import { TimeViewport } from '../data/chartViewport';
export function formatChartTime(t: number): string { const span = sixAxisViewport.end - sixAxisViewport.start; return t.toFixed(Math.max(1, Math.min(6, Math.ceil(-Math.log10(Math.max(span, 1e-9))) + 2))); }
export const sixAxisViewport = new TimeViewport();
const pending = new Set<() => void>();
let frame = 0;
function schedule(fn: () => void): void { pending.add(fn); if (!frame) frame = requestAnimationFrame(() => { frame = 0; const jobs = [...pending]; pending.clear(); jobs.forEach(job => job()); }); }
const vertical = new Map<HTMLCanvasElement, { factor: number; offset: number }>();
export function yRange(canvas: HTMLCanvasElement, lo: number, hi: number): [number, number] {
  const state = vertical.get(canvas) ?? { factor: 1, offset: 0 };
  const width = Math.max(hi - lo, 1e-9), half = width * state.factor / 2, center = (lo + hi) / 2 + state.offset * width;
  return [center - half, center + half];
}
export function resetChartView(): void { for (const s of vertical.values()) { s.factor = 1; s.offset = 0; } sixAxisViewport.reset(); }
export function bindChartNavigation(canvas: HTMLCanvasElement, redraw: () => void, left: number, right: number): void {
  const state = { factor: 1, offset: 0 }; vertical.set(canvas, state);
  canvas.style.touchAction = 'none'; canvas.style.cursor = 'grab'; canvas.title = '滚轮缩放时间；拖动平移；Shift+滚轮缩放纵轴；Shift+拖动平移纵轴；双击恢复全图';
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null, suppress = false;
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); const rect = canvas.getBoundingClientRect(), f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * .002)));
    if (e.shiftKey) { state.factor = Math.max(.001, Math.min(100, state.factor * f)); redraw(); }
    else sixAxisViewport.zoom(f, (e.clientX - rect.left - left) / Math.max(1, rect.width - left - right));
  }, { passive: false });
  canvas.addEventListener('pointerdown', e => { if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};suppress=false;canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing'; });
  canvas.addEventListener('pointermove', e => {
    if(!drag || e.pointerId!==drag.id)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(!drag.moved && Math.hypot(dx,dy)<4)return;
    drag.moved=true;const rect=canvas.getBoundingClientRect();drag.x=e.clientX;drag.y=e.clientY;
    if(e.shiftKey){state.offset+=dy/Math.max(1,rect.height-48)*state.factor;redraw();}
    else sixAxisViewport.pan(-dx/Math.max(1,rect.width-left-right)*(sixAxisViewport.end-sixAxisViewport.start));
  });
  const end=(e:PointerEvent)=>{if(!drag||e.pointerId!==drag.id)return;suppress=drag.moved;drag=null;canvas.style.cursor='grab';if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);};
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('lostpointercapture',()=>{if(drag){suppress=drag.moved;drag=null;canvas.style.cursor='grab';}});
  canvas.addEventListener('click',e=>{if(suppress){e.stopImmediatePropagation();suppress=false;}},true);
  canvas.addEventListener('dblclick',e=>{e.preventDefault();resetChartView();});
  sixAxisViewport.onChange(()=>{canvas.dataset.timeStart=String(sixAxisViewport.start);canvas.dataset.timeEnd=String(sixAxisViewport.end);schedule(redraw);});
}
