import { sixAxisViewport, bindChartNavigation, yRange, resetChartView, formatChartTime } from './chartNavigation';
import './SixAxisComparisonPanel.css';
import { getSixAxisVisibility, onSixAxisVisibilityChange } from '../data/sixAxisVisibility';
import { runStandardSixAxisEskf, runHuberSixAxisEskf, type SixAxisEskfResult } from '../filters/sixAxisEskf';
import { comparisonRows } from '../data/comparisonView';
import { setSoftwareInterference, type SharedRecording } from '../data/sharedRecording';

type Line = { label: string; values: number[]; color: string };
export class SixAxisComparisonPanel {
  private element: HTMLElement;
  private record: SharedRecording | null = null;
  private a0: SixAxisEskfResult | null = null;
  private a4: SixAxisEskfResult | null = null;
  private b0: SixAxisEskfResult | null = null;
  private b4: SixAxisEskfResult | null = null;
  private baselineKey = '';
  private cursor = 0;
  constructor(parent: HTMLElement) {
    this.element = document.createElement('section'); this.element.className = 'comparison-demo panel-card';
    this.element.innerHTML = `<div class="comparison-toolbar"><button id="six-original" class="btn btn-sm">原始记录</button><button id="six-software" class="btn btn-primary btn-sm">软件干扰演示</button><span id="six-scenario" role="status"></span></div><div class="comparison-input"><canvas aria-label="加速度X原始与注入后对比"></canvas></div><details id="six-nine-grid"><summary>展开九宫格：估计值 / 偏差 / 真实权重</summary><p>偏差参考同一算法的未注入结果，非真值误差。右列为全局均值权重，不是各姿态轴独立权重。</p><div class="nine-grid"></div></details><div class="comparison-toolbar"><label for="six-analysis-time">同步时间</label><input id="six-analysis-time" type="range" min="0" max="0" value="0"><span id="six-analysis-label"></span><button id="six-export-view" class="btn btn-sm">导出对比与偏差</button></div>`;
    parent.insertBefore(this.element, parent.querySelector('.charts-stack'));
    const detail = this.element.querySelector('details')!;
    detail.insertBefore(this.element.querySelector('.comparison-input')!, detail.querySelector('p'));
    detail.querySelector('p')!.textContent += ' 仅传播帧的权重占位值不表示采纳了观测。';
    this.element.querySelector('#six-original')!.addEventListener('click',()=>setSoftwareInterference(false));
    this.element.querySelector('#six-software')!.addEventListener('click',()=>{ try { setSoftwareInterference(true); } catch(e) { this.element.querySelector('#six-scenario')!.textContent = String(e); } });
    const grid = this.element.querySelector('.nine-grid')!;
    ['Roll','Pitch','相对 Yaw'].forEach(axis => ['估计值 (°)','相对未注入结果的偏差 (°)','全局平均权重 (0–1)'].forEach(title=>{
      const box=document.createElement('div');box.className='nine-cell';const label=document.createElement('h3');label.textContent=axis+' · '+title;const canvas=document.createElement('canvas');canvas.setAttribute('aria-label',label.textContent);box.append(label,canvas);grid.append(box);
    }));
    this.element.querySelector('details')!.addEventListener('toggle',()=>this.draw());
    this.element.querySelector('input')!.addEventListener('input',e=>{this.cursor=Number((e.target as HTMLInputElement).value);this.draw();});
    this.element.querySelector('#six-export-view')!.addEventListener('click',()=>this.export());
    const redraw=()=>this.draw();
    onSixAxisVisibilityChange(redraw);
    this.element.querySelectorAll('canvas').forEach(canvas=>bindChartNavigation(canvas,redraw,48,12));
    const reset=document.createElement('button');reset.className='btn btn-sm';reset.textContent='恢复全图';reset.id='six-chart-reset';reset.onclick=resetChartView;this.element.querySelector('.comparison-toolbar')!.append(reset);
    const hint=document.createElement('span');hint.className='muted-text';hint.textContent='滚轮缩放 · 拖动平移 · Shift 调整纵轴';this.element.querySelector('.comparison-toolbar')!.append(hint);
    const range=document.createElement('span');range.id='six-visible-range';range.className='muted-text';this.element.querySelector('.comparison-toolbar')!.append(range);
    this.element.querySelectorAll('canvas').forEach(canvas=>canvas.addEventListener('click',e=>{
      if(!this.record)return; const rect=canvas.getBoundingClientRect(),times=this.record.dataset.times;
      const t=sixAxisViewport.at((e.clientX-rect.left-48)/(rect.width-60));
      this.cursor=times.reduce((b,v,i)=>Math.abs(v-t)<Math.abs(times[b]-t)?i:b,0);this.draw();
    }));
    new ResizeObserver(()=>this.draw()).observe(this.element);
  }
  update(record: SharedRecording, a0: SixAxisEskfResult, a4: SixAxisEskfResult): void {
    const base=record.baseline??record.dataset;
    const key=base.id+JSON.stringify(a0.params);
    if(key!==this.baselineKey){this.b0=record.interference?runStandardSixAxisEskf(base,a0.params):a0;this.b4=record.interference?runHuberSixAxisEskf(base,a4.params):a4;this.baselineKey=key;}
    this.record=record;this.a0=a0;this.a4=a4;this.cursor=0;
    const pulse=record.interference;
    this.element.querySelector('#six-scenario')!.textContent=pulse?`软件注入，非真实外部干扰 · ax +${pulse.amplitude} m/s² · ${pulse.start.toFixed(2)}–${pulse.end.toFixed(2)}s · ${pulse.count} 帧`:'原始记录 · 未注入 · 无独立真值';
    this.element.querySelectorAll<HTMLButtonElement>('#six-original,#six-software').forEach(b=>b.setAttribute('aria-pressed',String(b.id===(pulse?'six-software':'six-original'))));
    (this.element.querySelector('input') as HTMLInputElement).max=String(record.dataset.times.length-1);this.draw();
  }
  private plot(canvas: HTMLCanvasElement, lines: Line[], title: string, weight=false): void {
    if(!this.record||canvas.getBoundingClientRect().width===0)return;
    const times=this.record.dataset.times,w=canvas.parentElement!.clientWidth,h=155,dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d')!;ctx.scale(dpr,dpr);
    let low=weight?0:Infinity,high=weight?1:-Infinity;
    if(!weight){for(const line of lines)for(const v of line.values){low=Math.min(low,v);high=Math.max(high,v);}if(!Number.isFinite(low)||!Number.isFinite(high)){low=-1;high=1;}const pad=Math.max(.02,(high-low)*.1);low-=pad;high+=pad;}
    [low,high]=yRange(canvas,low,high);
    const x=(t:number)=>48+(t-sixAxisViewport.start)/Math.max(1e-9,sixAxisViewport.end-sixAxisViewport.start)*(w-60),y=(v:number)=>31+(high-v)/(high-low)*99;
    ctx.font='11px Microsoft YaHei,sans-serif';ctx.fillStyle='#94a3b8';ctx.fillText(title,48,14);
    if(this.record.interference){ctx.fillStyle='rgba(251,191,36,.14)';const p=this.record.interference;const x0=Math.max(48,x(p.start)),x1=Math.min(w-12,x(p.end));if(x1>x0)ctx.fillRect(x0,25,x1-x0,105);}
    for(let i=0;i<3;i++){const v=low+(high-low)*i/2;ctx.fillStyle='#94a3b8';ctx.fillText(v.toFixed(2),1,y(v)+3);ctx.strokeStyle='#27364b';ctx.beginPath();ctx.moveTo(48,y(v));ctx.lineTo(w-12,y(v));ctx.stroke();ctx.fillText(formatChartTime(sixAxisViewport.at(i/2))+'s',48+(w-90)*i/2,151);}
    ctx.save();ctx.beginPath();ctx.rect(48,25,w-60,106);ctx.clip();
    lines.forEach((line,n)=>{ctx.strokeStyle=line.color;ctx.lineWidth=1.8;ctx.setLineDash(n===0?[4,3]:[]);ctx.beginPath();line.values.forEach((v,i)=>{if(!i||Math.abs(v-line.values[i-1])>180)ctx.moveTo(x(times[i]),y(v));else ctx.lineTo(x(times[i]),y(v));});ctx.stroke();});
    ctx.setLineDash([]);ctx.strokeStyle='#f1f5f9';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x(times[this.cursor]),25);ctx.lineTo(x(times[this.cursor]),131);ctx.stroke();ctx.restore();
  }
  private draw(): void {
    if(!this.record||!this.a0||!this.a4||!this.b0||!this.b4)return;
    this.element.querySelector('#six-visible-range')!.textContent=`时间窗 ${formatChartTime(sixAxisViewport.start)}–${formatChartTime(sixAxisViewport.end)} s`;
    const original=this.record.baseline??this.record.dataset;
    this.plot(this.element.querySelector('.comparison-input canvas')!,[{label:'原始',values:original.ax,color:'#94a3b8'},{label:'当前',values:this.record.dataset.ax,color:'#fbbf24'}],'加速度 X (m/s²)：灰=原始，黄=当前输入');
    const vis = getSixAxisVisibility();
    const rows=comparisonRows(this.a0,this.a4,this.b0,this.b4),canvases=this.element.querySelectorAll<HTMLCanvasElement>('.nine-grid canvas');
    rows.forEach((row,i)=>{
      const estLines: Line[] = [];
      if (vis.a0) estLines.push({label:'标准',values:row.standard,color:'#34d399'});
      if (vis.a4) estLines.push({label:'鲁棒',values:row.robust,color:'#c084fc'});
      const devLines: Line[] = [];
      if (vis.a0) devLines.push({label:'标准偏差',values:row.standardDeviation,color:'#34d399'});
      if (vis.a4) devLines.push({label:'鲁棒偏差',values:row.robustDeviation,color:'#c084fc'});
      const wLines: Line[] = [];
      if (vis.wy) wLines.push({label:'Wy',values:this.a4!.wyMean,color:'#fbbf24'});
      if (vis.wx) wLines.push({label:'Wx',values:this.a4!.wxMean,color:'#60a5fa'});
      this.plot(canvases[i*3],estLines,'绿虚线=标准，紫实线=鲁棒');
      this.plot(canvases[i*3+1],devLines,'同算法：当前 − 未注入（角度环绕处理）');
      this.plot(canvases[i*3+2],wLines,'黄虚线=Wy，蓝实线=Wx（各行同一全局值）',true);
    });
    (this.element.querySelector('input') as HTMLInputElement).value=String(this.cursor);
    this.element.querySelector('#six-analysis-label')!.textContent=this.record.dataset.times[this.cursor].toFixed(3)+' s · '+(this.a4.statuses[this.cursor]==='SIX_AXIS_NOMINAL'?'正常更新':'仅传播（无观测更新）');
  }
  private export(): void {
    if(!this.record||!this.a0||!this.a4||!this.b0||!this.b4)return;
    const rows=comparisonRows(this.a0,this.a4,this.b0,this.b4);
    const csv=['# No ground truth; deviations relative to same-algorithm uninjected baseline',`# software_injection=${JSON.stringify(this.record.interference??null)}`,'time_s,axis,standard_deg,robust_deg,standard_deviation_deg,robust_deviation_deg,global_wy_mean,global_wx_mean,status'];
    this.record.dataset.times.forEach((t,i)=>rows.forEach(row=>csv.push([t,row.field,row.standard[i],row.robust[i],row.standardDeviation[i],row.robustDeviation[i],this.a4!.wyMean[i],this.a4!.wxMean[i],this.a4!.statuses[i]].join(','))));
    const url=URL.createObjectURL(new Blob([csv.join('\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='six_axis_deviation_weights.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
