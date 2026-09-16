/**
 * Duckview engine — a thin, event-emitting wrapper around DuckDB-Wasm.
 *
 *   engine.boot()                 → instantiate wasm in a Web Worker, apply tuning
 *   engine.mount(dataset)         → register a file (URL or File) and create a view
 *   engine.query(sql)             → run SQL, returns { table, rows, ms, ... }
 *   engine.exportQuery(sql, fmt)  → CSV / Parquet bytes produced by DuckDB itself
 *
 * Everything runs locally: the wasm binary, worker and data are served from
 * the same static bundle; nothing is sent anywhere.
 */
import { duckdb, tableFromIPC, tableToIPC, Table } from '../../vendor/duckdb/duckdb-browser.mjs';
import { detectHardware, tuningStatements, memoryLimitSql, clampMB } from './hardware.js';
import { qid } from './format.js';

const abs = (rel) => new URL(rel, document.baseURI).href;

// The `mvp` (no wasm exceptions) bundle is not shipped: every browser since 2021 supports the `eh` build.
const BUNDLES = {
  eh: { mainModule: abs('./vendor/duckdb/duckdb-eh.wasm'), mainWorker: abs('./vendor/duckdb/duckdb-browser-eh.worker.js') },
  // Multi-threaded (pthreads over SharedArrayBuffer). Only selectable when the
  // page is cross-origin isolated (COOP/COEP headers) — selectBundle checks that.
  coi: {
    mainModule: abs('./vendor/duckdb/duckdb-coi.wasm'),
    mainWorker: abs('./vendor/duckdb/duckdb-browser-coi.worker.js'),
    pthreadWorker: abs('./vendor/duckdb/duckdb-browser-coi.pthread.worker.js'),
  },
};

export const FORMAT_LABEL = {
  parquet: 'Parquet',
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  ndjson: 'NDJSON',
  arrow: 'Arrow',
};

export function formatFromFilename(name) {
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  return { parquet: 'parquet', csv: 'csv', tsv: 'tsv', json: 'json', ndjson: 'ndjson', jsonl: 'ndjson', arrow: 'arrow', feather: 'arrow', ipc: 'arrow' }[ext] || null;
}

/** DuckDB's default cap on a single JSON value (16 MiB) and the hard maximum (UINT32). */
const JSON_DEFAULT_OBJECT_SIZE = 16 * 1024 ** 2;
const JSON_MAX_OBJECT_SIZE = 4294967295;

/**
 * The table function DuckDB uses to read a mounted file.
 * @param {object} [opts]
 * @param {number} [opts.maxObjectSize] JSON only: raise `maximum_object_size` so a
 *   whole-document array/object bigger than 16 MiB can be parsed.
 */
