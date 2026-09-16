/**
 * Overview — page 1.
 *
 * The moment a dataset becomes active we fire a fixed battery of queries and
 * paint the results — before the user writes any SQL:
 *
 *   header + KPIs      COUNT(*), column count, estimated memory, safety verdict
 *   schema             DESCRIBE (instant) + SUMMARIZE stats (nulls, distinct, min/max/avg)
 *   preview            SELECT * FROM t LIMIT 10
 *   distributions      rows per month (first DATE/TIMESTAMP column) and
 *                      top-5 counts for ≤ 2 low-cardinality text columns
 *
 * Every query card is a <duck-query>, so all of it can be edited, opened in
 * the Query tool and exported.
 */
import { DuckQuery } from './duck-query.js';
import { assessFeasibility } from './hardware.js';
import { FORMAT_LABEL } from './engine.js';
import {
  qid,
  fmtInt,
  fmtBytes,
  fmtCompact,
  fmtMs,
  fmtNumber,
  escapeHtml,
  isTemporalType,
  isTextType,
  isNumericType,
  isBoolType,
  isNestedType,
  typeWidth,
} from './format.js';

const MOUNT_MODE_LABEL = {
  'http-range': 'HTTP range reads',
  buffer: 'in-memory buffer',
  'file-reader': 'local file (streamed)',
  'arrow-table': 'Arrow table',
};

export class Overview {
  #token = 0;
  #cards = [];

  constructor({ engine, container, onFeasibility, settings }) {
    this.engine = engine;
    this.container = container;
    this.onFeasibility = onFeasibility;
    this.settings = settings;
  }

  /** Placeholder shown before any dataset is active. */
  renderEmpty(message = 'Upload a dataset to get started.') {
    this.#token++;
    this.#cards = [];
    const booting = /boot|fail/i.test(message);
    this.container.innerHTML = `
      <div class="card fade-in grid place-items-center px-6 py-16 text-center">
        <svg class="mb-3 size-8 text-zinc-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        <p class="text-sm text-zinc-300">${escapeHtml(message)}</p>
        ${
          booting
            ? ''
            : `<p class="mt-1 max-w-md text-xs text-zinc-500">Drop a Parquet, CSV, TSV, JSON, NDJSON or Arrow file anywhere on this page. It is read locally by DuckDB — nothing is uploaded. The schema and an automatic profile appear here the moment it loads.</p>
        <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button type="button" class="btn btn-primary ov-choose">Choose a file…</button>
          <span class="text-xs text-zinc-600">or load a sample from the sidebar</span>
        </div>`
        }
      </div>`;
    this.container.querySelector('.ov-choose')?.addEventListener('click', () => document.querySelector('#file-input')?.click());
  }

