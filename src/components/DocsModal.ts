import algorithmChangesMd from '../../docs/algorithm-changes.md?raw';
import algorithmSixAxisMd from '../../docs/algorithm-six-axis.md?raw';
import captureGuideMd from '../../docs/six-axis-capture-guide.md?raw';

export type DocTabId = 'algorithm' | 'changes' | 'capture';

const DOC_CONTENT: Record<DocTabId, { title: string; path: string; body: string }> = {
  algorithm: {
    title: '六轴算法主方案',
    path: 'docs/algorithm-six-axis.md',
    body: algorithmSixAxisMd,
  },
  changes: {
    title: '新增与修订清单',
    path: 'docs/algorithm-changes.md',
    body: algorithmChangesMd,
  },
  capture: {
    title: '六轴采集指南',
    path: 'docs/six-axis-capture-guide.md',
    body: captureGuideMd,
  },
};

export class DocsModal {
  private overlay: HTMLDivElement;
  private contentEl: HTMLPreElement;
  private pathLabel: HTMLSpanElement;
  private tabsEl: HTMLDivElement;
  private activeTab: DocTabId = 'algorithm';

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay hidden';

    this.overlay.innerHTML = `
      <div class="modal-card modal-wide" role="dialog" aria-modal="true" aria-label="六轴算法与采集文档">
        <div class="modal-header">
          <div>
            <h3>六轴算法方案与采集文档（本地打包只读）</h3>
            <p class="muted-text">当前路径：<span data-doc-path>-</span></p>
          </div>
          <button type="button" class="btn btn-ghost" data-action="close">✕</button>
        </div>
        <div class="doc-tabs" data-doc-tabs></div>
        <div class="modal-body">
          <pre class="doc-markdown-pre" data-doc-body></pre>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary" data-action="close">关闭</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    this.contentEl = this.overlay.querySelector('[data-doc-body]')!;
    this.pathLabel = this.overlay.querySelector('[data-doc-path]')!;
    this.tabsEl = this.overlay.querySelector('[data-doc-tabs]')!;

    this.overlay.querySelectorAll('[data-action="close"]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    this.renderTabs();
    this.renderContent();
  }

  public open(tab: DocTabId = 'algorithm'): void {
    this.activeTab = tab;
    this.renderTabs();
    this.renderContent();
    this.overlay.classList.remove('hidden');
  }

  public close(): void {
    this.overlay.classList.add('hidden');
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = '';
    (Object.keys(DOC_CONTENT) as DocTabId[]).forEach((id) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm ${id === this.activeTab ? 'btn-primary' : ''}`;
      btn.textContent = DOC_CONTENT[id].title;
      btn.addEventListener('click', () => {
        this.activeTab = id;
        this.renderTabs();
        this.renderContent();
      });
      this.tabsEl.appendChild(btn);
    });
  }

  private renderContent(): void {
    const doc = DOC_CONTENT[this.activeTab];
    this.pathLabel.textContent = doc.path;
    this.contentEl.textContent = doc.body;
  }
}
