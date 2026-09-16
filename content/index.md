---
title: Getting started
description: What DuckView is, how the three pages fit together, and how to load your own data.
order: 0
---

# Getting started

DuckView is a **local-first data workspace**. A build step turns a folder of Markdown and data files into a static site; when you open it, [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview) boots inside a Web Worker in *this tab* and every query runs on your machine. Nothing is uploaded, no server executes SQL, and the whole `dist/` folder can be hosted anywhere a static file can — or opened from a USB stick.

## The three pages

| Page | What it is for |
| --- | --- |
| **Overview** (`#/`) | Upload a dataset (or load a sample). DuckView immediately runs an overview suite: row/column counts, an in-memory estimate with a safety verdict, the full **schema** with per-column stats (`SUMMARIZE`), a preview, a rows-per-month series and top-5 distributions. |
| **Query** (`#/query`) | A tabbed SQL workbench. Each tab runs on its own connection, so several queries can be in flight at once and any of them can be stopped. Run with <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>, switch the result between table, bar and line, download results (CSV / Parquet / JSON) or the query itself (`.sql`), import `.sql` files as tabs. A schema explorer inserts identifiers; every run lands in the history. |
| **Docs** (`#/docs`) | These pages. They can embed live SQL cards — see [Authoring pages](#/docs/authoring). |
| **Settings** (`#/settings`) | Resource controls: DuckDB's memory limit (with presets derived from your hardware), insertion-order and object-cache switches, result row limits, overview profiling, safety-badge thresholds, sample autoload — plus a live readout of engine memory, JS heap, loaded datasets and running queries. |

Every card on the Overview and in the docs has an **Edit / Fork SQL** button that opens its query in the Query page, so the auto-generated analysis is a starting point rather than a dead end.

## Loading data

The workspace starts **empty**. Drop your files anywhere on the Overview page (or use *Choose a file…*). They are read directly through the browser's `File` API — no copy into memory, no upload — and unloaded when you close the tab. Drop several at once; the first becomes active. Each file becomes a DuckDB view named after it (`My Export (1).parquet` → `my_export_1`).

**Sample datasets** bundled with the build are listed under *Sample data* in the sidebar and only load when you press *Load*. The docs examples use them; a card whose sample isn't loaded offers to load it. Parquet samples are read over HTTP range requests, so only the columns a query touches are fetched. (Set `"duckview": { "autoload": true }` in `package.json` to mount every sample at boot instead.)

The view `dataset` always points at the **active dataset** (highlighted in the sidebar and selectable on the Query page), so a query written against `dataset` follows your selection. Hover a loaded dataset and click **×** to unload it.

### Supported formats

| Format | Extensions | Reader |
| --- | --- | --- |
| Parquet | `.parquet` | `read_parquet` — column-pruned, predicate push-down |
| CSV / TSV | `.csv` `.tsv` | `read_csv_auto` with header + dialect sniffing |
| JSON | `.json` | `read_json_auto` — arrays of objects, nested objects become `STRUCT`s. Files over 16 MB get a larger `maximum_object_size` automatically; a wrapper object such as `{"data": [ … ]}` is unnested into rows (the overview shows a *rows from data[]* badge) |
| NDJSON | `.ndjson` `.jsonl` | `read_json_auto`, newline-delimited |
| Arrow IPC | `.arrow` `.feather` `.ipc` | Loaded as a table via the Arrow IPC stream reader (file and stream layouts) |

## Hardware-aware by default

On boot DuckView reads `navigator.hardwareConcurrency` and `navigator.deviceMemory` and tunes DuckDB accordingly: `memory_limit` is set to a safe fraction of what a 32-bit wasm heap can address, and a matching `threads` count is requested (the default wasm build is single-threaded, so the attempt is reported honestly in the **System** panel).

Everything detected is a starting point. **Settings** shows what your machine has next to what the engine can actually use, and lets you move the limit anywhere from 256 MB up to the **4 GB ceiling of a 32-bit WebAssembly heap** — with *Conservative / Auto / Maximum* presets computed from your device memory. That ceiling is physics, not policy: a 16 GB laptop still gets at most 4 GB *per engine instance*, and the last 512 MB are marked as an unsafe zone because the engine module itself lives there too. Changes apply immediately to every connection (workbench tabs included) through DuckDB's `SET`, are shown in the status pill, and are re-applied on the next boot. *Reset to detected defaults* undoes everything.

Files far bigger than 4 GB are still fine as long as each *query's working set* fits: Parquet is read column-by-column with predicate push-down, so filter early, aggregate, and avoid `SELECT *`.

| Setting | Live? | Notes |
| --- | --- | --- |
| `memory_limit` | yes | Slider + presets, 256 MB – 4 GB (3.5–4 GB flagged unsafe). Lowering it below current usage is allowed but the next big query may fail. |
| `preserve_insertion_order` | yes | Off (default) lets DuckDB stream large results with less memory. |
| `enable_object_cache` | yes | Caches Parquet metadata between queries. |
| `threads` | on reload | Only with the multi-threaded engine (below). The pool is sized when the engine starts. |
| Engine build | on reload | Single-threaded (default) or multi-threaded (experimental). |
| Max concurrent queries, query timeout | yes | Workbench guards: extra tabs queue; a runaway query is stopped after N seconds. |
| Table rows, SUMMARIZE on load, estimate sample size, charts, badge thresholds, history size, sample autoload | yes | Workspace behaviour, stored in `localStorage`. |

### Multi-threaded engine (experimental)

DuckDB-Wasm ships a threaded build (`coi`) that runs scans, joins and aggregations across all your cores — roughly 3× faster on a 30M-row table in our tests. It needs the page to be *cross-origin isolated*: `npm run dev` sends the two required headers, and for hosts that can't (GitHub Pages, S3) DuckView installs a tiny service worker that adds them (one reload on first visit).

It is **opt-in** because of one upstream limitation in DuckDB-Wasm 1.32: the threaded build cannot load the Parquet and JSON extensions (they are published for unshared memory), so on that engine only CSV, TSV, Arrow and in-memory tables work. Switch in **Settings → Compute → Engine build**; Parquet/JSON loads fail fast with a hint pointing back to the single-threaded engine.

### Nothing is fetched from the internet

DuckDB-Wasm normally downloads its `parquet` and `json` extensions from `extensions.duckdb.org` on first use. DuckView's build vendors those files and points the engine at its own copy, so the site works with the network unplugged. (The build machine needs internet once — the same as `npm install`.)

The status pill in the navbar shows the engine state, detected cores, memory headroom and — once a dataset is profiled — a **safety badge**:

- **green** — the estimated working set fits comfortably
- **yellow** — high RAM footprint; prefer column-pruned queries, consider Parquet
- **red** — beyond the ceiling; use `LIMIT`, `USING SAMPLE`, or split the file

The estimate is `rows × row width`, where text columns are measured on a 5,000-row sample.

## The query workbench

- **Tabs.** *New tab* opens another editor; double-click a tab to rename it, **×** closes it. Tabs (name + SQL) survive reloads.
- **Run / Run all / Stop.** Every tab has its own DuckDB connection. Queries are executed through DuckDB's pending-query API, which slices work so tabs interleave — *Run all* starts every tab at once, and *Stop* cancels the current tab without touching the others. (The wasm build is single-threaded, so this is concurrency, not extra cores.)
- **Import .sql** opens each file as a tab. A file produced by *Export all* — sections separated by `-- @duckview-tab: name` lines — is split back into its tabs. Dropping `.sql` files anywhere on the page does the same.
- **Downloads.** Results as CSV, Parquet or JSON (full result, produced by DuckDB); the query as a `.sql` file, or *Copy* to the clipboard.
- **Schema explorer** — click a view or column to insert it at the cursor. **History** — the last 40 runs with timing; click to reopen.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> | Run the query in the focused editor |
| <kbd>Tab</kbd> | Insert two spaces in the editor |

## Privacy model

- The wasm engine, worker and libraries are served from the same static bundle — no CDN calls.
- Dropped files stay in the tab. Nothing is sent anywhere; there is no telemetry.
- Workbench tabs and history are kept in `localStorage` on this device only. Clear history with the trash icon on the Query page.