  /** Router hook: charts drawn while the view was hidden need a resize. */
  onShown() {
    for (const card of this.#cards) card.onShown?.();
  }

  async run(ds) {
    const token = ++this.#token;
    const alive = () => token === this.#token;
    const T = qid(ds.id);
    const t0 = performance.now();
    const schema = ds.schema ?? [];
    const ui = this.#renderShell(ds, schema);
    const mk = (opts) => {
      const card = DuckQuery.create({ collapsed: true, ...opts });
      this.#cards.push(card);
      return card;
    };

    // 1. Preview ---------------------------------------------------------
    const preview = mk({ title: 'Data preview', sql: `SELECT * FROM ${T} LIMIT 10;`, limit: 10 });
    ui.previewSlot.append(preview);
    const previewRun = preview.run();

    // 2. Volume ----------------------------------------------------------
    const countSql = `SELECT COUNT(*) AS total_rows FROM ${T};`;
    ui.rows.sqlLink.onclick = () => DuckQuery.forkTarget?.(countSql, { title: 'Row count' });
    const volumeRun = this.engine.query(countSql).then((res) => {
      if (!alive()) return null;
      const rows = Number(res.table.toArray()[0]?.total_rows ?? 0);
      ui.rows.value.textContent = fmtInt(rows);
      ui.rows.sub.textContent = `COUNT(*) in ${fmtMs(res.ms)}`;
      return rows;
    });

    // 3. Time series (independent of SUMMARIZE) ----------------------------
    const autoCharts = this.settings?.get('autoCharts') ?? true;
    const temporal = schema.find((c) => isTemporalType(c.type));
    if (temporal && autoCharts) {
      const sql = `SELECT strftime(date_trunc('month', ${qid(temporal.name)}::TIMESTAMP), '%Y-%m') AS month,
       COUNT(*) AS rows
FROM ${T}
WHERE ${qid(temporal.name)} IS NOT NULL
GROUP BY 1
ORDER BY 1;`;
      const card = mk({ title: `Rows per month · ${temporal.name}`, sql, chart: 'line', x: 'month', y: 'rows' });
      ui.chartsSlot.append(card);
      card.run();
    }

    // 4. Profile → schema card (skippable in Settings for very large files) -----------
    const summarizeSql = `SUMMARIZE SELECT * FROM ${T};`;
    const profileEnabled = this.settings?.get('profile') ?? true;
    const profileRun = profileEnabled
      ? this.engine
          .query(summarizeSql)
          .then((res) => {
            if (!alive()) return null;
            const stats = new Map(res.table.toArray().map((r) => [String(r.column_name), r.toJSON()]));
            this.#fillSchemaStats(ui, stats);
            ui.schemaMeta.textContent = `profiled with SUMMARIZE in ${fmtMs(res.ms)}`;
            return stats;
          })
          .catch((err) => {
            if (alive()) ui.schemaMeta.innerHTML = `<span class="text-rose-300">SUMMARIZE failed: ${escapeHtml(err.message)}</span>`;
            return null;
          })
      : Promise.resolve(null).then(() => {
          ui.schemaMeta.innerHTML = `${schema.length} columns · <a href="#/settings" class="text-violet-300 underline">profiling is off</a>`;
          for (const row of ui.schemaRows) for (const sk of row.querySelectorAll('.skeleton')) sk.replaceWith(Object.assign(document.createElement('span'), { textContent: '—', className: 'text-zinc-600' }));
          return null;
        });

    // 5. Memory estimate --------------------------------------------------
    const memoryRun = this.#estimateMemory(ds, schema, volumeRun, alive).then((estimate) => {
      if (!alive() || !estimate) return;
      ui.memory.value.textContent = fmtBytes(estimate.bytes);
      ui.memory.sub.textContent = `≈ ${fmtBytes(estimate.rowWidth)}/row × ${fmtCompact(estimate.rows)} rows · ${fmtBytes(ds.size)} on disk`;
      const verdict = assessFeasibility({
        estimatedBytes: estimate.bytes,
        diskBytes: ds.size,
        format: ds.format,
        memoryLimit: this.engine.hardware.memoryLimit,
        warnPct: this.settings?.get('warnPct'),
        dangerPct: this.settings?.get('dangerPct'),
      });
      this.#renderFeasibility(ui.alert, verdict);
      this.onFeasibility?.(verdict, ds);
    });

    // 6. Top-5 frequency for low/medium-cardinality text columns -------------
    profileRun.then((stats) => {
      if (!alive()) return;
      if (!autoCharts) {
        ui.chartsSlot.innerHTML = `<div class="card px-4 py-4 text-center text-xs text-zinc-500 lg:col-span-2">Distribution charts are turned off in <a href="#/settings" class="text-violet-300 underline">Settings</a>.</div>`;
        return;
      }
      const candidates = [];
      for (const [name, o] of stats ?? []) {
        const type = String(o.column_type ?? '');
        const uniq = Number(o.approx_unique ?? 0);
        if (isTextType(type) && !isNestedType(type) && uniq >= 2 && uniq <= 100) candidates.push({ name, uniq });
      }
      for (const col of candidates.slice(0, 2)) {
        const sql = `SELECT ${qid(col.name)}, COUNT(*) AS count
FROM ${T}
GROUP BY 1
ORDER BY 2 DESC
LIMIT 5;`;
        const card = mk({ title: `Top 5 · ${col.name}`, sql, chart: 'bar', x: col.name, y: 'count' });
        ui.chartsSlot.append(card);
        card.run();
      }
      if (!temporal && !candidates.length) {
        ui.chartsSlot.innerHTML = `<div class="card px-4 py-6 text-center text-xs text-zinc-500 lg:col-span-2">No date or low-cardinality text columns found — nothing to auto-chart. Open the preview in the Query tool and aggregate whatever you like.</div>`;
      }
    });

