/**
 * Settings — page 4.
 *
 * Resource controls for the engine (applied live through DuckDB's SET) and
 * for the workspace (row limits, overview profiling, safety thresholds…).
 * Everything is stored in localStorage and re-applied at boot. The sidebar
 * shows live resource usage and what was detected on this machine.
 */
import { settings, DEFAULTS } from './settings.js';
import { memoryPresets, clampMB, fmtMB, MEMORY_LIMIT_MIN_MB, MEMORY_LIMIT_MAX_MB, MEMORY_LIMIT_SAFE_MB, WASM_HEAP_LIMIT, fmtGB } from './hardware.js';
import { escapeHtml, fmtBytes, fmtInt, fmtMs } from './format.js';

const MB = 1024 ** 2;

export class SettingsPage {
  #timer = null;
  #busy = new Set();

  constructor({ root, sidebarRoot, engine, queryTool, manifest }) {
    this.root = root;
    this.sidebarRoot = sidebarRoot;
    this.engine = engine;
    this.queryTool = queryTool;
    this.manifest = manifest;
    this.#renderMain();
    this.#renderSidebar();
    engine.on('status', () => {
      this.#refreshEngineState();
      this.#renderLive();
      this.#renderHardware();
    });
    engine.on('settings', () => this.#refreshEngineState());
    engine.on('memory', () => this.#renderLive());
    engine.on('dataset:change', () => this.#renderLive());
    engine.on('dataset:removed', () => this.#renderLive());
    settings.on(() => this.#refreshWorkspaceState());
  }

  onShow() {
    this.#refreshEngineState();
    this.#refreshWorkspaceState();
    this.#renderLive();
    this.#renderHardware();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      if (this.engine.status === 'ready') this.engine.refreshMemory();
      this.#renderLive();
    }, 2500);
  }

  onHide() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  // -----------------------------------------------------------------------
  // Main column
  // -----------------------------------------------------------------------
  #renderMain() {
    const hw = this.engine.hardware;
    const presets = memoryPresets(hw);
    this.root.innerHTML = `
      <div class="space-y-4">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p class="text-[11px] font-medium uppercase tracking-wider text-violet-400">Settings</p>
            <h1 class="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">Resources &amp; behaviour</h1>
            <p class="mt-1 text-xs text-zinc-500">Engine settings apply immediately to every connection and are re-applied on the next boot. Stored on this device only.</p>
          </div>
          <button type="button" class="st-reset btn btn-ghost">Reset to detected defaults</button>
        </div>

        <!-- Machine vs engine -->
        <section class="card px-4 py-4" aria-label="Machine capability">
          <div class="grid gap-4 sm:grid-cols-3">
            <div>
              <p class="text-[11px] uppercase tracking-wider text-zinc-500">This machine</p>
              <p class="mt-1 text-lg font-semibold text-zinc-50">${hw.deviceMemoryReported ? `≥ ${hw.deviceMemoryGB} GB RAM` : 'RAM not reported'} <span class="text-zinc-500">·</span> ${hw.cores} cores</p>
              <p class="text-[11px] text-zinc-500">Browsers round <code>navigator.deviceMemory</code> down to 8 GB max, so "≥" is exact.</p>
            </div>
            <div>
              <p class="text-[11px] uppercase tracking-wider text-zinc-500">Engine can address</p>
              <p class="mt-1 text-lg font-semibold text-zinc-50">${fmtGB(WASM_HEAP_LIMIT)} <span class="text-zinc-500">·</span> <span class="st-threads-cap">…</span></p>
              <p class="text-[11px] text-zinc-500">DuckDB-Wasm is a 32-bit WebAssembly module: 4 GB is the hard ceiling per engine, whatever the machine has.</p>
            </div>
            <div>
              <p class="text-[11px] uppercase tracking-wider text-zinc-500">Bigger than 4 GB?</p>
              <p class="mt-1 text-[12px] leading-relaxed text-zinc-400">Parquet is read column-by-column with predicate push-down, so files far larger than RAM still query fine — the limit is the <em>working set</em> of one query, not the file. Filter early, aggregate, avoid <code class="rounded bg-zinc-800 px-1">SELECT *</code>.</p>
            </div>
          </div>
        </section>

        <!-- Engine memory -->
        <section class="card" aria-labelledby="st-mem-h">
          <header class="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
            <h2 id="st-mem-h" class="text-[13px] font-medium text-zinc-100">Engine memory</h2>
            <span class="st-mem-status font-mono text-[11px] text-zinc-500"></span>
          </header>
          <div class="space-y-5 px-4 py-4">
            <div>
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <label for="st-mem" class="text-sm text-zinc-200">DuckDB memory limit <code class="ml-1 rounded bg-zinc-800 px-1 font-mono text-[11px] text-zinc-400">memory_limit</code></label>
                <span class="st-mem-value font-mono text-lg font-semibold tabular-nums text-zinc-50"></span>
              </div>
              <div class="relative mt-3">
                <input id="st-mem" type="range" class="st-mem-range relative z-10 w-full accent-violet-500" min="${MEMORY_LIMIT_MIN_MB}" max="${MEMORY_LIMIT_MAX_MB}" step="64">
                <div class="pointer-events-none absolute top-1/2 right-0 h-1 -translate-y-1/2 rounded-r bg-rose-500/40" style="width:${(((MEMORY_LIMIT_MAX_MB - MEMORY_LIMIT_SAFE_MB) / (MEMORY_LIMIT_MAX_MB - MEMORY_LIMIT_MIN_MB)) * 100).toFixed(1)}%" title="Above ${fmtMB(MEMORY_LIMIT_SAFE_MB)} the wasm heap may fail to grow"></div>
              </div>
              <div class="mt-1 flex justify-between font-mono text-[10px] text-zinc-600">
                <span>${fmtMB(MEMORY_LIMIT_MIN_MB)}</span>
                <span>safe up to ${fmtMB(MEMORY_LIMIT_SAFE_MB)} · <span class="text-rose-400/80">${fmtMB(MEMORY_LIMIT_SAFE_MB)}–${fmtMB(MEMORY_LIMIT_MAX_MB)} may crash the engine</span></span>
                <span>${fmtMB(MEMORY_LIMIT_MAX_MB)}</span>
              </div>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                ${presets.map((p) => `<button type="button" data-preset="${p.id}" data-mb="${p.mb}" class="btn" title="${escapeHtml(p.hint)}">${escapeHtml(p.label)} <span class="font-mono text-[10px] text-zinc-500">${fmtMB(p.mb)}</span></button>`).join('')}
              </div>
              <div class="st-mem-usage mt-4"></div>
              <p class="st-mem-warn mt-2 text-[11px] leading-relaxed text-rose-300" hidden></p>
              <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">The limit is the most DuckDB will hold in RAM before a query fails with out-of-memory. Higher lets bigger aggregations and sorts finish in one pass; lower leaves room for other tabs. Between ${fmtMB(MEMORY_LIMIT_SAFE_MB)} and ${fmtMB(MEMORY_LIMIT_MAX_MB)} the module itself competes for the last of the address space — allocation can fail hard instead of raising a clean out-of-memory error, and you would have to reload.</p>
            </div>

            ${toggleRow('preserveInsertionOrder', 'Preserve insertion order', 'preserve_insertion_order', 'Off lets DuckDB stream large results without buffering to keep row order — less memory, same rows. Turn on if you rely on file order without ORDER BY.')}
            ${toggleRow('objectCache', 'Object cache', 'enable_object_cache', 'Keeps Parquet metadata between queries so repeated reads of the same file skip the footer round-trip.')}
          </div>
        </section>

        <!-- Compute -->
        <section class="card" aria-labelledby="st-cpu-h">
          <header class="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
            <h2 id="st-cpu-h" class="text-[13px] font-medium text-zinc-100">Compute</h2>
            <span class="st-threads-status font-mono text-[11px] text-zinc-500"></span>
          </header>
          <div class="px-4 py-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <label for="st-threads" class="text-sm text-zinc-200">DuckDB threads <code class="ml-1 rounded bg-zinc-800 px-1 font-mono text-[11px] text-zinc-400">threads</code></label>
              <span class="st-threads-value font-mono text-lg font-semibold tabular-nums text-zinc-50"></span>
            </div>
            <input id="st-threads" type="range" class="st-threads-range mt-3 w-full accent-violet-500" min="1" max="${Math.max(1, hw.cores)}" step="1">
            <div class="mt-1 flex justify-between font-mono text-[10px] text-zinc-600"><span>1</span><span>${hw.cores} cores detected</span></div>
            <p class="st-threads-note mt-2 text-[11px] leading-relaxed text-zinc-500"></p>
          </div>
          <div class="divide-y divide-zinc-800/70 border-t border-zinc-800">
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <p class="text-sm text-zinc-200">Engine build <span class="st-bundle-badge badge badge-zinc ml-1"></span></p>
                <p class="st-bundle-note text-[11px] text-zinc-500"></p>
              </div>
              <div class="flex items-center gap-2">
                <select data-setting="engine.bundle" class="st-select">
                  <option value="single">Single-threaded (default)</option>
                  <option value="threaded">Multi-threaded (experimental)</option>
                </select>
                <button type="button" class="st-reload btn btn-primary" hidden>Reload to apply</button>
              </div>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <p class="text-sm text-zinc-200">Extensions <span class="st-ext-badge badge badge-zinc ml-1"></span></p>
                <p class="st-ext-note text-[11px] text-zinc-500"></p>
              </div>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <p class="text-sm text-zinc-200">Add isolation headers with a service worker</p>
                <p class="text-[11px] text-zinc-500">Hosts like GitHub Pages can't send <code class="rounded bg-zinc-800 px-1">Cross-Origin-Opener-Policy</code> / <code class="rounded bg-zinc-800 px-1">Cross-Origin-Embedder-Policy</code>. A tiny service worker adds them so threads work anyway (one reload on first visit). Not needed when the server already sends them.</p>
              </div>
              <label class="switch"><input type="checkbox" data-setting="engine.coiServiceWorker"><span class="switch-track"></span></label>
            </div>
          </div>
        </section>

        <!-- Query guards -->
        <section class="card" aria-labelledby="st-guard-h">
          <header class="border-b border-zinc-800 px-4 py-3">
            <h2 id="st-guard-h" class="text-[13px] font-medium text-zinc-100">Query guards</h2>
          </header>
          <div class="divide-y divide-zinc-800/70">
            ${selectRow('maxConcurrentQueries', 'Workbench tabs running at once', 'Extra tabs queue until a slot frees. More slots = more interleaving on one worker (or real parallelism with threads); fewer keeps each query fast.', [1, 2, 4, 8, 16])}
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <p class="text-sm text-zinc-200">Query timeout</p>
                <p class="text-[11px] text-zinc-500">Automatically stop a tab's query after this long. Protects the tab from a runaway cross join.</p>
              </div>
              <select data-setting="queryTimeoutSec" class="st-select">
                <option value="0">Never</option>
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
                <option value="900">15 minutes</option>
              </select>
            </div>
          </div>
        </section>

        <!-- Workspace -->
        <section class="card" aria-labelledby="st-ws-h">
          <header class="border-b border-zinc-800 px-4 py-3">
            <h2 id="st-ws-h" class="text-[13px] font-medium text-zinc-100">Workspace</h2>
          </header>
          <div class="divide-y divide-zinc-800/70">
            ${selectRow('tableRows', 'Rows rendered per result table', 'Downloads always contain the full result; this only bounds the DOM.', [100, 200, 500, 1000, 2000])}
            ${switchRow('profile', 'Profile columns on load (SUMMARIZE)', 'Fills nulls / distinct / min / max / avg in the schema card and picks the top-5 charts. Costs a full scan — turn off for very large files.')}
            ${selectRow('estimateSampleRows', 'Rows sampled for the memory estimate', 'Text column widths are measured on the first N rows to estimate the in-memory footprint.', [1000, 5000, 20000, 100000])}
            ${switchRow('autoCharts', 'Distribution charts on the Overview', 'Rows-per-month and top-5 cards. Each is one aggregation query.')}
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <p class="text-sm text-zinc-200">Dataset safety badge thresholds</p>
                <p class="text-[11px] text-zinc-500">Estimated working set as a share of the memory limit. Yellow above the first, red above the second.</p>
              </div>
              <div class="flex items-center gap-2 font-mono text-xs text-zinc-400">
                <label class="flex items-center gap-1"><span class="size-2 rounded-full bg-amber-400"></span><input data-setting="warnPct" type="number" min="1" max="99" class="st-num w-16"> %</label>
                <label class="flex items-center gap-1"><span class="size-2 rounded-full bg-rose-400"></span><input data-setting="dangerPct" type="number" min="2" max="100" class="st-num w-16"> %</label>
              </div>
            </div>
            ${selectRow('historyMax', 'Query history size', 'Number of runs kept on the Query page.', [20, 40, 100, 250])}
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <p class="text-sm text-zinc-200">Sample datasets at boot</p>
                <p class="text-[11px] text-zinc-500">The build's own default is <strong class="text-zinc-400">${this.manifest.autoload ? 'load all samples' : 'load nothing'}</strong>.</p>
              </div>
              <select data-setting="autoloadSamples" class="st-select">
                <option value="">Follow the build</option>
                <option value="true">Always load all samples</option>
                <option value="false">Never load samples</option>
              </select>
            </div>
          </div>
        </section>

        <!-- Local data -->
        <section class="card" aria-labelledby="st-data-h">
          <header class="border-b border-zinc-800 px-4 py-3">
            <h2 id="st-data-h" class="text-[13px] font-medium text-zinc-100">Data stored in this browser</h2>
          </header>
          <div class="flex flex-wrap items-center gap-2 px-4 py-4">
            <button type="button" class="btn btn-ghost" data-clear="history">Clear query history</button>
            <button type="button" class="btn btn-ghost" data-clear="tabs">Reset workbench tabs</button>
            <button type="button" class="btn btn-ghost" data-clear="all">Clear everything &amp; reload</button>
            <span class="st-clear-note ml-auto font-mono text-[11px] text-zinc-500">localStorage only — no data ever leaves this machine</span>
          </div>
        </section>
      </div>`;

    const q = (sel) => this.root.querySelector(sel);
    this.ui = {
      memRange: q('.st-mem-range'),
      memValue: q('.st-mem-value'),
      memStatus: q('.st-mem-status'),
      memUsage: q('.st-mem-usage'),
      threadsRange: q('.st-threads-range'),
      threadsValue: q('.st-threads-value'),
      threadsStatus: q('.st-threads-status'),
      threadsNote: q('.st-threads-note'),
      threadsCap: q('.st-threads-cap'),
      memWarn: q('.st-mem-warn'),
      bundleBadge: q('.st-bundle-badge'),
      bundleNote: q('.st-bundle-note'),
      extBadge: q('.st-ext-badge'),
      extNote: q('.st-ext-note'),
      reloadBtn: q('.st-reload'),
      clearNote: q('.st-clear-note'),
    };
    this.ui.reloadBtn.addEventListener('click', () => {
      try {
        sessionStorage.removeItem('duckbrowser.coi.reloaded');
      } catch {
        /* ignore */
      }
      location.reload();
    });

    // --- engine: memory limit
    this.ui.memRange.addEventListener('input', () => (this.ui.memValue.textContent = fmtMB(Number(this.ui.memRange.value))));
    this.ui.memRange.addEventListener('change', () => this.#applyEngine('memoryLimitMB', clampMB(this.ui.memRange.value)));
    for (const b of this.root.querySelectorAll('[data-preset]')) {
      b.addEventListener('click', () => {
        const mb = Number(b.dataset.mb);
        this.ui.memRange.value = mb;
        this.ui.memValue.textContent = fmtMB(mb);
        this.#applyEngine('memoryLimitMB', b.dataset.preset === 'auto' ? null : mb, mb);
      });
    }
    // --- engine: toggles
    for (const t of this.root.querySelectorAll('[data-engine-toggle]')) {
      t.addEventListener('change', () => this.#applyEngine(t.dataset.engineToggle, t.checked));
    }
    // --- engine: threads
    this.ui.threadsRange.addEventListener('input', () => (this.ui.threadsValue.textContent = this.ui.threadsRange.value));
    this.ui.threadsRange.addEventListener('change', () => {
      // Thread-pool size is fixed at engine start (DuckDB joins every worker on a
      // change, which can deadlock the wasm build) — so this one applies on reload.
      const n = Number(this.ui.threadsRange.value);
      settings.set('engine.threads', n === this.engine.hardware.cores ? null : n);
      this.#refreshEngineState();
    });

    // --- workspace settings (immediate)
    for (const el of this.root.querySelectorAll('[data-setting]')) {
      el.addEventListener('change', () => {
        const key = el.dataset.setting;
        let value;
        if (el.type === 'checkbox') value = el.checked;
        else if (el.type === 'number') value = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) || 0));
        else if (key === 'autoloadSamples') value = el.value === '' ? null : el.value === 'true';
        else if (key === 'engine.bundle') value = el.value;
        else value = Number(el.value);
        if (key === 'warnPct' && value >= settings.get('dangerPct')) value = settings.get('dangerPct') - 1;
        if (key === 'dangerPct' && value <= settings.get('warnPct')) value = settings.get('warnPct') + 1;
        settings.set(key, value);
        if (key.startsWith('engine.bundle') || key === 'engine.coiServiceWorker') this.#refreshEngineState();
      });
    }

    q('.st-reset').addEventListener('click', () => this.#resetAll());
    for (const b of this.root.querySelectorAll('[data-clear]')) b.addEventListener('click', () => this.#clear(b.dataset.clear));
  }

  async #applyEngine(key, value, sliderMB) {
    if (this.#busy.has(key)) return;
    this.#busy.add(key);
    const statusEl = key === 'threads' ? this.ui.threadsStatus : this.ui.memStatus;
    statusEl.innerHTML = `<span class="spinner"></span>`;
    const applyValue = value ?? this.#autoValue(key);
    const res = await this.engine.applySetting(key, applyValue);
    if (res.ok) {
      settings.set(`engine.${key}`, value); // null keeps "auto"
      statusEl.innerHTML = `<span class="text-emerald-400">applied</span> ${escapeHtml(res.label)} <span class="text-zinc-600">· ${fmtMs(res.ms)}${value == null ? ' · auto' : ''}</span>`;
    } else {
      statusEl.innerHTML = `<span class="text-rose-400">not applied</span> <span class="text-zinc-500">${escapeHtml(res.error)}</span>`;
    }
    this.#busy.delete(key);
    this.#refreshEngineState();
    if (sliderMB != null) this.ui.memRange.value = sliderMB;
  }

  /** The hardware-derived value for an engine key (used when a setting is "auto"). */
  #autoValue(key) {
    const hw = this.engine.hardware;
    return {
      memoryLimitMB: clampMB(hw.memoryLimitAuto / MB),
      threads: hw.threadsRequested,
      preserveInsertionOrder: DEFAULTS.engine.preserveInsertionOrder,
      objectCache: DEFAULTS.engine.objectCache,
    }[key];
  }

  #refreshEngineState() {
    const ui = this.ui;
    if (!ui) return;
    const hw = this.engine.hardware;
    const cur = this.engine.current;
    const mb = Math.round(hw.memoryLimit / MB);
    if (!this.#busy.has('memoryLimitMB')) {
      ui.memRange.value = mb;
      ui.memValue.textContent = fmtMB(mb);
      const override = settings.get('engine.memoryLimitMB');
      if (!ui.memStatus.textContent) ui.memStatus.textContent = override ? `custom · applied ${cur?.memoryLimit ?? ''}` : `auto · ${cur?.memoryLimit ?? fmtMB(mb)}`;
    }
    for (const t of this.root.querySelectorAll('[data-engine-toggle]')) {
      const key = t.dataset.engineToggle;
      t.checked = cur ? cur[key] : (settings.get(`engine.${key}`) ?? DEFAULTS.engine[key]);
    }
    for (const p of this.root.querySelectorAll('[data-preset]')) p.classList.toggle('btn-primary', Number(p.dataset.mb) === mb);

    const bundle = this.engine.bundleName;
    const threaded = bundle === 'coi';
    const isolated = Boolean(globalThis.crossOriginIsolated);
    const storedThreads = settings.get('engine.threads');
    const pendingThreads = storedThreads ?? hw.cores;
    const active = hw.threadsActive ?? 1;
    ui.threadsRange.value = threaded ? pendingThreads : active;
    ui.threadsValue.textContent = String(threaded ? pendingThreads : active);
    ui.threadsRange.disabled = !threaded;
    ui.threadsCap.textContent = threaded ? `${hw.cores} threads` : '1 thread';
    const threadsPending = threaded && pendingThreads !== active;
    ui.threadsStatus.innerHTML = threaded
      ? threadsPending
        ? `<span class="text-amber-300">saved</span> running with ${active} now · ${pendingThreads} after reload`
        : `running with <span class="text-zinc-200">${active}</span> thread${active === 1 ? '' : 's'}`
      : '';
    ui.threadsNote.innerHTML = threaded
      ? `DuckDB spreads scans, joins and aggregations over up to <strong class="text-zinc-300">${hw.cores}</strong> worker threads (pthreads over SharedArrayBuffer). Fewer threads leave CPU for other tabs. The pool is sized when the engine starts, so changes take effect after a reload.`
      : `Fixed at <strong class="text-zinc-300">1</strong>: the single-threaded bundle is loaded${bundle ? ` (<code class="rounded bg-zinc-800 px-1">${bundle}</code>)` : ''}. ${
          settings.get('engine.bundle') === 'single'
            ? 'You chose single-threaded below.'
            : isolated
              ? 'The page is cross-origin isolated but the browser did not qualify for the threaded bundle (needs WebAssembly threads + SIMD).'
              : 'The page is not cross-origin isolated: the host did not send COOP/COEP headers. <code class="rounded bg-zinc-800 px-1">npm run dev</code> sends them; for other hosts leave the service-worker option on, or add the headers to your server config.'
        } Workbench tabs still run concurrently through DuckDB's pending-query API.`;

    const chosen = settings.get('engine.bundle');
    ui.bundleBadge.textContent = bundle ? `${bundle} · ${threaded ? `${hw.threadsActive} threads` : 'single-threaded'} · ${isolated ? 'isolated' : 'not isolated'}` : 'booting…';
    ui.bundleBadge.className = `st-bundle-badge badge ml-1 ${threaded ? 'badge-green' : 'badge-zinc'}`;
    const wantsThreads = ['threaded', 'auto'].includes(chosen);
    ui.bundleNote.innerHTML = wantsThreads
      ? `Loads the multi-threaded DuckDB build whenever the page is cross-origin isolated (falls back to single-threaded otherwise). <strong class="text-amber-300">Experimental:</strong> in DuckDB-Wasm 1.32 the threaded build cannot load the Parquet and JSON extensions (they are published for unshared memory), so it is for CSV, TSV, Arrow and in-memory tables — where it is ~3× faster on aggregations.`
      : 'The standard build: every format, extensions bundled, one thread. Workbench tabs still run concurrently.';
    const exts = this.engine.extensions ?? [];
    const okExts = exts.filter((e) => e.ok).map((e) => e.name);
    const badExts = exts.filter((e) => !e.ok);
    ui.extBadge.textContent = exts.length ? (badExts.length ? `${okExts.length}/${exts.length} loaded` : `${okExts.join(' + ')} loaded`) : 'booting…';
    ui.extBadge.className = `st-ext-badge badge ml-1 ${badExts.length ? 'badge-yellow' : 'badge-green'}`;
    ui.extNote.textContent = badExts.length
      ? badExts.map((e) => `${e.name}: ${e.error}`).join(' · ')
      : `Parquet and JSON readers are served from this bundle (./vendor/duckdb/extensions) — nothing is fetched from extensions.duckdb.org.`;
    const bundlePending = bundle && ((wantsThreads && !threaded && isolated) || (!wantsThreads && threaded));
    ui.reloadBtn.hidden = !(bundlePending || threadsPending);

    ui.memWarn.hidden = mb <= MEMORY_LIMIT_SAFE_MB;
    ui.memWarn.textContent = `Unsafe zone: ${fmtMB(mb)} leaves less than ${fmtMB(MEMORY_LIMIT_MAX_MB - mb)} of the 4 GB address space for the engine itself. If the heap cannot grow, the worker aborts and the page must be reloaded.`;
    this.#renderUsage();
  }

  #renderUsage() {
    const el = this.ui?.memUsage;
    if (!el) return;
    const usage = parseSize(this.engine.memory?.usage);
    const limit = this.engine.hardware.memoryLimit;
    const pct = usage != null && limit ? Math.min(100, (usage / limit) * 100) : 0;
    const tone = pct > 80 ? 'bg-rose-400' : pct > 50 ? 'bg-amber-400' : 'bg-violet-400';
    el.innerHTML = `
      <div class="flex items-center justify-between font-mono text-[11px] text-zinc-500">
        <span>in use now <span class="text-zinc-300">${this.engine.memory?.usage ?? '—'}</span></span>
        <span>${pct ? pct.toFixed(pct < 1 ? 2 : 0) + '% of limit' : ''}</span>
      </div>
      <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div class="h-full ${tone} transition-[width]" style="width:${Math.max(pct > 0 ? 1 : 0, pct)}%"></div></div>
      ${usage != null && usage > limit ? `<p class="mt-1 text-[11px] text-rose-300">Current usage already exceeds the new limit — the next large query may fail. Raise the limit or unload a dataset.</p>` : ''}`;
  }

