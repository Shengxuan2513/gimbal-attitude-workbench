import {
  evaluateSixAxisCompleteness,
  guessSixAxisMapping,
  parseAndValidateSixAxisCsv,
  previewCsv,
} from '../data/sixAxisParser';
import type { TimeUnit } from '../types/attitude';
import type {
  AccelUnit,
  GyroUnit,
  SixAxisDataset,
  SixAxisImportConfig,
  SixAxisTimeBase,
} from '../types/sixAxis';

export class SixAxisImportModal {
  private overlay: HTMLDivElement;
  private fileInput: HTMLInputElement;
  private rawText = '';
  private filename = '';
  private headers: string[] = [];
  private onImported: (dataset: SixAxisDataset) => void;

  private timeSelect!: HTMLSelectElement;
  private gxSelect!: HTMLSelectElement;
  private gySelect!: HTMLSelectElement;
  private gzSelect!: HTMLSelectElement;
  private axSelect!: HTMLSelectElement;
  private aySelect!: HTMLSelectElement;
  private azSelect!: HTMLSelectElement;
  private timeUnitSelect!: HTMLSelectElement;
  private gyroUnitSelect!: HTMLSelectElement;
  private accelUnitSelect!: HTMLSelectElement;
  private timeBaseSelect!: HTMLSelectElement;
  private signGxSelect!: HTMLSelectElement;
  private signGySelect!: HTMLSelectElement;
  private signGzSelect!: HTMLSelectElement;
  private signAxSelect!: HTMLSelectElement;
  private signAySelect!: HTMLSelectElement;
  private signAzSelect!: HTMLSelectElement;
  private confirmMeaningCheckbox!: HTMLInputElement;
  private previewContainer!: HTMLDivElement;
  private mappingHintBox!: HTMLDivElement;
  private errorBox!: HTMLDivElement;
  private fileInfoLabel!: HTMLSpanElement;
  private confirmBtn!: HTMLButtonElement;

