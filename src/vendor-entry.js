/**
 * Vendor bundle entry — compiled by esbuild into dist/vendor/duckdb/duckdb-browser.mjs.
 *
 * DuckDB-Wasm imports `apache-arrow` as a bare specifier, so it has to be
 * bundled for the browser anyway. Re-exporting the two IPC helpers from the
 * *same* Arrow copy lets the client read Arrow IPC files (footer-aware) and
 * hand DuckDB a stream it understands, without shipping a second Arrow.
 */
export * as duckdb from '@duckdb/duckdb-wasm/dist/duckdb-browser.mjs';
export { tableFromIPC, tableToIPC, Table } from 'apache-arrow';
