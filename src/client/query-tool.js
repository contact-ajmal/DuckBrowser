/**
 * Query tool — page 2.
 *
 * A tabbed SQL workbench. Every tab owns its own DuckDB connection (a
 * QuerySession), so tabs run concurrently — the worker interleaves pending
 * queries — and each can be stopped independently. Per tab: editor, result
 * table with chart controls (type / x / y), downloads for the result (CSV,
 * Parquet, JSON) and for the query (.sql). Tabs can be imported from .sql
 * files (one file → one tab, or a multi-tab export → many) and exported all
 * at once. Any card elsewhere can "fork" its SQL into a new tab here.
 */
import { SqlEditor } from './editor.js';
import { renderTable, renderChart, renderError, inferChartSpec } from './render.js';
import { downloadBlob } from './duck-query.js';
import { FORMAT_LABEL } from './engine.js';
import { fmtMs, fmtInt, fmtBytes, escapeHtml, arrowKind, isTemporalType, isTextType, isNumericType, isNestedType, qid } from './format.js';
import { settings } from './settings.js';

const TABS_KEY = 'duckview.query.tabs';
const LEGACY_DRAFT_KEY = 'duckview.query.sql';
const HISTORY_KEY = 'duckview.query.history';
const historyMax = () => Number(settings.get('historyMax')) || 40;
const MAX_TABS = 24;
/** Marker used by "Export all" so an import can split the file back into tabs. */
const TAB_MARKER = /^--\s*@(?:duckview|quilldb)-tab:\s*(.+?)\s*$/; // "quilldb" = files exported before the rename

const DEFAULT_SQL = `-- Query the active dataset (alias "dataset") or any mounted view by name.
-- ⌘/Ctrl + Enter runs this tab. Open more tabs to run queries side by side.
SELECT *
FROM dataset
LIMIT 25;`;

