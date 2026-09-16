#!/usr/bin/env node
/**
 * Duckview — sample dataset generator.
 *
 * Produces deterministic sample data in /data, one file per supported format:
 *   sales.csv        CSV       ~6k rows   orders with dates, regions, products
 *   regions.tsv      TSV       small      region lookup table (join target)
 *   orders.parquet   Parquet   ~25k rows  wider order-line fact table
 *   events.ndjson    NDJSON    ~10k rows  event log with nested `props` struct
 *   products.json    JSON      small      product catalogue as a JSON array
 *   sensors.arrow    Arrow IPC ~8k rows   IoT sensor readings (file format)
 *
 * Parquet is written by DuckDB itself (the Node build of DuckDB-Wasm), Arrow by
 * apache-arrow's IPC writer — the same libraries the browser bundle uses.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'fs-extra';

const require = createRequire(import.meta.url);
// Must be the CJS build: DuckDB's Node bundle `require`s apache-arrow, and the
// IPC writer only recognises Tables from the same module instance.
const { tableToIPC } = require('apache-arrow');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------------------
// Tiny deterministic PRNG (mulberry32) so every build produces the same files.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240916);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max) => min + rand() * (max - min);
const int = (min, max) => Math.floor(between(min, max + 1));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
/** Weighted choice: entries are [value, weight]. */
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) {
    if ((r -= w) <= 0) return v;
  }
  return entries[entries.length - 1][0];
}
const isoDate = (d) => d.toISOString().slice(0, 10);
const isoStamp = (d) => d.toISOString().replace('T', ' ').replace('Z', '');
function randomDate(start, end) {
  return new Date(start.getTime() + rand() * (end.getTime() - start.getTime()));
}

