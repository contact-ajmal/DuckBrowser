/**
 * Hardware profiler + auto-tuning plan.
 *
 * Detects what the browser is willing to tell us about the machine and turns it
 * into concrete DuckDB settings plus a memory ceiling used for feasibility
 * alerts. Everything here is a heuristic — browsers deliberately fuzz these
 * numbers — so the output is conservative.
 */

const GB = 1024 ** 3;

/** Hard ceiling of a wasm32 linear memory. DuckDB-Wasm cannot address more. */
export const WASM_HEAP_LIMIT = 4 * GB;

export function detectHardware() {
  const cores = Number(navigator.hardwareConcurrency) || 4;
  // navigator.deviceMemory is Chromium-only and bucketed (0.25 … 8). Others → assume 4 GB.
  const reportedMemory = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
  const deviceMemoryGB = reportedMemory ?? 4;

  // Leave room for the page, the OS and the wasm heap's own overhead.
  //   ≥8 GB device  → 3 GB ceiling (75% of the wasm limit)
  //    4 GB device  → 2 GB
  //    2 GB device  → 1 GB
  const memoryLimit = Math.max(0.5 * GB, Math.min(0.75 * WASM_HEAP_LIMIT, deviceMemoryGB * 0.5 * GB));

  const crossOriginIsolated = Boolean(globalThis.crossOriginIsolated);
  const ua = navigator.userAgentData?.platform || navigator.platform || 'unknown';

  return {
    cores,
    deviceMemoryGB,
    deviceMemoryReported: reportedMemory !== null,
    memoryLimit, // bytes — the *current* limit (Settings may change it at runtime)
    memoryLimitAuto: memoryLimit, // bytes — what detection chose; never mutated
    crossOriginIsolated,
    platform: ua,
    threadsRequested: cores,
  };
}

/** The absolute ceiling of a 32-bit wasm heap. Above MEMORY_LIMIT_SAFE_MB the heap may fail to grow. */
export const MEMORY_LIMIT_MAX_MB = 4096;
export const MEMORY_LIMIT_SAFE_MB = 3584;
export const MEMORY_LIMIT_MIN_MB = 256;

/**
 * DuckDB statements to apply for a given profile. Order matters.
 * `overrides` come from the Settings page; null/undefined fields mean "auto".
 */
export function tuningStatements(hw, overrides = {}) {
  const limitMB = clampMB(overrides.memoryLimitMB ?? Math.round(hw.memoryLimit / MB));
  const threads = overrides.threads ?? hw.threadsRequested;
  const preserve = overrides.preserveInsertionOrder ?? false;
  const cache = overrides.objectCache ?? true;
  return [
    { key: 'memoryLimitMB', sql: memoryLimitSql(limitMB), label: `memory_limit = ${fmtMB(limitMB)}`, required: true },
    { key: 'threads', sql: `PRAGMA threads = ${threads}`, label: `threads = ${threads}`, required: false },
    { key: 'preserveInsertionOrder', sql: `SET preserve_insertion_order = ${preserve}`, label: `preserve_insertion_order = ${preserve}`, required: false },
    { key: 'objectCache', sql: `SET enable_object_cache = ${cache}`, label: `enable_object_cache = ${cache}`, required: false },
    { key: 'progressBar', sql: `SET enable_progress_bar = false`, label: 'enable_progress_bar = false', required: false },
  ];
}

const MB = 1024 ** 2;
export const clampMB = (mb) => Math.min(MEMORY_LIMIT_MAX_MB, Math.max(MEMORY_LIMIT_MIN_MB, Math.round(Number(mb) || 0)));
export const memoryLimitSql = (mb) => `SET memory_limit = '${clampMB(mb)}MB'`;
export const fmtMB = (mb) => (mb >= 1024 ? `${String(Math.round((mb / 1024) * 100) / 100)} GB` : `${Math.round(mb)} MB`);

/** Preset memory limits derived from the detected hardware (in MB). */
export function memoryPresets(hw) {
  const deviceMB = hw.deviceMemoryGB * 1024;
  return [
    { id: 'conservative', label: 'Conservative', mb: clampMB(Math.min(1024, deviceMB * 0.25)), hint: 'Small datasets, keep RAM for other tabs' },
    { id: 'auto', label: 'Auto', mb: clampMB(hw.memoryLimitAuto / MB), hint: 'Detected default: half of device memory, capped for wasm' },
    { id: 'max', label: 'Maximum', mb: MEMORY_LIMIT_SAFE_MB, hint: 'As much as a 32-bit wasm heap can safely hold' },
  ];
}

/**
 * Dataset feasibility rating.
 * @param {object} args
 * @param {number} args.estimatedBytes  in-memory estimate (rows × row width)
 * @param {number} args.diskBytes       file size on disk
 * @param {string} args.format
 * @param {number} args.memoryLimit     DuckDB memory ceiling in bytes
 */
export function assessFeasibility({ estimatedBytes, diskBytes, format, memoryLimit, warnPct = 25, dangerPct = 60 }) {
  const ratio = estimatedBytes / memoryLimit;
  const pct = Math.round(ratio * 100);
  const columnar = format === 'parquet' || format === 'arrow';
  if (ratio < warnPct / 100) {
    return {
      level: 'green',
      label: 'Safe',
      summary: `Fits comfortably — ≈${pct}% of the ${fmtGB(memoryLimit)} memory ceiling.`,
      advice: null,
    };
  }
  if (ratio < dangerPct / 100) {
    return {
      level: 'yellow',
      label: 'High RAM footprint',
      summary: `Estimated working set is ≈${pct}% of the ${fmtGB(memoryLimit)} ceiling.`,
      advice: columnar
        ? 'Column-pruned queries (SELECT a, b …) stay fast; avoid SELECT * and wide ORDER BYs.'
        : 'Consider converting to Parquet — DuckDB can then read only the columns each query needs.',
    };
  }
  return {
    level: 'red',
    label: 'Exceeds headroom',
    summary: `Estimated working set (${fmtGB(estimatedBytes)}) is beyond the ${fmtGB(memoryLimit)} ceiling.`,
    advice:
      'Aggregations and filters will still stream, but wide SELECT *, SUMMARIZE and ORDER BY may fail. Use LIMIT, USING SAMPLE, or split the file.' +
      (diskBytes && !columnar ? ' Parquet would cut the footprint several-fold.' : ''),
  };
}

export function fmtGB(bytes) {
  const gb = bytes / GB;
  if (gb >= 1) return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