  constructor(onImported: (dataset: SixAxisDataset) => void) {
    this.onImported = onImported;
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay hidden';

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.csv,text/csv';
    this.fileInput.className = 'hidden';

    this.overlay.innerHTML = `
      <div class="modal-card modal-wide" role="dialog" aria-modal="true" aria-label="导入六轴原始 IMU CSV">
        <div class="modal-header">
          <div>
            <h3>导入六轴原始 IMU CSV（本地检查与隔离加载）</h3>
            <p class="muted-text">WT61PC 无磁力计配置：仅接收机体系三轴角速度与三轴比力。失败或取消不会污染已有位置角或六轴数据。</p>
          </div>
          <button type="button" class="btn btn-ghost" data-action="close">✕</button>
        </div>

        <div class="modal-body">
          <div class="import-file-row">
            <button type="button" class="btn btn-primary" data-action="pick-file">选择六轴 CSV 文件</button>
            <span class="file-info-label">未选择文件</span>
          </div>

          <div class="import-preview-section">
            <div class="section-subtitle">前几行预览</div>
            <div class="preview-table-wrap">
              <div class="empty-hint">请先选择一个六轴原始 CSV 文件以预览表头和示例行。</div>
            </div>
          </div>

          <div class="import-mapping-grid">
            <label>
              <span>时间列</span>
              <select data-field="timeCol"></select>
            </label>
            <label>
              <span>时间单位（必须显式确认）</span>
              <select data-field="timeUnit">
                <option value="">-- 请选择单位（未确认） --</option>
                <option value="s">秒 (s)</option>
                <option value="ms">毫秒 (ms)</option>
              </select>
            </label>
            <label>
              <span>角速度单位（必须显式确认）</span>
              <select data-field="gyroUnit">
                <option value="">-- 请选择单位（未确认） --</option>
                <option value="rad_s">弧度/秒 (rad/s)</option>
                <option value="deg_s">度/秒 (°/s)</option>
              </select>
            </label>
            <label>
              <span>比力单位（必须显式确认）</span>
              <select data-field="accelUnit">
                <option value="">-- 请选择单位（未确认） --</option>
                <option value="m_s2">米/秒² (m/s²)</option>
                <option value="g">重力倍数 (g, 9.80665 m/s²)</option>
              </select>
            </label>
            <label>
              <span>时间基准来源</span>
              <select data-field="timeBase">
                <option value="unknown">待核实（未确认硬件同步）</option>
                <option value="device_sample">设备采样时间戳</option>
                <option value="host_rx">上位机接收时间（含串口抖动）</option>
              </select>
            </label>
            <div></div>

            <label><span>gx 列</span><select data-field="gxCol"></select></label>
            <label><span>gx 方向</span><select data-field="signGx"><option value="1">+1</option><option value="-1">-1</option></select></label>
            <label><span>gy 列</span><select data-field="gyCol"></select></label>
            <label><span>gy 方向</span><select data-field="signGy"><option value="1">+1</option><option value="-1">-1</option></select></label>
            <label><span>gz 列</span><select data-field="gzCol"></select></label>
            <label><span>gz 方向</span><select data-field="signGz"><option value="1">+1</option><option value="-1">-1</option></select></label>

            <label><span>ax 列</span><select data-field="axCol"></select></label>
            <label><span>ax 方向</span><select data-field="signAx"><option value="1">+1</option><option value="-1">-1</option></select></label>
            <label><span>ay 列</span><select data-field="ayCol"></select></label>
            <label><span>ay 方向</span><select data-field="signAy"><option value="1">+1</option><option value="-1">-1</option></select></label>
            <label><span>az 列</span><select data-field="azCol"></select></label>
            <label><span>az 方向</span><select data-field="signAz"><option value="1">+1</option><option value="-1">-1</option></select></label>
          </div>

          <label class="confirm-checkbox-row">
            <input type="checkbox" data-field="confirmedPhysicalMeaning" />
            <span>我已确认：所选六通道为机体系原始角速度与含重力比力（非关节 rpm、非欧拉角速率、非去重力线加速度）。</span>
          </label>

          <div class="import-mapping-hint hidden" role="status"></div>
          <div class="import-error-box hidden" role="alert"></div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-action="close">取消</button>
          <button type="button" class="btn btn-primary" data-action="confirm" disabled>执行格式检查并加载</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.fileInput);

    this.timeSelect = this.overlay.querySelector('[data-field="timeCol"]')!;
    this.gxSelect = this.overlay.querySelector('[data-field="gxCol"]')!;
    this.gySelect = this.overlay.querySelector('[data-field="gyCol"]')!;
    this.gzSelect = this.overlay.querySelector('[data-field="gzCol"]')!;
    this.axSelect = this.overlay.querySelector('[data-field="axCol"]')!;
    this.aySelect = this.overlay.querySelector('[data-field="ayCol"]')!;
    this.azSelect = this.overlay.querySelector('[data-field="azCol"]')!;
    this.timeUnitSelect = this.overlay.querySelector('[data-field="timeUnit"]')!;
    this.gyroUnitSelect = this.overlay.querySelector('[data-field="gyroUnit"]')!;
    this.accelUnitSelect = this.overlay.querySelector('[data-field="accelUnit"]')!;
    this.timeBaseSelect = this.overlay.querySelector('[data-field="timeBase"]')!;
    this.signGxSelect = this.overlay.querySelector('[data-field="signGx"]')!;
    this.signGySelect = this.overlay.querySelector('[data-field="signGy"]')!;
    this.signGzSelect = this.overlay.querySelector('[data-field="signGz"]')!;
    this.signAxSelect = this.overlay.querySelector('[data-field="signAx"]')!;
    this.signAySelect = this.overlay.querySelector('[data-field="signAy"]')!;
    this.signAzSelect = this.overlay.querySelector('[data-field="signAz"]')!;
    this.confirmMeaningCheckbox = this.overlay.querySelector('[data-field="confirmedPhysicalMeaning"]')!;
    this.previewContainer = this.overlay.querySelector('.preview-table-wrap')!;
    this.mappingHintBox = this.overlay.querySelector('.import-mapping-hint')!;
    this.errorBox = this.overlay.querySelector('.import-error-box')!;
    this.fileInfoLabel = this.overlay.querySelector('.file-info-label')!;
    this.confirmBtn = this.overlay.querySelector('[data-action="confirm"]')!;

    this.overlay.querySelectorAll('[data-action="close"]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    this.overlay
      .querySelector('[data-action="pick-file"]')!
      .addEventListener('click', () => this.fileInput.click());

    for (const el of [
      this.timeSelect,
      this.gxSelect,
      this.gySelect,
      this.gzSelect,
      this.axSelect,
      this.aySelect,
      this.azSelect,
      this.timeUnitSelect,
      this.gyroUnitSelect,
      this.accelUnitSelect,
    ]) {
      el.addEventListener('change', () => {
        this.errorBox.classList.add('hidden');
        this.updateState();
      });
    }

    this.confirmMeaningCheckbox.addEventListener('change', () => {
      this.errorBox.classList.add('hidden');
      this.updateState();
    });

    this.confirmBtn.addEventListener('click', () => this.handleConfirm());

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      this.loadFile(file);
    });
  }

  public open(): void {
    this.errorBox.classList.add('hidden');
    this.errorBox.innerHTML = '';
    this.overlay.classList.remove('hidden');
  }

  public close(): void {
    this.overlay.classList.add('hidden');
  }

  private async loadFile(file: File): Promise<void> {
    this.filename = file.name;
    this.rawText = await file.text();
    const preview = previewCsv(this.rawText, 5);
    this.headers = preview.headers;

    this.fileInfoLabel.textContent = `${file.name}（共 ${preview.totalDataRows} 行数据，${preview.headers.length} 列）`;
    this.errorBox.classList.add('hidden');
    this.errorBox.innerHTML = '';
    this.confirmMeaningCheckbox.checked = false;

    if (this.headers.length === 0) {
      this.previewContainer.innerHTML = '<div class="empty-hint">文件为空，无法解析表头。</div>';
      this.updateState();
      return;
    }

    const ths = preview.headers.map((h) => `<th>${this.escapeHtml(h)}</th>`).join('');
    const trs = preview.rows
      .map(
        (r) =>
          `<tr>${preview.headers
            .map((_, i) => `<td>${this.escapeHtml(r[i] ?? '')}</td>`)
            .join('')}</tr>`
      )
      .join('');
    this.previewContainer.innerHTML = `<table class="preview-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;

    const optsHtml =
      '<option value="">-- 未映射（请选择） --</option>' +
      this.headers
        .map((h) => `<option value="${this.escapeHtml(h)}">${this.escapeHtml(h)}</option>`)
        .join('');

    for (const sel of [
      this.timeSelect,
      this.gxSelect,
      this.gySelect,
      this.gzSelect,
      this.axSelect,
      this.aySelect,
      this.azSelect,
    ]) {
      sel.innerHTML = optsHtml;
    }

    const guessed = guessSixAxisMapping(this.headers);
    this.timeSelect.value = guessed.timeCol ?? '';
    this.gxSelect.value = guessed.gxCol ?? '';
    this.gySelect.value = guessed.gyCol ?? '';
    this.gzSelect.value = guessed.gzCol ?? '';
    this.axSelect.value = guessed.axCol ?? '';
    this.aySelect.value = guessed.ayCol ?? '';
    this.azSelect.value = guessed.azCol ?? '';
    this.timeUnitSelect.value = guessed.timeUnit ?? '';
    this.gyroUnitSelect.value = guessed.gyroUnit ?? '';
    this.accelUnitSelect.value = guessed.accelUnit ?? '';

    this.updateState();
  }

