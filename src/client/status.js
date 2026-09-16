/**
 * Navbar status pill + sidebar "System" panel.
 *
 * Pill segments: [● Engine] [cores] [memory headroom] [dataset safety badge]
 */
import { fmtGB } from './hardware.js';
import { escapeHtml } from './format.js';

const DOT = {
  booting: 'bg-amber-400 animate-pulse',
  ready: 'bg-emerald-400',
  busy: 'bg-violet-400 animate-pulse',
  error: 'bg-rose-500',
};

export class StatusBar {
  #pending = 0;
  #safety = { level: 'zinc', label: 'No dataset', title: 'Select a dataset to assess feasibility' };
  #engineState = { status: 'booting', message: 'Booting engine…' };

  constructor({ engine, pillEl, factsEl }) {
    this.engine = engine;
    this.pillEl = pillEl;
    this.factsEl = factsEl;

    engine.on('status', (s) => {
      this.#engineState = s;
      this.render();
      this.renderFacts();
    });
    engine.on('query:start', () => {
      this.#pending++;
      this.render();
    });
    const done = () => {
      this.#pending = Math.max(0, this.#pending - 1);
      this.render();
    };
    engine.on('query:end', done);
    engine.on('query:error', done);
    engine.on('memory', () => this.renderFacts());
    this.render();
    this.renderFacts();
  }

  setSafety(verdict, ds) {
    this.#safety = {
      level: verdict.level,
      label: verdict.label,
      title: `${ds.file}: ${verdict.summary}${verdict.advice ? ' ' + verdict.advice : ''}`,
    };
    this.render();
  }

  clearSafety() {
    this.#safety = { level: 'zinc', label: 'No dataset', title: 'Select a dataset to assess feasibility' };
    this.render();
  }

  render() {
    const hw = this.engine.hardware;
    const st = this.#engineState.status;
    const busy = st === 'ready' && this.#pending > 0;
    const dot = DOT[busy ? 'busy' : st] ?? DOT.booting;
    const engineLabel =
      st === 'ready'
        ? busy
          ? `Running ${this.#pending}`
          : `DuckDB ${this.engine.version ?? ''}`
        : st === 'error'
          ? 'Engine error'
          : this.#engineState.message || 'Booting…';
    // `display` is owned by `cls` so responsive hiding works (hidden vs inline-flex must not both be base-level).
    const seg = (inner, title, cls = 'inline-flex', href = null) =>
      href
        ? `<a href="${href}" class="${cls} items-center gap-1.5 px-2.5 hover:text-zinc-200" title="${escapeHtml(title)}">${inner}</a>`
        : `<span class="${cls} items-center gap-1.5 px-2.5" title="${escapeHtml(title)}">${inner}</span>`;
    const divider = (cls = '') => `<span class="${cls} h-3.5 w-px bg-zinc-800" aria-hidden="true"></span>`;
    const safetyCls = { green: 'text-emerald-300', yellow: 'text-amber-300', red: 'text-rose-300', zinc: 'text-zinc-500' }[this.#safety.level];
    const safetyDot = { green: 'bg-emerald-400', yellow: 'bg-amber-400', red: 'bg-rose-400', zinc: 'bg-zinc-600' }[this.#safety.level];

    this.pillEl.innerHTML = `
      <div class="flex h-7 items-center rounded-full border border-zinc-800 bg-zinc-900/70 font-mono text-[11px] text-zinc-400">
        ${seg(`<span class="size-1.5 rounded-full ${dot}"></span><span class="${st === 'ready' ? 'text-zinc-200' : ''}">${escapeHtml(engineLabel)}</span>`, this.#engineState.message || '')}
        ${divider('hidden sm:block')}
        ${seg(
          `<svg class="size-3 text-zinc-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1.5"/><path stroke-linecap="round" d="M8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3"/></svg><span>${hw.cores} cores</span>`,
          `navigator.hardwareConcurrency = ${hw.cores} · DuckDB threads = ${hw.threadsActive ?? '?'}${(hw.threadsActive ?? 1) === 1 ? ' (single-threaded wasm bundle; a COOP/COEP-isolated host enables pthreads)' : ''}`,
          'hidden sm:inline-flex',
        )}
        ${divider('hidden md:block')}
        ${seg(
          `<svg class="size-3 text-zinc-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="6" width="15" height="8" rx="1.5"/><path d="M6 9v2m3-2v2m3-2v2"/></svg><span>${fmtGB(hw.memoryLimit)} headroom</span>`,
          `DuckDB memory_limit = ${hw.memoryLimitApplied || fmtGB(hw.memoryLimit)} · device memory ${hw.deviceMemoryReported ? '≥ ' + hw.deviceMemoryGB + ' GB (navigator.deviceMemory)' : 'unknown (assumed 4 GB)'}` +
            (this.engine.memory.usage ? ` · in use ${this.engine.memory.usage}` : '') +
            ' · click to adjust in Settings',
          'hidden md:inline-flex',
          '#/settings',
        )}
        ${divider()}
        ${seg(`<span class="size-1.5 rounded-full ${safetyDot}"></span><span class="${safetyCls}">${escapeHtml(this.#safety.label)}</span>`, this.#safety.title)}
      </div>`;
  }

  renderFacts() {
    const e = this.engine;
    const hw = e.hardware;
    const row = (k, v, cls = '') => `<dt class="text-zinc-500">${escapeHtml(k)}</dt><dd class="truncate ${cls}" title="${escapeHtml(String(v))}">${escapeHtml(String(v))}</dd>`;
    const tuning = e.tuning.length
      ? e.tuning.map((t) => `<span class="${t.ok ? 'text-emerald-400' : 'text-zinc-600 line-through'}" title="${escapeHtml(t.error || 'applied')}">${escapeHtml(t.label)}</span>`).join('<br>')
      : '—';
    this.factsEl.innerHTML =
      row('engine', e.status === 'ready' ? `DuckDB ${e.version} · ${e.bundleName} wasm` : e.status === 'error' ? 'failed' : 'booting…', e.status === 'ready' ? 'text-zinc-200' : '') +
      row('boot', e.bootMs ? `${Math.round(e.bootMs)} ms` : '—') +
      row('cores', `${hw.cores} detected · ${hw.threadsActive ?? '?'} active`) +
      row('device', hw.deviceMemoryReported ? `≥ ${hw.deviceMemoryGB} GB RAM` : 'RAM n/a (assume 4 GB)') +
      row('limit', hw.memoryLimitApplied || fmtGB(hw.memoryLimit)) +
      row('in use', e.memory.usage || '—') +
      row('isolated', hw.crossOriginIsolated ? 'yes (pthreads possible)' : 'no') +
      row('extensions', e.extensions?.length ? e.extensions.map((x) => `${x.name} ${x.ok ? '✓' : '✗'}`).join(' · ') + (e.extensions.every((x) => x.ok) ? ' · bundled' : '') : '—', e.extensions?.every((x) => x.ok) ? 'text-emerald-400' : 'text-amber-300') +
      `<dt class="text-zinc-500">tuning</dt><dd class="leading-4">${tuning}</dd>`;
  }
}