const ICONS = {
  play: `<svg class="size-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z"/></svg>`,
  stop: `<svg class="size-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="2"/></svg>`,
  download: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10 3v10m0 0 3.5-3.5M10 13 6.5 9.5M3 15v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1"/></svg>`,
  upload: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M3 15v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1"/></svg>`,
  copy: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M4 13V5a1 1 0 0 1 1-1h8"/></svg>`,
  trash: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>`,
  plus: `<svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" d="M10 4v12M4 10h12"/></svg>`,
  close: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" d="m6 6 8 8m0-8-8 8"/></svg>`,
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

let tabSeq = 0;
const newId = () => `t${Date.now().toString(36)}${(++tabSeq).toString(36)}`;

export class QueryTool {
  /** @type {Map<string, Tab>} */
  #tabs = new Map();
  #activeId = null;
  #history = store.get(HISTORY_KEY, []);
  #chart = null;
  #queue = []; // tab ids waiting for a free slot (Settings → max concurrent queries)

  constructor({ root, sidebarRoot, engine, router, onSelectDataset, onLoadSample }) {
    this.root = root;
    this.sidebarRoot = sidebarRoot;
    this.engine = engine;
    this.router = router;
    this.onSelectDataset = onSelectDataset;
    this.onLoadSample = onLoadSample;
    this.#renderMain();
    this.#renderSidebar();
    this.#restoreTabs();

    engine.on('dataset:change', () => this.#renderSchema());
    engine.on('dataset:removed', () => this.#renderSchema());
    engine.on('dataset:active', () => {
      this.#renderSchema();
      this.#renderDatasetSelect();
      this.#renderEmptyHint();
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  get active() {
    return this.#tabs.get(this.#activeId) ?? null;
  }
  get tabs() {
    return [...this.#tabs.values()];
  }
  /** SQL of the active tab (kept for scripts and tests). */
  get sql() {
    return this.editor.value;
  }
  set sql(v) {
    this.editor.value = v;
    this.#syncEditor();
  }

  /** Open a new tab. Returns the tab. */
  newTab({ name, sql = '', activate = true, origin = '' } = {}) {
    if (this.#tabs.size >= MAX_TABS) {
      this.#flash(`Tab limit (${MAX_TABS}) reached — close a tab first`, true);
      return null;
    }
    const n = this.#tabs.size + 1;
    const tab = new Tab({ id: newId(), name: name || `Query ${n}`, sql, origin, session: this.engine.createSession(name || `Query ${n}`) });
    this.#tabs.set(tab.id, tab);
    if (activate) this.activate(tab.id);
    else this.#renderTabs();
    this.#persist();
    return tab;
  }

  activate(id) {
    if (!this.#tabs.has(id) || id === this.#activeId) {
      this.#renderTabs();
      return;
    }
    this.#syncEditor();
    this.#activeId = id;
    const tab = this.active;
    this.editor.value = tab.sql;
    this.ui.origin.textContent = tab.origin;
    this.#renderTabs();
    this.#renderTabState();
    this.#persist();
  }

  async closeTab(id) {
    const tab = this.#tabs.get(id);
    if (!tab) return;
    this.#queue = this.#queue.filter((q) => q !== id);
    await tab.session.close();
    const order = [...this.#tabs.keys()];
    const idx = order.indexOf(id);
    this.#tabs.delete(id);
    if (this.#activeId === id) {
      this.#activeId = null;
      const next = order[idx + 1] ?? order[idx - 1];
      if (next) this.activate(next);
      else this.newTab({ sql: DEFAULT_SQL });
    } else {
      this.#renderTabs();
    }
    this.#persist();
  }

  renameTab(id, name) {
    const tab = this.#tabs.get(id);
    if (!tab || !name.trim()) return;
    tab.name = name.trim().slice(0, 40);
    tab.session.label = tab.name;
    this.#renderTabs();
    this.#persist();
  }

  /** Fork from elsewhere: opens a new tab (or reuses an empty one) and runs. */
  load(sql, { title, run = true, chart, x, y } = {}) {
    const current = this.active;
    const reuse = current && !current.sql.trim() && !current.result && !current.running;
    const tab = reuse ? current : this.newTab({ name: shortName(title), activate: true });
    if (!tab) return;
    if (reuse && title) this.renameTab(tab.id, shortName(title));
    tab.origin = title ? `forked from "${title}"` : '';
    tab.sql = sql;
    if (chart && chart !== 'none') tab.view = { type: chart === 'auto' ? 'table' : chart, x: x || '', y: y || '' };
    this.editor.value = sql;
    this.ui.origin.textContent = tab.origin;
    this.#renderTabs();
    this.#persist();
    if (run) this.run(tab.id);
    requestAnimationFrame(() => this.editor.focus({ end: true }));
  }

  /** Called by the router when the view becomes visible. */
  onShow() {
    this.#chart?.resize();
    this.#renderSchema();
    this.#renderDatasetSelect();
    this.#renderEmptyHint();
    if (!this.active?.result) requestAnimationFrame(() => this.editor.focus({ end: true }));
  }

  get runningCount() {
    return this.tabs.filter((t) => t.running).length;
  }

  async run(id = this.#activeId) {
    const tab = this.#tabs.get(id);
    if (!tab) return;
    if (id === this.#activeId) this.#syncEditor();
    if (!tab.sql.trim() || tab.running || tab.queued) return;
    const max = Math.max(1, Number(settings.get('maxConcurrentQueries')) || 4);
    if (this.runningCount >= max) {
      // Over the concurrency limit: wait for a slot instead of piling onto the worker.
      tab.queued = true;
      this.#queue.push(id);
      this.#renderTabs();
      if (id === this.#activeId) this.#renderTabState();
      return;
    }
    return this.#execute(tab);
  }

  async #execute(tab) {
    const sql = tab.sql.trim();
    tab.queued = false;
    tab.running = true;
    tab.error = null;
    tab.timedOut = false;
    tab.startedAt = performance.now();
    this.#renderTabs();
    if (tab.id === this.#activeId) this.#renderTabState();
    const timeoutSec = Math.max(0, Number(settings.get('queryTimeoutSec')) || 0);
    const timer = timeoutSec
      ? setTimeout(() => {
          tab.timedOut = true;
          tab.session.cancel();
        }, timeoutSec * 1000)
      : null;
    try {
      const result = await tab.session.run(sql);
      tab.result = result;
      tab.ms = result.ms;
      this.#pushHistory({ sql, ms: result.ms, rows: result.numRows, ok: true, tab: tab.name });
      this.engine.refreshMemory();
    } catch (err) {
      tab.result = null;
      if (tab.timedOut && err.cancelled) err.message = `Stopped by the ${timeoutSec}s query timeout (Settings → Query guards).`;
      tab.error = err;
      tab.ms = err.ms ?? 0;
      if (!err.cancelled) this.#pushHistory({ sql, ms: tab.ms, rows: 0, ok: false, error: err.message, tab: tab.name });
    } finally {
      if (timer) clearTimeout(timer);
      tab.running = false;
      this.#renderTabs();
      if (tab.id === this.#activeId) this.#renderTabState();
      this.#drainQueue();
    }
  }

  #drainQueue() {
    const max = Math.max(1, Number(settings.get('maxConcurrentQueries')) || 4);
    while (this.#queue.length && this.runningCount < max) {
      const tab = this.#tabs.get(this.#queue.shift());
      if (tab && tab.queued) this.#execute(tab);
    }
  }

  async stop(id = this.#activeId) {
    const tab = this.#tabs.get(id);
    if (!tab) return;
    if (tab.queued) {
      tab.queued = false;
      this.#queue = this.#queue.filter((q) => q !== id);
      this.#renderTabs();
      if (id === this.#activeId) this.#renderTabState();
      return;
    }
    if (tab.running) await tab.session.cancel();
  }

  /** Run every tab that has SQL and isn't already running — concurrently. */
  runAll() {
    this.#syncEditor();
    for (const tab of this.#tabs.values()) if (tab.sql.trim() && !tab.running) this.run(tab.id);
  }

  // -----------------------------------------------------------------------
  // Import / export
  // -----------------------------------------------------------------------
  /** Import .sql/.txt files: a multi-tab export splits into tabs, anything else is one tab per file. */
  async importFiles(files) {
    let opened = 0;
    let first = null;
    for (const file of files) {
      const text = await file.text();
      const parts = splitTabs(text);
      const base = file.name.replace(/\.[^.]+$/, '');
      for (const part of parts) {
        const tab = this.newTab({ name: part.name || base, sql: part.sql.trim(), activate: false, origin: `imported from ${file.name}` });
        if (!tab) break;
        first ??= tab.id;
        opened++;
      }
    }
    if (first) this.activate(first);
    this.#flash(opened ? `Imported ${opened} quer${opened === 1 ? 'y' : 'ies'} — press Run (or Run all) to execute` : 'Nothing to import', !opened);
    return opened;
  }

  exportTab(id = this.#activeId) {
    const tab = this.#tabs.get(id);
    if (!tab) return;
    if (id === this.#activeId) this.#syncEditor();
    const name = `${fileSafe(tab.name)}.sql`;
    downloadBlob(new Blob([this.#sqlHeader() + tab.sql.trim() + '\n'], { type: 'application/sql;charset=utf-8' }), name);
    this.#flash(`Saved ${name}`);
  }

  exportAll() {
    this.#syncEditor();
    const body = this.tabs
      .filter((t) => t.sql.trim())
      .map((t) => `-- @duckview-tab: ${t.name}\n${t.sql.trim()}\n`)
      .join('\n');
    const name = `duckview-queries-${stamp()}.sql`;
    downloadBlob(new Blob([this.#sqlHeader() + body], { type: 'application/sql;charset=utf-8' }), name);
    this.#flash(`Saved ${name} (${this.#tabs.size} tabs — import it to restore them)`);
  }

  async copySql() {
    try {
      await navigator.clipboard.writeText(this.sql);
      this.#flash('SQL copied to clipboard');
    } catch {
      this.#flash('Clipboard unavailable — select the editor text and copy manually', true);
    }
  }

  async download(format) {
    const tab = this.active;
    if (!tab) return;
    const btn = this.ui.downloads.querySelector(`[data-dl="${format}"]`);
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const blob = await this.engine.exportQuery(tab.sql, format);
      const name = `${fileSafe(tab.name)}-${stamp()}.${format}`;
      downloadBlob(blob, name);
      this.#flash(`Saved ${name} (${fmtBytes(blob.size)})`);
    } catch (err) {
      this.#flash(`Export failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  #sqlHeader() {
    const ds = this.engine.activeId ? `${this.engine.activeId} (${this.engine.datasets.get(this.engine.activeId)?.file ?? ''})` : 'none';
    return `-- DuckView query export\n-- exported: ${new Date().toISOString()}\n-- active dataset: ${ds}\n\n`;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------
  #restoreTabs() {
    const saved = store.get(TABS_KEY, null);
    if (saved?.tabs?.length) {
      for (const t of saved.tabs) this.newTab({ name: t.name, sql: t.sql ?? '', activate: false });
      const ids = [...this.#tabs.keys()];
      this.activate(ids[Math.min(saved.active ?? 0, ids.length - 1)]);
      return;
    }
    // First run (or pre-tabs draft): one tab.
    const legacy = store.get(LEGACY_DRAFT_KEY, null);
    this.newTab({ sql: legacy || DEFAULT_SQL });
  }

  #persist() {
    this.#syncEditor();
    const ids = [...this.#tabs.keys()];
    store.set(TABS_KEY, { active: Math.max(0, ids.indexOf(this.#activeId)), tabs: this.tabs.map((t) => ({ name: t.name, sql: t.sql })) });
  }

  /** Copy the editor's text into the active tab model. */
  #syncEditor() {
    const tab = this.active;
    if (tab) tab.sql = this.editor.value;
  }

  // -----------------------------------------------------------------------
  // Rendering — main column
  // -----------------------------------------------------------------------
  #renderMain() {
    this.root.innerHTML = `
      <div class="space-y-4">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p class="text-[11px] font-medium uppercase tracking-wider text-violet-400">Query tool</p>
            <h1 class="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">SQL workbench</h1>
            <p class="qt-origin mt-1 font-mono text-[11px] text-zinc-500"></p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="btn btn-ghost cursor-pointer" title="Import .sql files as tabs">${ICONS.upload}<span>Import .sql</span><input type="file" class="qt-import sr-only" multiple accept=".sql,.txt,text/plain,application/sql"></label>
            <button type="button" class="qt-export-all btn btn-ghost" title="Download every tab as one .sql file">${ICONS.download}<span>Export all</span></button>
            <label class="flex items-center gap-2 text-xs text-zinc-400">
              <span><code class="rounded bg-zinc-800 px-1 text-zinc-300">dataset</code> →</span>
              <select class="qt-dataset h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-xs text-zinc-200 outline-none focus:border-violet-500/60"></select>
            </label>
          </div>
        </div>

        <div class="qt-empty-hint" hidden></div>

        <div class="card overflow-hidden">
          <div class="qt-tabs flex items-stretch gap-0.5 overflow-x-auto border-b border-zinc-800 bg-zinc-950/40 px-1 pt-1" role="tablist"></div>
          <div class="qt-editor p-2"></div>
          <div class="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2">
            <button type="button" class="qt-run btn btn-primary">${ICONS.play}<span>Run</span><kbd class="kbd ml-1 hidden sm:inline">⌘↵</kbd></button>
            <button type="button" class="qt-stop btn" hidden>${ICONS.stop}<span>Stop</span></button>
            <button type="button" class="qt-run-all btn btn-ghost" title="Run every tab concurrently">Run all</button>
            <button type="button" class="qt-clear btn btn-ghost">Clear</button>
            <span class="qt-status font-mono text-[11px] text-zinc-500"></span>
            <div class="ml-auto flex flex-wrap items-center gap-1">
              <span class="mr-1 text-[11px] text-zinc-500">Query</span>
              <button type="button" class="qt-dl-sql btn btn-ghost" title="Download this tab as a .sql file">${ICONS.download}<span>.sql</span></button>
              <button type="button" class="qt-copy btn btn-ghost" title="Copy SQL to clipboard">${ICONS.copy}<span>Copy</span></button>
            </div>
          </div>
          <div class="qt-flash border-t border-zinc-800 px-3 py-1.5 font-mono text-[11px]" hidden></div>
        </div>

        <div class="card overflow-hidden">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 px-3 py-2">
            <h2 class="text-[13px] font-medium text-zinc-100">Results <span class="qt-results-tab font-normal text-zinc-500"></span></h2>
            <div class="qt-chart-controls flex flex-wrap items-center gap-2" hidden>
              <div class="inline-flex rounded-md border border-zinc-800 p-0.5 font-mono text-[11px]" role="group" aria-label="Result view">
                <button type="button" data-type="table" class="rounded px-2 py-0.5">Table</button>
                <button type="button" data-type="bar" class="rounded px-2 py-0.5">Bar</button>
                <button type="button" data-type="line" class="rounded px-2 py-0.5">Line</button>
              </div>
              <label class="qt-axis flex items-center gap-1 font-mono text-[11px] text-zinc-500" hidden>x <select data-axis="x" class="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 text-zinc-200 outline-none focus:border-violet-500/60"></select></label>
              <label class="qt-axis flex items-center gap-1 font-mono text-[11px] text-zinc-500" hidden>y <select data-axis="y" class="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 text-zinc-200 outline-none focus:border-violet-500/60"></select></label>
            </div>
            <div class="qt-downloads ml-auto flex flex-wrap items-center gap-1" hidden>
              <span class="mr-1 text-[11px] text-zinc-500">Download</span>
              <button type="button" class="btn btn-ghost" data-dl="csv">${ICONS.download}<span>CSV</span></button>
              <button type="button" class="btn btn-ghost" data-dl="parquet">${ICONS.download}<span>Parquet</span></button>
              <button type="button" class="btn btn-ghost" data-dl="json">${ICONS.download}<span>JSON</span></button>
            </div>
          </div>
          <div class="qt-results min-h-[8rem]"></div>
          <div class="qt-rowinfo border-t border-zinc-800 px-3 py-1.5 font-mono text-[11px] text-zinc-500" hidden></div>
        </div>
      </div>`;

    const q = (sel) => this.root.querySelector(sel);
    this.ui = {
      origin: q('.qt-origin'),
      datasetSelect: q('.qt-dataset'),
      emptyHint: q('.qt-empty-hint'),
      tabs: q('.qt-tabs'),
      editorWrap: q('.qt-editor'),
      runBtn: q('.qt-run'),
      stopBtn: q('.qt-stop'),
      status: q('.qt-status'),
      flash: q('.qt-flash'),
      resultsTab: q('.qt-results-tab'),
      chartControls: q('.qt-chart-controls'),
      axisX: q('[data-axis="x"]'),
      axisY: q('[data-axis="y"]'),
      downloads: q('.qt-downloads'),
      results: q('.qt-results'),
      rowinfo: q('.qt-rowinfo'),
    };

    this.editor = new SqlEditor({
      value: '',
      onRun: () => this.run(),
      onChange: () => {
        this.#syncEditor();
        this.#persistSoon();
      },
      placeholder: '-- Write SQL, then press ⌘/Ctrl + Enter',
    });
    this.editor.el.classList.add('qt-editor-box');
    this.ui.editorWrap.append(this.editor.el);

    this.ui.runBtn.addEventListener('click', () => this.run());
    this.ui.stopBtn.addEventListener('click', () => this.stop());
    q('.qt-run-all').addEventListener('click', () => this.runAll());
    q('.qt-clear').addEventListener('click', () => {
      this.sql = '';
      const tab = this.active;
      if (tab) {
        tab.result = null;
        tab.error = null;
        tab.origin = '';
      }
      this.ui.origin.textContent = '';
      this.#renderTabState();
      this.editor.focus();
    });
    q('.qt-dl-sql').addEventListener('click', () => this.exportTab());
    q('.qt-export-all').addEventListener('click', () => this.exportAll());
    q('.qt-copy').addEventListener('click', () => this.copySql());
    q('.qt-import').addEventListener('change', (e) => {
      this.importFiles([...e.target.files]);
      e.target.value = '';
    });
    this.ui.downloads.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      if (b) this.download(b.dataset.dl);
    });
    this.ui.chartControls.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-type]');
      if (!b || !this.active) return;
      this.active.view.type = b.dataset.type;
      this.#renderResult();
    });
    for (const sel of [this.ui.axisX, this.ui.axisY]) {
      sel.addEventListener('change', () => {
        if (!this.active) return;
        this.active.view[sel.dataset.axis] = sel.value;
        this.#renderResult();
      });
    }
    this.ui.datasetSelect.addEventListener('change', () => this.onSelectDataset?.(this.ui.datasetSelect.value));
    this.ui.tabs.addEventListener('click', (e) => this.#onTabClick(e));
    this.ui.tabs.addEventListener('dblclick', (e) => {
      const tabEl = e.target.closest('[data-tab]');
      if (tabEl) this.#startRename(tabEl.dataset.tab);
    });
    this.#renderDatasetSelect();
    this.#renderEmptyHint();
  }

  #persistSoon() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this.#persist(), 400);
  }

  #renderTabs() {
    const el = this.ui.tabs;
    el.innerHTML =
      this.tabs
        .map((t) => {
          const active = t.id === this.#activeId;
          const dot = t.running
            ? '<span class="spinner"></span>'
            : t.queued
              ? '<span class="size-1.5 animate-pulse rounded-full bg-amber-400" title="queued — waiting for a free slot"></span>'
              : t.error
                ? '<span class="size-1.5 rounded-full bg-rose-400"></span>'
                : t.result
                  ? '<span class="size-1.5 rounded-full bg-emerald-400"></span>'
                  : '<span class="size-1.5 rounded-full bg-zinc-700"></span>';
          return `
          <div role="tab" aria-selected="${active}" data-tab="${t.id}" title="${escapeHtml(t.name)} — double-click to rename"
               class="group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-xs transition-colors ${active ? 'border-zinc-800 bg-zinc-900 text-zinc-100' : 'border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-300'}">
            <span class="flex w-3 justify-center">${dot}</span>
            <span class="qt-tab-name max-w-[10rem] truncate font-medium">${escapeHtml(t.name)}</span>
            ${t.ms != null && !t.running ? `<span class="font-mono text-[10px] text-zinc-600">${fmtMs(t.ms)}</span>` : ''}
            <button type="button" data-close="${t.id}" class="-mr-1 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 ${active ? 'opacity-100' : ''}" title="Close tab" aria-label="Close tab ${escapeHtml(t.name)}">${ICONS.close}</button>
          </div>`;
        })
        .join('') +
      `<button type="button" data-new class="ml-0.5 flex shrink-0 items-center gap-1 self-center rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="New tab">${ICONS.plus}<span class="hidden sm:inline">New tab</span></button>`;
  }

  #onTabClick(e) {
    const close = e.target.closest('[data-close]');
    if (close) {
      e.stopPropagation();
      this.closeTab(close.dataset.close);
      return;
    }
    if (e.target.closest('[data-new]')) {
      this.newTab();
      this.editor.focus();
      return;
    }
    const tabEl = e.target.closest('[data-tab]');
    if (tabEl && !tabEl.querySelector('input')) this.activate(tabEl.dataset.tab);
  }

  #startRename(id) {
    const tabEl = this.ui.tabs.querySelector(`[data-tab="${id}"]`);
    const nameEl = tabEl?.querySelector('.qt-tab-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.value = this.#tabs.get(id)?.name ?? '';
    input.className = 'w-28 rounded border border-violet-500/50 bg-zinc-950 px-1 text-xs text-zinc-100 outline-none';
    input.setAttribute('aria-label', 'Tab name');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      this.renameTab(id, input.value || 'Query');
      this.#renderTabs();
    };
    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') {
        input.removeEventListener('blur', commit);
        this.#renderTabs();
      }
    });
  }

  /** Paint the active tab's run state, status line and result. */
  #renderTabState() {
    const tab = this.active;
    const ui = this.ui;
    this.#chart?.destroy();
    this.#chart = null;
    if (!tab) return;
    ui.runBtn.hidden = tab.running || tab.queued;
    ui.stopBtn.hidden = !(tab.running || tab.queued);
    ui.resultsTab.textContent = `· ${tab.name}`;
    if (tab.queued) {
      ui.status.innerHTML = `<span class="animate-pulse text-amber-300">queued</span>`;
      ui.results.innerHTML = `<div class="px-4 py-10 text-center text-xs text-zinc-400">Waiting for a free slot — ${this.runningCount} quer${this.runningCount === 1 ? 'y is' : 'ies are'} running (limit ${settings.get('maxConcurrentQueries')}, adjustable in <a href="#/settings" class="text-violet-300 underline">Settings</a>).</div>`;
      ui.chartControls.hidden = true;
      ui.downloads.hidden = true;
      ui.rowinfo.hidden = true;
      return;
    }
    if (tab.running) {
      ui.status.innerHTML = `<span class="animate-pulse text-zinc-400">executing…</span>`;
      ui.results.setAttribute('aria-busy', 'true');
      ui.results.innerHTML = `
        <div class="flex items-center justify-center gap-3 px-4 py-12 text-xs text-zinc-400">
          <span class="spinner"></span> Running on its own connection — switch tabs freely, or press Stop.
        </div>`;
      ui.chartControls.hidden = true;
      ui.downloads.hidden = true;
      ui.rowinfo.hidden = true;
      return;
    }
    ui.results.removeAttribute('aria-busy');
    if (tab.error) {
      ui.status.innerHTML = tab.error.cancelled
        ? `<span class="text-amber-400">●</span> Stopped after ${fmtMs(tab.ms)}`
        : `<span class="text-rose-400">●</span> Failed after ${fmtMs(tab.ms)}`;
      ui.results.replaceChildren(tab.error.cancelled ? cancelledBox(tab.ms) : renderError(tab.error, tab.sql));
      ui.chartControls.hidden = true;
      ui.downloads.hidden = true;
      ui.rowinfo.hidden = true;
      return;
    }
    if (tab.result) {
      const r = tab.result;
      ui.status.innerHTML = `<span class="text-emerald-400">●</span> Executed in <span class="text-zinc-200">${fmtMs(r.ms)}</span> · ${fmtInt(r.numRows)} row${r.numRows === 1 ? '' : 's'} · ${r.columns.length} column${r.columns.length === 1 ? '' : 's'}`;
      this.#renderResult();
      return;
    }
    ui.status.textContent = '';
    ui.results.innerHTML = `<div class="px-4 py-10 text-center text-xs text-zinc-500">Run this tab to see results here.</div>`;
    ui.chartControls.hidden = true;
    ui.downloads.hidden = true;
    ui.rowinfo.hidden = true;
  }

  #renderResult() {
    const tab = this.active;
    const result = tab?.result;
    const ui = this.ui;
    if (!result) return;
    this.#chart?.destroy();
    this.#chart = null;
    const view = tab.view;

    const numeric = result.fields.filter((f) => arrowKind(f) === 'num').map((f) => f.name);
    const canChart = numeric.length > 0 && result.numRows > 0;
    ui.chartControls.hidden = !canChart;
    ui.downloads.hidden = false;
    if (canChart) {
      const auto = inferChartSpec(result, { chart: 'auto' });
      if (!result.columns.includes(view.x)) view.x = auto?.x ?? result.columns[0];
      if (!numeric.includes(view.y)) view.y = auto?.y?.[0] ?? numeric[0];
      ui.axisX.innerHTML = result.columns.map((c) => `<option value="${escapeHtml(c)}" ${c === view.x ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
      ui.axisY.innerHTML = numeric.map((c) => `<option value="${escapeHtml(c)}" ${c === view.y ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
    } else {
      view.type = 'table';
    }
    for (const b of ui.chartControls.querySelectorAll('button[data-type]')) {
      const active = b.dataset.type === view.type;
      b.classList.toggle('bg-zinc-800', active);
      b.classList.toggle('text-zinc-100', active);
      b.classList.toggle('text-zinc-500', !active);
    }
    for (const l of ui.chartControls.querySelectorAll('.qt-axis')) l.hidden = view.type === 'table';

    ui.results.replaceChildren();
    if (view.type !== 'table' && canChart) {
      const rendered = renderChart(result, { type: view.type, x: view.x, y: [view.y] });
      if (rendered) {
        this.#chart = rendered.chart;
        rendered.el.classList.add('!h-[22rem]');
        const wrap = document.createElement('div');
        wrap.className = 'p-4';
        wrap.append(rendered.el);
        ui.results.append(wrap);
      }
    }
    const t = renderTable(result, { maxRows: Math.max(500, Number(settings.get('tableRows')) || 500) });
    t.el.classList.remove('max-h-[28rem]');
    t.el.classList.add('max-h-[60vh]');
    if (view.type !== 'table') t.el.classList.add('border-t', 'border-zinc-800');
    ui.results.append(t.el);
    ui.rowinfo.hidden = false;
    ui.rowinfo.textContent = t.total > t.shown ? `Showing ${fmtInt(t.shown)} of ${fmtInt(t.total)} rows — downloads contain the full result` : `${fmtInt(t.total)} row${t.total === 1 ? '' : 's'}`;
  }

  #renderDatasetSelect() {
    const sel = this.ui.datasetSelect;
    const ready = [...this.engine.datasets.values()].filter((d) => d.state === 'ready');
    sel.innerHTML = ready.length
      ? ready.map((d) => `<option value="${escapeHtml(d.id)}" ${d.id === this.engine.activeId ? 'selected' : ''}>${escapeHtml(d.id)} · ${escapeHtml(FORMAT_LABEL[d.format] ?? d.format)}</option>`).join('')
      : `<option value="">no datasets loaded</option>`;
    sel.disabled = !ready.length;
  }

  #renderEmptyHint() {
    const el = this.ui.emptyHint;
    const none = ![...this.engine.datasets.values()].some((d) => d.state === 'ready');
    el.hidden = !none;
    if (none) {
      el.className = 'qt-empty-hint card flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-zinc-300';
      el.innerHTML = `
        <span class="text-zinc-400">No dataset loaded yet.</span>
        <a href="#/" class="btn btn-primary">Upload a file on the Overview page →</a>
        ${this.onLoadSample ? `<button type="button" class="qt-load-sample btn btn-ghost">or load a sample dataset</button>` : ''}
        <span class="text-xs text-zinc-500">You can still run SQL that doesn't touch a table, e.g. <code class="rounded bg-zinc-800 px-1">SELECT 42</code>.</span>`;
      el.querySelector('.qt-load-sample')?.addEventListener('click', () => this.onLoadSample?.());
    }
  }

  #flash(text, isError = false) {
    const f = this.ui.flash;
    f.textContent = text;
    f.className = `qt-flash border-t border-zinc-800 px-3 py-1.5 font-mono text-[11px] ${isError ? 'text-rose-300' : 'text-emerald-300'}`;
    f.hidden = false;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => (f.hidden = true), 5000);
  }

  // -----------------------------------------------------------------------
  // Rendering — sidebar (schema explorer + history)
  // -----------------------------------------------------------------------
  #renderSidebar() {
    this.sidebarRoot.innerHTML = `
      <section class="card">
        <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Schema</h2>
          <span class="text-[10px] text-zinc-600">click to insert</span>
        </header>
        <div class="qt-schema max-h-[50vh] overflow-y-auto py-1"></div>
      </section>
      <section class="card">
        <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">History</h2>
          <button type="button" class="qt-history-clear btn btn-ghost h-6 px-1.5" title="Clear history">${ICONS.trash}</button>
        </header>
        <ul class="qt-history max-h-[40vh] divide-y divide-zinc-800/70 overflow-y-auto"></ul>
      </section>`;
    this.ui.schema = this.sidebarRoot.querySelector('.qt-schema');
    this.ui.history = this.sidebarRoot.querySelector('.qt-history');
    this.sidebarRoot.querySelector('.qt-history-clear').addEventListener('click', () => {
      this.#history = [];
      store.set(HISTORY_KEY, []);
      this.#renderHistory();
    });
    this.ui.schema.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const body = toggle.parentElement.nextElementSibling;
        body.hidden = !body.hidden;
        toggle.querySelector('.chev').style.transform = body.hidden ? '' : 'rotate(90deg)';
        return;
      }
      const ins = e.target.closest('[data-insert]');
      if (ins) this.#insert(ins.dataset.insert);
    });
    this.ui.history.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-idx]');
      if (!btn) return;
      const entry = this.#history[Number(btn.dataset.idx)];
      if (entry) this.load(entry.sql, { title: entry.tab ? `history · ${entry.tab}` : 'history', run: false });
    });
    this.#renderSchema();
    this.#renderHistory();
  }

  #renderSchema() {
    const el = this.ui?.schema;
    if (!el) return;
    const datasets = [...this.engine.datasets.values()];
    if (!datasets.length) {
      el.innerHTML = `<p class="px-4 py-3 text-xs text-zinc-500">No datasets loaded. Upload one on the <a href="#/" class="text-violet-300 underline">Overview</a> page.</p>`;
      return;
    }
    const typeClass = (t) => (isNumericType(t) ? 'text-amber-300/80' : isTemporalType(t) ? 'text-teal-300/80' : isNestedType(t) ? 'text-orange-300/80' : isTextType(t) ? 'text-zinc-500' : 'text-sky-300/80');
    el.innerHTML = datasets
      .map((d) => {
        const active = d.id === this.engine.activeId;
        const cols = (d.schema ?? [])
          .map((c) => `<li><button type="button" data-insert="${escapeHtml(qid(c.name))}" class="flex w-full items-center justify-between gap-2 px-3 py-1 text-left font-mono text-[11px] hover:bg-zinc-800/60"><span class="truncate text-zinc-300">${escapeHtml(c.name)}</span><span class="shrink-0 ${typeClass(c.type)}">${escapeHtml(shortType(c.type))}</span></button></li>`)
          .join('');
        return `
          <div>
            <div class="flex items-center">
              <button type="button" data-toggle class="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left hover:bg-zinc-800/60">
                <svg class="chev size-3 shrink-0 text-zinc-500 transition-transform ${active ? 'rotate-90' : ''}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m8 6 4 4-4 4"/></svg>
                <span class="truncate font-mono text-xs ${active ? 'text-violet-200' : 'text-zinc-200'}">${escapeHtml(d.id)}</span>
                ${active ? '<span class="badge badge-violet">dataset</span>' : ''}
                <span class="ml-auto shrink-0 text-[10px] text-zinc-600">${d.schema?.length ?? '…'} cols</span>
              </button>
              <button type="button" data-insert="${escapeHtml(qid(d.id))}" title="Insert view name" class="mr-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">+</button>
            </div>
            <ul class="mb-1 ml-4 border-l border-zinc-800" ${active ? '' : 'hidden'}>${cols}</ul>
          </div>`;
      })
      .join('');
  }

  #renderHistory() {
    const el = this.ui?.history;
    if (!el) return;
    if (!this.#history.length) {
      el.innerHTML = `<li class="px-4 py-3 text-xs text-zinc-500">Queries you run appear here.</li>`;
      return;
    }
    el.innerHTML = this.#history
      .map(
        (h, i) => `
        <li>
          <button type="button" data-idx="${i}" class="block w-full px-4 py-2 text-left hover:bg-zinc-800/50" title="${escapeHtml(h.sql)}">
            <span class="block truncate font-mono text-[11px] text-zinc-300">${escapeHtml(h.sql.replace(/\s+/g, ' ').trim())}</span>
            <span class="block font-mono text-[10px] ${h.ok ? 'text-zinc-500' : 'text-rose-400'}">${new Date(h.at).toLocaleTimeString()} · ${h.ok ? `${fmtMs(h.ms)} · ${fmtInt(h.rows)} rows` : 'failed'}${h.tab ? ` · ${escapeHtml(h.tab)}` : ''}</span>
          </button>
        </li>`,
      )
      .join('');
  }

  #pushHistory(entry) {
    const normalized = entry.sql.trim();
    this.#history = [{ ...entry, sql: normalized, at: Date.now() }, ...this.#history.filter((h) => h.sql !== normalized)].slice(0, historyMax());
    store.set(HISTORY_KEY, this.#history);
    this.#renderHistory();
  }

  #insert(text) {
    const ta = this.editor.textarea;
    const { selectionStart: s, selectionEnd: e } = ta;
    const before = ta.value.slice(0, s);
    const pad = before.length && !/\s|\(|,$/.test(before.slice(-1)) ? ' ' : '';
    ta.setRangeText(pad + text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }
}