// ---------------------------------------------------------------------------
// Reference data shared across datasets
// ---------------------------------------------------------------------------
const REGIONS = [
  { code: 'NA', region_name: 'North America', hq_country: 'United States', timezone: 'America/New_York', target_revenue: 2_400_000 },
  { code: 'EU', region_name: 'Europe', hq_country: 'Germany', timezone: 'Europe/Berlin', target_revenue: 1_900_000 },
  { code: 'APAC', region_name: 'Asia Pacific', hq_country: 'Singapore', timezone: 'Asia/Singapore', target_revenue: 1_500_000 },
  { code: 'LATAM', region_name: 'Latin America', hq_country: 'Brazil', timezone: 'America/Sao_Paulo', target_revenue: 700_000 },
  { code: 'MEA', region_name: 'Middle East & Africa', hq_country: 'United Arab Emirates', timezone: 'Asia/Dubai', target_revenue: 500_000 },
];
const COUNTRIES = {
  NA: ['United States', 'Canada', 'Mexico'],
  EU: ['Germany', 'France', 'United Kingdom', 'Netherlands', 'Spain'],
  APAC: ['Japan', 'Australia', 'Singapore', 'India'],
  LATAM: ['Brazil', 'Argentina', 'Chile'],
  MEA: ['United Arab Emirates', 'South Africa', 'Kenya'],
};
const PRODUCTS = [
  { sku: 'QL-100', name: 'Quill Notebook A5', category: 'Stationery', unit_price: 12.5, cost: 4.1, weight_kg: 0.32, launched: '2021-03-01' },
  { sku: 'QL-101', name: 'Quill Notebook A4', category: 'Stationery', unit_price: 16.0, cost: 5.3, weight_kg: 0.51, launched: '2021-03-01' },
  { sku: 'QL-110', name: 'Fountain Pen Classic', category: 'Writing', unit_price: 48.0, cost: 15.2, weight_kg: 0.05, launched: '2020-09-15' },
  { sku: 'QL-111', name: 'Fountain Pen Brass', category: 'Writing', unit_price: 79.0, cost: 24.8, weight_kg: 0.07, launched: '2022-05-20' },
  { sku: 'QL-112', name: 'Gel Pen 5-pack', category: 'Writing', unit_price: 9.9, cost: 2.4, weight_kg: 0.06, launched: '2020-01-10' },
  { sku: 'QL-120', name: 'Ink Cartridge Midnight', category: 'Ink', unit_price: 6.5, cost: 1.1, weight_kg: 0.02, launched: '2020-09-15' },
  { sku: 'QL-121', name: 'Ink Bottle Sepia 50ml', category: 'Ink', unit_price: 18.0, cost: 4.9, weight_kg: 0.14, launched: '2021-11-02' },
  { sku: 'QL-130', name: 'Desk Mat Linen', category: 'Desk', unit_price: 34.0, cost: 11.0, weight_kg: 0.8, launched: '2022-02-14' },
  { sku: 'QL-131', name: 'Pen Stand Walnut', category: 'Desk', unit_price: 29.0, cost: 9.5, weight_kg: 0.42, launched: '2022-02-14' },
  { sku: 'QL-132', name: 'Monitor Riser Oak', category: 'Desk', unit_price: 64.0, cost: 22.0, weight_kg: 2.1, launched: '2023-04-03' },
  { sku: 'QL-140', name: 'Leather Journal Cover', category: 'Accessories', unit_price: 42.0, cost: 13.7, weight_kg: 0.25, launched: '2021-07-19' },
  { sku: 'QL-141', name: 'Pen Case Canvas', category: 'Accessories', unit_price: 22.0, cost: 6.8, weight_kg: 0.12, launched: '2021-07-19' },
  { sku: 'QL-150', name: 'Planner 2024', category: 'Stationery', unit_price: 24.0, cost: 7.2, weight_kg: 0.45, launched: '2023-10-01' },
  { sku: 'QL-151', name: 'Sticky Notes Pastel', category: 'Stationery', unit_price: 5.5, cost: 1.3, weight_kg: 0.09, launched: '2020-01-10' },
  { sku: 'QL-160', name: 'Calligraphy Starter Kit', category: 'Writing', unit_price: 58.0, cost: 19.0, weight_kg: 0.6, launched: '2023-01-25' },
];
const SEGMENTS = [['Consumer', 5], ['Small Business', 3], ['Enterprise', 1]];
const CHANNELS = [['Online', 6], ['Retail', 3], ['Wholesale', 1]];
const REPS = ['A. Okafor', 'B. Lindqvist', 'C. Nakamura', 'D. Rossi', 'E. Haddad', 'F. Moreau', 'G. Patel', 'H. Silva'];
const PAYMENT = [['card', 7], ['paypal', 2], ['invoice', 1]];

