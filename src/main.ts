import './style.css';
import { AttitudeCharts } from './components/AttitudeCharts';
import { CsvImportModal } from './components/CsvImportModal';
import { Viewport3D } from './components/Viewport3D';
import {
  CURSOR_COLOR,
  DISTURBANCE_MARKER_COLOR,
  SERIES_ORDER,
  SERIES_STYLES,
} from './constants/seriesStyle';
import { createDemoDataset, createPositionDerivedDataset } from './data/demoData';
import { applyDisturbance, computeDeviationFromOriginal } from './data/disturbance';
import {
  DEFAULT_KF_PARAMS,
  huberAngleKfFilter,
  standardAngleKfFilter,
} from './filters/angleKf';
import { robustResidualFilter, standardSmoothingFilter } from './filters/demoFilters';
import { fullImuAttitudeEkfPlaceholder } from './filters/imuEkfInterface';
import { findNearestFrameIndex, periodicAngleDiff } from './math/angles';
import type {
  AppliedDisturbance,
  AttitudeDataset,
  AxisKey,
  DataSourceId,
  DisturbanceConfig,
  DisturbanceType,
  SeriesData,
  SourceDeviationStats,
} from './types/attitude';

type FilterMode = 'kf' | 'smooth';

interface AppState {
  dataset: AttitudeDataset;
  filterMode: FilterMode;
  kfMu: number;
  disturbanceConfig: DisturbanceConfig;
  appliedDisturbance: AppliedDisturbance | null;
  seriesMap: Record<DataSourceId, SeriesData>;
  deviations: Record<DataSourceId, SourceDeviationStats | null>;
  visibleSeries: Record<DataSourceId, boolean>;
  modelSource: DataSourceId;
  currentIndex: number;
  playTimeSec: number;
  isPlaying: boolean;
  speed: 0.5 | 1 | 2;
}

