/**
 * <duck-query> — a live SQL card.
 *
 *   <duck-query title="Revenue by region" chart="bar" x="region" y="revenue">
 *     <pre class="dq-src"><code>SELECT … </code></pre>
 *   </duck-query>
 *
 * Attributes
 *   title       card heading
 *   chart       auto | bar | line | none        (default: none)
 *   x, y        chart columns (y may be comma-separated)
 *   autorun     "false" to wait for a manual Run
 *   collapsed   hide the SQL editor until "SQL" is toggled
 *   limit       max rows rendered in the table (default 200)
 *
 * Every card can be run, edited in place, forked into the scratchpad, and
 * exported as CSV / Parquet. The SQL editor is always editable — the card is
 * the starting point, not the end.
 */
import { SqlEditor } from './editor.js';
import { renderTable, renderChart, renderSkeleton, renderError, inferChartSpec, MAX_TABLE_ROWS } from './render.js';
import { fmtMs, fmtInt, escapeHtml } from './format.js';
import { settings } from './settings.js';

const ICONS = {
  play: `<svg class="size-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z"/></svg>`,
  fork: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5v11m0-11L8 8m-3.5-3.5L1 8m14.5 8.5v-11m0 11L12 13m3.5 3.5L19 13"/></svg>`,
  code: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m6.5 6-4 4 4 4m7-8 4 4-4 4M11.5 3l-3 14"/></svg>`,
  download: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10 3v10m0 0 3.5-3.5M10 13 6.5 9.5M3 15v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1"/></svg>`,
  reset: `<svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 10a6 6 0 1 1 1.76 4.24M4 10V6m0 4h4"/></svg>`,
};

let cardSeq = 0;

export class DuckQuery extends HTMLElement {
  /** Set by client.js: the shared Engine instance. */
  static engine = null;
  /** Resolved by client.js (via markReady) once the bundled datasets are mounted. */
  static #readyResolve;
  static #readyReject;
  static whenReady = new Promise((resolve, reject) => {
    DuckQuery.#readyResolve = resolve;
    DuckQuery.#readyReject = reject;
  });
  static markReady(value) {
    DuckQuery.#readyResolve(value);
  }
  static markFailed(err) {
    DuckQuery.#readyReject(err);
  }
  /** Set by client.js: (sql, meta) => void — opens the SQL in the Query tool. */
  static forkTarget = null;
  /** Set by client.js: ids of bundled samples + a loader, for "table not found" hints. */
  static sampleIds = new Set();
  static loadSample = null;
  static instances = new Set();

  static get observedAttributes() {
    return ['title'];
  }

  /** Programmatic factory used by the overview suite. */
  static create({ sql, title, chart = 'none', x, y, autorun = false, collapsed = true, limit, extraClass = '' } = {}) {
    const el = document.createElement('duck-query');
    el.setAttribute('title', title || `Query ${cardSeq + 1}`);
    el.setAttribute('chart', chart);
    if (x) el.setAttribute('x', x);
    if (y) el.setAttribute('y', y);
    if (!autorun) el.setAttribute('autorun', 'false');
    if (collapsed) el.setAttribute('collapsed', '');
    if (limit) el.setAttribute('limit', String(limit));
    if (extraClass) el.className = extraClass;
    el.initialSql = sql;
    return el;
  }

  #built = false;
  #editor = null;
  #chart = null;
  #result = null;
  #runToken = 0;
  #originalSql = '';
  #view = 'chart';
  #viewChosen = false; // user clicked the Chart/Table toggle
  #deferred = false; // autorun postponed because the card sits in a hidden view
  #hasRun = false;
  #ui = {};

