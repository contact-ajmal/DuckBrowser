/**
 * DuckBrowser desktop shell (Electron).
 *
 * Serves the built site from `dist/` over a private `duckbrowser://` scheme so
 * ES modules, Web Workers and wasm behave exactly as on a web server:
 *   - correct MIME types (application/wasm, text/javascript …)
 *   - HTTP Range requests, which DuckDB uses to read Parquet samples by byte range
 *   - COOP/COEP headers, so the page is cross-origin isolated and the opt-in
 *     multi-threaded engine is available
 * The renderer runs sandboxed with no Node access; nothing else is needed —
 * the app talks to the file system only through the browser's File API.
 */
import { app, BrowserWindow, protocol, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCHEME = 'duckbrowser';
const HOST = 'app';
const DIST = path.join(app.getAppPath(), 'dist');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.ndjson': 'application/x-ndjson',
  '.jsonl': 'application/x-ndjson',
  '.parquet': 'application/vnd.apache.parquet',
  '.arrow': 'application/vnd.apache.arrow.file',
  '.feather': 'application/vnd.apache.arrow.file',
  '.sql': 'application/sql; charset=utf-8',
  '.woff2': 'font/woff2',
};

// Must run before app.ready: makes the scheme behave like https (secure
// context, origin for localStorage, fetch/XHR/Worker support).
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false } },
]);

const baseHeaders = (extra = {}) => ({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'no-cache',
  ...extra,
});

/** Resolve a request URL to a file inside dist/, or null if it escapes it. */
function resolveFile(requestUrl) {
  const url = new URL(requestUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '' || pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(DIST, pathname));
  return file.startsWith(DIST + path.sep) ? file : null;
}

async function serve(request) {
  const file = resolveFile(request.url);
  if (!file) return new Response('Forbidden', { status: 403 });
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const size = stat.size;

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: baseHeaders({ 'Content-Type': type, 'Content-Length': String(size) }) });
  }

  // Byte ranges: DuckDB reads Parquet footers/column chunks this way.
  const range = request.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    let end = m[1] === '' ? size - 1 : m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: baseHeaders({ 'Content-Range': `bytes */${size}` }) });
    }
    const handle = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(end - start + 1);
      await handle.read(buf, 0, buf.length, start);
      return new Response(buf, {
        status: 206,
        headers: baseHeaders({ 'Content-Type': type, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` }),
      });
    } finally {
      await handle.close();
    }
  }

  const body = await fs.readFile(file);
  return new Response(body, { status: 200, headers: baseHeaders({ 'Content-Type': type, 'Content-Length': String(size) }) });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'DuckBrowser',
    backgroundColor: '#09090b',
    show: false,
    icon: process.platform === 'linux' ? path.join(__dirname, '..', 'build', 'icon.png') : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Links to the outside world open in the system browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(`${SCHEME}://${HOST}/index.html`);
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'DuckBrowser on GitHub', click: () => shell.openExternal('https://github.com/contact-ajmal/DuckBrowser') },
        { label: 'DuckDB documentation', click: () => shell.openExternal('https://duckdb.org/docs/') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