export function readerFor(format, file, opts = {}) {
  const f = `'${file.replace(/'/g, "''")}'`;
  switch (format) {
    case 'parquet':
      return `read_parquet(${f})`;
    case 'csv':
      return `read_csv_auto(${f}, header=true)`;
    case 'tsv':
      return `read_csv_auto(${f}, header=true, delim='\\t')`;
    case 'json':
    case 'ndjson': {
      const size = opts.maxObjectSize ? Math.min(JSON_MAX_OBJECT_SIZE, Math.max(JSON_DEFAULT_OBJECT_SIZE, Math.ceil(opts.maxObjectSize))) : null;
      return size ? `read_json_auto(${f}, maximum_object_size=${size})` : `read_json_auto(${f})`;
    }
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

/** "My Data (1).csv" → "my_data_1" */
export function toViewName(filename) {
  let id = filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) id = 'dataset';
  if (/^[0-9]/.test(id)) id = `t_${id}`;
  return id;
}

/**
 * Arrow IPC *file* → IPC *stream* bytes for DuckDB's insertArrowFromIPCStream.
 *
 * File layout: "ARROW1"+pad | messages | footer | int32 footer len | "ARROW1".
 * Writers differ: Arrow C++/PyArrow repeat the Schema message in the body, so
 * slicing the middle out yields a valid stream for free. Arrow JS only stores
 * the schema in the footer, so for those we let Arrow's footer-aware reader
 * rebuild the table and re-serialise it as a stream.
 */
function arrowFileToStream(bytes) {
  const MAGIC = 'ARROW1';
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  if (bytes.length < 16 || ascii(0, 6) !== MAGIC) return bytes; // already a stream
  if (ascii(bytes.length - 6, bytes.length) !== MAGIC) throw new Error('Arrow file is truncated (missing trailing magic).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLen = dv.getInt32(bytes.length - 10, true);
  const end = bytes.length - 10 - footerLen;

  if (firstMessageType(dv, 8) === 1 /* Schema */) {
    let stream = bytes.subarray(8, end);
    const EOS = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0];
    const hasEOS = stream.length >= 8 && EOS.every((b, i) => stream[stream.length - 8 + i] === b);
    if (!hasEOS) {
      const out = new Uint8Array(stream.length + 8);
      out.set(stream);
      out.set(EOS, stream.length);
      stream = out;
    }
    return stream;
  }
  // Schema lives only in the footer (Arrow JS writer): decode + re-encode.
  return tableToIPC(tableFromIPC(bytes), 'stream');
}

/** Read the `header_type` of the encapsulated IPC message starting at `off` (0 if unreadable). */
function firstMessageType(dv, off) {
  try {
    if (dv.getInt32(off, true) !== -1) return 0; // no continuation marker → legacy/unknown
    const metaStart = off + 8;
    const root = metaStart + dv.getInt32(metaStart, true);
    const vtable = root - dv.getInt32(root, true);
    const vtableLen = dv.getInt16(vtable, true);
    const fieldOffset = 4 + 1 * 2 < vtableLen ? dv.getInt16(vtable + 4 + 1 * 2, true) : 0; // field 1 = header_type
    return fieldOffset ? dv.getUint8(root + fieldOffset) : 0;
  } catch {
    return 0;
  }
}

class Emitter {
  #listeners = new Map();
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }
  emit(event, payload) {
    for (const fn of this.#listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[Duckview] listener for "${event}" threw`, e);
      }
    }
  }
}

/**
 * A QuerySession owns one DuckDB connection and runs statements through the
 * *pending query* API. The worker executes pending queries in small time
 * slices, so sessions interleave — several tabs can be in flight at once on
 * the single-threaded wasm build — and a running query can be cancelled.
 */
export class QuerySession {
  #engine;
  #conn = null;
  #running = false;

  constructor(engine, label = 'session') {
    this.#engine = engine;
    this.label = label;
  }

  get running() {
    return this.#running;
  }

  async #connection() {
    await this.#engine.ready;
    if (!this.#conn) this.#conn = await this.#engine.db.connect();
    return this.#conn;
  }

