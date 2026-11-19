import {
  evaluateMappingCompleteness,
  guessDefaultMapping,
  parseAndValidateCsv,
  previewCsv,
} from '../data/csvParser';
import type {
  AngleUnit,
  AttitudeDataset,
  CsvImportConfig,
  RotationOrder,
  TimeUnit,
} from '../types/attitude';

export class CsvImportModal {
  private overlay: HTMLDivElement;
  private fileInput: HTMLInputElement;
  private rawText = '';
  private filename = '';
  private headers: string[] = [];
  private onImported: (dataset: AttitudeDataset) => void;

  private timeSelect!: HTMLSelectElement;
  private rollSelect!: HTMLSelectElement;
  private pitchSelect!: HTMLSelectElement;
  private yawSelect!: HTMLSelectElement;
  private timeUnitSelect!: HTMLSelectElement;
  private angleUnitSelect!: HTMLSelectElement;
  private orderSelect!: HTMLSelectElement;
  private signRollSelect!: HTMLSelectElement;
  private signPitchSelect!: HTMLSelectElement;
  private signYawSelect!: HTMLSelectElement;
  private previewContainer!: HTMLDivElement;
  private mappingHintBox!: HTMLDivElement;
  private errorBox!: HTMLDivElement;
  private fileInfoLabel!: HTMLSpanElement;
  private confirmBtn!: HTMLButtonElement;

  constructor(onImported: (dataset: AttitudeDataset) => void) {
    this.onImported = onImported;
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay hidden';

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.csv,text/csv';
    this.fileInput.className = 'hidden';

    this.overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="导入姿态角 CSV">
        <div class="modal-header">
          <div>
            <h3>导入姿态角 CSV（本地读取）</h3>
            <p class="muted-text">支持带表头的 UTF-8 CSV（含可选 BOM）。导入失败时保留当前已加载数据。</p>
          </div>
          <button type="button" class="btn btn-ghost" data-action="close">✕</button>
        </div>

        <div class="modal-body">
          <div class="import-file-row">
            <button type="button" class="btn btn-primary" data-action="pick-file">选择 CSV 文件</button>
            <span class="file-info-label">未选择文件</span>
          </div>

          <div class="import-preview-section">
            <div class="section-subtitle">前几行预览</div>
            <div class="preview-table-wrap">
              <div class="empty-hint">请先选择一个 CSV 文件以预览表头和示例行。</div>
            </div>
          </div>

          <div class="import-mapping-grid">
            <label>
              <span>时间列</span>
              <select data-field="timeCol"></select>
            </label>
            <label>
              <span>时间单位</span>
              <select data-field="timeUnit">
                <option value="s">秒 (s)</option>
                <option value="ms">毫秒 (ms)</option>
              </select>
            </label>
            <label>
              <span>角度单位</span>
              <select data-field="angleUnit">
                <option value="deg">度 (°)</option>
                <option value="rad">弧度 (rad)</option>
              </select>
            </label>
            <label>
              <span>旋转顺序</span>
              <select data-field="rotationOrder">
                <option value="ZYX">ZYX (Rz·Ry·Rx，默认)</option>
                <option value="XYZ">XYZ (Rx·Ry·Rz)</option>
                <option value="ZXY">ZXY (Rz·Rx·Ry)</option>
                <option value="YXZ">YXZ (Ry·Rx·Rz)</option>
                <option value="YZX">YZX (Ry·Rz·Rx)</option>
                <option value="XZY">XZY (Rx·Rz·Ry)</option>
              </select>
            </label>

            <label>
              <span>Roll (横滚) 列</span>
              <select data-field="rollCol"></select>
            </label>
            <label>
              <span>Roll 方向</span>
              <select data-field="signRoll">
                <option value="1">+1 (正向)</option>
                <option value="-1">-1 (反向)</option>
              </select>
            </label>

            <label>
              <span>Pitch (俯仰) 列</span>
              <select data-field="pitchCol"></select>
            </label>
            <label>
              <span>Pitch 方向</span>
              <select data-field="signPitch">
                <option value="1">+1 (正向)</option>
                <option value="-1">-1 (反向)</option>
              </select>
            </label>

            <label>
              <span>Yaw (偏航) 列</span>
              <select data-field="yawCol"></select>
            </label>
            <label>
              <span>Yaw 方向</span>
              <select data-field="signYaw">
                <option value="1">+1 (正向)</option>
                <option value="-1">-1 (反向)</option>
              </select>
            </label>
          </div>

          <div class="import-mapping-hint hidden" role="status"></div>
          <div class="import-error-box hidden" role="alert"></div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-action="close">取消</button>
          <button type="button" class="btn btn-primary" data-action="confirm" disabled>确认导入并校验</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.fileInput);