  private getCurrentConfig(): SixAxisImportConfig {
    return {
      timeCol: this.timeSelect.value,
      gxCol: this.gxSelect.value,
      gyCol: this.gySelect.value,
      gzCol: this.gzSelect.value,
      axCol: this.axSelect.value,
      ayCol: this.aySelect.value,
      azCol: this.azSelect.value,
      timeUnit: this.timeUnitSelect.value as TimeUnit | '',
      gyroUnit: this.gyroUnitSelect.value as GyroUnit | '',
      accelUnit: this.accelUnitSelect.value as AccelUnit | '',
      gyroSigns: {
        x: Number(this.signGxSelect.value) as 1 | -1,
        y: Number(this.signGySelect.value) as 1 | -1,
        z: Number(this.signGzSelect.value) as 1 | -1,
      },
      accelSigns: {
        x: Number(this.signAxSelect.value) as 1 | -1,
        y: Number(this.signAySelect.value) as 1 | -1,
        z: Number(this.signAzSelect.value) as 1 | -1,
      },
      timeBase: this.timeBaseSelect.value as SixAxisTimeBase,
      confirmedPhysicalMeaning: this.confirmMeaningCheckbox.checked,
    };
  }

  private updateState(): void {
    const cfg = this.getCurrentConfig();
    const status = evaluateSixAxisCompleteness(this.headers.length > 0, cfg);
    this.confirmBtn.disabled = !status.complete;
    if (status.message) {
      this.mappingHintBox.textContent = status.message;
      this.mappingHintBox.classList.remove('hidden');
    } else {
      this.mappingHintBox.textContent = '';
      this.mappingHintBox.classList.add('hidden');
    }
  }

  private handleConfirm(): void {
    if (!this.rawText) return;
    const cfg = this.getCurrentConfig();
    const result = parseAndValidateSixAxisCsv(this.rawText, this.filename, cfg, false);
    if ('errors' in result) {
      this.errorBox.classList.remove('hidden');
      this.errorBox.innerHTML = `
        <strong>六轴 CSV 检查未通过（当前已有数据保持不变）：</strong>
        <ul>${result.errors.map((e) => `<li>${this.escapeHtml(e)}</li>`).join('')}</ul>
      `;
      return;
    }

    this.onImported(result.dataset);
    this.close();
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
