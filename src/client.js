/**
 * Duckbrowser client entry point.
 *
 * Boots DuckDB-Wasm in a Web Worker and wires the three routed views:
 *
 *   #/            Overview — schema + auto-generated profile of the active dataset
 *   #/query       Query tool — tabbed SQL workbench with charts, downloads and history
 *   #/docs/<id>   Documentation
 *
 * The workspace starts empty: you upload your own files. The datasets bundled
 * with the build are listed as samples and mounted only on request (or at boot
 * when `duckbrowser.autoload` is set in package.json).
 */
import { Engine } from './client/engine.js';
import { DuckQuery } from './client/duck-query.js';
import { Router } from './client/router.js';
import { Overview } from './client/overview.js';
import { DatasetPanel } from './client/datasets.js';
import { QueryTool } from './client/query-tool.js';
import { Docs } from './client/docs.js';
import { StatusBar } from './client/status.js';
import { SettingsPage } from './client/settings-page.js';
import { settings } from './client/settings.js';

const manifest = window.__DUCKBROWSER__ ?? { datasets: [], pages: [], autoload: false, defaultDataset: null };
const params = new URLSearchParams(location.search);

/**
 * Multi-threaded DuckDB needs a cross-origin-isolated page. If the host didn't
 * send COOP/COEP headers, install a service worker that adds them and reload
 * once (only on secure origins, only when the user hasn't picked single-threaded).
 */
async function ensureCrossOriginIsolation() {
  const eng = settings.get('engine');
  const wantThreads = ['threaded', 'auto'].includes(eng.bundle);
  if (globalThis.crossOriginIsolated || !wantThreads || !eng.coiServiceWorker) return false;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  const FLAG = 'duckbrowser.coi.reloaded';
  try {
    if (sessionStorage.getItem(FLAG)) return false; // already tried once this session — headers still missing
    const reg = await navigator.serviceWorker.register('./coi-sw.js', { scope: './' });
    if (navigator.serviceWorker.controller) return false; // worker controls the page yet we're not isolated: give up quietly
    await new Promise((resolve) => {
      const w = reg.installing || reg.waiting || reg.active;
      if (!w || w.state === 'activated') return resolve();
      w.addEventListener('statechange', () => w.state === 'activated' && resolve());
    });
    sessionStorage.setItem(FLAG, '1');
    location.reload();
    return true;
  } catch (err) {
    console.warn('[Duckbrowser] cross-origin isolation service worker unavailable:', err);
    return false;
  }
}

const engine = new Engine({ debug: params.has('debug'), tuningOverrides: settings.get('engine'), extensions: manifest.extensions?.names ?? ['parquet', 'json'] });
DuckQuery.engine = engine;

const $ = (sel) => document.querySelector(sel);
const router = new Router();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const status = new StatusBar({ engine, pillEl: $('#status-pill'), factsEl: $('#system-facts') });
const overview = new Overview({
  engine,
  container: $('#overview'),
  onFeasibility: (verdict, ds) => status.setSafety(verdict, ds),
  settings,
});
const panel = new DatasetPanel({
  engine,
  listEl: $('#dataset-list'),
  countEl: $('#dataset-count'),
  dropzoneEl: $('#dropzone'),
  inputEl: $('#file-input'),
  samplesEl: $('#samples-panel'),
  sampleListEl: $('#sample-list'),
  loadAllEl: $('#samples-load-all'),
  samples: manifest.datasets,
  onSelect: (id) => selectDataset(id),
  onDrop: (id) => {
    // A freshly dropped file is best understood on the Overview page.
    selectDataset(id);
    router.go('/');
  },
  onSqlFiles: async (files) => {
    await queryTool.importFiles(files);
    router.go('/query');
  },
});
const queryTool = new QueryTool({
  root: $('#query-tool'),
  sidebarRoot: $('#query-sidebar'),
  engine,
  router,
  onSelectDataset: (id) => selectDataset(id),
  onLoadSample: manifest.datasets.length ? () => panel.loadSample(manifest.defaultDataset ?? manifest.datasets[0].id) : null,
});
const docs = new Docs({ root: $('#docs-main'), sidebarRoot: $('#docs-sidebar'), pages: manifest.pages, router });
const settingsPage = new SettingsPage({ root: $('#settings-main'), sidebarRoot: $('#settings-sidebar'), engine, queryTool, manifest });