    this.timeSelect = this.overlay.querySelector('[data-field="timeCol"]')!;
    this.rollSelect = this.overlay.querySelector('[data-field="rollCol"]')!;
    this.pitchSelect = this.overlay.querySelector('[data-field="pitchCol"]')!;
    this.yawSelect = this.overlay.querySelector('[data-field="yawCol"]')!;
    this.timeUnitSelect = this.overlay.querySelector('[data-field="timeUnit"]')!;
    this.angleUnitSelect = this.overlay.querySelector('[data-field="angleUnit"]')!;
    this.orderSelect = this.overlay.querySelector('[data-field="rotationOrder"]')!;
    this.signRollSelect = this.overlay.querySelector('[data-field="signRoll"]')!;
    this.signPitchSelect = this.overlay.querySelector('[data-field="signPitch"]')!;
    this.signYawSelect = this.overlay.querySelector('[data-field="signYaw"]')!;
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

    this.confirmBtn.addEventListener('click', () => this.handleConfirm());

    for (const sel of [this.timeSelect, this.rollSelect, this.pitchSelect, this.yawSelect]) {
      sel.addEventListener('change', () => {
        this.errorBox.classList.add('hidden');
        this.updateMappingState();
      });
    }

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

    if (this.headers.length === 0) {
      this.previewContainer.innerHTML = '<div class="empty-hint">文件为空，无法解析表头。</div>';
      this.updateMappingState();
      return;
    }

    // Render preview table
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

    // Populate column selects (with explicit "未映射" option)
    const optsHtml =
      '<option value="">-- 未映射（请选择） --</option>' +
      this.headers
        .map((h) => `<option value="${this.escapeHtml(h)}">${this.escapeHtml(h)}</option>`)
        .join('');
    for (const sel of [this.timeSelect, this.rollSelect, this.pitchSelect, this.yawSelect]) {
      sel.innerHTML = optsHtml;
    }

    const guessed = guessDefaultMapping(this.headers);
    this.timeSelect.value = guessed.timeCol ?? '';
    this.rollSelect.value = guessed.rollCol ?? '';
    this.pitchSelect.value = guessed.pitchCol ?? '';
    this.yawSelect.value = guessed.yawCol ?? '';
    if (guessed.timeUnit) this.timeUnitSelect.value = guessed.timeUnit;
    if (guessed.angleUnit) this.angleUnitSelect.value = guessed.angleUnit;

    this.updateMappingState();
  }

  private updateMappingState(): void {
    const status = evaluateMappingCompleteness(this.headers.length > 0, {
      timeCol: this.timeSelect.value,
      rollCol: this.rollSelect.value,
      pitchCol: this.pitchSelect.value,
      yawCol: this.yawSelect.value,
    });
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
    const config: CsvImportConfig = {
      timeCol: this.timeSelect.value,
      rollCol: this.rollSelect.value,
      pitchCol: this.pitchSelect.value,
      yawCol: this.yawSelect.value,
      timeUnit: this.timeUnitSelect.value as TimeUnit,
      angleUnit: this.angleUnitSelect.value as AngleUnit,
      rotationOrder: this.orderSelect.value as RotationOrder,
      axisSigns: {
        roll: Number(this.signRollSelect.value) as 1 | -1,
        pitch: Number(this.signPitchSelect.value) as 1 | -1,
        yaw: Number(this.signYawSelect.value) as 1 | -1,
      },
    };

    const result = parseAndValidateCsv(this.rawText, this.filename, config);
    if ('errors' in result) {
      this.errorBox.classList.remove('hidden');
      this.errorBox.innerHTML = `
        <strong>导入校验失败（当前已有数据保持不变）：</strong>
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
