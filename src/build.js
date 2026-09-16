#!/usr/bin/env node
/**
 * DuckView build pipeline.
 *
 *   content/*.md  ──marked──▶  dist/index.html  (docs view; ```sql fences → <duck-query>)
 *   data/*        ──copy───▶  dist/data/        (+ dist/manifest.json)
 *   src/client/*  ──copy───▶  dist/assets/
 *   src/styles.css ─tailwind▶ dist/assets/styles.css
 *   node_modules  ──copy───▶  dist/vendor/      (DuckDB-Wasm, Chart.js, Prism)
 *
 * The output is a fully static bundle: no server-side code, no CDN calls.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import { Marked } from 'marked';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = {
  content: path.join(ROOT, 'content'),
  data: path.join(ROOT, 'data'),
  src: path.join(ROOT, 'src'),
  dist: path.join(ROOT, 'dist'),
};
const pkg = fs.readJsonSync(path.join(ROOT, 'package.json'));

// ---------------------------------------------------------------------------
// Terminal output helpers
// ---------------------------------------------------------------------------
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const step = (n, title) => console.log(`\n${c.cyan(`[${n}/6]`)} ${c.bold(title)}`);
const item = (msg) => console.log(`   ${c.dim('•')} ${msg}`);
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
};

// ---------------------------------------------------------------------------
// Dataset manifest — every file in /data becomes a DuckDB view named after it
// ---------------------------------------------------------------------------
const FORMAT_BY_EXT = {
  '.parquet': 'parquet',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.json': 'json',
  '.ndjson': 'ndjson',
  '.jsonl': 'ndjson',
  '.arrow': 'arrow',
  '.feather': 'arrow',
  '.ipc': 'arrow',
};

/** "My Data (1).csv" → "my_data_1" — a safe, unquoted SQL identifier. */
export function toViewName(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  let id = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) id = 'dataset';
  if (/^[0-9]/.test(id)) id = `t_${id}`;
  return id;
}

async function collectDatasets() {
  if (!(await fs.pathExists(DIRS.data))) return [];
  const files = (await fs.readdir(DIRS.data)).filter((f) => !f.startsWith('.')).sort();
  const datasets = [];
  const seen = new Set();
  for (const file of files) {
    const format = FORMAT_BY_EXT[path.extname(file).toLowerCase()];
    if (!format) {
      item(c.yellow(`skipping ${file} (unsupported extension)`));
      continue;
    }
    let id = toViewName(file);
    let n = 2;
    while (seen.has(id)) id = `${toViewName(file)}_${n++}`;
    seen.add(id);
    const { size } = await fs.stat(path.join(DIRS.data, file));
    datasets.push({ id, file, format, size, url: `./data/${encodeURIComponent(file)}`, source: 'bundled' });
  }
  return datasets;
}

// ---------------------------------------------------------------------------
// Markdown → HTML with <duck-query> components
// ---------------------------------------------------------------------------
const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Minimal front matter: `---\nkey: value\n---` at the top of the file. */
function parseFrontMatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/**
 * Parse fence info strings such as:
 *   sql {title="Revenue by region" chart=bar x=region y=revenue}
 *   sql title="Top products" chart=bar
 */
function parseFenceOptions(lang = '') {
  const [first, ...rest] = lang.trim().split(/\s+/);
  const opts = {};
  const tail = rest.join(' ').replace(/^\{|\}$/g, '');
  const re = /([A-Za-z_][\w-]*)(?:=("([^"]*)"|'([^']*)'|([^\s}]+)))?/g;
  let m;
  while ((m = re.exec(tail))) {
    opts[m[1]] = m[3] ?? m[4] ?? m[5] ?? 'true';
  }
  return { lang: (first || '').toLowerCase(), opts };
}

const slugger = () => {
  const used = new Map();
  return (text) => {
    let slug = text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    const n = used.get(slug) ?? 0;
    used.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  };
};

