/*
 * Duckview cross-origin-isolation service worker.
 *
 * DuckDB-Wasm can only use multiple threads when the page is cross-origin
 * isolated, which needs two response headers the static host may not send
 * (GitHub Pages, S3 …). This worker adds them to every same-origin response.
 * Registered by client.js only when the page is NOT already isolated and the
 * user hasn't chosen the single-threaded engine in Settings.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0 || response.type === 'opaque') return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