    await Promise.allSettled([previewRun, volumeRun, profileRun, memoryRun]);
    if (alive()) ui.timing.textContent = `overview suite finished in ${fmtMs(performance.now() - t0)}`;
  }

  // -----------------------------------------------------------------------
  async #estimateMemory(ds, schema, volumeRun, alive) {
    const rows = await volumeRun;
    if (rows == null || !alive()) return null;
    const textCols = schema.filter((c) => isTextType(c.type) && !isNestedType(c.type));
    let avgLen = {};
    if (textCols.length && rows > 0) {
      const sel = textCols.map((c) => `avg(octet_length(${qid(c.name)}::VARCHAR::BLOB)) AS ${qid(c.name)}`).join(', ');
      try {
        const sample = Math.max(100, Number(this.settings?.get('estimateSampleRows')) || 5000);
        const res = await this.engine.query(`SELECT ${sel} FROM (SELECT * FROM ${qid(ds.id)} LIMIT ${sample});`, { silent: true });
        avgLen = res.table.toArray()[0]?.toJSON?.() ?? {};
      } catch {
        /* fall back to fixed widths */
      }
    }
    let rowWidth = 0;
    for (const c of schema) {
      let w = typeWidth(c.type);
      if (isTextType(c.type) && !isNestedType(c.type)) {
        const len = Number(avgLen[c.name] ?? 24) || 0;
        w = len <= 12 ? 16 : 16 + len; // DuckDB string_t: 12-byte inline prefix, else pointer + heap
      }
      rowWidth += w;
    }
    return { rows, rowWidth, bytes: rows * rowWidth };
  }

  #renderFeasibility(el, verdict) {
    if (verdict.level === 'green') {
      el.hidden = true;
      return;
    }
    const tone = verdict.level === 'yellow' ? 'border-amber-500/30 bg-amber-500/5 text-amber-200' : 'border-rose-500/30 bg-rose-500/5 text-rose-200';
    el.className = `card fade-in flex items-start gap-3 px-4 py-3 text-sm ${tone}`;
    el.innerHTML = `
      <svg class="mt-0.5 size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>
      <div>
        <p class="font-medium">${escapeHtml(verdict.label)} — ${escapeHtml(verdict.summary)}</p>
        ${verdict.advice ? `<p class="mt-0.5 text-xs opacity-80">${escapeHtml(verdict.advice)}</p>` : ''}
      </div>`;
    el.hidden = false;
  }

  // -----------------------------------------------------------------------
  // Schema card
  // -----------------------------------------------------------------------
  #fillSchemaStats(ui, stats) {
    for (const row of ui.schemaRows) {
      const o = stats.get(row.dataset.col);
      if (!o) continue;
      const nullPct = Number(o.null_percentage ?? 0);
      const uniq = Number(o.approx_unique ?? 0);
      const numeric = isNumericType(String(o.column_type ?? ''));
      row.querySelector('.s-nulls').innerHTML = `
        <span class="inline-flex items-center justify-end gap-1.5">
          <span class="inline-block h-1.5 w-10 overflow-hidden rounded-full bg-zinc-800"><span class="block h-full ${nullPct > 20 ? 'bg-rose-400' : nullPct > 0 ? 'bg-amber-400' : 'bg-emerald-500/60'}" style="width:${Math.max(nullPct > 0 ? 4 : 0, Math.min(100, nullPct))}%"></span></span>
          <span class="${nullPct > 0 ? 'text-zinc-300' : 'text-zinc-500'}">${fmtNumber(nullPct, 1)}%</span>
        </span>`;
      row.querySelector('.s-unique').textContent = fmtInt(uniq);
      row.querySelector('.s-min').textContent = o.min == null ? '—' : truncate(String(o.min), 28);
      row.querySelector('.s-max').textContent = o.max == null ? '—' : truncate(String(o.max), 28);
      row.querySelector('.s-avg').textContent = numeric && o.avg != null ? fmtNumber(Number(o.avg), 3) : '—';
    }
  }

  #renderShell(ds, schema) {
    const c = this.container;
    this.#cards = [];
    const typeBadge = (t) => {
      const cls = isNumericType(t) ? 'text-amber-300 border-amber-500/30 bg-amber-500/10' : isTemporalType(t) ? 'text-teal-300 border-teal-500/30 bg-teal-500/10' : isBoolType(t) ? 'text-sky-300 border-sky-500/30 bg-sky-500/10' : isNestedType(t) ? 'text-orange-300 border-orange-500/30 bg-orange-500/10' : 'text-zinc-300 border-zinc-700 bg-zinc-800/60';
      return `<span class="badge ${cls}" title="${escapeHtml(t)}">${escapeHtml(shortType(t))}</span>`;
    };
    const skel = `<span class="skeleton inline-block h-3 w-12 align-middle"></span>`;
    const schemaRows = schema
      .map(
        (col, i) => `
        <tr data-col="${escapeHtml(col.name)}">
          <td class="num text-zinc-600">${i + 1}</td>
          <td class="str font-medium">${escapeHtml(col.name)}</td>
          <td>${typeBadge(col.type)}</td>
          <td class="s-nulls num">${skel}</td>
          <td class="s-unique num">${skel}</td>
          <td class="s-min text-zinc-400">${skel}</td>
          <td class="s-max text-zinc-400">${skel}</td>
          <td class="s-avg num">${skel}</td>
        </tr>`,
      )
      .join('');

    c.innerHTML = `
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[11px] font-medium uppercase tracking-wider text-violet-400">Overview · auto-generated on load</p>
          <h1 class="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-50">${escapeHtml(ds.file)}</h1>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <span class="badge badge-zinc">${escapeHtml(FORMAT_LABEL[ds.format] ?? ds.format)}</span>
            <span class="badge badge-zinc">${fmtBytes(ds.size)}</span>
            <span class="badge badge-zinc" title="How DuckDB reads this file">${escapeHtml(MOUNT_MODE_LABEL[ds.mountMode] ?? ds.mountMode ?? '')}</span>
            <span class="badge badge-zinc">${ds.source === 'local' ? 'local file — never uploaded' : 'bundled'}</span>
            ${ds.unwrapped ? `<span class="badge badge-violet" title="The file is a single object; its ${escapeHtml(ds.unwrapped.column)} array was unnested into rows.${ds.unwrapped.dropped.length ? ' Top-level fields not carried over: ' + escapeHtml(ds.unwrapped.dropped.join(', ')) : ''}">rows from ${escapeHtml(ds.unwrapped.column)}[]</span>` : ''}
            <span class="ml-1 font-mono text-[11px] text-zinc-500">query it as <code class="rounded bg-zinc-800 px-1 text-zinc-300">${escapeHtml(ds.id)}</code> or <code class="rounded bg-zinc-800 px-1 text-zinc-300">dataset</code></span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="ov-timing font-mono text-[11px] text-zinc-500">running overview suite…</span>
          <a href="#/query" class="btn btn-primary">Open Query tool →</a>
        </div>
      </div>

      <div class="ov-alert" hidden></div>

      <div class="grid gap-4 sm:grid-cols-3">
        ${kpiCard('rows', 'Total rows')}
        ${kpiCard('cols', 'Total columns')}
        ${kpiCard('memory', 'Estimated memory')}
      </div>

      <section class="card fade-in overflow-hidden" aria-label="Schema">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-3 py-2">
          <h2 class="text-[13px] font-medium text-zinc-100">Schema</h2>
          <span class="ov-schema-meta font-mono text-[11px] text-zinc-500">${schema.length} columns · profiling…</span>
          <div class="ml-auto flex items-center gap-1">
            <button type="button" class="btn btn-ghost ov-describe" title="Open DESCRIBE in the Query tool">DESCRIBE ↗</button>
            <button type="button" class="btn btn-ghost ov-summarize" title="Open SUMMARIZE in the Query tool">SUMMARIZE ↗</button>
          </div>
        </header>
        <div class="max-h-[32rem] overflow-auto">
          <table class="grid-table">
            <thead><tr>
              <th class="num">#</th><th>column</th><th>type</th><th class="num">nulls</th><th class="num">distinct ≈</th><th>min</th><th>max</th><th class="num">avg</th>
            </tr></thead>
            <tbody>${schemaRows || `<tr><td colspan="8" class="py-6 text-center text-zinc-500">No columns.</td></tr>`}</tbody>
          </table>
        </div>
      </section>

      <div class="ov-preview"></div>
      <div class="ov-charts grid gap-4 lg:grid-cols-2"></div>`;

    const kpiRefs = (key) => {
      const root = c.querySelector(`[data-kpi="${key}"]`);
      return { root, value: root.querySelector('.kpi-value'), sub: root.querySelector('.kpi-sub'), sqlLink: root.querySelector('.kpi-sql') };
    };
    const refs = {
      rows: kpiRefs('rows'),
      cols: kpiRefs('cols'),
      memory: kpiRefs('memory'),
      alert: c.querySelector('.ov-alert'),
      previewSlot: c.querySelector('.ov-preview'),
      chartsSlot: c.querySelector('.ov-charts'),
      timing: c.querySelector('.ov-timing'),
      schemaMeta: c.querySelector('.ov-schema-meta'),
      schemaRows: [...c.querySelectorAll('tr[data-col]')],
    };

    // Column count + type mix are known immediately from DESCRIBE.
    refs.cols.value.textContent = fmtInt(schema.length);
    const kinds = { numeric: 0, text: 0, temporal: 0, other: 0 };
    for (const col of schema) {
      if (isTemporalType(col.type)) kinds.temporal++;
      else if (isNumericType(col.type)) kinds.numeric++;
      else if (isTextType(col.type)) kinds.text++;
      else kinds.other++;
    }
    refs.cols.sub.textContent = [
      kinds.numeric && `${kinds.numeric} numeric`,
      kinds.text && `${kinds.text} text`,
      kinds.temporal && `${kinds.temporal} temporal`,
      kinds.other && `${kinds.other} other`,
    ]
      .filter(Boolean)
      .join(' · ');
    const T = qid(ds.id);
    refs.cols.sqlLink.onclick = () => DuckQuery.forkTarget?.(`DESCRIBE ${T};`, { title: 'Schema' });
    refs.memory.sqlLink.onclick = () => DuckQuery.forkTarget?.(`PRAGMA database_size;`, { title: 'Engine memory' });
    c.querySelector('.ov-describe').onclick = () => DuckQuery.forkTarget?.(`DESCRIBE ${T};`, { title: 'Schema' });
    c.querySelector('.ov-summarize').onclick = () => DuckQuery.forkTarget?.(`SUMMARIZE SELECT * FROM ${T};`, { title: 'Column profile' });
    return refs;
  }
}

function kpiCard(key, label) {
  return `
    <div class="card fade-in p-4" data-kpi="${key}">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-zinc-400">${label}</span>
        <button type="button" class="kpi-sql btn btn-ghost h-6 px-1.5 font-mono text-[10px]" title="Open the SQL behind this number in the Query tool">SQL ↗</button>
      </div>
      <div class="kpi-value mt-2 text-3xl font-semibold tracking-tight text-zinc-50"><span class="skeleton inline-block h-8 w-24 align-middle"></span></div>
      <div class="kpi-sub mt-1 h-4 truncate font-mono text-[11px] text-zinc-500"></div>
    </div>`;
}

function shortType(t) {
  return String(t)
    .replace(/^TIMESTAMP WITH TIME ZONE$/i, 'TIMESTAMPTZ')
    .replace(/^STRUCT\(.*\)$/i, 'STRUCT')
    .replace(/^MAP\(.*\)$/i, 'MAP');
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