/** One workbench tab. */
class Tab {
  constructor({ id, name, sql, origin, session }) {
    this.id = id;
    this.name = name;
    this.sql = sql;
    this.origin = origin || '';
    this.session = session;
    this.running = false;
    this.queued = false;
    this.result = null;
    this.error = null;
    this.ms = null;
    this.view = { type: 'table', x: '', y: '' };
  }
}

/** Split a .sql file on "-- @duckview-tab: name" markers; no markers → one part. */
export function splitTabs(text) {
  const lines = text.split(/\r?\n/);
  const parts = [];
  let current = null;
  let preamble = [];
  for (const line of lines) {
    const m = line.match(TAB_MARKER);
    if (m) {
      if (current) parts.push(current);
      current = { name: m[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) parts.push(current);
  if (!parts.length) return [{ name: '', sql: stripExportHeader(preamble.join('\n')) }];
  return parts.map((p) => ({ name: p.name, sql: p.lines.join('\n') })).filter((p) => p.sql.trim());
}

/** Drop the header comment our own exports write, so re-imports stay clean. */
function stripExportHeader(sql) {
  return sql.replace(/^(--\s*(?:DuckView|QuillDB) query( export)?\n(--.*\n)*\n?)/, '');
}

function cancelledBox(ms) {
  const el = document.createElement('div');
  el.className = 'm-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200';
  el.textContent = `Query stopped after ${fmtMs(ms)}. Edit it and run again.`;
  return el;
}

function shortType(t) {
  return String(t)
    .replace(/^TIMESTAMP WITH TIME ZONE$/i, 'TIMESTAMPTZ')
    .replace(/^STRUCT\(.*\)$/i, 'STRUCT')
    .replace(/^MAP\(.*\)$/i, 'MAP')
    .replace(/^DECIMAL\(.*\)$/i, 'DECIMAL');
}

const shortName = (s) => (s ? String(s).slice(0, 40) : '');
const fileSafe = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'query';
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