  /** Run SQL; resolves to the same result shape as Engine#query. */
  async run(sql) {
    if (this.#running) throw new Error('A query is already running in this tab — stop it first.');
    const conn = await this.#connection();
    const id = this.#engine.nextQueryId();
    const t0 = performance.now();
    this.#running = true;
    this.#engine.emit('query:start', { id, sql, session: this.label });
    try {
      const reader = await conn.send(sql);
      await reader.open({ autoDestroy: false });
      const schema = reader.schema;
      const batches = await reader.readAll();
      const table = batches.length ? new Table(batches) : new Table(schema);
      const ms = performance.now() - t0;
      const fields = table.schema.fields;
      this.#engine.emit('query:end', { id, sql, ms, numRows: table.numRows });
      return { id, sql, table, fields, columns: fields.map((f) => f.name), numRows: table.numRows, ms };
    } catch (err) {
      const ms = performance.now() - t0;
      const error = new Error(cleanError(err));
      error.sql = sql;
      error.ms = ms;
      error.cancelled = /cancel/i.test(error.message);
      this.#engine.emit('query:error', { id, sql, ms, error });
      throw error;
    } finally {
      this.#running = false;
    }
  }

  /** Cancel the in-flight query (the pending run() rejects with `cancelled: true`). */
  async cancel() {
    if (!this.#running || !this.#conn) return false;
    return this.#conn.cancelSent();
  }

  async close() {
    await this.cancel().catch(() => {});
    await this.#conn?.close().catch(() => {});
    this.#conn = null;
  }
}

export class Engine extends Emitter {
  db = null;
  conn = null;
  bundle = null;
  version = null;
  hardware = detectHardware();
  tuning = []; // [{ label, ok, error }]
  datasets = new Map(); // id → dataset record
  status = 'idle'; // idle | booting | ready | error
  bootError = null;
  #readyResolve;
  ready = new Promise((r) => (this.#readyResolve = r));
  #queryCount = 0;
  #memory = { usage: null, limit: null };

  nextQueryId() {
    return ++this.#queryCount;
  }

  /** A dedicated connection for a workbench tab. */
  createSession(label) {
    return new QuerySession(this, label);
  }

  constructor({ debug = false, tuningOverrides = {}, extensions = ['parquet', 'json'] } = {}) {
    super();
    this.debug = debug;
    this.tuningOverrides = tuningOverrides;
    this.extensionNames = extensions;
    this.extensions = []; // [{ name, ok, error }]
  }

  get memory() {
    return this.#memory;
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async boot() {
    if (this.status !== 'idle') return this.ready;
    this.status = 'booting';
    this.emit('status', { status: 'booting', message: 'Selecting wasm bundle' });
    const t0 = performance.now();
    try {
      const wantThreads = ['threaded', 'auto'].includes(this.tuningOverrides.bundle); // Settings → Engine build
      this.bundle = await duckdb.selectBundle(wantThreads ? BUNDLES : { eh: BUNDLES.eh });
      const bundleName = this.bundle.mainModule.includes('-coi.') ? 'coi' : this.bundle.mainModule.includes('-eh.') ? 'eh' : 'mvp';
      const logger = this.debug ? new duckdb.ConsoleLogger() : new duckdb.VoidLogger();
      const worker = new Worker(this.bundle.mainWorker);
      this.db = new duckdb.AsyncDuckDB(logger, worker);
      await this.db.instantiate(this.bundle.mainModule, this.bundle.pthreadWorker, (p) => {
        if (p?.bytesTotal) {
          this.emit('status', {
            status: 'booting',
            message: `Loading engine ${Math.round((p.bytesLoaded / p.bytesTotal) * 100)}%`,
            progress: p.bytesLoaded / p.bytesTotal,
          });
        }
      });
      // A stored thread count goes in at open(): shrinking the pthread pool after
      // it has started can deadlock the coi bundle, so we size it up front.
      const threadOverride = this.tuningOverrides.threads;
      await this.db.open({
        path: ':memory:',
        ...(bundleName === 'coi' ? { maximumThreads: Math.max(1, Math.round(threadOverride || this.hardware.threadsRequested)) } : {}),
        query: { castBigIntToDouble: false, castDecimalToDouble: true, castTimestampToDate: true },
      });
      this.conn = await this.db.connect();
      this.version = await this.db.getVersion();
      this.bundleName = bundleName;

      // --- Hardware-aware tuning -----------------------------------------
      this.emit('status', { status: 'booting', message: 'Tuning for this machine' });
      if (this.tuningOverrides.memoryLimitMB) this.hardware.memoryLimit = clampMB(this.tuningOverrides.memoryLimitMB) * 1024 ** 2;
      // `threads` is deliberately left out of the boot batch (see open() above).
      const { threads: _ignored, ...bootOverrides } = this.tuningOverrides;
      for (const stmt of tuningStatements(this.hardware, bootOverrides).filter((st) => st.key !== 'threads' || bundleName !== 'coi')) {
        try {
          await this.conn.query(stmt.sql);
          this.tuning.push({ key: stmt.key, label: stmt.label, ok: true });
        } catch (err) {
          // e.g. "PRAGMA threads" on a single-threaded wasm build — expected.
          this.tuning.push({ key: stmt.key, label: stmt.label, ok: false, error: String(err?.message || err) });
          if (stmt.required) throw err;
        }
      }
      await this.readSettings();
      this.hardware.threadsFixed = this.tuning.find((t) => t.key === 'threads')?.ok === false && this.hardware.threadsRequested > 1;

      // --- Extensions: from our own bundle, never from extensions.duckdb.org ------
      this.emit('status', { status: 'booting', message: 'Loading extensions' });
      await this.#loadExtensions();
      await this.refreshMemory();

      this.status = 'ready';
      this.bootMs = performance.now() - t0;
      this.readyAt = performance.now();
      this.emit('status', { status: 'ready', message: `DuckDB ${this.version} ready in ${Math.round(this.bootMs)} ms` });
      console.info(
        `%c🦆 Duckview%c DuckDB ${this.version} (${bundleName} bundle) booted in ${Math.round(this.bootMs)} ms · ` +
          `${this.hardware.cores} cores · ${this.hardware.threadsActive} thread(s) · limit ${this.hardware.memoryLimitApplied}`,
        'color:#a78bfa;font-weight:600',
        'color:inherit',
      );
      this.#readyResolve(this);
      return this;
    } catch (err) {
      this.status = 'error';
      this.bootError = err;
      this.emit('status', { status: 'error', message: `Engine failed to start: ${err?.message || err}` });
      console.error('[Duckview] boot failed', err);
      throw err;
    }
  }

  /**
   * DuckDB-Wasm no longer links parquet/json statically; by default it would
   * download them from extensions.duckdb.org on first use. The build vendors
   * them under ./vendor/duckdb/extensions/<version>/<platform>/, so we point
   * both repository settings there and load up front.
   */
  async #loadExtensions() {
    const repo = abs('./vendor/duckdb/extensions').replace(/\/$/, '');
    try {
      await this.conn.query(`SET custom_extension_repository = '${repo}'`);
      await this.conn.query(`SET autoinstall_extension_repository = '${repo}'`);
      if (this.bundleName === 'coi') {
        await this.conn.query(`SET autoinstall_known_extensions = false`);
        await this.conn.query(`SET autoload_known_extensions = false`);
      }
    } catch (err) {
      console.warn('[Duckview] could not point DuckDB at the local extension repository', err);
    }
    for (const name of this.extensionNames) {
      if (this.bundleName === 'coi') {
        // The wasm_threads extension builds import unshared memory and cannot link
        // into the shared-memory engine (upstream packaging issue in DuckDB-Wasm
        // 1.32 / DuckDB 1.4.x). Attempting it can wedge the worker, so don't.
        this.extensions.push({ name, ok: false, error: 'not available in the threaded engine (upstream build issue) — use the single-threaded engine for Parquet/JSON' });
        continue;
      }
      const t0 = performance.now();
      try {
        await this.conn.query(`LOAD ${name}`);
        this.extensions.push({ name, ok: true, ms: performance.now() - t0 });
      } catch (err) {
        this.extensions.push({ name, ok: false, error: cleanError(err), ms: performance.now() - t0 });
        console.warn(`[Duckview] extension "${name}" failed to load from the local bundle:`, cleanError(err));
      }
    }
  }

  /** Ask DuckDB what it actually settled on. */
  async readSettings() {
    try {
      const t = await this.conn.query(
        `SELECT current_setting('threads') AS threads, current_setting('memory_limit') AS memory_limit,
                current_setting('preserve_insertion_order') AS preserve_insertion_order, current_setting('enable_object_cache') AS enable_object_cache`,
      );
      const row = t.toArray()[0]?.toJSON?.() ?? {};
      this.hardware.threadsActive = Number(row.threads) || 1;
      this.hardware.memoryLimitApplied = String(row.memory_limit ?? '');
      this.current = {
        threads: Number(row.threads) || 1,
        memoryLimit: String(row.memory_limit ?? ''),
        preserveInsertionOrder: String(row.preserve_insertion_order) === 'true',
        objectCache: String(row.enable_object_cache) === 'true',
      };
    } catch {
      this.hardware.threadsActive = this.hardware.threadsActive ?? 1;
    }
    return this.current;
  }

  /**
   * Change a resource setting while running. Global DuckDB settings apply to
   * every connection (workbench tabs included). Resolves { ok, label, error }.
   */
  async applySetting(key, value) {
    await this.ready;
    const sql = {
      memoryLimitMB: () => memoryLimitSql(value),
      threads: () => `PRAGMA threads = ${Math.max(1, Math.round(Number(value) || 1))}`,
      preserveInsertionOrder: () => `SET preserve_insertion_order = ${Boolean(value)}`,
      objectCache: () => `SET enable_object_cache = ${Boolean(value)}`,
    }[key]?.();
    if (!sql) throw new Error(`Unknown setting: ${key}`);
    if (key === 'threads' && this.bundleName === 'coi') {
      // Resizing a live pthread pool can deadlock the wasm build; the count is applied at open() instead.
      return { key, label: sql.replace(/^(SET|PRAGMA)\s+/, ''), ok: false, error: 'Thread count is fixed at engine start — reload to apply.', ms: 0 };
    }
    const t0 = performance.now();
    try {
      await this.conn.query(sql);
      if (key === 'memoryLimitMB') this.hardware.memoryLimit = clampMB(value) * 1024 ** 2; // feasibility + status pill follow the live limit
      await this.readSettings();
      await this.refreshMemory();
      const entry = { key, label: sql.replace(/^(SET|PRAGMA)\s+/, ''), ok: true, ms: performance.now() - t0 };
      this.#recordTuning(entry);
      this.emit('settings', this.current);
      return entry;
    } catch (err) {
      const entry = { key, label: sql.replace(/^(SET|PRAGMA)\s+/, ''), ok: false, error: cleanError(err), ms: performance.now() - t0 };
      this.#recordTuning(entry);
      return entry;
    }
  }

  #recordTuning(entry) {
    const i = this.tuning.findIndex((t) => t.key === entry.key);
    if (i >= 0) this.tuning[i] = entry;
    else this.tuning.push(entry);
    this.emit('status', { status: this.status, message: `${entry.label}${entry.ok ? '' : ' — ' + entry.error}` });
  }

  async refreshMemory() {
    try {
      const t = await this.conn.query(`PRAGMA database_size`);
      const row = t.toArray()[0]?.toJSON?.();
      if (row) {
        this.#memory = { usage: String(row.memory_usage ?? ''), limit: String(row.memory_limit ?? '') };
        this.emit('memory', this.#memory);
      }
    } catch {
      /* not fatal */
    }
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------
  /**
   * Run a statement. Resolves to { table, rows, columns, fields, ms, sql }.
   * `rows` is an array of plain objects (Arrow row proxies unwrapped).
   */
  async query(sql, { silent = false } = {}) {
    if (this.status !== 'ready') await this.ready;
    const id = this.nextQueryId();
    const t0 = performance.now();
    if (!silent) this.emit('query:start', { id, sql });
    try {
      const table = await this.conn.query(sql);
      const ms = performance.now() - t0;
      const fields = table.schema.fields;
      const result = {
        id,
        sql,
        table,
        fields,
        columns: fields.map((f) => f.name),
        numRows: table.numRows,
        ms,
      };
      if (!silent) this.emit('query:end', { id, sql, ms, numRows: table.numRows });
      return result;
    } catch (err) {
      const ms = performance.now() - t0;
      const error = new Error(cleanError(err));
      error.sql = sql;
      error.ms = ms;
      if (!silent) this.emit('query:error', { id, sql, ms, error });
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Datasets
  // ---------------------------------------------------------------------
  /**
   * Mount a dataset and expose it as a view named `dataset.id`.
   * @param {object} ds { id, file, format, size, url? | fileHandle?, source }
   */
  async mount(ds) {
    await this.ready;
    const rec = { ...ds, state: 'loading', error: null, mountedAt: null };
    this.datasets.set(ds.id, rec);
    this.emit('dataset:change', rec);
    const t0 = performance.now();
    try {
      if (ds.fileHandle) {
        await this.#mountFile(rec);
      } else {
        await this.#mountURL(rec);
      }
      // Fetch the schema once; consumers (overview, feasibility) reuse it.
      rec.schema = await this.#describe(ds.id);
      if (rec.format === 'json' || rec.format === 'ndjson') await this.#maybeUnwrapJson(rec);
      rec.state = 'ready';
      rec.mountedAt = Date.now();
      rec.mountMs = performance.now() - t0;
      this.emit('dataset:change', rec);
      return rec;
    } catch (err) {
      rec.state = 'error';
      rec.error = cleanError(err);
      if (this.bundleName === 'coi' && /not in the catalog|read_parquet|read_json/i.test(rec.error)) {
        rec.error = `The threaded engine cannot read ${FORMAT_LABEL[rec.format] ?? rec.format} in this DuckDB-Wasm version. Switch to the single-threaded engine in Settings and reload.`;
        err = new Error(rec.error);
      }
      this.emit('dataset:change', rec);
      throw err;
    }
  }

  async #describe(id) {
    const desc = await this.query(`DESCRIBE ${qid(id)}`, { silent: true });
    return desc.table.toArray().map((r) => {
      const o = r.toJSON();
      return { name: String(o.column_name), type: String(o.column_type) };
    });
  }

  /**
   * API-style exports often wrap the records: {"status": "ok", "data": [ {...}, ... ]}.
   * DuckDB reads that as ONE row with a STRUCT[] column, which is useless to
   * profile. If the file has a single row and exactly one list-of-struct
   * column, redefine the view to UNNEST it into rows (scalar wrapper fields are
   * dropped and remembered on the record so the UI can say so).
   */
  async #maybeUnwrapJson(rec) {
    const lists = rec.schema.filter((c) => /^STRUCT\(.*\)\[\]$/s.test(c.type));
    if (lists.length !== 1 || rec.schema.length > 6) return;
    const count = await this.query(`SELECT COUNT(*) AS n FROM ${qid(rec.id)}`, { silent: true });
    if (Number(count.table.toArray()[0]?.n) !== 1) return;
    const col = lists[0].name;
    const reader = readerFor(rec.format, rec.file, { maxObjectSize: rec.readerOptions?.maximum_object_size });
    // max_depth 2: explode the list (1) and spread the struct into columns (2); deeper lists stay as-is.
    await this.conn.query(`CREATE OR REPLACE VIEW ${qid(rec.id)} AS SELECT UNNEST(${qid(col)}, max_depth := 2) FROM ${reader}`);
    rec.unwrapped = { column: col, dropped: rec.schema.filter((c) => c.name !== col).map((c) => c.name) };
    rec.schema = await this.#describe(rec.id);
  }

  async #createView(rec, opts = {}) {
    try {
      await this.conn.query(`CREATE OR REPLACE VIEW ${qid(rec.id)} AS SELECT * FROM ${readerFor(rec.format, rec.file, opts)}`);
      if (opts.maxObjectSize) rec.readerOptions = { maximum_object_size: Math.ceil(opts.maxObjectSize) };
    } catch (err) {
      // A .json file that is one big array/object must fit DuckDB's per-value
      // buffer. Retry once with the buffer sized to the file (+ slack).
      if (/maximum_object_size/i.test(String(err?.message ?? err)) && !opts.maxObjectSize && rec.size) {
        return this.#createView(rec, { ...opts, maxObjectSize: rec.size * 1.1 + 1024 ** 2 });
      }
      throw err;
    }
  }

  async #mountURL(rec) {
    const url = new URL(rec.url, document.baseURI).href;
    if (rec.format === 'arrow') {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rec.file}`);
      await this.#insertArrow(rec.id, new Uint8Array(await res.arrayBuffer()));
      rec.mountMode = 'arrow-table';
      return;
    }
    // Preferred: let DuckDB read the file over HTTP with range requests, so
    // Parquet is column-pruned and nothing is copied into wasm memory up front.
    try {
      await this.db.registerFileURL(rec.file, url, duckdb.DuckDBDataProtocol.HTTP, false);
      await this.#createView(rec);
      rec.mountMode = 'http-range';
    } catch (err) {
      // Fallback (no Range support, file:// …): fetch fully and register the buffer.
      if (this.debug) console.warn(`[Duckview] HTTP mount failed for ${rec.file}; falling back to buffer`, err);
      await this.db.dropFile(rec.file).catch(() => {});
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rec.file}`);
      await this.db.registerFileBuffer(rec.file, new Uint8Array(await res.arrayBuffer()));
      await this.#createView(rec);
      rec.mountMode = 'buffer';
    }
  }

  async #mountFile(rec) {
    const file = rec.fileHandle;
    if (rec.format === 'arrow') {
      await this.#insertArrow(rec.id, new Uint8Array(await file.arrayBuffer()));
      rec.mountMode = 'arrow-table';
      return;
    }
    // BROWSER_FILEREADER streams straight from the File object — no upload,
    // no full copy into the wasm heap.
    await this.db.dropFile(rec.file).catch(() => {});
    await this.db.registerFileHandle(rec.file, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    await this.#createView(rec);
    rec.mountMode = 'file-reader';
  }

  async #insertArrow(name, bytes) {
    const stream = arrowFileToStream(bytes);
    await this.conn.query(`DROP TABLE IF EXISTS ${qid(name)}`);
    await this.conn.query(`DROP VIEW IF EXISTS ${qid(name)}`);
    await this.conn.insertArrowFromIPCStream(stream, { name, schema: 'main', create: true });
  }

