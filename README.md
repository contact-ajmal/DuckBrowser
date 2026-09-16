# 🦆 Duckview

**Local-first, privacy-focused static data workspace.** Markdown + data files in, a DuckDB-Wasm dashboard out.

> Instant, hardware-aware analytics on your own machine — zero cloud compute, zero configuration, complete data privacy.

Duckview compiles `content/*.md` and `data/*` into a static site in `dist/`. The site boots [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview) in a Web Worker, mounts the bundled datasets, and offers three pages:

| Page | Route | What it does |
| --- | --- | --- |
| **Overview** | `#/` | Upload a dataset (samples load on demand) → instant KPIs, full **schema** with per-column stats, preview, time series and top-5 distributions |
| **Query** | `#/query` | Tabbed SQL workbench: each tab on its own connection (concurrent runs, per-tab Stop), ⌘/Ctrl+Enter, table / bar / line results with axis pickers, downloads (CSV · Parquet · JSON · `.sql`), `.sql` import, schema explorer, history |
| **Docs** | `#/docs/<page>` | Documentation rendered from `content/*.md`, with live SQL cards |
| **Settings** | `#/settings` | Machine-vs-engine readout; `memory_limit` slider to the 4 GB wasm ceiling with hardware-derived presets and an unsafe zone; opt-in multi-threaded engine + thread count; query guards (max concurrent tabs, timeout); `preserve_insertion_order`, object cache, table row limits, overview profiling, safety thresholds, sample autoload; live memory / heap / dataset readout |

The three pages are hash routes inside one HTML file, so the engine and any files you dropped in survive navigation. Every auto-generated card has an **Edit / Fork SQL** button that opens it on the Query page.

## Quick start

```bash
npm install
npm run data     # generate the sample datasets in ./data (deterministic)
npm run build    # compile ./content + ./data → ./dist
npm run dev      # serve ./dist at http://localhost:4173
```

`npm start` runs build + dev in one go.

## What you get

| Feature | Where |
| --- | --- |
| Multi-format ingestion — Parquet, CSV, TSV, JSON, NDJSON, Arrow IPC | `src/client/engine.js` |
| Bundled datasets are mounted over **HTTP range requests** (Parquet is column-pruned, nothing copied into memory up front) | `Engine#mountURL` |
| Drag-and-drop / file picker: local files are read through the browser `File` API — never uploaded | `src/client/datasets.js` |
| Auto-run overview suite → KPI cards, schema card (DESCRIBE + SUMMARIZE), preview table, monthly time series, top-5 distributions | `src/client/overview.js` |
| Query tool: tabs, per-tab `QuerySession` (pending-query API → interleaved execution + cancel), chart controls, result + query downloads, `.sql` import/export, schema explorer, history | `src/client/query-tool.js`, `engine.js` |
| `<duck-query>` Web Component: run, edit inline, fork to the Query page, export CSV / Parquet, execution timing | `src/client/duck-query.js` |
| Syntax-highlighted SQL editor (Prism), `⌘/Ctrl+Enter` to run | `src/client/editor.js` |
| Settings page: engine settings applied live via `SET` (`Engine#applySetting`), persisted overrides re-applied at boot, workspace behaviour | `src/client/settings-page.js`, `settings.js` |
| Hash router (`#/`, `#/query`, `#/docs/<page>`, `#/settings`, `?ds=<id>` deep links) | `src/client/router.js` |
| Hardware profiler: `hardwareConcurrency`, `deviceMemory` → `memory_limit`, `threads`, safety badge + feasibility alerts | `src/client/hardware.js`, `status.js` |
| SSG: Markdown → HTML, ```` ```sql ```` fences → `<duck-query>`, Tailwind v4, vendored runtime **including DuckDB's parquet/json extensions** (no CDN, works offline) | `src/build.js` |
| Multi-threaded engine (opt-in): `coi` bundle under COOP/COEP (`serve.json` for dev; `coi-sw.js` service worker for static hosts), thread pool sized at `open()` | `src/client/engine.js`, `src/coi-sw.js` |

## Project layout

```
content/            Markdown doc pages (front matter: title, description, order)
data/               Datasets — each file becomes a DuckDB view named after it
scripts/
  generate-data.js  Sample data generator (Parquet via DuckDB, Arrow via apache-arrow)
src/
  build.js          Build pipeline
  template.html     Page shell
  styles.css        Tailwind v4 entry (dark-first zinc palette)
  vendor-entry.js   esbuild entry bundling DuckDB-Wasm + apache-arrow into one ESM
  client.js         Browser entry point
  client/           router · engine · overview · query-tool · docs · settings-page · settings · duck-query · editor · render · datasets · status · hardware · format
dist/               Build output (static, ~70 MB: eh + coi wasm bundles, extensions, libs)
```

## Writing pages

```markdown
---
title: Sales review
order: 20               # sidebar position (index.md is 0)
---