function buildInitialAppHtml(): string {
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-left">
          <h1 class="app-title">三轴云台姿态可视化实验台</h1>
          <div class="topbar-actions">
            <button id="btn-import-csv" class="btn btn-primary" type="button">导入 CSV</button>
            <button id="btn-load-new" class="btn" type="button">加载新数据</button>
            <button id="btn-load-demo" class="btn" type="button">加载示例</button>
          </div>
        </div>
        <div class="topbar-meta">
          <span class="meta-pill">文件：<strong id="meta-filename">-</strong></span>
          <span id="meta-source-pill" class="meta-pill">来源：<strong id="meta-source">-</strong></span>
          <span class="meta-pill">样本数：<strong id="meta-count">0</strong></span>
        </div>
      </header>

      <section class="upper-grid">
        <div class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">三维姿态视图</h2>
            <span id="convention-badge" class="convention-badge">-</span>
          </div>
          <div id="viewport-3d" class="viewport-wrap">
            <div class="viewport-overlay-top">
              <button id="btn-reset-cam" class="btn btn-sm" type="button">重置视角</button>
            </div>
          </div>
          <div class="model-footer">
            <div class="model-source-select">
              <label for="select-model-source" class="muted-text">模型跟随数据源：</label>
              <select id="select-model-source">
                <option value="raw">原日志</option>
                <option value="disturbed">受扰数据</option>
                <option value="filter_standard">标准角度KF（简化演示）</option>
                <option value="filter_robust">Huber鲁棒角度KF（简化演示）</option>
              </select>
            </div>
            <div class="angle-pills">
              <div class="angle-pill"><span>R</span><strong id="model-roll">0.00°</strong></div>
              <div class="angle-pill"><span>P</span><strong id="model-pitch">0.00°</strong></div>
              <div class="angle-pill"><span>Y</span><strong id="model-yaw">0.00°</strong></div>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">人工干扰注入与滤波对比</h2>
            <div class="filter-mode-bar">
              <label for="select-filter-mode" class="muted-text">滤波模式：</label>
              <select id="select-filter-mode">
                <option value="kf">角度KF（参考文档简化实现）</option>
                <option value="smooth">角度平滑（旧演示回退）</option>
              </select>
              <label for="input-kf-mu" class="muted-text" id="lbl-kf-mu">μ(演示选值)：</label>
              <input id="input-kf-mu" type="number" step="0.1" min="0.1" value="${DEFAULT_KF_PARAMS.mu}" style="width:62px;" />
              <button id="btn-export-diag" class="btn btn-sm" type="button">导出诊断CSV</button>
            </div>
          </div>

          <div class="disturbance-form">
            <div class="field-group">
              <label for="dist-type">干扰类型</label>
              <select id="dist-type">
                <option value="spike">单帧尖峰</option>
                <option value="interval">连续区间偏移</option>
              </select>
            </div>
            <div class="field-group">
              <label for="dist-axis">目标轴</label>
              <select id="dist-axis">
                <option value="pitch">Pitch (俯仰)</option>
                <option value="roll">Roll (横滚)</option>
                <option value="yaw">Yaw (偏航)</option>
              </select>
            </div>
            <div class="field-group">
              <label for="dist-start">起点时间 (s)</label>
              <input id="dist-start" type="number" step="0.02" value="8.0" />
            </div>
            <div class="field-group">
              <label for="dist-amp">幅度 (°)</label>
              <input id="dist-amp" type="number" step="1" value="20" />
            </div>
            <div class="field-group" id="dist-dur-group">
              <label for="dist-dur">持续时间 (s)</label>
              <input id="dist-dur" type="number" step="0.1" min="0.02" value="2.0" disabled />
            </div>
          </div>

          <div class="disturbance-actions">
            <div id="dist-hit-status" class="hit-status">未注入干扰（受扰数据与原日志一致）</div>
            <div class="disturbance-btns">
              <button id="btn-apply-dist" class="btn btn-primary btn-sm" type="button">应用</button>
              <button id="btn-clear-dist" class="btn btn-danger btn-sm" type="button">清除</button>
            </div>
          </div>

          <div class="readings-wrap">
            <table class="readings-table">
              <thead>
                <tr>
                  <th>数据源</th>
                  <th>Roll (°)</th>
                  <th>Pitch (°)</th>
                  <th>Yaw (°)</th>
                  <th>相对原日志的偏差 (当前Δ · 三轴最大RMSE / Max)</th>
                  <th>帧权重 (R/P/Y)</th>
                </tr>
              </thead>
              <tbody id="readings-tbody"></tbody>
            </table>
          </div>
          <div id="filter-params-note" class="ref-note"></div>
          <div id="kf-diag-bar" class="ref-note mono"></div>
          <div id="imu-ekf-status" class="ref-note"></div>
          <div class="ref-note">
            注：无独立姿态真值参考时，统计量均为「相对原日志的偏差」（原日志本身可能含噪）。Huber 仅观测降权 (Ψx=I) 为参考文档的简化实现，均属演示算法。
          </div>
        </div>
      </section>

      <section class="playback-bar">
        <div class="playback-controls">
          <button id="btn-play-pause" class="btn btn-primary btn-sm" type="button">播放</button>
          <button id="btn-prev-frame" class="btn btn-sm" type="button">◀ 上一帧</button>
          <button id="btn-next-frame" class="btn btn-sm" type="button">下一帧 ▶</button>
        </div>
        <input id="playback-slider" class="playback-slider" type="range" min="0" max="100" value="0" />
        <div class="speed-group" role="group" aria-label="播放倍速">
          <button class="speed-btn" data-speed="0.5" type="button">0.5×</button>
          <button class="speed-btn active" data-speed="1" type="button">1×</button>
          <button class="speed-btn" data-speed="2" type="button">2×</button>
        </div>
        <div id="playback-time" class="playback-time">t = 0.000s / 0.000s · 第 1 / 1 帧</div>
      </section>

      <section class="charts-panel">
        <div class="legend-bar">
          <div id="legend-toggles" class="legend-toggles"></div>
          <div class="legend-markers">
            <span class="marker-badge">
              <span style="display:inline-block;width:14px;height:2px;background:${CURSOR_COLOR};"></span>
              当前时间游标
            </span>
            <span class="marker-badge">
              <span style="display:inline-block;width:12px;height:10px;background:rgba(239,68,68,0.25);border:1px dashed ${DISTURBANCE_MARKER_COLOR};"></span>
              干扰命中帧 / 区间
            </span>
            <span>点击或拖动曲线跳到最近真实采样帧</span>
          </div>
        </div>
        <div class="charts-stack">
          <div class="chart-box"><canvas id="chart-roll"></canvas></div>
          <div class="chart-box"><canvas id="chart-pitch"></canvas></div>
          <div class="chart-box"><canvas id="chart-yaw"></canvas></div>
        </div>
      </section>
    </div>
  `;
}

function main(): void {
  const root = document.getElementById('app')!;
  root.innerHTML = buildInitialAppHtml();

  const initialDataset = createDemoDataset();
  const state: AppState = {
    dataset: initialDataset,
    filterMode: 'kf',
    kfMu: DEFAULT_KF_PARAMS.mu,
    disturbanceConfig: {
      enabled: false,
      type: 'spike',
      axis: 'pitch',
      startTime: 8.0,
      amplitude: 20,
      duration: 2.0,
    },
    appliedDisturbance: null,
    seriesMap: {
      raw: { roll: initialDataset.roll, pitch: initialDataset.pitch, yaw: initialDataset.yaw },
      disturbed: { roll: initialDataset.roll, pitch: initialDataset.pitch, yaw: initialDataset.yaw },
      filter_standard: { roll: [], pitch: [], yaw: [] },
      filter_robust: { roll: [], pitch: [], yaw: [] },
    },
    deviations: {
      raw: null,
      disturbed: null,
      filter_standard: null,
      filter_robust: null,
    },
    visibleSeries: {
      raw: true,
      disturbed: true,
      filter_standard: true,
      filter_robust: true,
    },
    modelSource: 'raw',
    currentIndex: 0,
    playTimeSec: 0,
    isPlaying: false,
    speed: 1,
  };

  // DOM Elements
  const metaFilename = document.getElementById('meta-filename')!;
  const metaSource = document.getElementById('meta-source')!;
  const metaSourcePill = document.getElementById('meta-source-pill')!;
  const metaCount = document.getElementById('meta-count')!;
  const conventionBadge = document.getElementById('convention-badge')!;
  const selectModelSource = document.getElementById('select-model-source') as HTMLSelectElement;
  const modelRollEl = document.getElementById('model-roll')!;
  const modelPitchEl = document.getElementById('model-pitch')!;
  const modelYawEl = document.getElementById('model-yaw')!;

  const distTypeEl = document.getElementById('dist-type') as HTMLSelectElement;
  const distAxisEl = document.getElementById('dist-axis') as HTMLSelectElement;
  const distStartEl = document.getElementById('dist-start') as HTMLInputElement;
  const distAmpEl = document.getElementById('dist-amp') as HTMLInputElement;
  const distDurEl = document.getElementById('dist-dur') as HTMLInputElement;
  const distHitStatus = document.getElementById('dist-hit-status')!;

  const readingsTbody = document.getElementById('readings-tbody')!;
  const filterParamsNote = document.getElementById('filter-params-note')!;
  const kfDiagBar = document.getElementById('kf-diag-bar')!;
  const imuEkfStatusEl = document.getElementById('imu-ekf-status')!;
  const selectFilterMode = document.getElementById('select-filter-mode') as HTMLSelectElement;
  const inputKfMu = document.getElementById('input-kf-mu') as HTMLInputElement;
  const lblKfMu = document.getElementById('lbl-kf-mu')!;
  const btnExportDiag = document.getElementById('btn-export-diag') as HTMLButtonElement;
  const btnPlayPause = document.getElementById('btn-play-pause') as HTMLButtonElement;
  const btnPrevFrame = document.getElementById('btn-prev-frame') as HTMLButtonElement;
  const btnNextFrame = document.getElementById('btn-next-frame') as HTMLButtonElement;
  const playbackSlider = document.getElementById('playback-slider') as HTMLInputElement;
  const playbackTimeEl = document.getElementById('playback-time')!;
  const legendTogglesEl = document.getElementById('legend-toggles')!;

  // 3D Viewport & Charts
  const viewport3D = new Viewport3D(document.getElementById('viewport-3d')!);
  const charts = new AttitudeCharts(
    {
      roll: document.getElementById('chart-roll') as HTMLCanvasElement,
      pitch: document.getElementById('chart-pitch') as HTMLCanvasElement,
      yaw: document.getElementById('chart-yaw') as HTMLCanvasElement,
    },
    (idx) => {
      pausePlayback();
      jumpToFrame(idx);
    }
  );

  // CSV Import Modal
  const importModal = new CsvImportModal((newDataset) => {
    loadDataset(newDataset);
  });

  function recomputePipeline(): void {
    const raw: SeriesData = {
      roll: state.dataset.roll,
      pitch: state.dataset.pitch,
      yaw: state.dataset.yaw,
    };

    const { disturbed, applied } = applyDisturbance(state.dataset, state.disturbanceConfig);
    state.appliedDisturbance = applied;

    const filterInput = {
      times: state.dataset.times,
      roll: disturbed.roll,
      pitch: disturbed.pitch,
      yaw: disturbed.yaw,
    };

    const isKf = state.filterMode === 'kf';
    const stdFilter = isKf ? standardAngleKfFilter : standardSmoothingFilter;
    const robFilter = isKf ? huberAngleKfFilter : robustResidualFilter;

    SERIES_STYLES.filter_standard.label = stdFilter.name;
    SERIES_STYLES.filter_standard.shortLabel = stdFilter.shortName;
    SERIES_STYLES.filter_robust.label = robFilter.name;
    SERIES_STYLES.filter_robust.shortLabel = robFilter.shortName;

    const optStd = selectModelSource.querySelector('option[value="filter_standard"]');
    const optRob = selectModelSource.querySelector('option[value="filter_robust"]');
    if (optStd) optStd.textContent = stdFilter.name;
    if (optRob) optRob.textContent = robFilter.name;

    const stdOut = isKf
      ? standardAngleKfFilter.run(filterInput)
      : standardSmoothingFilter.run(filterInput);
    const robOut = isKf
      ? huberAngleKfFilter.run(filterInput, { mu: state.kfMu })
      : robustResidualFilter.run(filterInput);

    state.seriesMap = {
      raw,
      disturbed,
      filter_standard: stdOut,
      filter_robust: robOut,
    };

    state.deviations = {
      raw: null,
      disturbed: computeDeviationFromOriginal(disturbed, raw),
      filter_standard: computeDeviationFromOriginal(stdOut, raw),
      filter_robust: computeDeviationFromOriginal(robOut, raw),
    };

    filterParamsNote.textContent =
      `当前算法参数：${stdFilter.name} [${stdOut.paramsSummary ?? '-'}] ｜ ${robFilter.name} [${robOut.paramsSummary ?? '-'}]`;

    const imuAvail = fullImuAttitudeEkfPlaceholder.checkAvailability({
      times: state.dataset.times,
    });
    imuEkfStatusEl.textContent = `完整IMU姿态EKF：${imuAvail.available ? '可用' : '不可用'}（${imuAvail.reason}）`;

    inputKfMu.disabled = !isKf;
    lblKfMu.classList.toggle('muted-text', true);
    btnExportDiag.disabled = !robOut.diagnostics;
    renderLegend();
  }

  function updateDatasetHeaderUI(): void {
    const ds = state.dataset;
    const totalT = ds.times.length > 0 ? ds.times[ds.times.length - 1] : 0;
    metaFilename.textContent = ds.filename;
    metaSource.textContent = ds.sourceLabel;
    metaSourcePill.classList.toggle('warning', !ds.convention.confirmed);
    metaCount.textContent = `${ds.times.length} 帧 (${totalT.toFixed(2)}s)`;

    const signs = ds.convention.axisSigns;
    const signStr = `R(${signs.roll > 0 ? '+' : '-'}) P(${signs.pitch > 0 ? '+' : '-'}) Y(${signs.yaw > 0 ? '+' : '-'})`;
    conventionBadge.textContent = `${ds.convention.frameLabel} · 转序 ${ds.convention.rotationOrder} · ${signStr}`;
    conventionBadge.classList.toggle('unconfirmed', !ds.convention.confirmed);

    playbackSlider.min = '0';
    playbackSlider.max = String(Math.max(0, ds.times.length - 1));
  }

  function updateDisturbanceStatusUI(): void {
    const app = state.appliedDisturbance;
    if (!app) {
      distHitStatus.textContent = '未注入干扰（受扰数据与原日志一致）';
      distHitStatus.classList.remove('active');
      return;
    }

    const axisLabel =
      app.config.axis === 'roll' ? 'Roll' : app.config.axis === 'pitch' ? 'Pitch' : 'Yaw';
    const ampStr = `${app.config.amplitude >= 0 ? '+' : ''}${app.config.amplitude}°`;

    if (app.config.type === 'spike') {
      if (app.hitIndices.length === 0) {
        distHitStatus.textContent = '未命中任何采样帧';
        distHitStatus.classList.remove('active');
      } else {
        const idx = app.hitIndices[0];
        distHitStatus.textContent = `已命中单帧尖峰：${axisLabel} ${ampStr} · 第 ${idx + 1} 帧 (t = ${app.hitStartTime.toFixed(3)}s)`;
        distHitStatus.classList.add('active');
      }
    } else {
      distHitStatus.textContent = `已命中区间偏移：${axisLabel} ${ampStr} · [${app.hitStartTime.toFixed(2)}s, ${app.hitEndTime.toFixed(2)}s) 共 ${app.hitIndices.length} 帧`;
      distHitStatus.classList.add('active');
    }
  }

  function renderLegend(): void {
    legendTogglesEl.innerHTML = '';
    for (const id of SERIES_ORDER) {
      const style = SERIES_STYLES[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `legend-item ${state.visibleSeries[id] ? '' : 'off'}`;
      const borderStyle =
        style.lineDash.length === 0
          ? 'solid'
          : style.lineDash[0] <= 2
            ? 'dotted'
            : 'dashed';
      btn.innerHTML = `
        <span class="legend-line-sample" style="border-top-color:${style.color};border-top-style:${borderStyle};"></span>
        <span>${style.label}（${style.dashDesc}）</span>
      `;
      btn.addEventListener('click', () => {
        state.visibleSeries[id] = !state.visibleSeries[id];
        renderLegend();
        syncCharts();
      });
      legendTogglesEl.appendChild(btn);
    }
  }

  function syncCurrentFrameUI(): void {
    const times = state.dataset.times;
    if (times.length === 0) return;

    const idx = Math.max(0, Math.min(times.length - 1, state.currentIndex));
    state.currentIndex = idx;

    // 1. Update 3D Airplane
    const modelSeries = state.seriesMap[state.modelSource];
    const r = modelSeries.roll[idx] ?? 0;
    const p = modelSeries.pitch[idx] ?? 0;
    const y = modelSeries.yaw[idx] ?? 0;
    viewport3D.setAttitude(
      r,
      p,
      y,
      state.dataset.convention.rotationOrder
    );
    modelRollEl.textContent = `${r.toFixed(2)}°`;
    modelPitchEl.textContent = `${p.toFixed(2)}°`;
    modelYawEl.textContent = `${y.toFixed(2)}°`;

    // 2. Update Playback Bar
    const totalT = times[times.length - 1];
    playbackSlider.value = String(idx);
    playbackTimeEl.textContent = `t = ${times[idx].toFixed(3)}s / ${totalT.toFixed(3)}s · 第 ${idx + 1} / ${times.length} 帧`;

    // 3. Update Readings Table
    const rawS = state.seriesMap.raw;
    const rowsHtml = SERIES_ORDER.map((id) => {
      const style = SERIES_STYLES[id];
      const s = state.seriesMap[id];
      const dev = state.deviations[id];
      const vr = s.roll[idx];
      const vp = s.pitch[idx];
      const vy = s.yaw[idx];

      let devCell = '<span class="muted-text">基准（原日志）</span>';
      if (dev) {
        const dR = periodicAngleDiff(vr, rawS.roll[idx]);
        const dP = periodicAngleDiff(vp, rawS.pitch[idx]);
        const dY = periodicAngleDiff(vy, rawS.yaw[idx]);
        const maxRmse = Math.max(dev.roll.rmse, dev.pitch.rmse, dev.yaw.rmse);
        const maxPeak = Math.max(dev.roll.maxAbs, dev.pitch.maxAbs, dev.yaw.maxAbs);
        devCell = `Δ(${dR >= 0 ? '+' : ''}${dR.toFixed(1)},${dP >= 0 ? '+' : ''}${dP.toFixed(1)},${dY >= 0 ? '+' : ''}${dY.toFixed(1)}) · ${maxRmse.toFixed(2)}/${maxPeak.toFixed(2)}°`;
      }

      let weightCell = '-';
      if (s.weights) {
        const wr = s.weights.roll[idx];
        const wp = s.weights.pitch[idx];
        const wy = s.weights.yaw[idx];
        weightCell = `${wr.toFixed(2)} / ${wp.toFixed(2)} / ${wy.toFixed(2)}`;
      }

      return `
        <tr>
          <td><span class="series-dot" style="background:${style.color};"></span>${style.label}</td>
          <td class="mono">${vr.toFixed(2)}</td>
          <td class="mono">${vp.toFixed(2)}</td>
          <td class="mono">${vy.toFixed(2)}</td>
          <td class="mono">${devCell}</td>
          <td class="mono">${weightCell}</td>
        </tr>
      `;
    }).join('');
    readingsTbody.innerHTML = rowsHtml;

    // Update current-frame Huber KF diagnostics summary
    const robDiag = state.seriesMap.filter_robust.diagnostics;
    if (robDiag) {
      const dr = robDiag.roll[idx];
      const dp = robDiag.pitch[idx];
      const dy = robDiag.yaw[idx];
      const psdOk = dr.covPsd && dp.covPsd && dy.covPsd && dr.covSymmetric && dp.covSymmetric && dy.covSymmetric;
      kfDiagBar.textContent =
        `Huber诊断(第${idx + 1}帧): Pitch[pred=${dp.predicted.toFixed(2)}°, ν=${dp.innovation >= 0 ? '+' : ''}${dp.innovation.toFixed(2)}°, e=${dp.normalizedResidual >= 0 ? '+' : ''}${dp.normalizedResidual.toFixed(2)}, w=${dp.weight.toFixed(3)}, R_eff=${dp.rEff.toFixed(2)}, P_diag=(${dp.pDiag[0].toFixed(2)},${dp.pDiag[1].toFixed(2)})] · 三轴协方差对称/半正定=${psdOk ? '正常' : '异常'}`;
    } else {
      kfDiagBar.textContent = '当前为角度平滑回退模式（无 KF 协方差/创新诊断）。';
    }

    // 4. Sync Charts
    syncCharts();
  }

  function syncCharts(): void {
    charts.update({
      times: state.dataset.times,
      seriesMap: state.seriesMap,
      visibleSeries: state.visibleSeries,
      currentIndex: state.currentIndex,
      appliedDisturbance: state.appliedDisturbance,
    });
  }

  function jumpToFrame(idx: number): void {
    const maxIdx = Math.max(0, state.dataset.times.length - 1);
    const clamped = Math.max(0, Math.min(maxIdx, idx));
    state.currentIndex = clamped;
    state.playTimeSec = state.dataset.times[clamped] ?? 0;
    syncCurrentFrameUI();
  }

  function loadDataset(newDataset: AttitudeDataset): void {
    pausePlayback();
    state.dataset = newDataset;
    // Reset disturbance and playback position when switching files
    state.disturbanceConfig.enabled = false;
    state.currentIndex = 0;
    state.playTimeSec = newDataset.times[0] ?? 0;

    recomputePipeline();
    updateDatasetHeaderUI();
    updateDisturbanceStatusUI();
    syncCurrentFrameUI();
  }

  // Playback loop (timestamp-driven, supports unequal intervals)
  let lastRafTs = 0;
  let rafId = 0;

  function tickPlayback(now: number): void {
    if (!state.isPlaying) return;
    if (lastRafTs === 0) lastRafTs = now;
    const dtSec = Math.min(0.1, (now - lastRafTs) / 1000);
    lastRafTs = now;

    const times = state.dataset.times;
    const totalT = times[times.length - 1] ?? 0;
    state.playTimeSec += dtSec * state.speed;

    if (state.playTimeSec >= totalT) {
      state.playTimeSec = totalT;
      state.currentIndex = Math.max(0, times.length - 1);
      syncCurrentFrameUI();
      pausePlayback();
      return;
    }

    const nextIdx = findNearestFrameIndex(times, state.playTimeSec);
    if (nextIdx !== state.currentIndex) {
      state.currentIndex = nextIdx;
      syncCurrentFrameUI();
    }

    rafId = requestAnimationFrame(tickPlayback);
  }

  function startPlayback(): void {
    const times = state.dataset.times;
    if (times.length < 2) return;
    const totalT = times[times.length - 1];
    if (state.currentIndex >= times.length - 1 || state.playTimeSec >= totalT) {
      state.currentIndex = 0;
      state.playTimeSec = times[0];
    }
    state.isPlaying = true;
    btnPlayPause.textContent = '暂停';
    lastRafTs = 0;
    rafId = requestAnimationFrame(tickPlayback);
  }

  function pausePlayback(): void {
    state.isPlaying = false;
    btnPlayPause.textContent = '播放';
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // Event Listeners
  selectFilterMode.addEventListener('change', () => {
    state.filterMode = selectFilterMode.value as FilterMode;
    recomputePipeline();
    syncCurrentFrameUI();
  });

  inputKfMu.addEventListener('change', () => {
    const val = Number(inputKfMu.value);
    if (Number.isFinite(val) && val > 0) {
      state.kfMu = val;
      recomputePipeline();
      syncCurrentFrameUI();
    } else {
      inputKfMu.value = String(state.kfMu);
    }
  });

  btnExportDiag.addEventListener('click', () => {
    const diag = state.seriesMap.filter_robust.diagnostics;
    if (!diag) return;
    const times = state.dataset.times;
    const dist = state.seriesMap.disturbed;
    const est = state.seriesMap.filter_robust;
    const lines = [
      'frame_idx,time_s,pitch_obs_deg,pitch_pred_deg,pitch_nu_deg,pitch_e,pitch_w,pitch_r_eff,pitch_est_deg,pitch_p00,pitch_p11,pitch_cov_sym,pitch_cov_psd',
    ];
    for (let i = 0; i < times.length; i++) {
      const d = diag.pitch[i];
      lines.push(
        [
          i + 1,
          times[i],
          dist.pitch[i],
          d.predicted.toFixed(6),
          d.innovation.toFixed(6),
          d.normalizedResidual.toFixed(6),
          d.weight.toFixed(6),
          d.rEff.toFixed(6),
          est.pitch[i].toFixed(6),
          d.pDiag[0].toFixed(6),
          d.pDiag[1].toFixed(6),
          d.covSymmetric,
          d.covPsd,
        ].join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kf_huber_pitch_diagnostics.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btn-import-csv')!.addEventListener('click', () => {
    importModal.open();
  });

  document.getElementById('btn-load-new')!.addEventListener('click', () => {
    loadDataset(createPositionDerivedDataset());
  });

  document.getElementById('btn-load-demo')!.addEventListener('click', () => {
    loadDataset(createDemoDataset());
  });

  document.getElementById('btn-reset-cam')!.addEventListener('click', () => {
    viewport3D.resetCamera();
  });

  selectModelSource.addEventListener('change', () => {
    state.modelSource = selectModelSource.value as DataSourceId;
    syncCurrentFrameUI();
  });

  distTypeEl.addEventListener('change', () => {
    const isInterval = distTypeEl.value === 'interval';
    distDurEl.disabled = !isInterval;
  });

  document.getElementById('btn-apply-dist')!.addEventListener('click', () => {
    const startVal = Number(distStartEl.value);
    const ampVal = Number(distAmpEl.value);
    const durVal = Number(distDurEl.value);

    state.disturbanceConfig = {
      enabled: true,
      type: distTypeEl.value as DisturbanceType,
      axis: distAxisEl.value as AxisKey,
      startTime: Number.isFinite(startVal) ? startVal : 0,
      amplitude: Number.isFinite(ampVal) ? ampVal : 0,
      duration: Number.isFinite(durVal) && durVal > 0 ? durVal : 1.0,
    };

    recomputePipeline();
    updateDisturbanceStatusUI();
    syncCurrentFrameUI();
  });

  document.getElementById('btn-clear-dist')!.addEventListener('click', () => {
    state.disturbanceConfig.enabled = false;
    recomputePipeline();
    updateDisturbanceStatusUI();
    syncCurrentFrameUI();
  });

  btnPlayPause.addEventListener('click', () => {
    if (state.isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  });

  btnPrevFrame.addEventListener('click', () => {
    pausePlayback();
    jumpToFrame(state.currentIndex - 1);
  });

  btnNextFrame.addEventListener('click', () => {
    pausePlayback();
    jumpToFrame(state.currentIndex + 1);
  });

  playbackSlider.addEventListener('input', () => {
    pausePlayback();
    jumpToFrame(Number(playbackSlider.value));
  });

  document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const spd = Number(btn.dataset.speed) as 0.5 | 1 | 2;
      state.speed = spd;
      document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Initial render
  renderLegend();
  loadDataset(initialDataset);
}

main();
