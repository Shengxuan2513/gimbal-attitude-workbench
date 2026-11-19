import './style.css';
import { AttitudeCharts } from './components/AttitudeCharts';
import { CsvImportModal } from './components/CsvImportModal';
import { DocsModal, type DocTabId } from './components/DocsModal';
import { SixAxisCharts } from './components/SixAxisCharts';
import { SixAxisImportModal } from './components/SixAxisImportModal';
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
  buildNormalizedSixAxisCsv,
  buildSixAxisQualityReport,
  createSimulatedSixAxisDataset,
  SIX_AXIS_TEMPLATE_CSV,
} from './data/sixAxisParser';
import {
  DEFAULT_KF_PARAMS,
  huberAngleKfFilter,
  standardAngleKfFilter,
} from './filters/angleKf';
import { robustResidualFilter, standardSmoothingFilter } from './filters/demoFilters';
import {
  buildTriAxisDiagnosticsCsv,
  formatAxisKfDiagnosticSummary,
} from './filters/diagnosticsExport';
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
import type { SixAxisDataset } from './types/sixAxis';

type FilterMode = 'kf' | 'smooth';
type WorkspaceTab = 'position' | 'six_axis';

interface AppState {
  activeTab: WorkspaceTab;
  dataset: AttitudeDataset;
  sixAxisDataset: SixAxisDataset | null;
  filterMode: FilterMode;
  kfMu: number;
  diagAxis: AxisKey;
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
          <div class="workspace-tabs" role="tablist" aria-label="数据链路切换">
            <button id="tab-btn-position" class="btn btn-sm btn-primary" type="button" role="tab" aria-selected="true">位置角演示链路</button>
            <button id="tab-btn-six-axis" class="btn btn-sm" type="button" role="tab" aria-selected="false">六轴数据准备与检查</button>
          </div>
          <div class="topbar-actions">
            <button id="btn-doc-algo" class="btn btn-sm" type="button">算法文档</button>
            <button id="btn-doc-changes" class="btn btn-sm" type="button">变更清单</button>
            <button id="btn-doc-capture" class="btn btn-sm" type="button">采集指南</button>
          </div>
        </div>
        <div class="topbar-meta" id="position-meta-bar">
          <button id="btn-import-csv" class="btn btn-primary btn-sm" type="button">导入 CSV</button>
          <button id="btn-load-new" class="btn btn-sm" type="button">加载新数据</button>
          <button id="btn-load-demo" class="btn btn-sm" type="button">加载示例</button>
          <span class="meta-pill">文件：<strong id="meta-filename">-</strong></span>
          <span id="meta-source-pill" class="meta-pill">来源：<strong id="meta-source">-</strong></span>
          <span class="meta-pill">样本数：<strong id="meta-count">0</strong></span>
        </div>
      </header>

      <div id="view-position" class="workspace-view">

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
              <label for="select-diag-axis" class="muted-text">诊断轴：</label>
              <select id="select-diag-axis">
                <option value="roll">Roll</option>
                <option value="pitch" selected>Pitch</option>
                <option value="yaw">Yaw</option>
              </select>
              <button id="btn-export-diag" class="btn btn-sm" type="button">导出三轴诊断CSV</button>
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