  connectedCallback() {
    if (this.#built) return;
    this.#built = true;
    DuckQuery.instances.add(this);
    this.seq = ++cardSeq;

    // Source SQL: programmatic property, or the <pre> the build emitted.
    const src = this.querySelector('pre.dq-src');
    const sql = (this.initialSql ?? src?.textContent ?? '').trim();
    src?.remove();
    this.#originalSql = sql;

    this.#render(sql);
    if (this.getAttribute('autorun') !== 'false') {
      DuckQuery.whenReady
        .then(() => {
          // Cards inside a hidden view (docs pages, other routes) wait until shown.
          if (this.closest('[hidden]')) this.#deferred = true;
          else this.run();
        })
        .catch((err) => {
          this.#ui.body.replaceChildren(renderError(err));
          this.#ui.status.innerHTML = `<span class="text-rose-400">●</span> engine unavailable`;
        });
    }
  }

  disconnectedCallback() {
    DuckQuery.instances.delete(this);
    this.#chart?.destroy();
    this.#chart = null;
  }

  attributeChangedCallback(name, _old, value) {
    if (name === 'title' && this.#ui.title) this.#ui.title.textContent = value;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  get sql() {
    return this.#editor?.value ?? this.#originalSql;
  }
  set sql(v) {
    if (this.#editor) this.#editor.value = v;
    else this.#originalSql = v;
  }
  get result() {
    return this.#result;
  }
  get title() {
    return this.getAttribute('title') || `Query ${this.seq}`;
  }
  /** True if the SQL mentions the `dataset` alias view. */
  get dependsOnActiveDataset() {
    return /\bdataset\b/i.test(this.sql);
  }
  get hasRun() {
    return this.#hasRun;
  }

  /** Run now if autorun was postponed while the card was hidden. */
  runIfDeferred() {
    if (this.#deferred) {
      this.#deferred = false;
      this.run();
    }
  }

  /** Charts rendered while hidden have no size — call after the view appears. */
  onShown() {
    this.#chart?.resize();
  }

  async run(sqlOverride) {
    const engine = DuckQuery.engine;
    if (!engine) return;
    const sql = (sqlOverride ?? this.sql).trim();
    if (!sql) return;
    const token = ++this.#runToken;
    this.#hasRun = true;
    this.#deferred = false;
    this.#setRunning(true);
    this.#ui.body.replaceChildren(renderSkeleton({ chart: this.#chartRequested() }));
    try {
      const result = await engine.query(sql);
      if (token !== this.#runToken) return; // superseded by a newer run
      this.#result = result;
      this.#renderResult(result);
      this.#ui.status.innerHTML = `<span class="text-emerald-400">●</span> Executed in <span class="text-zinc-200">${fmtMs(result.ms)}</span> · ${fmtInt(result.numRows)} row${result.numRows === 1 ? '' : 's'}`;
      this.dispatchEvent(new CustomEvent('dq:result', { detail: result, bubbles: true }));
      engine.refreshMemory();
    } catch (err) {
      if (token !== this.#runToken) return;
      this.#result = null;
      this.#ui.body.replaceChildren(renderError(err, sql), ...this.#missingTableHint(err));
      this.#ui.status.innerHTML = `<span class="text-rose-400">●</span> Failed after ${fmtMs(err.ms ?? 0)}`;
      this.#ui.footer.hidden = true;
      this.dispatchEvent(new CustomEvent('dq:error', { detail: err, bubbles: true }));
    } finally {
      if (token === this.#runToken) this.#setRunning(false);
    }
  }

  /** Hand this card's SQL (and chart config) to the Query tool. */
  fork() {
    DuckQuery.forkTarget?.(this.sql, {
      title: this.title,
      from: this,
      chart: this.getAttribute('chart'),
      x: this.getAttribute('x'),
      y: this.getAttribute('y')?.split(',')[0]?.trim(),
    });
  }

  toggleSql(force) {
    const area = this.#ui.editorArea;
    const show = force ?? area.hidden;
    area.hidden = !show;
    this.#ui.sqlBtn.setAttribute('aria-expanded', String(show));
    this.#ui.sqlBtn.classList.toggle('btn-primary', show);
    if (show) this.#editor.focus({ end: false });
  }

  async exportAs(format) {
    const engine = DuckQuery.engine;
    if (!engine) return;
    const btn = this.#ui[format === 'parquet' ? 'parquetBtn' : 'csvBtn'];
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const blob = await engine.exportQuery(this.sql, format);
      const name = `${slug(this.title)}.${format}`;
      downloadBlob(blob, name);
      this.#flash(`Saved ${name} (${(blob.size / 1024).toFixed(1)} KB)`);
    } catch (err) {
      this.#flash(`Export failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  #chartRequested() {
    const c = this.getAttribute('chart');
    return c && c !== 'none';
  }

  #render(sql) {
    const collapsed = this.hasAttribute('collapsed');
    this.innerHTML = `
      <div class="card fade-in @container overflow-hidden">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <h3 class="dq-title truncate text-[13px] font-medium text-zinc-100"></h3>
            <span class="dq-modified badge badge-violet" hidden>modified</span>
          </div>
          <span class="dq-status font-mono text-[11px] text-zinc-500"></span>
          <div class="ml-auto flex items-center gap-1">
            <button type="button" class="btn dq-run" title="Run (⌘/Ctrl+Enter)">${ICONS.play}<span>Run</span></button>
            <button type="button" class="btn btn-ghost dq-sql" aria-expanded="${!collapsed}" title="Show / hide SQL">${ICONS.code}<span>SQL</span></button>
            <button type="button" class="btn btn-ghost dq-reset" title="Restore original query" hidden>${ICONS.reset}</button>
            <button type="button" class="btn btn-primary dq-fork" title="Open this query in the Query tool and keep going">${ICONS.fork}<span>Edit / Fork<span class="@max-xl:hidden"> SQL</span></span></button>
            <span class="mx-1 h-4 w-px bg-zinc-800" aria-hidden="true"></span>
            <button type="button" class="btn btn-ghost dq-csv" title="Export result as CSV">${ICONS.download}<span class="@max-xl:hidden">CSV</span></button>
            <button type="button" class="btn btn-ghost dq-parquet" title="Export result as Parquet">${ICONS.download}<span class="@max-xl:hidden">Parquet</span></button>
          </div>
        </header>
        <div class="dq-editor border-b border-zinc-800 bg-zinc-950/40 p-2" ${collapsed ? 'hidden' : ''}></div>
        <div class="dq-body min-h-[4rem]"></div>
        <footer class="dq-footer flex flex-wrap items-center gap-3 border-t border-zinc-800 px-3 py-1.5 font-mono text-[11px] text-zinc-500" hidden>
          <span class="dq-rowinfo"></span>
          <div class="dq-viewtoggle ml-auto inline-flex rounded-md border border-zinc-800 p-0.5" hidden>
            <button type="button" data-result-view="chart" class="rounded px-2 py-0.5">Chart</button>
            <button type="button" data-result-view="table" class="rounded px-2 py-0.5">Table</button>
          </div>
        </footer>
        <div class="dq-flash px-3 py-1.5 font-mono text-[11px]" hidden></div>
      </div>`;

    const q = (sel) => this.querySelector(sel);
    this.#ui = {
      title: q('.dq-title'),
      status: q('.dq-status'),
      modified: q('.dq-modified'),
      runBtn: q('.dq-run'),
      sqlBtn: q('.dq-sql'),
      resetBtn: q('.dq-reset'),
      forkBtn: q('.dq-fork'),
      csvBtn: q('.dq-csv'),
      parquetBtn: q('.dq-parquet'),
      editorArea: q('.dq-editor'),
      body: q('.dq-body'),
      footer: q('.dq-footer'),
      rowinfo: q('.dq-rowinfo'),
      viewToggle: q('.dq-viewtoggle'),
      flash: q('.dq-flash'),
    };
    this.#ui.title.textContent = this.title;
    if (!collapsed) this.#ui.sqlBtn.classList.add('btn-primary');

    this.#editor = new SqlEditor({
      value: sql,
      onRun: () => this.run(),
      onChange: (v) => {
        const modified = v.trim() !== this.#originalSql.trim();
        this.#ui.modified.hidden = !modified;
        this.#ui.resetBtn.hidden = !modified;
      },
    });
    this.#ui.editorArea.append(this.#editor.el);

    this.#ui.runBtn.addEventListener('click', () => this.run());
    this.#ui.sqlBtn.addEventListener('click', () => this.toggleSql());
    this.#ui.resetBtn.addEventListener('click', () => {
      this.#editor.value = this.#originalSql;
      this.#ui.modified.hidden = true;
      this.#ui.resetBtn.hidden = true;
      this.run();
    });
    this.#ui.forkBtn.addEventListener('click', () => this.fork());
    this.#ui.csvBtn.addEventListener('click', () => this.exportAs('csv'));
    this.#ui.parquetBtn.addEventListener('click', () => this.exportAs('parquet'));
    this.#ui.viewToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-result-view]');
      if (btn) {
        this.#viewChosen = true;
        this.#setView(btn.dataset.resultView);
      }
    });

    this.#ui.body.innerHTML = `<div class="px-4 py-6 text-center font-mono text-[11px] text-zinc-600">Waiting for engine…</div>`;
  }

  #setRunning(running) {
    this.#ui.runBtn.disabled = running;
    this.#ui.runBtn.innerHTML = running ? `<span class="spinner"></span><span>Running</span>` : `${ICONS.play}<span>Run</span>`;
    if (running) this.#ui.status.innerHTML = `<span class="animate-pulse text-zinc-400">executing…</span>`;
    this.classList.toggle('is-running', running);
  }

  #renderResult(result) {
    this.#chart?.destroy();
    this.#chart = null;
    const body = this.#ui.body;
    body.replaceChildren();

    const limit = Number(this.getAttribute('limit')) || Number(settings.get('tableRows')) || MAX_TABLE_ROWS;
    const spec = this.#chartRequested()
      ? inferChartSpec(result, { chart: this.getAttribute('chart'), x: this.getAttribute('x'), y: this.getAttribute('y') })
      : null;

    const chartWrap = document.createElement('div');
    chartWrap.className = 'dq-chart p-3';
    let chartRendered = null;
    if (spec && result.numRows > 0) {
      chartRendered = renderChart(result, spec);
      if (chartRendered) {
        this.#chart = chartRendered.chart;
        chartWrap.append(chartRendered.el);
        body.append(chartWrap);
      }
    }

    const tableWrap = document.createElement('div');
    tableWrap.className = 'dq-table';
    const t = renderTable(result, { maxRows: limit });
    tableWrap.append(t.el);
    body.append(tableWrap);

    this.#ui.footer.hidden = false;
    this.#ui.rowinfo.textContent =
      t.total > t.shown ? `Showing ${fmtInt(t.shown)} of ${fmtInt(t.total)} rows — export for the full set` : `${fmtInt(t.total)} row${t.total === 1 ? '' : 's'} · ${result.columns.length} column${result.columns.length === 1 ? '' : 's'}`;

    this.#ui.viewToggle.hidden = !chartRendered;
    if (!this.#viewChosen) this.#view = spec?.inferred ? 'table' : 'chart';
    this.#setView(chartRendered ? this.#view : 'table', { silent: true });
  }

  #setView(view, { silent = false } = {}) {
    this.#view = view;
    const chartEl = this.querySelector('.dq-chart');
    const tableEl = this.querySelector('.dq-table');
    if (chartEl) chartEl.hidden = view !== 'chart';
    if (tableEl) tableEl.hidden = Boolean(chartEl) && view !== 'table';
    for (const b of this.#ui.viewToggle.querySelectorAll('button')) {
      const active = b.dataset.resultView === view;
      b.classList.toggle('bg-zinc-800', active);
      b.classList.toggle('text-zinc-100', active);
      b.classList.toggle('text-zinc-500', !active);
    }
    if (!silent && view === 'chart') this.#chart?.resize();
  }

  /** Friendlier follow-up for "Table with name X does not exist" errors. */
  #missingTableHint(err) {
    const name = String(err?.message ?? '').match(/Table with name (\w+) does not exist/)?.[1];
    if (!name) return [];
    const box = document.createElement('div');
    box.className = 'mx-3 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300';
    if (name === 'dataset') {
      box.innerHTML = `<span>No dataset is active.</span><a href="#/" class="btn btn-primary">Upload one on the Overview page →</a>`;
    } else if (DuckQuery.sampleIds.has(name) && DuckQuery.loadSample) {
      box.innerHTML = `<span>This example uses the bundled sample <code class="rounded bg-zinc-800 px-1">${escapeHtml(name)}</code>, which isn't loaded.</span><button type="button" class="btn btn-primary">Load sample and re-run</button>`;
      box.querySelector('button').addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.innerHTML = `<span class="spinner"></span> loading`;
        await DuckQuery.loadSample(name);
        this.run();
      });
    } else {
      return [];
    }
    return [box];
  }

  #flash(text, isError = false) {
    const f = this.#ui.flash;
    f.textContent = text;
    f.className = `dq-flash px-3 py-1.5 font-mono text-[11px] ${isError ? 'text-rose-300' : 'text-emerald-300'}`;
    f.hidden = false;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => (f.hidden = true), 4000);
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'query';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (!customElements.get('duck-query')) customElements.define('duck-query', DuckQuery);