  /** Point the `dataset` alias view at one of the mounted datasets. */
  async setActive(id) {
    const rec = this.datasets.get(id);
    if (!rec || rec.state !== 'ready') throw new Error(`Dataset "${id}" is not mounted`);
    await this.conn.query(`CREATE OR REPLACE VIEW dataset AS SELECT * FROM ${qid(id)}`);
    this.activeId = id;
    this.emit('dataset:active', rec);
    return rec;
  }

  async unmount(id) {
    const rec = this.datasets.get(id);
    if (!rec) return;
    await this.conn.query(`DROP VIEW IF EXISTS ${qid(id)}`).catch(() => {});
    await this.conn.query(`DROP TABLE IF EXISTS ${qid(id)}`).catch(() => {});
    await this.db.dropFile(rec.file).catch(() => {});
    this.datasets.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      await this.conn.query(`DROP VIEW IF EXISTS dataset`).catch(() => {});
      this.emit('dataset:active', null);
    }
    this.emit('dataset:removed', rec);
  }

  /** Register a user-supplied File (drag & drop / file picker). */
  async mountLocalFile(file) {
    const format = formatFromFilename(file.name);
    if (!format) throw new Error(`Unsupported file type: ${file.name}`);
    let id = toViewName(file.name);
    let n = 2;
    while (this.datasets.has(id)) id = `${toViewName(file.name)}_${n++}`;
    // Keep the registered filename unique too (two "data.csv" drops).
    const fileName = this.datasets.size && [...this.datasets.values()].some((d) => d.file === file.name) ? `${id}_${file.name}` : file.name;
    return this.mount({ id, file: fileName, format, size: file.size, fileHandle: file, source: 'local' });
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------
  /**
   * Produce a CSV, Parquet or JSON file from a query. DuckDB writes it into
   * its virtual FS, we copy the bytes out and hand back a Blob.
   */
  async exportQuery(sql, format = 'csv') {
    await this.ready;
    const name = `duckview_export_${Date.now()}.${format}`;
    const body = sql.trim().replace(/;+\s*$/, '');
    const options = { parquet: `(FORMAT PARQUET, COMPRESSION ZSTD)`, csv: `(FORMAT CSV, HEADER true)`, json: `(FORMAT JSON, ARRAY true)` }[format];
    if (!options) throw new Error(`Unsupported export format: ${format}`);
    try {
      await this.conn.query(`COPY (${body}) TO '${name}' ${options}`);
      const bytes = await this.db.copyFileToBuffer(name);
      const type = { parquet: 'application/vnd.apache.parquet', csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8' }[format];
      return new Blob([bytes], { type });
    } finally {
      await this.db.dropFile(name).catch(() => {});
    }
  }
}

function cleanError(err) {
  const msg = String(err?.message ?? err ?? 'Unknown error');
  // DuckDB-Wasm prefixes messages with the error class; keep it — it's useful —
  // but strip the noisy "Error: " that the async bridge adds.
  return msg.replace(/^Error:\s*/, '');
}
