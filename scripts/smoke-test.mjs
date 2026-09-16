#!/usr/bin/env node
/**
 * DuckView smoke test — drives the built site in headless Chrome and checks the
 * three pages end to end: the engine boots, every dataset mounts, the
 * Overview populates (KPIs, schema, preview, charts), the Query tool runs SQL,
 * charts it and exports results + query, docs pages run their live cards,
 * fork → Query works, and a dropped file mounts through the File API.
 *
 *   npm test                                                  # builds, serves dist/ on a temp port
 *   node scripts/smoke-test.mjs --url http://localhost:4173   # against a running server
 *
 * Uses playwright-core with the Chrome already on this machine (no browser download).
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const PORT = Number(argValue('--port') || 4179);
let BASE = argValue('--url');

const c = { ok: (s) => `\x1b[32m✔\x1b[0m ${s}`, bad: (s) => `\x1b[31m✖\x1b[0m ${s}`, dim: (s) => `\x1b[2m${s}\x1b[0m`, head: (s) => `\n\x1b[1m${s}\x1b[0m` };
let failures = 0;
const check = (cond, label, detail = '') => {
  console.log(cond ? c.ok(label) : c.bad(label), detail ? c.dim(detail) : '');
  if (!cond) failures++;
};

// ---------------------------------------------------------------------------
// Serve dist/ unless a URL was given
// ---------------------------------------------------------------------------
let server = null;
if (!BASE) {
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'serve.cmd' : 'serve');
  server = spawn(bin, ['dist', '-l', String(PORT), '-n'], { cwd: ROOT, stdio: 'ignore' });
  BASE = `http://localhost:${PORT}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    try {
      if ((await fetch(`${BASE}/index.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
console.log(c.dim(`\nTesting ${BASE}`));

const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// Local-first guarantee: nothing outside localhost may be requested. Abort (and record) anything that tries.
const externalRequests = [];
await context.route(/^(?!https?:\/\/localhost)/, (route) => {
  externalRequests.push(route.request().url());
  route.abort();
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => {
  if (r.url().startsWith('http://localhost')) pageErrors.push(`request failed: ${r.url()}`);
});

const settled = () => page.waitForFunction(() => [...document.querySelectorAll('duck-query')].every((q) => !q.classList.contains('is-running')), null, { timeout: 60000 });
const overviewDone = () => page.waitForFunction(() => document.querySelector('.ov-timing')?.textContent.includes('finished'), null, { timeout: 60000 });
const visibleView = () => page.evaluate(() => [...document.querySelectorAll('section.view[data-view]')].find((v) => !v.hidden)?.dataset.view);
const DuckView_SAMPLES = 6;

try {
  // ── Page 1 · Overview ──────────────────────────────────────────────────────
  console.log(c.head('Overview  #/'));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DuckView?.engine?.status === 'ready', null, { timeout: 60000 });
  const boot = await page.evaluate(() => ({ version: DuckView.engine.version, bundle: DuckView.engine.bundleName, ms: Math.round(DuckView.engine.bootMs), tuning: DuckView.engine.tuning }));
  check(true, `engine ready — DuckDB ${boot.version} (${boot.bundle}) in ${boot.ms} ms`);
  check(boot.tuning.find((t) => t.label.startsWith('memory_limit'))?.ok, 'memory_limit applied');
  const exts = await page.evaluate(() => DuckView.engine.extensions.map((e) => `${e.name}:${e.ok ? 'ok' : e.error}`));
  check(exts.length === 2 && exts.every((e) => e.endsWith(':ok')), 'parquet + json extensions loaded from the local bundle', exts.join(', '));
  check((await visibleView()) === 'home', 'home view is visible by default');
  await page.waitForFunction(() => document.querySelector('#overview .ov-choose'), null, { timeout: 20000 });
  const empty = await page.evaluate(() => ({ datasets: DuckView.engine.datasets.size, samples: document.querySelectorAll('#sample-list [data-sample]').length, pill: document.querySelector('#status-pill').textContent }));
  check(empty.datasets === 0 && empty.samples === DuckView_SAMPLES, `boots empty: 0 datasets loaded, ${empty.samples} samples offered`, empty.pill.replace(/\s+/g, ' ').trim());

  // Load one sample from the sidebar button, then the rest via "Load all".
  await page.click('#sample-list [data-sample="sales"]');
  await page.waitForFunction(() => DuckView.engine.activeId === 'sales', null, { timeout: 60000 });
  check(true, 'clicking "Load" on a sample mounts it and makes it active');
  await page.click('#samples-load-all');
  await page.waitForFunction(() => DuckView.engine.datasets.size >= DuckView.manifest.datasets.length && [...DuckView.engine.datasets.values()].every((d) => d.state !== 'loading'), null, { timeout: 60000 });
  const datasets = await page.evaluate(() => [...DuckView.engine.datasets.values()].map((d) => ({ id: d.id, state: d.state, mode: d.mountMode, error: d.error })));
  for (const d of datasets) check(d.state === 'ready', `sample "${d.id}" mounted`, d.error || d.mode);
  check(await page.evaluate(() => DuckView.engine.activeId === 'sales'), '"Load all" keeps the active dataset');

  await overviewDone();
  await settled();
  await page.waitForTimeout(400);
  const kpis = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-kpi]')].map((k) => [k.dataset.kpi, k.querySelector('.kpi-value').textContent.trim()])));
  check(/^\d[\d,]*$/.test(kpis.rows), `KPI total rows = ${kpis.rows}`);
  check(/^\d+$/.test(kpis.cols), `KPI total columns = ${kpis.cols}`);
  check(/\d+(\.\d+)? [KMG]?B/.test(kpis.memory), `KPI estimated memory = ${kpis.memory}`);
  const schema = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#overview tr[data-col]')];
    return { rows: rows.length, statsFilled: rows.filter((r) => !r.querySelector('.skeleton')).length, first: rows[0]?.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) };
  });
  check(schema.rows > 0 && schema.rows === Number(kpis.cols), `schema card lists ${schema.rows} columns`);
  check(schema.statsFilled === schema.rows, 'schema card stats filled from SUMMARIZE', schema.first);
  check(await page.evaluate(() => document.querySelectorAll('#overview canvas').length) >= 1, 'overview rendered at least one chart');
  check(await page.evaluate(() => document.querySelectorAll('#overview .ov-preview .grid-table tbody tr').length) === 10, 'preview table shows 10 rows');
  const ovCards = await page.evaluate(() => [...document.querySelectorAll('#overview duck-query')].map((q) => ({ title: q.getAttribute('title'), ok: Boolean(q.result), err: q.querySelector('.dq-body pre')?.textContent.slice(0, 120) })));
  for (const card of ovCards) check(card.ok, `overview card "${card.title}"`, card.err || '');

  // ── Fork → Query ─────────────────────────────────────────────────────────────
  console.log(c.head('Fork → Query  #/query'));
  await page.evaluate(() => [...document.querySelectorAll('#overview duck-query')].find((q) => q.getAttribute('title').startsWith('Top 5')).fork());
  await page.waitForFunction(() => location.hash.startsWith('#/query') && DuckView.queryTool.sql.includes('GROUP BY'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.qt-status')?.textContent.includes('Executed'), null, { timeout: 30000 });
  check((await visibleView()) === 'query', 'fork navigated to the Query page and ran the SQL');
  check(await page.evaluate(() => Boolean(document.querySelector('#query-tool canvas'))), 'forked bar chart rendered in the Query tool');
  check(await page.evaluate(() => DuckView.queryTool.active.name.startsWith('Top 5')), 'fork opened as its own tab named after the card');

  // ── Tabs: concurrent runs + stop ────────────────────────────────────────────
  console.log(c.head('Tabs'));
  const tabs = await page.evaluate(async () => {
    const qt = DuckView.queryTool;
    const a = qt.newTab({ name: 'A', sql: 'SELECT COUNT(*) AS n FROM range(600000000)' });
    const b = qt.newTab({ name: 'B', sql: 'SELECT SUM(range) AS s FROM range(600000000)' });
    const z = qt.newTab({ name: 'Z', sql: 'SELECT COUNT(*) FROM range(5000000000)' });
    const t0 = performance.now();
    for (const t of [a, b, z]) qt.run(t.id);
    await new Promise((r) => setTimeout(r, 250));
    const inFlight = qt.tabs.filter((t) => t.running).length;
    await qt.stop(z.id);
    while (qt.tabs.some((t) => t.running)) await new Promise((r) => setTimeout(r, 50));
    return { inFlight, total: Math.round(performance.now() - t0), a: a.result?.numRows, b: b.result?.numRows, zCancelled: Boolean(z.error?.cancelled), tabCount: qt.tabs.length, dots: document.querySelectorAll('.qt-tabs [role="tab"]').length };
  });
  check(tabs.inFlight >= 2, `${tabs.inFlight} tabs were in flight at once (own connections, interleaved)`);
  check(tabs.a === 1 && tabs.b === 1, 'concurrent tabs both completed', `${tabs.total} ms total`);
  check(tabs.zCancelled, 'Stop cancelled the long-running tab');
  check(tabs.dots === tabs.tabCount, `tab bar shows ${tabs.tabCount} tabs`);
  const closed = await page.evaluate(async () => {
    const qt = DuckView.queryTool;
    const before = qt.tabs.length;
    await qt.closeTab(qt.tabs.find((t) => t.name === 'Z').id);
    qt.renameTab(qt.active.id, 'renamed');
    return { before, after: qt.tabs.length, name: qt.active.name, persisted: JSON.parse(localStorage.getItem('duckview.query.tabs')).tabs.length };
  });
  check(closed.after === closed.before - 1 && closed.persisted === closed.after, 'close tab + persistence to localStorage');
  check(closed.name === 'renamed', 'rename tab');

  // ── Import .sql ───────────────────────────────────────────────────────────────
  console.log(c.head('Import'));
  const imported = await page.evaluate(async () => {
    const qt = DuckView.queryTool;
    const before = qt.tabs.length;
    const single = new File(['SELECT region, COUNT(*) AS n FROM sales GROUP BY 1;'], 'by_region.sql', { type: 'application/sql' });
    const multi = new File([['-- DuckView query export', '-- exported: now', '', '-- @duckview-tab: Alpha', 'SELECT 1 AS a;', '', '-- @duckview-tab: Beta', 'SELECT 2 AS b;'].join('\n')], 'bundle.sql', { type: 'application/sql' });
    const n = await qt.importFiles([single, multi]);
    const names = qt.tabs.slice(before).map((t) => t.name);
    await qt.run(qt.active.id);
    return { n, names, activeRows: qt.active.result?.numRows ?? null, activeName: qt.active.name };
  });
  check(imported.n === 3 && imported.names.join(',') === 'by_region,Alpha,Beta', 'import: one file → one tab, multi-tab export → three tabs', imported.names.join(', '));
  check(imported.activeName === 'by_region' && imported.activeRows === 5, 'imported query runs in its tab');
  const dropped = await page.evaluate(async () => {
    const before = DuckView.queryTool.tabs.length;
    await DuckView.panel.ingest([new File(['SELECT 42 AS answer;'], 'dropped.sql', { type: 'application/sql' })]);
    await new Promise((r) => setTimeout(r, 300));
    return { added: DuckView.queryTool.tabs.length - before, hash: location.hash };
  });
  check(dropped.added === 1 && dropped.hash.startsWith('#/query'), 'dropping a .sql file anywhere opens it as a tab on the Query page');

  // ── Page 2 · Query tool ──────────────────────────────────────────────────────
  const runSql = async (sql) => {
    await page.evaluate((s) => {
      DuckView.queryTool.sql = s;
      return DuckView.queryTool.run();
    }, sql);
  };
  await runSql('SELECT region, COUNT(*) AS n, ROUND(SUM(revenue)) AS revenue FROM sales GROUP BY 1 ORDER BY 2 DESC');
  const q1 = await page.evaluate(() => ({ status: document.querySelector('.qt-status').textContent, rows: document.querySelectorAll('.qt-results .grid-table tbody tr').length, controls: !document.querySelector('.qt-chart-controls').hidden }));
  check(/Executed in .* 5 rows/.test(q1.status) && q1.rows === 5, 'query ran and rendered 5 rows', q1.status.trim());
  check(q1.controls, 'chart controls appear for numeric results');
  await page.click('.qt-chart-controls button[data-type="bar"]');
  await page.selectOption('[data-axis="y"]', 'revenue');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => Boolean(document.querySelector('#query-tool canvas')) && document.querySelector('[data-axis="y"]').value === 'revenue'), 'switched to bar chart with y = revenue');
  await page.click('.qt-chart-controls button[data-type="table"]');
  check(await page.evaluate(() => !document.querySelector('#query-tool canvas')), 'switched back to table view');

  const exp = await page.evaluate(async () => {
    const sql = DuckView.queryTool.sql;
    const csv = await DuckView.engine.exportQuery(sql, 'csv');
    const pq = await DuckView.engine.exportQuery(sql, 'parquet');
    const json = JSON.parse(await (await DuckView.engine.exportQuery(sql, 'json')).text());
    return { csvLines: (await csv.text()).trim().split('\n').length, parquetMagic: String.fromCharCode(...new Uint8Array(await pq.slice(0, 4).arrayBuffer())), jsonRows: Array.isArray(json) ? json.length : -1, jsonKeys: Object.keys(json[0] ?? {}) };
  });
  check(exp.csvLines === 6, 'CSV download: header + 5 rows');
  check(exp.parquetMagic === 'PAR1', 'Parquet download has PAR1 magic');
  check(exp.jsonRows === 5 && exp.jsonKeys.includes('revenue'), 'JSON download is an array of 5 objects');
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.click('.qt-dl-sql');
  const sqlFile = await dl;
  check(sqlFile.suggestedFilename().endsWith('.sql'), `query downloaded as ${sqlFile.suggestedFilename()}`);

  await runSql('SELECT * FROM nope_table');
  check(await page.evaluate(() => document.querySelector('.qt-status').textContent.includes('Failed') && Boolean(document.querySelector('.qt-results pre'))), 'failed query shows the DuckDB error');
  const hist = await page.evaluate(() => document.querySelectorAll('.qt-history li[data-idx], .qt-history button[data-idx]').length);
  check(hist >= 2, `history lists ${hist} entries`);
  const insert = await page.evaluate(() => {
    DuckView.queryTool.sql = 'SELECT ';
    document.querySelector('.qt-schema [data-insert]').click();
    return DuckView.queryTool.sql;
  });
  check(/^SELECT "?\w+"?/.test(insert), 'schema explorer inserts an identifier', insert);

  // Switching dataset from the Query page updates the alias.
  const other = datasets.find((d) => d.state === 'ready' && d.id !== 'sales')?.id;
  await page.selectOption('.qt-dataset', other);
  await page.waitForFunction((id) => DuckView.engine.activeId === id, other, { timeout: 20000 });
  await runSql('SELECT COUNT(*) AS n FROM dataset');
  check(await page.evaluate(() => document.querySelector('.qt-status').textContent.includes('1 row')), `active dataset switched to "${other}" from the Query page`);

  // ── Page 3 · Docs ─────────────────────────────────────────────────────────────
  console.log(c.head('Docs  #/docs'));
  await page.evaluate(() => (location.hash = '#/docs'));
  await page.waitForFunction(() => location.hash.startsWith('#/docs/'), null, { timeout: 5000 });
  check((await visibleView()) === 'docs', `docs view visible, redirected to ${await page.evaluate(() => location.hash)}`);
  const pages = await page.evaluate(() => DuckView.manifest.pages.map((p) => p.slug));
  for (const slug of pages) {
    await page.evaluate((s) => (location.hash = `#/docs/${s}`), slug);
    await page.waitForFunction((s) => !document.querySelector(`article[data-doc="${s}"]`).hidden, slug, { timeout: 5000 });
    await page.waitForTimeout(300);
    await settled();
    await page.evaluate(async (s) => {
      for (const q of document.querySelectorAll(`article[data-doc="${s}"] duck-query[autorun="false"]`)) await q.run();
    }, slug);
    const res = await page.evaluate((s) => {
      const cards = [...document.querySelectorAll(`article[data-doc="${s}"] duck-query`)];
      return { total: cards.length, ran: cards.filter((q) => q.result).length, failed: cards.filter((q) => q.querySelector('.dq-body pre')).map((q) => q.getAttribute('title')), toc: document.querySelectorAll('#docs-sidebar [data-heading]').length };
    }, slug);
    check(res.failed.length === 0 && res.ran === res.total, `docs/${slug}: ${res.ran}/${res.total} live cards ran · ${res.toc} TOC entries`, res.failed.join(', '));
  }

  // ── Page 4 · Settings ───────────────────────────────────────────────────────────
  console.log(c.head('Settings  #/settings'));
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.waitForTimeout(300);
  check((await visibleView()) === 'settings', 'settings view visible');
  const before = await page.evaluate(() => ({ limit: DuckView.engine.current.memoryLimit, slider: document.querySelector('.st-mem-range').value }));
  await page.evaluate(() => {
    const r = document.querySelector('.st-mem-range');
    r.value = 1024;
    r.dispatchEvent(new Event('input'));
    r.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.querySelector('.st-mem-status').textContent.includes('applied'), null, { timeout: 10000 });
  const mem = await page.evaluate(() => ({ current: DuckView.engine.current.memoryLimit, stored: DuckView.settings.get('engine.memoryLimitMB'), pill: document.querySelector('#status-pill').textContent.replace(/\s+/g, ' ') }));
  check(mem.current.startsWith('976') && mem.stored === 1024 && mem.pill.includes('1.0 GB headroom'), `memory_limit applied live: ${before.limit} → ${mem.current}`, 'status pill follows');
  await page.click('[data-preset="auto"]');
  await page.waitForFunction(() => document.querySelector('.st-mem-status').textContent.includes('auto'), null, { timeout: 10000 });
  const auto = await page.evaluate(() => ({ current: DuckView.engine.current.memoryLimit, stored: DuckView.settings.get('engine.memoryLimitMB'), autoMB: Math.round(DuckView.engine.hardware.memoryLimitAuto / 1024 ** 2), liveMB: Math.round(DuckView.engine.hardware.memoryLimit / 1024 ** 2) }));
  check(auto.stored === null && auto.liveMB === auto.autoMB, `Auto preset restores the detected limit (${auto.current})`);
  await page.click('label.switch:has([data-engine-toggle="preserveInsertionOrder"])');
  await page.waitForFunction(() => DuckView.engine.current.preserveInsertionOrder === true, null, { timeout: 10000 });
  check(true, 'preserve_insertion_order toggled live');
  const threads = await page.evaluate(() => ({ disabled: document.querySelector('.st-threads-range').disabled, note: document.querySelector('.st-threads-note').textContent, max: document.querySelector('.st-mem-range').max }));
  check(threads.disabled && /single-threaded/.test(threads.note), 'threads control is honest about the single-threaded build');
  check(threads.max === '4096', 'memory slider reaches the 4 GB wasm ceiling');
  await page.evaluate(() => {
    const r = document.querySelector('.st-mem-range');
    r.value = 4096;
    r.dispatchEvent(new Event('input'));
    r.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => !document.querySelector('.st-mem-warn').hidden, null, { timeout: 10000 });
  check(await page.evaluate(() => DuckView.engine.current.memoryLimit.startsWith('3.8')), 'memory_limit = 4 GB applied with the unsafe-zone warning shown');
  await page.click('[data-preset="auto"]');
  await page.waitForFunction(() => document.querySelector('.st-mem-status').textContent.includes('auto'), null, { timeout: 10000 });
  await page.selectOption('[data-setting="tableRows"]', '100');
  await page.click('label.switch:has([data-setting="profile"])');
  const ws = await page.evaluate(() => JSON.parse(localStorage.getItem('duckview.settings')));
  check(ws.tableRows === 100 && ws.profile === false && ws.engine.preserveInsertionOrder === true, 'workspace + engine settings persisted to localStorage');
  await page.evaluate(() => {
    const r = document.querySelector('.st-mem-range');
    r.value = 1536;
    r.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => DuckView.settings.get('engine.memoryLimitMB') === 1536, null, { timeout: 10000 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.DuckView?.engine?.status === 'ready', null, { timeout: 60000 });
  const boot2 = await page.evaluate(() => ({ limit: DuckView.engine.current.memoryLimit, preserve: DuckView.engine.current.preserveInsertionOrder, tuning: DuckView.engine.tuning.find((t) => t.key === 'memoryLimitMB')?.label }));
  check(boot2.limit.startsWith('1.4') && boot2.preserve === true, `overrides re-applied at boot (${boot2.tuning}, preserve_insertion_order = true)`);
  // profile off → schema card skips SUMMARIZE
  await page.evaluate(() => (location.hash = '#/'));
  await page.click('#sample-list [data-sample="sales"]');
  await overviewDone();
  check(await page.evaluate(() => /profiling is off/.test(document.querySelector('.ov-schema-meta').textContent)), 'overview respects "profile off"');
  await page.evaluate(() => {
    DuckView.settings.reset();
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.DuckView?.engine?.status === 'ready', null, { timeout: 60000 });
  check(await page.evaluate(() => Math.round(DuckView.engine.hardware.memoryLimit / 1024 ** 2) === Math.round(DuckView.engine.hardware.memoryLimitAuto / 1024 ** 2)), 'reset restores detected defaults after reload');
  // The remembered selection re-mounts "sales" on its own after a reload.
  await page.waitForFunction(() => DuckView.engine.activeId === 'sales', null, { timeout: 60000 });
  await overviewDone();
  check(true, 'remembered dataset re-mounted after reload');

  // ── Threaded engine (opt-in) ──────────────────────────────────────────────────
  console.log(c.head('Threaded engine  (opt-in)'));
  await page.evaluate(() => {
    DuckView.settings.set('engine.bundle', 'threaded');
    DuckView.settings.set('engine.threads', 3);
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.DuckView?.engine?.status === 'ready', null, { timeout: 90000 });
  const thr = await page.evaluate(async () => {
    const e = DuckView.engine;
    const csv = await DuckView.panel.loadSample('sales', { select: true }).catch(() => null);
    const pq = await DuckView.panel.loadSample('orders', { select: false }).catch(() => null);
    const pqErr = e.datasets.get('orders')?.error || '';
    await e.query('CREATE TABLE bench AS SELECT range AS id, (range * 7919) % 1000 AS k, (range % 977)::DOUBLE AS v FROM range(8000000)');
    const t0 = performance.now();
    await e.query('SELECT k, COUNT(*), SUM(v) FROM bench GROUP BY k');
    return { isolated: globalThis.crossOriginIsolated, bundle: e.bundleName, threads: e.current.threads, csv: csv?.state, pq: pq?.state ?? 'error', pqErr, groupByMs: Math.round(performance.now() - t0), exts: e.extensions.map((x) => x.ok) };
  });
  check(thr.isolated && thr.bundle === 'coi', `threaded engine loads under COOP/COEP (${thr.bundle}, isolated)`);
  check(thr.threads === 3, `stored thread count applied at open(): threads = ${thr.threads}`);
  check(thr.csv === 'ready', 'CSV works on the threaded engine');
  check(thr.pq !== 'ready' && /single-threaded engine/.test(thr.pqErr), 'Parquet on the threaded engine fails fast with a clear hint', thr.pqErr.slice(0, 80));
  check(await page.evaluate(() => document.querySelector('.st-threads-range').disabled === false), 'threads slider is enabled on the threaded engine');
  await page.evaluate(() => DuckView.settings.set('engine.bundle', 'single'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.DuckView?.engine?.status === 'ready', null, { timeout: 90000 });
  check(await page.evaluate(() => DuckView.engine.bundleName === 'eh'), 'back to the single-threaded engine');
  await page.waitForFunction(() => DuckView.engine.activeId === 'sales', null, { timeout: 60000 });
  await overviewDone();

  // ── Query guards ────────────────────────────────────────────────────────────────
  console.log(c.head('Query guards'));
  const guard = await page.evaluate(async () => {
    DuckView.settings.set('maxConcurrentQueries', 2);
    location.hash = '#/query';
    await new Promise((r) => setTimeout(r, 300));
    const qt = DuckView.queryTool;
    const tabs = [1, 2, 3, 4].map((i) => qt.newTab({ name: 'g' + i, sql: `SELECT COUNT(*) FROM range(${400000000 + i})` }));
    for (const t of tabs) qt.run(t.id);
    // run() marks the tab running/queued synchronously, so this snapshot is deterministic.
    const snapshot = tabs.map((t) => (t.running ? 'R' : t.queued ? 'Q' : '.')).join('');
    let peak = 0;
    while (qt.tabs.some((t) => t.running || t.queued)) {
      peak = Math.max(peak, qt.runningCount);
      await new Promise((r) => setTimeout(r, 25));
    }
    const done = tabs.every((t) => t.result?.numRows === 1);
    DuckView.settings.set('queryTimeoutSec', 1);
    const slow = qt.newTab({ name: 'slow', sql: 'SELECT COUNT(*) FROM range(9000000000)' });
    const t0 = performance.now();
    await qt.run(slow.id);
    DuckView.settings.set('queryTimeoutSec', 0);
    DuckView.settings.set('maxConcurrentQueries', 4);
    return { snapshot, peak, done, timeoutMs: Math.round(performance.now() - t0), timeoutMsg: slow.error?.message };
  });
  check(guard.snapshot === 'RRQQ' && guard.peak <= 2 && guard.done, `concurrency limit 2: never more than ${guard.peak} running, all four finished (${guard.snapshot})`);
  check(guard.timeoutMs < 3000 && /timeout/.test(guard.timeoutMsg || ''), `query timeout stopped a runaway query after ${guard.timeoutMs} ms`);
  await page.evaluate(() => (location.hash = '#/'));

  // ── Drop a local file (routes back to Overview) ───────────────────────────────
  console.log(c.head('Local file'));
  const drop = await page.evaluate(async () => {
    const file = new File(['id,name,score,when\n1,alpha,3.5,2024-01-02\n2,beta,4.25,2024-02-03\n'], 'smoke test (1).csv', { type: 'text/csv' });
    const rec = await DuckView.engine.mountLocalFile(file);
    DuckView.panel.onDrop(rec.id);
    await new Promise((r) => setTimeout(r, 1500));
    return { id: rec.id, mode: rec.mountMode, active: DuckView.engine.activeId, hash: location.hash, h1: document.querySelector('#overview h1')?.textContent };
  });
  check(drop.active === drop.id && drop.mode === 'file-reader', `dropped file mounted as "${drop.id}" via ${drop.mode}`);
  check(drop.hash.startsWith('#/') && !drop.hash.startsWith('#/query') && drop.h1 === 'smoke test (1).csv', 'drop routed to the Overview for the new file', drop.hash);
  // Large JSON: a >16 MB single-array file and a >16 MB wrapper object ({"data": [...]}).
  const bigJson = await page.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 70000; i++) rows.push({ id: i, user: `user_${i % 500}`, amount: i % 97, meta: { device: i % 2 ? 'mobile' : 'desktop', note: 'x'.repeat(160) }, tags: ['a', 'b'] });
    const arrayFile = new File([JSON.stringify(rows)], 'big-array.json', { type: 'application/json' });
    const wrapped = new File([JSON.stringify({ status: 'ok', count: rows.length, data: rows })], 'wrapped.json', { type: 'application/json' });
    const count = async (id) => Number((await DuckView.engine.query(`SELECT COUNT(*) AS n FROM "${id}"`)).table.toArray()[0].n);
    const a = await DuckView.engine.mountLocalFile(arrayFile).catch((e) => ({ state: 'error', error: e.message }));
    const w = await DuckView.engine.mountLocalFile(wrapped).catch((e) => ({ state: 'error', error: e.message }));
    return {
      mb: (arrayFile.size / 1024 ** 2).toFixed(1),
      array: { state: a.state, error: a.error, rows: a.state === 'ready' ? await count(a.id) : null, cols: a.schema?.length },
      wrapped: { state: w.state, error: w.error, rows: w.state === 'ready' ? await count(w.id) : null, cols: w.schema?.map((c) => c.name), unwrapped: w.unwrapped, maxObj: w.readerOptions?.maximum_object_size },
    };
  });
  check(bigJson.array.state === 'ready' && bigJson.array.rows === 70000, `${bigJson.mb} MB JSON array mounts (${bigJson.array.rows} rows)`, bigJson.array.error || '');
  check(bigJson.wrapped.state === 'ready' && bigJson.wrapped.rows === 70000 && bigJson.wrapped.unwrapped?.column === 'data' && bigJson.wrapped.maxObj > 16777216, `wrapper-object JSON retried with a larger maximum_object_size and unnested from "data" (${bigJson.wrapped.rows} rows)`, bigJson.wrapped.error || (bigJson.wrapped.cols || []).join(', '));

  const unloaded = await page.evaluate(async () => {
    await DuckView.engine.unmount('smoke_test_1');
    await new Promise((r) => setTimeout(r, 800));
    return { gone: !DuckView.engine.datasets.has('smoke_test_1'), active: DuckView.engine.activeId, h1: document.querySelector('#overview h1')?.textContent };
  });
  check(unloaded.gone && unloaded.active && unloaded.h1?.includes(unloaded.active), `unloading the active dataset falls back to "${unloaded.active}"`);

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.join(' | '));
  check(externalRequests.length === 0, 'no request left localhost during the entire run (local-first)', externalRequests.slice(0, 3).join(', '));
} catch (err) {
  failures++;
  console.log(c.bad(`test run aborted: ${err.message}`));
} finally {
  await browser.close();
  server?.kill();
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m\n` : '\n\x1b[32mAll checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
