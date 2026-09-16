/**
 * Rendering primitives: result tables, charts, skeletons, error boxes.
 * Everything takes an engine query result ({ table, fields, numRows }) and
 * returns a DOM node.
 */
import { formatCell, plainValue, arrowTypeLabel, arrowKind, escapeHtml, fmtInt } from './format.js';

export const MAX_TABLE_ROWS = 200;

// Validated categorical palette (dark surface #18181b) — fixed slot order.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const SURFACE = '#18181b';
const GRID = '#27272a';
const TEXT_MUTED = '#a1a1aa';
const TEXT_DIM = '#71717a';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
export function renderTable(result, { maxRows = MAX_TABLE_ROWS } = {}) {
  const { table, fields } = result;
  const wrap = document.createElement('div');
  wrap.className = 'relative max-h-[28rem] overflow-auto';
  const rows = table.toArray();
  const shown = rows.slice(0, maxRows);

  const head = fields
    .map((f) => {
      const kind = arrowKind(f);
      return `<th class="${kind === 'num' ? 'num' : ''}">${escapeHtml(f.name)}<span class="type">${escapeHtml(arrowTypeLabel(f.type))}</span></th>`;
    })
    .join('');

  const body = [];
  for (const row of shown) {
    const cells = [];
    for (const f of fields) {
      const { text, kind } = formatCell(row[f.name], f);
      const cls = kind === 'null' ? 'null' : kind;
      const title = kind === 'json' ? ` title="${escapeHtml(text)}"` : '';
      cells.push(`<td class="${cls}"${title}>${escapeHtml(text)}</td>`);
    }
    body.push(`<tr>${cells.join('')}</tr>`);
  }

  wrap.innerHTML = `<table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`;
  if (!rows.length) {
    wrap.innerHTML += `<div class="px-3 py-6 text-center text-xs text-zinc-500">No rows returned.</div>`;
  }
  return { el: wrap, shown: shown.length, total: rows.length };
}

// ---------------------------------------------------------------------------
// Charts (Chart.js, dark theme, validated palette, thin marks)
// ---------------------------------------------------------------------------
let chartDefaultsApplied = false;
function applyChartDefaults() {
  const Chart = globalThis.Chart;
  if (!Chart || chartDefaultsApplied) return;
  chartDefaultsApplied = true;
  Chart.defaults.color = TEXT_MUTED;
  Chart.defaults.borderColor = GRID;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.animation.duration = 300;
  Chart.defaults.plugins.tooltip.backgroundColor = '#09090b';
  Chart.defaults.plugins.tooltip.borderColor = GRID;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = '#f4f4f5';
  Chart.defaults.plugins.tooltip.bodyColor = TEXT_MUTED;
  Chart.defaults.plugins.tooltip.padding = 8;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
}

/**
 * Decide chart axes from a result: x = first non-numeric column, y = numeric columns.
 * Explicit `x` / `y` (comma separated) override.
 */
export function inferChartSpec(result, { chart = 'auto', x, y } = {}) {
  const { fields } = result;
  if (!fields.length || chart === 'none') return null;
  const numeric = fields.filter((f) => arrowKind(f) === 'num').map((f) => f.name);
  const nonNumeric = fields.filter((f) => arrowKind(f) !== 'num').map((f) => f.name);

  const xCol = x || nonNumeric[0] || fields[0].name;
  const xField = fields.find((f) => f.name === xCol);
  const temporal = xField && (arrowKind(xField) === 'date' || /^\d{4}-\d{2}/.test(String(result.table.getChild(xCol)?.get(0) ?? '')));
  // Explicit y may list several series (author asserts comparable scales); auto
  // mode stays single-series — measures of different scale never share an axis.
  const yCols = y
    ? y.split(',').map((s) => s.trim()).filter(Boolean)
    : numeric.filter((n) => n !== xCol).slice(0, 1);
  if (!yCols.length) return null;

  let type = chart;
  if (type === 'auto') {
    // Heuristics: skip shapes that can't be read as a chart.
    if (result.numRows < 2) return null;
    if (!temporal && result.numRows > 60) return null; // too many categories for bars
    if (temporal && result.numRows > 2000) return null;
    type = temporal ? 'line' : 'bar';
  }
  return { type, x: xCol, y: yCols, inferred: chart === 'auto' };
}

const hexToRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/**
 * Render a bar / line chart for a result. Returns { el, chart } — call
 * chart.destroy() before re-rendering into the same card.
 */
export function renderChart(result, spec, { maxPoints = 500 } = {}) {
  const Chart = globalThis.Chart;
  if (!Chart) return null;
  applyChartDefaults();
  const { table, fields } = result;
  const xField = fields.find((f) => f.name === spec.x);
  const yFields = spec.y.map((name) => fields.find((f) => f.name === name)).filter(Boolean);
  if (!xField || !yFields.length) return null;

  const rows = table.toArray().slice(0, maxPoints);
  const labels = rows.map((r) => formatCell(r[xField.name], xField).text);
  const isLine = spec.type === 'line';
  const datasets = yFields.map((f, i) => {
    const color = SERIES[i % SERIES.length];
    const data = rows.map((r) => plainValue(r[f.name], f));
    return isLine
      ? {
          label: f.name,
          data,
          borderColor: color,
          backgroundColor: hexToRgba(color, 0.1),
          borderWidth: 2,
          borderJoinStyle: 'round',
          borderCapStyle: 'round',
          pointRadius: rows.length > 60 ? 0 : 4,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: SURFACE,
          pointBorderWidth: 2,
          fill: yFields.length === 1,
          tension: 0.2,
          spanGaps: true,
        }
      : {
          label: f.name,
          data,
          backgroundColor: color,
          hoverBackgroundColor: hexToRgba(color, 0.85),
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 24,
          categoryPercentage: 0.7,
          barPercentage: 0.9,
        };
  });

  const horizontal = !isLine && rows.length <= 12 && labels.some((l) => l.length > 8);
  const wrapper = document.createElement('div');
  wrapper.className = 'relative w-full';
  wrapper.style.height = horizontal ? `${Math.max(180, 28 * rows.length + 48)}px` : '16rem';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${spec.type} chart of ${spec.y.join(', ')} by ${spec.x}`);
  wrapper.append(canvas);

  const numberTick = (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }) : v);
  const valueAxis = {
    beginAtZero: true,
    grid: { color: GRID, lineWidth: 1, drawTicks: false },
    border: { display: false },
    ticks: { color: TEXT_DIM, font: { family: 'ui-monospace, Menlo, monospace', size: 10 }, callback: numberTick, maxTicksLimit: 6, padding: 6 },
  };
  const categoryAxis = {
    grid: { display: false },
    border: { color: GRID },
    ticks: { color: TEXT_MUTED, autoSkip: true, maxRotation: 0, maxTicksLimit: horizontal ? undefined : 12, padding: 6 },
  };

  const chart = new Chart(canvas, {
    type: isLine ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 8, right: 12 } },
      scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
      plugins: {
        legend: { display: yFields.length > 1, position: 'top', align: 'end' },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${typeof ctx.parsed === 'object' ? fmtInt(horizontal ? ctx.parsed.x : ctx.parsed.y) : ctx.formattedValue}`,
          },
        },
      },
    },
  });
  return { el: wrapper, chart };
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function renderSkeleton({ rows = 5, chart = false } = {}) {
  const el = document.createElement('div');
  el.className = 'space-y-2 p-4';
  el.setAttribute('aria-busy', 'true');
  if (chart) {
    el.innerHTML = `<div class="flex h-48 items-end gap-2 px-2">${Array.from({ length: 9 }, (_, i) => `<div class="skeleton w-full" style="height:${30 + ((i * 37) % 60)}%"></div>`).join('')}</div>`;
    return el;
  }
  el.innerHTML =
    `<div class="skeleton h-4 w-2/3"></div>` +
    Array.from({ length: rows }, (_, i) => `<div class="skeleton h-3" style="width:${95 - ((i * 13) % 30)}%"></div>`).join('');
  return el;
}

export function renderError(err, sql) {
  const el = document.createElement('div');
  el.className = 'm-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3';
  const msg = String(err?.message ?? err);
  el.innerHTML = `<div class="mb-1 flex items-center gap-2 text-xs font-medium text-rose-300">
      <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>
      Query failed
    </div>
    <pre class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-rose-200/90">${escapeHtml(msg)}</pre>`;
  return el;
}

export function spinner(label = 'Running') {
  const s = document.createElement('span');
  s.className = 'inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400';
  s.innerHTML = `<span class="spinner"></span>${escapeHtml(label)}`;
  return s;
}