      <div id="view-six-axis" class="workspace-view hidden">
        <section class="panel-card six-axis-banner">
          <div class="panel-header">
            <h2 class="panel-title">六轴原始 IMU 数据准备与检查（WT61PC 无磁配置）</h2>
            <span class="convention-badge unconfirmed">完整六轴 ESKF 尚未接入 · 本轮不宣称完成</span>
          </div>
          <div class="ref-note">
            当前链路与「位置角演示链路」完全隔离：仅用于检查机体系原始三轴角速度（rad/s）与三轴比力（m/s²）。WT61PC 无磁力计数据；Yaw 为相对零方向且可能漂移；真实原始日志待今晚采集；无独立姿态真值参考。<strong>严禁使用标量角度 KF、平滑算法或原始速度/比力直接驱动 3D 姿态模型。</strong>
          </div>
          <div class="six-axis-toolbar">
            <div class="topbar-actions">
              <button id="btn-six-import" class="btn btn-primary btn-sm" type="button">导入六轴原始 CSV</button>
              <button id="btn-six-load-sim" class="btn btn-sm" type="button">加载模拟六轴样例（仅格式演示）</button>
              <button id="btn-six-download-tpl" class="btn btn-sm" type="button">下载六轴 Schema 模板 CSV</button>
              <button id="btn-six-export-csv" class="btn btn-sm" type="button" disabled>导出规范化七列 CSV</button>
              <button id="btn-six-export-report" class="btn btn-sm" type="button" disabled>导出质量与元数据报告</button>
            </div>
            <div class="topbar-meta">
              <span class="meta-pill">文件：<strong id="six-meta-filename">未加载</strong></span>
              <span id="six-meta-source-pill" class="meta-pill warning">状态：<strong id="six-meta-source">等待导入六轴原始 CSV</strong></span>
              <span class="meta-pill">样本数：<strong id="six-meta-count">0</strong></span>
            </div>
          </div>
        </section>

        <section class="upper-grid">
          <div class="panel-card">
            <div class="panel-header">
              <h2 class="panel-title">用户确认信息（导入配置）</h2>
              <span class="muted-text">人工确认与程序检查严格分离</span>
            </div>
            <div id="six-user-confirm-body" class="six-info-list">
              <div class="muted-text">尚未导入六轴数据。请在导入弹窗中显式确认列映射、单位、轴向符号、时间基准与物理含义。</div>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-header">
              <h2 class="panel-title">程序检查结果（格式与显式条件）</h2>
              <span id="six-check-badge" class="convention-badge unconfirmed">待检查</span>
            </div>
            <div id="six-program-check-body" class="six-info-list">
              <div class="muted-text">尚未执行检查。检查通过仅代表格式与显式条件满足，不代表传感器来源已验证、时间已硬件同步或噪声已标定。</div>
            </div>
          </div>
        </section>