  #refreshWorkspaceState() {
    for (const el of this.root.querySelectorAll('[data-setting]')) {
      const key = el.dataset.setting;
      const v = settings.get(key);
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else if (key === 'autoloadSamples') el.value = v == null ? '' : String(v);
      else el.value = String(v ?? '');
    }
  }

  async #resetAll() {
    settings.reset();
    const hw = this.engine.hardware;
    await this.engine.applySetting('memoryLimitMB', clampMB(detectDefaultMB(hw)));
    await this.engine.applySetting('preserveInsertionOrder', DEFAULTS.engine.preserveInsertionOrder);
    await this.engine.applySetting('objectCache', DEFAULTS.engine.objectCache);
    this.ui.memStatus.textContent = 'reset to detected defaults';
    this.#refreshEngineState();
    this.#refreshWorkspaceState();
  }

  #clear(what) {
    const note = this.ui.clearNote;
    if (what === 'history' || what === 'all') localStorage.removeItem('duckbrowser.query.history');
    if (what === 'tabs' || what === 'all') localStorage.removeItem('duckbrowser.query.tabs');
    if (what === 'all') {
      // Both prefixes: current keys and anything migrated from the QuillDB days.
      for (const area of [localStorage, sessionStorage]) {
        for (const k of Object.keys(area)) if (/^(duckbrowser|duckview|quilldb)\./.test(k)) area.removeItem(k);
      }
      location.reload();
      return;
    }
    note.textContent = what === 'history' ? 'History cleared — takes effect on the Query page after reload' : 'Tabs reset on next reload';
    setTimeout(() => (note.textContent = 'localStorage only — no data ever leaves this machine'), 4000);
  }

  // -----------------------------------------------------------------------
  // Sidebar — live resources + detected hardware
  // -----------------------------------------------------------------------
  #renderSidebar() {
    this.sidebarRoot.innerHTML = `
      <section class="card">
        <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Live resources</h2>
          <span class="size-1.5 animate-pulse rounded-full bg-emerald-400" title="refreshing every 2.5 s"></span>
        </header>
        <dl class="st-live grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 font-mono text-[11px] text-zinc-400"></dl>
      </section>
      <section class="card">
        <header class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Detected on this machine</h2>
        </header>
        <dl class="st-hw grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 font-mono text-[11px] text-zinc-400"></dl>
      </section>`;
    this.ui.live = this.sidebarRoot.querySelector('.st-live');
    this.ui.hw = this.sidebarRoot.querySelector('.st-hw');
    this.#renderLive();
    this.#renderHardware();
  }

  #renderLive() {
    const el = this.ui?.live;
    if (!el) return;
    const e = this.engine;
    const datasets = [...e.datasets.values()];
    const bytes = datasets.reduce((n, d) => n + (d.size || 0), 0);
    const running = this.queryTool?.tabs.filter((t) => t.running).length ?? 0;
    const heap = globalThis.performance?.memory;
    const row = (k, v, cls = 'text-zinc-200') => `<dt class="text-zinc-500">${k}</dt><dd class="truncate ${cls}">${v}</dd>`;
    el.innerHTML =
      row('engine mem', `${e.memory?.usage ?? '—'} <span class="text-zinc-600">/ ${e.memory?.limit ?? '—'}</span>`) +
      row('js heap', heap ? `${fmtBytes(heap.usedJSHeapSize)} <span class="text-zinc-600">/ ${fmtBytes(heap.jsHeapSizeLimit)}</span>` : '<span class="text-zinc-600">n/a in this browser</span>') +
      row('datasets', `${datasets.length} loaded <span class="text-zinc-600">· ${fmtBytes(bytes)}</span>`) +
      row('queries', `${running} running <span class="text-zinc-600">· ${this.queryTool?.tabs.length ?? 0} tabs</span>`) +
      row('engine', e.status === 'ready' ? `ready <span class="text-zinc-600">· boot ${fmtMs(e.bootMs)}</span>` : e.status);
    this.#renderUsage();
  }

  #renderHardware() {
    const el = this.ui?.hw;
    if (!el) return;
    const hw = this.engine.hardware;
    const row = (k, v) => `<dt class="text-zinc-500">${k}</dt><dd class="truncate text-zinc-300">${v}</dd>`;
    el.innerHTML =
      row('cores', `${hw.cores} <span class="text-zinc-600">logical</span>`) +
      row('memory', hw.deviceMemoryReported ? `≥ ${hw.deviceMemoryGB} GB` : `<span class="text-zinc-600">n/a (assume ${hw.deviceMemoryGB} GB)</span>`) +
      row('auto limit', fmtMB(clampMB(detectDefaultMB(hw)))) +
      row('wasm heap', `${fmtGB(WASM_HEAP_LIMIT)} <span class="text-zinc-600">max</span>`) +
      row('platform', escapeHtml(hw.platform)) +
      row('isolated', hw.crossOriginIsolated ? 'yes' : 'no') +
      row('bundle', `${this.engine.bundleName ?? '…'} <span class="text-zinc-600">DuckDB ${this.engine.version ?? ''}</span>`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function toggleRow(key, label, setting, help) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm text-zinc-200">${label} <code class="ml-1 rounded bg-zinc-800 px-1 font-mono text-[11px] text-zinc-400">${setting}</code></p>
        <p class="text-[11px] text-zinc-500">${help}</p>
      </div>
      <label class="switch"><input type="checkbox" data-engine-toggle="${key}"><span class="switch-track"></span></label>
    </div>`;
}
function switchRow(key, label, help) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div class="min-w-0">
        <p class="text-sm text-zinc-200">${label}</p>
        <p class="text-[11px] text-zinc-500">${help}</p>
      </div>
      <label class="switch"><input type="checkbox" data-setting="${key}"><span class="switch-track"></span></label>
    </div>`;
}
function selectRow(key, label, help, options) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div class="min-w-0">
        <p class="text-sm text-zinc-200">${label}</p>
        <p class="text-[11px] text-zinc-500">${help}</p>
      </div>
      <select data-setting="${key}" class="st-select">${options.map((o) => `<option value="${o}">${fmtInt(o)}</option>`).join('')}</select>
    </div>`;
}

/** The hardware-derived memory limit before any override (MB). */
const detectDefaultMB = (hw) => hw.memoryLimitAuto / MB;

/** "1.9 MiB" / "2.7 GiB" / "123 bytes" → bytes */
function parseSize(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(bytes?|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const pow = { byte: 0, bytes: 0, kib: 1, kb: 1, mib: 2, mb: 2, gib: 3, gb: 3, tib: 4, tb: 4 }[unit] ?? 0;
  return n * 1024 ** pow;
}