# Q4 revenue

```sql {title="Revenue by region" chart=bar x=region y=revenue}
SELECT region, SUM(revenue) AS revenue FROM sales GROUP BY 1 ORDER BY 2 DESC;
```
```

Fence options: `title`, `chart` (`bar` | `line` | `auto` | `none`), `x`, `y` (comma-separated for multiple series), `autorun=false`, `static=true`.

Views: each file in `data/` is a sample, listed in the sidebar and mounted as a view when the user presses *Load* (`sales.csv` → `sales`). The workspace otherwise starts empty for the user's own files. The view `dataset` always points at the active dataset, so a card written against `dataset` re-runs when the selection changes. `package.json` → `"duckview": { "autoload": true, "defaultDataset": "sales" }` restores mount-everything-at-boot behaviour.

## Testing

```bash
npm test         # build, serve dist/ on a temp port, run the headless smoke test
npm run test:live   # same checks against an already-running `npm run dev`
```

`scripts/smoke-test.mjs` drives the site in headless Chrome (via `playwright-core`, using the Chrome already installed) and checks all three pages: empty boot, loading samples, the Overview KPIs / schema card / preview / charts, fork → Query, concurrent tabs + Stop, tab close/rename/persistence, `.sql` import (single and multi-tab) and drop, chart types and axes, CSV / Parquet / JSON / `.sql` downloads, history and the schema explorer, every docs page's live cards, the Settings page (live `memory_limit` change reflected in the status pill, 4 GB ceiling + unsafe warning, presets, toggles, persistence across reload, profile-off overview, reset), the opt-in threaded engine (loads under COOP/COEP, stored thread count, CSV works, Parquet fails fast with a hint), query guards (concurrency queue, timeout), large JSON files, a dropped data file, unloading the active dataset — and that **no request leaves localhost** during the entire run. Add `?debug` to the URL when testing by hand to get DuckDB's console logger.

## Hardware tuning

On boot the client sets:

- `memory_limit` — `min(0.75 × 4 GB wasm ceiling, 0.5 × deviceMemory)`, floor 512 MB
- `PRAGMA threads = hardwareConcurrency` — applied when the build supports it. The default `eh`/`mvp` wasm bundles are single-threaded; the pragma is attempted and reported honestly in the System panel (a COOP/COEP-isolated host can use the `coi` bundle for pthreads).
- `preserve_insertion_order = false`, `enable_object_cache = true`

The navbar pill shows engine status, detected cores, memory headroom and a per-dataset safety badge (green / yellow / red) derived from `rows × estimated row width` vs. the memory ceiling. The **Settings** page overrides any of this at runtime (256 MB – 4 GB memory limit with Conservative / Auto / Maximum presets and a flagged unsafe zone above 3.5 GB, insertion order, object cache, badge thresholds, concurrency limit, query timeout); overrides live in `localStorage` and are re-applied at boot.

**Memory ceiling:** DuckDB-Wasm is a 32-bit WebAssembly module, so 4 GB per engine instance is a hard limit whatever the machine has — there is no 12 GB setting to be had until a Memory64 build exists. Files larger than that still query fine when each query's working set fits (Parquet is column-pruned).

**Threads:** the default engine is single-threaded. The threaded `coi` build is available as an opt-in (Settings → Engine build) and scales real workloads ~3× on 8 cores, but in DuckDB-Wasm 1.32 it cannot load the parquet/json extensions (published for unshared memory), so it is limited to CSV/TSV/Arrow and in-memory tables. It requires cross-origin isolation: `npm run dev` sends COOP/COEP via `serve.json`; on hosts that can't, the bundled `coi-sw.js` service worker adds the headers. Thread count is applied at engine start (`maximumThreads`), so changes take effect on reload — resizing a live pthread pool deadlocks the wasm build.

**Offline:** DuckDB-Wasm autoloads `parquet`/`json` from `extensions.duckdb.org` by default. The build downloads them once (cached in `node_modules/.cache/duckview`), ships them under `vendor/duckdb/extensions/`, and the engine is pointed there — the smoke test blocks every non-localhost request for the whole run to prove it.

## Notes

- JSON files larger than DuckDB's 16 MB `maximum_object_size` are retried with the buffer sized to the file; a single wrapper object (`{"data": [...]}`) is unnested into rows automatically.
- The Arrow IPC *file* format is supported for both C++/PyArrow-written files (schema repeated in the body — sliced straight into DuckDB) and Arrow-JS-written files (schema only in the footer — decoded with Arrow's reader and re-streamed).
- Exports run `COPY (…) TO` inside DuckDB, so CSV/Parquet files contain the *full* result even when the table view is truncated.
- Add `?debug` to the URL to enable DuckDB's console logger.