        <section class="charts-panel">
          <div class="panel-header">
            <h2 class="panel-title">六轴原始通道波形与统计（非姿态解算输出）</h2>
            <span class="muted-text">仅展示机体系原始 ω_b 与 f_b；完整六轴 ESKF 接入前不驱动三维姿态</span>
          </div>
          <div class="charts-stack">
            <div class="chart-box six-chart-box"><canvas id="six-chart-gyro"></canvas></div>
            <div class="chart-box six-chart-box"><canvas id="six-chart-accel"></canvas></div>
          </div>
          <div class="readings-wrap">
            <table class="readings-table">
              <thead>
                <tr>
                  <th>通道</th>
                  <th>最小值</th>
                  <th>最大值</th>
                  <th>均值</th>
                  <th>标准差</th>
                </tr>
              </thead>
              <tbody id="six-stats-tbody">
                <tr><td colspan="5" class="muted-text" style="text-align:center;">暂无六轴通道数据</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  `;
}

function main(): void {
  const root = document.getElementById('app')!;
  root.innerHTML = buildInitialAppHtml();

  const initialDataset = createDemoDataset();
  const state: AppState = {
    activeTab: 'position',
    dataset: initialDataset,
    sixAxisDataset: null,
    filterMode: 'kf',
    kfMu: DEFAULT_KF_PARAMS.mu,
    diagAxis: 'pitch',
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
  const selectDiagAxis = document.getElementById('select-diag-axis') as HTMLSelectElement;
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

  // Six-Axis Charts, Modal & Docs Modal (completely isolated from positionState)
  const sixAxisCharts = new SixAxisCharts({
    gyro: document.getElementById('six-chart-gyro') as HTMLCanvasElement,
    accel: document.getElementById('six-chart-accel') as HTMLCanvasElement,
  });
  const sixAxisImportModal = new SixAxisImportModal((sixDs) => {
    state.sixAxisDataset = sixDs;
    renderSixAxisView();
  });
  const docsModal = new DocsModal();

  const tabBtnPosition = document.getElementById('tab-btn-position') as HTMLButtonElement;
  const tabBtnSixAxis = document.getElementById('tab-btn-six-axis') as HTMLButtonElement;
  const viewPosition = document.getElementById('view-position')!;
  const viewSixAxis = document.getElementById('view-six-axis')!;
  const positionMetaBar = document.getElementById('position-meta-bar')!;

  const sixMetaFilename = document.getElementById('six-meta-filename')!;
  const sixMetaSource = document.getElementById('six-meta-source')!;
  const sixMetaSourcePill = document.getElementById('six-meta-source-pill')!;
  const sixMetaCount = document.getElementById('six-meta-count')!;
  const sixUserConfirmBody = document.getElementById('six-user-confirm-body')!;
  const sixProgramCheckBody = document.getElementById('six-program-check-body')!;
  const sixCheckBadge = document.getElementById('six-check-badge')!;
  const sixStatsTbody = document.getElementById('six-stats-tbody')!;
  const btnSixExportCsv = document.getElementById('btn-six-export-csv') as HTMLButtonElement;
  const btnSixExportReport = document.getElementById('btn-six-export-report') as HTMLButtonElement;

  function switchWorkspaceTab(tab: WorkspaceTab): void {
    state.activeTab = tab;
    const isPos = tab === 'position';
    viewPosition.classList.toggle('hidden', !isPos);
    viewSixAxis.classList.toggle('hidden', isPos);
    positionMetaBar.classList.toggle('hidden', !isPos);

    tabBtnPosition.classList.toggle('btn-primary', isPos);
    tabBtnPosition.setAttribute('aria-selected', String(isPos));
    tabBtnSixAxis.classList.toggle('btn-primary', !isPos);
    tabBtnSixAxis.setAttribute('aria-selected', String(!isPos));

    if (!isPos) {
      sixAxisCharts.renderAll();
    } else {
      charts.renderAll();
    }
  }

  function renderSixAxisView(): void {
    const ds = state.sixAxisDataset;
    if (!ds) {
      btnSixExportCsv.disabled = true;
      btnSixExportReport.disabled = true;
      sixAxisCharts.update(null);
      return;
    }

    btnSixExportCsv.disabled = false;
    btnSixExportReport.disabled = false;

    sixMetaFilename.textContent = ds.filename;
    sixMetaSource.textContent = ds.sourceStatusLabel;
    sixMetaSourcePill.classList.toggle('warning', true);
    sixMetaCount.textContent = `${ds.programChecks.validCompleteGroups} / ${ds.programChecks.totalCsvRows} 帧 (${ds.programChecks.durationSec.toFixed(2)}s)`;

    const cfg = ds.importConfig;
    const chk = ds.programChecks;
    const timeBaseLabel = chk.timeSourceLabel;

    sixUserConfirmBody.innerHTML = `
      <div><strong>数据类型：</strong>${ds.isSimulatedSample ? '模拟样例（仅格式演示，非实测）' : '本地导入六轴原始 CSV（来源及标定待确认）'}</div>
      <div><strong>映射列：</strong>主时间=${cfg.timeCol}${cfg.hostTimeCol ? `（电脑时间=${cfg.hostTimeCol}，仅追溯不去重）` : ''} ｜ 陀螺=(${cfg.gxCol}, ${cfg.gyCol}, ${cfg.gzCol}) ｜ 比力=(${cfg.axCol}, ${cfg.ayCol}, ${cfg.azCol})</div>
      <div><strong>显式单位：</strong>时间=${cfg.timeUnit} ｜ 角速度=${cfg.gyroUnit}→rad/s ｜ 比力=${cfg.accelUnit}→m/s²（不改变原始文件）</div>
      <div><strong>轴向符号：</strong>陀螺(${cfg.gyroSigns.x > 0 ? '+' : '-'},${cfg.gyroSigns.y > 0 ? '+' : '-'},${cfg.gyroSigns.z > 0 ? '+' : '-'}) ｜ 比力(${cfg.accelSigns.x > 0 ? '+' : '-'},${cfg.accelSigns.y > 0 ? '+' : '-'},${cfg.accelSigns.z > 0 ? '+' : '-'})</div>
      <div><strong>时间基准：</strong>${timeBaseLabel} ｜ <strong>物理含义确认：</strong>${cfg.confirmedPhysicalMeaning ? '已确认（非rpm/非模块姿态角/非去重力线加速度）' : '未确认'}</div>
    `;

    sixCheckBadge.textContent = chk.binVerified ? 'CSV + .bin 检查通过' : '仅 CSV 检查通过';
    const excludedHtml =
      chk.excludedCount > 0
        ? `<div class="hit-status active"><strong>排除记录：</strong>${chk.excludedCount} 条 — ${chk.excludedReasons.join('；')}</div>`
        : `<div><strong>排除记录：</strong>0 条（全部 ${chk.totalCsvRows} 行均为有效完整组）</div>`;
    const binHtml = ds.binInspection
      ? `<div><strong>配套 .bin 检查：</strong>${ds.binInspection.filename}（时间包=${ds.binInspection.timePacketCount}，加速度包=${ds.binInspection.accelPacketCount}，角速度包=${ds.binInspection.gyroPacketCount}，校验失败=${ds.binInspection.badChecksumCount}，尾部截断=${ds.binInspection.truncatedTailBytes}B）</div>`
      : `<div><strong>配套 .bin 检查：</strong>未提供（仅 CSV 模式：未验证二进制包边界与通道同步）</div>`;

    sixProgramCheckBody.innerHTML = `
      <div><strong>检查声明：</strong>${chk.summaryBadge}</div>
      <div><strong>总行数 / 有效完整组：</strong>${chk.totalCsvRows} 行 / ${chk.validCompleteGroups} 组 · 总时长 ${chk.durationSec.toFixed(3)}s</div>
      ${excludedHtml}
      ${binHtml}
      <div><strong>间隔与有效频率：</strong>dt_min=${chk.dtMin.toFixed(4)}s · dt_med=${chk.dtMed.toFixed(4)}s · dt_max=${chk.dtMax.toFixed(4)}s · 有效频率 ${chk.effectiveHz.toFixed(2)} Hz（数据缺口 ${chk.gapCount} 处；相邻重复电脑时间 ${chk.duplicateHostTimeCount} 个已保留未去重）</div>
      <div><strong>辅助比力范数 |f_b|：</strong>均值 ${chk.accelNormMean.toFixed(3)} ± ${chk.accelNormStd.toFixed(3)} m/s²（范围 ${chk.accelNormMin.toFixed(3)}～${chk.accelNormMax.toFixed(3)}）</div>
      <div><strong>待确认项：</strong>${chk.unconfirmedItems.join('；')}</div>
    `;

    const chList: Array<{ label: string; stat: typeof chk.channels.gx }> = [
      { label: 'gx (rad/s)', stat: chk.channels.gx },
      { label: 'gy (rad/s)', stat: chk.channels.gy },
      { label: 'gz (rad/s)', stat: chk.channels.gz },
      { label: 'ax (m/s²)', stat: chk.channels.ax },
      { label: 'ay (m/s²)', stat: chk.channels.ay },
      { label: 'az (m/s²)', stat: chk.channels.az },
    ];
    sixStatsTbody.innerHTML = chList
      .map(
        (c) => `
        <tr>
          <td>${c.label}</td>
          <td class="mono">${c.stat.min.toFixed(4)}</td>
          <td class="mono">${c.stat.max.toFixed(4)}</td>
          <td class="mono">${c.stat.mean.toFixed(4)}</td>
          <td class="mono">${c.stat.std.toFixed(4)}</td>
        </tr>
      `
      )
      .join('');

    sixAxisCharts.update(ds);
  }

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
    selectDiagAxis.disabled = !isKf || !robOut.diagnostics;
    btnExportDiag.disabled = !isKf || !robOut.diagnostics;
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

  function updateDiagnosticsBar(): void {
    const times = state.dataset.times;
    if (times.length === 0) return;
    const idx = Math.max(0, Math.min(times.length - 1, state.currentIndex));
    const robDiag = state.seriesMap.filter_robust.diagnostics;
    if (state.filterMode === 'kf' && robDiag) {
      const dr = robDiag.roll[idx];
      const dp = robDiag.pitch[idx];
      const dy = robDiag.yaw[idx];
      const psdOk =
        dr.covPsd && dp.covPsd && dy.covPsd && dr.covSymmetric && dp.covSymmetric && dy.covSymmetric;
      const axis = state.diagAxis;
      kfDiagBar.textContent = formatAxisKfDiagnosticSummary(
        idx,
        times[idx],
        axis,
        state.seriesMap.disturbed[axis][idx],
        state.seriesMap.filter_robust[axis][idx],
        robDiag[axis][idx],
        psdOk
      );
    } else {
      kfDiagBar.textContent = '当前为角度平滑回退模式（无 KF 协方差/创新诊断，不可导出）。';
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
    updateDiagnosticsBar();

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

  selectDiagAxis.addEventListener('change', () => {
    state.diagAxis = selectDiagAxis.value as AxisKey;
    updateDiagnosticsBar();
  });

  btnExportDiag.addEventListener('click', () => {
    const csvText = buildTriAxisDiagnosticsCsv({
      dataset: state.dataset,
      filterMode: state.filterMode,
      filterName: huberAngleKfFilter.name,
      paramsSummary: state.seriesMap.filter_robust.paramsSummary ?? '',
      disturbanceConfig: state.disturbanceConfig,
      appliedDisturbance: state.appliedDisturbance,
      disturbedSeries: state.seriesMap.disturbed,
      robustSeries: state.seriesMap.filter_robust,
    });
    if (!csvText) return;
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kf_huber_triaxis_diagnostics.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  tabBtnPosition.addEventListener('click', () => switchWorkspaceTab('position'));
  tabBtnSixAxis.addEventListener('click', () => switchWorkspaceTab('six_axis'));

  const openDoc = (tab: DocTabId) => docsModal.open(tab);
  document.getElementById('btn-doc-algo')!.addEventListener('click', () => openDoc('algorithm'));
  document.getElementById('btn-doc-changes')!.addEventListener('click', () => openDoc('changes'));
  document.getElementById('btn-doc-capture')!.addEventListener('click', () => openDoc('capture'));

  document.getElementById('btn-six-import')!.addEventListener('click', () => {
    sixAxisImportModal.open();
  });

  document.getElementById('btn-six-load-sim')!.addEventListener('click', () => {
    state.sixAxisDataset = createSimulatedSixAxisDataset();
    renderSixAxisView();
  });

  document.getElementById('btn-six-download-tpl')!.addEventListener('click', () => {
    const blob = new Blob([SIX_AXIS_TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'six_axis_imu_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  btnSixExportCsv.addEventListener('click', () => {
    if (!state.sixAxisDataset) return;
    const csvText = buildNormalizedSixAxisCsv(state.sixAxisDataset);
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'normalized_six_axis_imu.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  btnSixExportReport.addEventListener('click', () => {
    if (!state.sixAxisDataset) return;
    const reportJson = buildSixAxisQualityReport(state.sixAxisDataset);
    const blob = new Blob([reportJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'six_axis_quality_report.json';
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
