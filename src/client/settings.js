/**
 * Settings store — persisted in localStorage, observable.
 *
 * Two groups:
 *   engine.*   DuckDB settings applied live via SET (memory_limit, threads, …)
 *              `null` means "auto" — use the hardware-derived default.
 *   the rest   Duckbrowser behaviour (row limits, overview profile, thresholds…)
 */

const KEY = 'duckbrowser.settings';

/**
 * The project has been renamed twice (QuillDB → DuckView → Duckbrowser).
 * Carry over anything saved under an old key prefix the first time this
 * build runs, so tabs, history and settings survive. Newer prefixes win.
 * Old keys are left in place, untouched.
 */
const LEGACY_PREFIXES = ['duckview.', 'quilldb.'];
export function migrateLegacyStorage() {
  for (const area of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      if (!area) continue;
      const keys = [];
      for (let i = 0; i < area.length; i++) keys.push(area.key(i));
      for (const prefix of LEGACY_PREFIXES) {
        for (const k of keys) {
          if (!k || !k.startsWith(prefix)) continue;
          const next = `duckbrowser.${k.slice(prefix.length)}`;
          if (area.getItem(next) == null) area.setItem(next, area.getItem(k));
        }
      }
    } catch {
      /* private mode / blocked storage */
    }
  }
}
migrateLegacyStorage();

export const DEFAULTS = Object.freeze({
  engine: {
    memoryLimitMB: null, // null → auto (hardware.memoryLimit)
    threads: null, // null → auto (hardware.threadsRequested)
    preserveInsertionOrder: false,
    objectCache: true,
    bundle: 'single', // 'single' (default; Parquet/JSON supported) · 'threaded' (opt-in coi build; CSV/TSV/Arrow only in DuckDB-Wasm 1.32)
    coiServiceWorker: true, // add COOP/COEP via service worker on hosts that don't send them
  },
  maxConcurrentQueries: 4, // workbench tabs in flight at once; the rest queue
  queryTimeoutSec: 0, // auto-stop a tab's query after N seconds (0 = never)
  tableRows: 200, // rows rendered in result tables (downloads are always complete)
  profile: true, // run SUMMARIZE in the overview suite
  estimateSampleRows: 5000, // rows sampled to measure text widths for the memory estimate
  autoCharts: true, // overview distribution charts
  warnPct: 25, // safety badge: yellow above this % of the memory ceiling
  dangerPct: 60, // safety badge: red above this %
  historyMax: 40,
  autoloadSamples: null, // null → follow the build manifest
});

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k]) out[k] = merge(base[k], v);
    else if (k in base) out[k] = v;
  }
  return out;
}

class Settings {
  #state;
  #listeners = new Set();

  constructor() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      /* ignore */
    }
    this.#state = merge(DEFAULTS, saved);
  }

  /** `get('tableRows')` or `get('engine.memoryLimitMB')` */
  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.#state);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] = { ...o[k] }), (this.#state = { ...this.#state }));
    target[last] = value;
    this.#persist();
    this.#emit(path, value);
  }

  reset() {
    this.#state = merge(DEFAULTS, {});
    this.#persist();
    this.#emit('*', null);
  }

  get all() {
    return this.#state;
  }

  /** Subscribe: fn(path, value). Returns an unsubscribe function. */
  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(path, value) {
    for (const fn of this.#listeners) {
      try {
        fn(path, value);
      } catch (e) {
        console.error('[Duckbrowser] settings listener threw', e);
      }
    }
  }

  #persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#state));
    } catch {
      /* private mode */
    }
  }
}

export const settings = new Settings();
