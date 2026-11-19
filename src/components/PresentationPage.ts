import { shareRecording, observeRecording } from '../data/sharedRecording';
import { readSensorAttitude, type SensorAttitude } from '../data/sensorAttitude';
import './PresentationPage.css';
import { Viewport3D } from './Viewport3D';
import { SixAxisImportModal } from './SixAxisImportModal';
import { createSimulatedSixAxisDataset } from '../data/sixAxisParser';
import { importPresentationCsv } from '../data/presentationImport';
import { inspectWitMotionBin } from '../data/witMotionBin';
import { runStandardSixAxisEskf, runHuberSixAxisEskf, buildSixAxisEskfComparisonCsv } from '../filters/sixAxisEskf';
import type { SixAxisEskfResult } from '../filters/sixAxisEskf';
import type { SixAxisDataset } from '../types/sixAxis';

export function mountPresentationPage(advanced: HTMLElement): void {
  advanced.hidden = true;
  const page = document.createElement('main');
  page.className = 'presentation';
  page.innerHTML = `
    <header class="show-header"><div><span class="show-eyebrow">ATTITUDE WORKBENCH</span><h1>云台姿态演示</h1></div>
      <div class="show-actions"><button id="show-import" class="btn btn-primary">导入记录</button><button id="show-demo" class="btn">加载演示</button><button id="show-full" class="btn">全屏</button><button id="show-check" class="btn">六轴分析</button></div></header>
    <div class="show-status"><span id="show-file">加载模拟演示中…</span><span>无磁 · 相对偏航 · 无独立真值</span></div>
    <p id="show-error" role="alert" hidden></p>
    <section class="show-grid"><article class="show-model"><div class="show-panel-title"><h2>三维姿态</h2><select id="show-source" aria-label="模型数据源"><option value="robust">鲁棒滤波</option><option value="standard">标准滤波</option><option value="sensor" disabled hidden>传感器姿态</option></select><button id="show-camera" class="btn">重置视角</button></div>
      <div id="show-viewport"></div><div id="show-angles" class="show-angles"></div></article>
    <article class="show-curves"><div class="show-panel-title"><h2>姿态对比</h2><span id="show-sensor-legend" class="show-blue" hidden>━ 传感器姿态（非真值）</span><span class="show-green">━ 标准滤波</span><span class="show-purple">━ 鲁棒滤波</span></div>
      <div class="show-chart"><canvas aria-label="横滚角对比"></canvas></div><div class="show-chart"><canvas aria-label="俯仰角对比"></canvas></div><div class="show-chart"><canvas aria-label="相对偏航角对比"></canvas></div></article></section>
    <footer class="show-playback"><button id="show-play" class="btn btn-primary">播放</button><button id="show-restart" class="btn">重新播放</button><input id="show-slider" aria-label="播放进度" type="range" min="0" max="0" value="0"><span id="show-time"></span><select id="show-speed" aria-label="播放倍速"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><button id="show-export" class="btn">导出结果</button></footer>`;
  advanced.before(page);
  const el = <T extends HTMLElement>(id: string) => page.querySelector<T>(`#show-${id}`)!;
  const viewport = new Viewport3D(el('viewport'));
  const slider = el<HTMLInputElement>('slider');
  const canvases = Array.from(page.querySelectorAll<HTMLCanvasElement>('.show-chart canvas'));
  let dataset: SixAxisDataset;
  let standard: SixAxisEskfResult;
  let robust: SixAxisEskfResult;
  let sensor: SensorAttitude | null = null;
  let index = 0;
  let playing = false;
  let clock = 0;
  let last = 0;
  let importVersion = 0;
  const stop = () => { playing = false; el('play').textContent = '播放'; };
  function draw(): void {
    if (!standard) return;
    const fields = ['rollDeg', 'pitchDeg', 'yawDeg'] as const;
    const titles = ['Roll 横滚角 (°)', 'Pitch 俯仰角 (°)', 'Yaw 相对偏航角 (°)'];
    const times = dataset.times;
    const duration = Math.max(times.at(-1)!, 1e-6);
    canvases.forEach((canvas, axis) => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      const w = Math.max(rect.width, 200), h = Math.max(rect.height, 100);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d')!; ctx.scale(dpr, dpr);
      const a = standard[fields[axis]], b = robust[fields[axis]], c = sensor?.[fields[axis]];
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < times.length; i++) { lo = Math.min(lo, a[i], b[i], c?.[i] ?? Infinity); hi = Math.max(hi, a[i], b[i], c?.[i] ?? -Infinity); }
      const padding = Math.max(1, (hi - lo) * .12); lo -= padding; hi += padding;
      const left = 54, top = 26, pw = w - left - 14, ph = h - top - 26;
      const x = (t: number) => left + t / duration * pw;
      const y = (v: number) => top + (hi - v) / (hi - lo) * ph;
      ctx.font = '12px Microsoft YaHei, sans-serif'; ctx.fillStyle = '#dbe5f5'; ctx.fillText(titles[axis], left, 17);
      for (let j = 0; j <= 2; j++) {
        const v = lo + (hi - lo) * j / 2;
        ctx.strokeStyle = '#243044'; ctx.beginPath(); ctx.moveTo(left, y(v)); ctx.lineTo(w - 14, y(v)); ctx.stroke();
        ctx.fillStyle = '#94a3b8'; ctx.fillText(v.toFixed(1), 4, y(v) + 4);
        ctx.fillText((duration * j / 2).toFixed(1) + 's', x(duration * j / 2) - 12, h - 5);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
      (c ? [a, b, c] : [a, b]).forEach((values, n) => {
        ctx.strokeStyle = ['#34d399', '#c084fc', '#60a5fa'][n]; ctx.lineWidth = 2; ctx.setLineDash(n === 0 ? [5, 3] : []); ctx.beginPath();
        values.forEach((v, i) => { if (i === 0 || Math.abs(v - values[i - 1]) > 180) ctx.moveTo(x(times[i]), y(v)); else ctx.lineTo(x(times[i]), y(v)); }); ctx.stroke();
      });
      ctx.setLineDash([]); ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(times[index]), top); ctx.lineTo(x(times[index]), top + ph); ctx.stroke(); ctx.restore();
    });
  }
  function render(): void {
    if (!standard) return;
    const source = el<HTMLSelectElement>('source').value;
    const result = source === 'sensor' && sensor ? sensor : source === 'standard' ? standard : robust;
    viewport.setAttitude(result.rollDeg[index], result.pitchDeg[index], result.yawDeg[index], 'ZYX');
    el('angles').textContent = `Roll ${result.rollDeg[index].toFixed(1)}°　 Pitch ${result.pitchDeg[index].toFixed(1)}°　 Yaw ${result.yawDeg[index].toFixed(1)}°`;
    slider.value = String(index);
    el('time').textContent = `${dataset.times[index].toFixed(2)} / ${dataset.times.at(-1)!.toFixed(2)} s`;
    draw();
  }
  function load(ds: SixAxisDataset, sourceText?: string, publish = true): void {
    const a = runStandardSixAxisEskf(ds), b = runHuberSixAxisEskf(ds);
    const nextSensor = sourceText ? readSensorAttitude(sourceText, ds) : null;
    stop(); sensor = nextSensor; el('sensor-legend').hidden = !sensor;
    const sensorOption = el<HTMLSelectElement>('source').querySelector<HTMLOptionElement>('[value=sensor]')!;
    sensorOption.disabled = !sensor; sensorOption.hidden = !sensor;
    if (!sensor && el<HTMLSelectElement>('source').value === 'sensor') el<HTMLSelectElement>('source').value = 'robust';
    dataset = ds; standard = a; robust = b; index = 0; clock = 0;
    slider.max = String(ds.times.length - 1);
    const c = ds.programChecks;
    el('file').textContent = `${ds.isSimulatedSample ? '模拟演示' : ds.filename} · ${ds.times.length} 帧 · ${c.effectiveHz.toFixed(1)} Hz · ${c.binVerified ? '已检查 BIN' : '仅 CSV，未验证通道同步'}${c.excludedCount ? ` · 排除 ${c.excludedCount} 条` : ''}${c.gapCount ? ` · ${c.gapCount} 处缺口` : ''}`;
    el('error').hidden = true; render();
    if (publish) shareRecording({ dataset: ds, text: sourceText, origin: 'presentation' });
  }
  const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = '.csv,.bin'; fileInput.multiple = true; fileInput.hidden = true; page.append(fileInput);
  el('import').onclick = () => { fileInput.value = ''; fileInput.click(); };
  fileInput.onchange = async () => {
    const version = ++importVersion;
    const files = Array.from(fileInput.files ?? []);
    const csvs = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    const bins = files.filter(f => f.name.toLowerCase().endsWith('.bin'));
    try {
      if (csvs.length !== 1 || bins.length > 1) throw new Error('请选择一份 WitMotion CSV，可同时选择对应的 BIN。');
      const bin = bins[0] ? inspectWitMotionBin(new Uint8Array(await bins[0].arrayBuffer()), bins[0].name) : null;
      const text = await csvs[0].text();
      const result = importPresentationCsv(text, csvs[0].name, bin);
      if (version !== importVersion) return;
      if ('errors' in result) throw new Error(result.errors.slice(0, 2).join('；'));
      load(result.dataset, text);
    } catch (e) {
      if (version !== importVersion) return;
      el('error').hidden = false; el('error').textContent = `导入失败，原数据保留。${e instanceof Error ? e.message : String(e)} 可在「数据检查」中手动配置。`;
    }
  };
  const manual = new SixAxisImportModal(ds => { ++importVersion; load(ds); });
  const back = document.createElement('button'); back.className = 'btn presentation-back'; back.textContent = '三维回放'; back.hidden = true; advanced.before(back);
  function showAdvanced(show: boolean): void { const oldPlay = advanced.querySelector<HTMLButtonElement>('#btn-play-pause'); if (!show && oldPlay?.textContent?.includes('暂停')) oldPlay.click(); stop(); page.hidden = show; advanced.hidden = !show; back.hidden = !show; if (!show) requestAnimationFrame(render); }
  el('check').onclick = () => { showAdvanced(true); advanced.querySelector<HTMLButtonElement>('#tab-btn-six-axis')!.click(); };
  back.onclick = () => showAdvanced(false);
  const manualButton = document.createElement('button'); manualButton.className = 'btn presentation-manual'; manualButton.textContent = '手动导入到演示'; manualButton.onclick = () => manual.open(); back.after(manualButton); manualButton.hidden = true;
  back.addEventListener('click', () => { manualButton.hidden = true; });
  el('check').addEventListener('click', () => { manualButton.hidden = false; });
  el('demo').onclick = () => { ++importVersion; load(createSimulatedSixAxisDataset()); };
  el('play').onclick = () => { if (playing) stop(); else { if (index === dataset.times.length - 1) { index = 0; clock = 0; } playing = true; last = performance.now(); el('play').textContent = '暂停'; render(); } };
  el('restart').onclick = () => { index = 0; clock = 0; playing = true; last = performance.now(); el('play').textContent = '暂停'; render(); };
  slider.oninput = () => { stop(); index = Number(slider.value); clock = dataset.times[index]; render(); };
  el('source').onchange = render;
  el('camera').onclick = () => viewport.resetCamera();
  el('full').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { el('error').hidden = false; el('error').textContent = '浏览器未允许全屏，可使用 F11。'; } };
  el('export').onclick = () => {
    const blob = new Blob([buildSixAxisEskfComparisonCsv(dataset, standard, robust)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'six_axis_eskf_comparison.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  canvases.forEach(canvas => canvas.onclick = e => { const rect = canvas.getBoundingClientRect(); const t = Math.max(0, Math.min(1, (e.clientX - rect.left - 54) / (rect.width - 68))) * dataset.times.at(-1)!; stop(); index = dataset.times.reduce((best, v, i) => Math.abs(v - t) < Math.abs(dataset.times[best] - t) ? i : best, 0); clock = dataset.times[index]; render(); });
  new ResizeObserver(() => { if (!page.hidden) draw(); }).observe(el('viewport'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  function tick(now: number): void { if (playing) { clock += (now - last) / 1000 * Number(el<HTMLSelectElement>('speed').value); while (index + 1 < dataset.times.length && dataset.times[index + 1] <= clock) index++; if (index === dataset.times.length - 1) stop(); render(); } last = now; requestAnimationFrame(tick); }
  observeRecording(record => { if (record.origin !== 'presentation') { ++importVersion; load(record.dataset, record.text, false); } });
  load(createSimulatedSixAxisDataset()); showAdvanced(true); manualButton.hidden = false; advanced.querySelector<HTMLButtonElement>('#tab-btn-six-axis')!.click(); requestAnimationFrame(tick);
}