// Any card's "Edit / Fork SQL" lands in a workbench tab.
DuckQuery.forkTarget = (sql, meta = {}) => {
  queryTool.load(sql, meta);
  router.go('/query');
};
// Docs examples reference the samples; offer to load one when it's missing.
DuckQuery.sampleIds = new Set(manifest.datasets.map((d) => d.id));
DuckQuery.loadSample = (id) => panel.loadSample(id, { select: !engine.activeId });

router
  .on('home', { onShow: () => overview.onShown() })
  .on('query', { onShow: () => queryTool.onShow() })
  .on('docs', {
    onShow: (route) => {
      docs.show(route.param);
      docs.scrollToHeading(route.params.get('h'));
    },
  })
  .on('settings', { onShow: () => settingsPage.onShow(), onHide: () => settingsPage.onHide() });

// ---------------------------------------------------------------------------
// Dataset selection → overview suite
// ---------------------------------------------------------------------------
const SELECTION_KEY = 'duckbrowser.activeDataset';

async function selectDataset(id) {
  const rec = engine.datasets.get(id);
  if (!rec || rec.state !== 'ready' || engine.activeId === id) return;
  await engine.setActive(id);
  try {
    sessionStorage.setItem(SELECTION_KEY, id);
  } catch {
    /* ignore */
  }
  router.setParam('ds', id);
  status.clearSafety();
  overview.run(rec);
  // Doc cards that query the `dataset` alias follow the selection (only ones already run).
  for (const card of DuckQuery.instances) {
    if (card.closest('[data-view="docs"]') && card.hasRun && card.dependsOnActiveDataset) card.run();
  }
}

// When the active dataset is unloaded, fall back to another loaded one or the empty state.
engine.on('dataset:removed', () => {
  if (engine.activeId) return;
  const next = [...engine.datasets.values()].find((d) => d.state === 'ready');
  if (next) selectDataset(next.id);
  else {
    router.setParam('ds', null);
    status.clearSafety();
    overview.renderEmpty();
  }
});

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
overview.renderEmpty('Booting DuckDB-Wasm…');
router.start();

const bootAndMount = (async () => {
  if (await ensureCrossOriginIsolation()) return new Promise(() => {}); // reloading
  await engine.boot();
  // A deep link (?ds=…) or a remembered selection re-mounts that sample; otherwise
  // the workspace stays empty until the user uploads (or `autoload` is on).
  const requested = router.route.params.get('ds');
  let remembered = null;
  try {
    remembered = sessionStorage.getItem(SELECTION_KEY);
  } catch {
    /* ignore */
  }
  const isSample = (id) => id && manifest.datasets.some((d) => d.id === id);
  const autoload = settings.get('autoloadSamples') ?? manifest.autoload; // Settings page can override the build default
  const wanted = autoload ? manifest.datasets.map((d) => d.id) : [requested, remembered].filter(isSample);
  const initial = [requested, remembered, manifest.defaultDataset].find(isSample) ?? wanted[0] ?? null;

  const mounted = [];
  for (const id of [...new Set(wanted)].sort((a, b) => (a === initial ? -1 : b === initial ? 1 : 0))) {
    const rec = await panel.loadSample(id, { select: id === initial });
    if (rec) mounted.push(rec);
  }
  if (mounted.length) {
    console.info(`%c🦆 Duckbrowser%c mounted ${mounted.length} sample dataset(s): ${mounted.map((r) => r.id).join(', ')}`, 'color:#a78bfa;font-weight:600', 'color:inherit');
  }
  if (!engine.activeId) overview.renderEmpty('Drop a file to get started.');
  return mounted;
})();

bootAndMount.then(
  (ok) => DuckQuery.markReady(ok),
  (err) => {
    DuckQuery.markFailed(err);
    overview.renderEmpty(`DuckDB failed to start: ${err?.message || err}`);
  },
);

// Deep links like #/query?ds=orders switch (or load) the dataset after boot.
window.addEventListener('hashchange', async () => {
  const id = router.route.params.get('ds');
  if (!id || id === engine.activeId) return;
  if (!engine.datasets.has(id) && manifest.datasets.some((d) => d.id === id)) await panel.loadSample(id);
  else selectDataset(id);
});

// Handy for poking around in DevTools.
window.Duckbrowser = { engine, router, overview, queryTool, docs, settingsPage, settings, panel, DuckQuery, manifest };