function createMarkdown(pageState) {
  const marked = new Marked({ gfm: true, breaks: false });
  const slug = slugger();

  marked.use({
    renderer: {
      code({ text, lang }) {
        const { lang: language, opts } = parseFenceOptions(lang || '');
        if (language === 'sql' && opts.static !== 'true') {
          pageState.queries += 1;
          const attrs = [];
          const title = opts.title || `Query ${pageState.queries}`;
          attrs.push(`title="${escapeHtml(title)}"`);
          for (const key of ['chart', 'x', 'y', 'dataset', 'limit']) {
            if (opts[key]) attrs.push(`${key}="${escapeHtml(opts[key])}"`);
          }
          if (opts.autorun === 'false') attrs.push('autorun="false"');
          if (opts.editable === 'true') attrs.push('editable');
          // The SQL travels as escaped text inside a <pre>; the component reads
          // .textContent (entity-decoded) and replaces it with the live card.
          // Before JS runs, the <pre> renders as a plain code block.
          return `<duck-query ${attrs.join(' ')}>\n<pre class="dq-src"><code>${escapeHtml(text)}</code></pre>\n</duck-query>\n`;
        }
        const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
        return `<pre class="code-block"><code${cls}>${escapeHtml(text)}</code></pre>\n`;
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(inner);
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${depth}>\n`;
      },
      table({ header, rows }) {
        const th = header.map((cell) => `<th${cell.align ? ` style="text-align:${cell.align}"` : ''}>${this.parser.parseInline(cell.tokens)}</th>`).join('');
        const body = rows
          .map((row) => `<tr>${row.map((cell) => `<td${cell.align ? ` style="text-align:${cell.align}"` : ''}>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`)
          .join('\n');
        return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>\n`;
      },
    },
  });
  return marked;
}

async function collectPages() {
  if (!(await fs.pathExists(DIRS.content))) return [];
  const files = (await fs.readdir(DIRS.content)).filter((f) => f.endsWith('.md'));
  const pages = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(DIRS.content, file), 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    const slug = file.replace(/\.md$/, '');
    const state = { queries: 0 };
    const html = createMarkdown(state).parse(body);
    pages.push({
      slug,
      href: `#/docs/${slug}`,
      title: meta.title || (slug === 'index' ? 'Getting started' : slug.replace(/[-_]/g, ' ')),
      description: meta.description || '',
      order: Number(meta.order ?? (slug === 'index' ? 0 : 100)),
      html,
      queries: state.queries,
    });
  }
  // `order:` front matter first (index.md defaults to 0), then title.
  pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return pages;
}

// ---------------------------------------------------------------------------
// Vendor assets — copied from node_modules so the bundle works offline
// ---------------------------------------------------------------------------
const VENDOR = [
  { from: '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js', to: 'vendor/duckdb/duckdb-browser-eh.worker.js' },
  { from: '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', to: 'vendor/duckdb/duckdb-eh.wasm' },
  // Multi-threaded bundle: picked automatically when the page is served cross-origin isolated.
  { from: '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js', to: 'vendor/duckdb/duckdb-browser-coi.worker.js' },
  { from: '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js', to: 'vendor/duckdb/duckdb-browser-coi.pthread.worker.js' },
  { from: '@duckdb/duckdb-wasm/dist/duckdb-coi.wasm', to: 'vendor/duckdb/duckdb-coi.wasm' },
  { from: 'chart.js/dist/chart.umd.js', to: 'vendor/chart.umd.js' },
  { from: 'prismjs/components/prism-core.min.js', to: 'vendor/prism/prism-core.min.js' },
  { from: 'prismjs/components/prism-sql.min.js', to: 'vendor/prism/prism-sql.min.js' },
];

/**
 * duckdb-browser.mjs imports `apache-arrow` as a bare specifier, which browsers
 * can't resolve. Bundle it (plus apache-arrow) into one self-contained ES module
 * via src/vendor-entry.js, which also re-exports the Arrow IPC helpers.
 */
async function bundleDuckDB(outFile) {
  const result = await esbuild.build({
    entryPoints: [path.join(DIRS.src, 'vendor-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    outfile: outFile,
    logLevel: 'silent',
  });
  if (result.errors.length) throw new Error(result.errors.map((e) => e.text).join('\n'));
  return (await fs.stat(outFile)).size;
}

function resolveVendor(spec) {
  // Deep files aren't in the packages' `exports` maps, so resolve them from
  // node_modules directly rather than via require.resolve.
  const file = path.join(ROOT, 'node_modules', spec);
  if (!fs.existsSync(file)) throw new Error(`Vendor file not found: ${spec} (run npm install)`);
  return file;
}

// ---------------------------------------------------------------------------
// DuckDB extensions — vendored so the engine never fetches from extensions.duckdb.org
// ---------------------------------------------------------------------------
const EXTENSIONS = ['parquet', 'json'];
const EXTENSION_PLATFORMS = ['wasm_eh', 'wasm_threads']; // single-threaded default + opt-in threaded engine
const EXTENSION_REPO = 'https://extensions.duckdb.org';

/** Ask the bundled engine which DuckDB version it is (extension paths are versioned). */
async function detectDuckDBVersion() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm'));
  const db = await duckdb.createDuckDB(
    { eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs') } },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  const conn = db.connect();
  const version = String(conn.query('SELECT version() AS v').toArray()[0].v);
  conn.close();
  return version;
}

async function vendorExtensions() {
  const version = await detectDuckDBVersion();
  const cacheRoot = path.join(ROOT, 'node_modules', '.cache', 'duckview', 'duckdb-extensions', version);
  const outRoot = path.join(DIRS.dist, 'vendor', 'duckdb', 'extensions', version);
  const vendored = [];
  const missing = [];
  for (const platform of EXTENSION_PLATFORMS) {
    for (const name of EXTENSIONS) {
      const file = `${name}.duckdb_extension.wasm`;
      const cached = path.join(cacheRoot, platform, file);
      if (!(await fs.pathExists(cached))) {
        const url = `${EXTENSION_REPO}/${version}/${platform}/${file}`;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await fs.outputFile(cached, Buffer.from(await res.arrayBuffer()));
        } catch (err) {
          missing.push({ platform, name, error: err.message });
          continue;
        }
      }
      await fs.copy(cached, path.join(outRoot, platform, file));
      const { size } = await fs.stat(cached);
      vendored.push({ platform, name, size });
    }
  }
  return { version, vendored, missing };
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------
function renderShell({ template, pages, manifest }) {
  // Every doc is embedded; the client router shows one at a time so the engine
  // (and any files the user dropped in) survive navigation.
  const docs = pages
    .map((p) => `<article class="doc" data-doc="${escapeHtml(p.slug)}" data-title="${escapeHtml(p.title)}" hidden>\n${p.html}\n</article>`)
    .join('\n');
  return template
    .replace(/\{\{title\}\}/g, escapeHtml(manifest.title))
    .replace(/\{\{description\}\}/g, escapeHtml(manifest.description))
    .replace('{{docs}}', docs)
    .replace('{{manifest}}', JSON.stringify(manifest).replace(/</g, '\\u003c'))
    .replace(/\{\{version\}\}/g, escapeHtml(pkg.version));
}

// ---------------------------------------------------------------------------
// Tailwind
// ---------------------------------------------------------------------------
function buildTailwind(input, output) {
  // Run the CLI's JS entry through Node rather than the .cmd/.sh shim in
  // node_modules/.bin — Node refuses to spawn .cmd files without a shell on Windows.
  const cliPkg = path.join(ROOT, 'node_modules', '@tailwindcss', 'cli');
  const binField = fs.readJsonSync(path.join(cliPkg, 'package.json')).bin;
  const entry = path.join(cliPkg, typeof binField === 'string' ? binField : binField.tailwindcss);
  execFileSync(process.execPath, [entry, '-i', input, '-o', output, '--minify'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function build() {
  const t0 = Date.now();
  console.log(`\n🦆  ${c.bold('DuckView build')} ${c.dim(`v${pkg.version}`)}`);

  step(1, 'Clean output directory');
  await fs.emptyDir(DIRS.dist);
  item(`emptied ${path.relative(ROOT, DIRS.dist)}/`);

  step(2, 'Copy datasets');
  const datasets = await collectDatasets();
  await fs.ensureDir(path.join(DIRS.dist, 'data'));
  for (const ds of datasets) {
    await fs.copy(path.join(DIRS.data, ds.file), path.join(DIRS.dist, 'data', ds.file));
    item(`${ds.file.padEnd(18)} ${ds.format.padEnd(8)} ${fmtBytes(ds.size).padStart(9)}   → view ${c.green(ds.id)}`);
  }
  if (!datasets.length) item(c.yellow('no datasets found in /data (run `npm run data`)'));

  step(3, 'Bundle vendor runtime (DuckDB-Wasm, Chart.js, Prism)');
  let vendorBytes = 0;
  const duckdbEsm = path.join(DIRS.dist, 'vendor/duckdb/duckdb-browser.mjs');
  const esmSize = await bundleDuckDB(duckdbEsm);
  vendorBytes += esmSize;
  item(`${'vendor/duckdb/duckdb-browser.mjs'.padEnd(46)} ${fmtBytes(esmSize).padStart(9)}   ${c.dim('(bundled with apache-arrow via esbuild)')}`);
  for (const v of VENDOR) {
    const src = resolveVendor(v.from);
    const dest = path.join(DIRS.dist, v.to);
    await fs.copy(src, dest);
    const { size } = await fs.stat(dest);
    vendorBytes += size;
    item(`${v.to.padEnd(46)} ${fmtBytes(size).padStart(9)}`);
  }
  item(c.dim(`total ${fmtBytes(vendorBytes)} — served locally, nothing fetched from a CDN`));
  // COOP/COEP headers for `serve`: enables SharedArrayBuffer → the multi-threaded coi bundle.
  await fs.copy(path.join(DIRS.src, 'serve.json'), path.join(DIRS.dist, 'serve.json'));
  item(`serve.json ${c.dim('(COOP/COEP headers → cross-origin isolation → DuckDB threads)')}`);
  await fs.copy(path.join(DIRS.src, 'coi-sw.js'), path.join(DIRS.dist, 'coi-sw.js'));
  item(`coi-sw.js ${c.dim('(adds the same headers on hosts that cannot send them)')}`);
  const ext = await vendorExtensions();
  for (const v of ext.vendored) item(`extensions/${ext.version}/${v.platform}/${v.name}${' '.repeat(Math.max(1, 20 - v.platform.length - v.name.length))}${fmtBytes(v.size).padStart(9)}`);
  for (const m of ext.missing) item(c.yellow(`extension ${m.platform}/${m.name} NOT vendored (${m.error}) — the engine would fall back to ${EXTENSION_REPO} at runtime`));
  item(c.dim(`DuckDB ${ext.version} · extensions served from ./vendor/duckdb/extensions, cached in node_modules/.cache/duckview`));

  step(4, 'Copy client modules');
  const clientFiles = [];
  await fs.copy(path.join(DIRS.src, 'client.js'), path.join(DIRS.dist, 'assets', 'client.js'));
  clientFiles.push('client.js');
  const clientDir = path.join(DIRS.src, 'client');
  if (await fs.pathExists(clientDir)) {
    await fs.copy(clientDir, path.join(DIRS.dist, 'assets', 'client'));
    for (const f of await fs.readdir(clientDir)) clientFiles.push(`client/${f}`);
  }
  item(`${clientFiles.length} modules → assets/  ${c.dim(clientFiles.join(', '))}`);

  step(5, 'Compile Tailwind CSS');
  const cssOut = path.join(DIRS.dist, 'assets', 'styles.css');
  buildTailwind(path.join(DIRS.src, 'styles.css'), cssOut);
  item(`assets/styles.css ${fmtBytes((await fs.stat(cssOut)).size)} (minified)`);

  step(6, 'Render Markdown docs + page shell');
  const pages = await collectPages();
  const template = await fs.readFile(path.join(DIRS.src, 'template.html'), 'utf8');
  const config = pkg.duckview ?? {};
  const manifest = {
    name: 'DuckView',
    title: config.title || 'DuckView',
    version: pkg.version,
    description: config.description || pkg.description,
    // Samples are listed but only mounted on request unless `autoload` is set.
    autoload: Boolean(config.autoload),
    extensions: { version: ext.version, names: [...new Set(ext.vendored.map((v) => v.name))], platforms: [...new Set(ext.vendored.map((v) => v.platform))] },
    defaultDataset: config.defaultDataset && datasets.some((d) => d.id === config.defaultDataset) ? config.defaultDataset : datasets[0]?.id || null,
    builtAt: new Date().toISOString(),
    datasets: datasets.map(({ id, file, format, size, url, source }) => ({ id, file, format, size, url, source })),
    pages: pages.map(({ slug, href, title, description }) => ({ slug, href, title, description })),
  };
  await fs.writeJson(path.join(DIRS.dist, 'manifest.json'), manifest, { spaces: 2 });
  for (const page of pages) {
    item(`docs/${page.slug.padEnd(16)} "${page.title}"  ${c.dim(`${page.queries} live quer${page.queries === 1 ? 'y' : 'ies'}`)}`);
  }
  if (!pages.length) item(c.yellow('no Markdown pages found in /content'));
  await fs.writeFile(path.join(DIRS.dist, 'index.html'), renderShell({ template, pages, manifest }));
  item(`index.html  ${c.dim('(routes: #/  #/query  #/docs/<page>)')}`);
  item('manifest.json');

  console.log(`\n${c.green('✔')} Built ${pages.length} doc page(s), ${datasets.length} dataset(s) into ${c.bold('dist/')} in ${Date.now() - t0}ms`);
  console.log(`  ${c.dim('Serve it with')} ${c.cyan('npm run dev')} ${c.dim('→ http://localhost:4173')}\n`);
}

build().catch((err) => {
  console.error(`\n${c.red('✖ Build failed:')}\n`, err);
  process.exit(1);
});