// ---------------------------------------------------------------------------
// CSV / TSV helpers
// ---------------------------------------------------------------------------
function csvCell(v, delim) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(delim) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}
function toDelimited(rows, delim = ',') {
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(delim)];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c], delim)).join(delim));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 1. sales.csv — ~6,000 orders across 2023–2024
// ---------------------------------------------------------------------------
function buildSales(n = 6000) {
  const start = new Date('2023-01-01T00:00:00Z');
  const end = new Date('2024-12-31T00:00:00Z');
  const rows = [];
  for (let i = 0; i < n; i++) {
    const region = pick(REGIONS);
    const product = pick(PRODUCTS);
    const qty = weighted([[1, 5], [2, 3], [3, 2], [5, 1], [10, 0.4]]);
    const discount = weighted([[0, 6], [0.05, 2], [0.1, 1.5], [0.2, 0.5]]);
    const d = randomDate(start, end);
    // Seasonal bump towards Q4 so the monthly chart has a visible shape.
    const seasonal = 1 + (d.getUTCMonth() >= 9 ? 0.35 : 0) + (d.getUTCMonth() === 0 ? -0.15 : 0);
    const revenue = round(product.unit_price * qty * (1 - discount) * seasonal);
    rows.push({
      order_id: `SO-${100000 + i}`,
      order_date: isoDate(d),
      region: region.code,
      country: pick(COUNTRIES[region.code]),
      product: product.name,
      category: product.category,
      quantity: qty,
      unit_price: product.unit_price,
      discount,
      revenue,
      customer_segment: weighted(SEGMENTS),
      channel: weighted(CHANNELS),
      sales_rep: pick(REPS),
      returned: rand() < 0.04,
    });
  }
  rows.sort((a, b) => (a.order_date < b.order_date ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------
// 2. orders.parquet — ~25,000 order lines (wider, more numeric columns)
// ---------------------------------------------------------------------------
function buildOrders(n = 25000) {
  const start = new Date('2022-01-01T00:00:00Z');
  const end = new Date('2024-12-31T00:00:00Z');
  const rows = [];
  for (let i = 0; i < n; i++) {
    const region = pick(REGIONS);
    const product = pick(PRODUCTS);
    const qty = weighted([[1, 5], [2, 3], [4, 2], [6, 1], [12, 0.5], [24, 0.2]]);
    const placed = randomDate(start, end);
    const shipDays = weighted([[1, 4], [2, 5], [3, 3], [5, 1.5], [8, 0.6], [14, 0.2]]);
    const shipped = new Date(placed.getTime() + shipDays * 86400000 + int(0, 86399) * 1000);
    const discount = weighted([[0, 7], [0.05, 2], [0.15, 1], [0.3, 0.3]]);
    const gross = product.unit_price * qty;
    const net = round(gross * (1 - discount));
    const shipping = round(weighted([[0, 3], [4.99, 4], [9.99, 2], [24.0, 0.5]]));
    rows.push({
      order_line_id: i + 1,
      order_id: `PO-${200000 + Math.floor(i / weighted([[1, 5], [2, 3], [3, 1]]))}`,
      placed_at: isoStamp(placed),
      shipped_at: rand() < 0.03 ? null : isoStamp(shipped),
      region_code: region.code,
      country: pick(COUNTRIES[region.code]),
      sku: product.sku,
      category: product.category,
      quantity: qty,
      unit_price: product.unit_price,
      unit_cost: product.cost,
      discount_pct: discount,
      net_amount: net,
      margin: round(net - product.cost * qty),
      shipping_fee: shipping,
      weight_kg: round(product.weight_kg * qty, 3),
      payment_method: weighted(PAYMENT),
      customer_id: 1000 + int(0, 2400),
      is_gift: rand() < 0.07,
    });
  }
  rows.sort((a, b) => (a.placed_at < b.placed_at ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------
// 3. events.ndjson — ~10,000 product analytics events with a nested struct
// ---------------------------------------------------------------------------
function buildEvents(n = 10000) {
  const start = new Date('2024-06-01T00:00:00Z');
  const end = new Date('2024-08-31T23:59:59Z');
  const types = [['page_view', 10], ['search', 4], ['add_to_cart', 2.5], ['checkout', 1], ['purchase', 0.7], ['signup', 0.5], ['error', 0.3]];
  const pages = ['/', '/products', '/products/fountain-pens', '/products/notebooks', '/cart', '/checkout', '/account', '/blog/ink-guide'];
  const devices = [['desktop', 5], ['mobile', 4], ['tablet', 1]];
  const plans = [['free', 6], ['pro', 3], ['team', 1]];
  const referrers = [['direct', 4], ['google', 3], ['newsletter', 1.5], ['instagram', 1], ['reddit', 0.5]];
  const browsers = [['Chrome', 6], ['Safari', 3], ['Firefox', 1.2], ['Edge', 0.8]];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ts = randomDate(start, end);
    const type = weighted(types);
    const region = pick(REGIONS);
    rows.push({
      event_id: `evt_${(i + 1).toString(36).padStart(6, '0')}`,
      ts: ts.toISOString(),
      user_id: `u_${int(1, 1800)}`,
      session_id: `s_${int(1, 5200)}`,
      event_type: type,
      page: pick(pages),
      device: weighted(devices),
      browser: weighted(browsers),
      country: pick(COUNTRIES[region.code]),
      duration_ms: type === 'page_view' ? int(200, 45000) : int(50, 8000),
      status_code: type === 'error' ? weighted([[500, 3], [404, 2], [429, 1]]) : 200,
      props: {
        plan: weighted(plans),
        referrer: weighted(referrers),
        ab_variant: rand() < 0.5 ? 'A' : 'B',
        cart_value: type === 'add_to_cart' || type === 'checkout' || type === 'purchase' ? round(between(5, 240)) : null,
      },
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------
// 4. sensors.arrow — ~8,000 IoT readings from 12 devices, 5-minute cadence
// ---------------------------------------------------------------------------
function buildSensors() {
  const devices = Array.from({ length: 12 }, (_, i) => ({
    id: `sensor-${String(i + 1).padStart(2, '0')}`,
    site: ['warehouse-a', 'warehouse-b', 'office', 'lab'][i % 4],
    baseTemp: between(17, 24),
    baseHum: between(35, 60),
  }));
  const start = Date.UTC(2024, 8, 1, 0, 0, 0);
  const steps = 8000 / devices.length;
  const rows = [];
  for (let s = 0; s < steps; s++) {
    const t = start + s * 5 * 60 * 1000;
    const hour = (s * 5) / 60;
    const diurnal = Math.sin(((hour % 24) / 24) * Math.PI * 2 - Math.PI / 2);
    for (const d of devices) {
      const spike = rand() < 0.004 ? between(6, 14) : 0;
      rows.push({
        reading_ts: new Date(t),
        device_id: d.id,
        site: d.site,
        temperature_c: round(d.baseTemp + diurnal * 2.5 + between(-0.4, 0.4) + spike, 2),
        humidity_pct: round(d.baseHum - diurnal * 4 + between(-1.5, 1.5), 1),
        battery_v: round(3.7 - (s / steps) * 0.6 * (d.id.endsWith('7') ? 2 : 1) + between(-0.02, 0.02), 3),
        status: spike ? 'alert' : rand() < 0.01 ? 'offline' : 'ok',
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DuckDB (Node build of DuckDB-Wasm) — used to write Parquet + Arrow
// ---------------------------------------------------------------------------
async function openDuckDB() {
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const DIST = path.dirname(require.resolve('@duckdb/duckdb-wasm'));
  const bundles = {
    mvp: { mainModule: path.join(DIST, 'duckdb-mvp.wasm'), mainWorker: path.join(DIST, 'duckdb-node-mvp.worker.cjs') },
    eh: { mainModule: path.join(DIST, 'duckdb-eh.wasm'), mainWorker: path.join(DIST, 'duckdb-node-eh.worker.cjs') },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  return db;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const log = (msg) => console.log(`  ${msg}`);
const sizeOf = (p) => `${(fs.statSync(p).size / 1024).toFixed(1)} KB`;

async function main() {
  console.log('\n🦆  Duckview — generating sample datasets\n');
  await fs.ensureDir(DATA_DIR);

  // --- CSV
  const sales = buildSales();
  const salesPath = path.join(DATA_DIR, 'sales.csv');
  await fs.writeFile(salesPath, toDelimited(sales, ','));
  log(`sales.csv        ${sales.length.toLocaleString()} rows   ${sizeOf(salesPath)}`);

  // --- TSV
  const regionsPath = path.join(DATA_DIR, 'regions.tsv');
  await fs.writeFile(regionsPath, toDelimited(REGIONS, '\t'));
  log(`regions.tsv      ${REGIONS.length} rows      ${sizeOf(regionsPath)}`);

  // --- JSON (array)
  const productsPath = path.join(DATA_DIR, 'products.json');
  await fs.writeFile(productsPath, JSON.stringify(PRODUCTS, null, 2) + '\n');
  log(`products.json    ${PRODUCTS.length} rows     ${sizeOf(productsPath)}`);

  // --- NDJSON
  const events = buildEvents();
  const eventsPath = path.join(DATA_DIR, 'events.ndjson');
  await fs.writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  log(`events.ndjson    ${events.length.toLocaleString()} rows  ${sizeOf(eventsPath)}`);

  // --- Parquet (via DuckDB)
  // The Node runtime maps DuckDB's filesystem onto the real disk: COPY TO writes
  // a `tmp_<name>` file and its final rename is unreliable in wasm, so write into
  // a private temp dir and move the result into ./data ourselves.
  const db = await openDuckDB();
  const conn = db.connect();
  const orders = buildOrders();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckview-'));
  const tmpParquet = path.join(tmpDir, 'orders.parquet');
  const ordersPath = path.join(DATA_DIR, 'orders.parquet');
  db.registerFileText('orders_tmp.csv', toDelimited(orders, ','));
  conn.query(`
    COPY (
      SELECT
        order_line_id::INTEGER   AS order_line_id,
        order_id,
        placed_at::TIMESTAMP     AS placed_at,
        shipped_at::TIMESTAMP    AS shipped_at,
        region_code, country, sku, category,
        quantity::INTEGER        AS quantity,
        unit_price::DOUBLE       AS unit_price,
        unit_cost::DOUBLE        AS unit_cost,
        discount_pct::DOUBLE     AS discount_pct,
        net_amount::DOUBLE       AS net_amount,
        margin::DOUBLE           AS margin,
        shipping_fee::DOUBLE     AS shipping_fee,
        weight_kg::DOUBLE        AS weight_kg,
        payment_method,
        customer_id::INTEGER     AS customer_id,
        is_gift::BOOLEAN         AS is_gift
      FROM read_csv_auto('orders_tmp.csv', header=true, nullstr='')
    ) TO '${tmpParquet.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)
  `);
  const written = (await fs.pathExists(tmpParquet)) ? tmpParquet : path.join(tmpDir, 'tmp_orders.parquet');
  await fs.move(written, ordersPath, { overwrite: true });
  await fs.remove(tmpDir);
  const verify = conn.query(`SELECT COUNT(*)::INTEGER AS n FROM read_parquet('${ordersPath.replace(/'/g, "''")}')`).toArray()[0].n;
  log(`orders.parquet   ${Number(verify).toLocaleString()} rows  ${sizeOf(ordersPath)}   (zstd, verified by DuckDB)`);

  // --- Arrow IPC file (via DuckDB -> apache-arrow)
  const sensors = buildSensors();
  db.registerFileText(
    'sensors_tmp.csv',
    toDelimited(sensors.map((r) => ({ ...r, reading_ts: isoStamp(r.reading_ts) })), ','),
  );
  const sensorTable = conn.query(`
    SELECT
      reading_ts::TIMESTAMP AS reading_ts,
      device_id, site,
      temperature_c::DOUBLE AS temperature_c,
      humidity_pct::DOUBLE  AS humidity_pct,
      battery_v::DOUBLE     AS battery_v,
      status
    FROM read_csv_auto('sensors_tmp.csv', header=true)
    ORDER BY reading_ts, device_id
  `);
  const arrowBytes = tableToIPC(sensorTable, 'file');
  const sensorsPath = path.join(DATA_DIR, 'sensors.arrow');
  await fs.writeFile(sensorsPath, arrowBytes);
  log(`sensors.arrow    ${sensorTable.numRows.toLocaleString()} rows   ${sizeOf(sensorsPath)}   (IPC file format)`);

  conn.close();
  console.log('\n✔ Done. Files written to ./data\n');
}

main().catch((err) => {
  console.error('\n✖ Data generation failed:\n', err);
  process.exit(1);
});
