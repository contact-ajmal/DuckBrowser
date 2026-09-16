/**
 * Formatting + type helpers shared by the whole client.
 * Pure functions only — no DOM, no DuckDB.
 */

export const fmtInt = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString());

export function fmtNumber(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(bytes);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Compact form for KPI cards: 1.2K, 3.4M … */
export function fmtCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------
// DuckDB type helpers (operate on DESCRIBE / SUMMARIZE `column_type` strings)
// ---------------------------------------------------------------------------
const NUMERIC_RE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;
const TEMPORAL_RE = /^(DATE|TIMESTAMP)/i;
const TEXT_RE = /^(VARCHAR|TEXT|STRING|CHAR|JSON|UUID|ENUM)/i;
const NESTED_RE = /^(STRUCT|MAP|LIST|UNION)|\[\]$/i;

export const isNumericType = (t) => NUMERIC_RE.test(t);
export const isTemporalType = (t) => TEMPORAL_RE.test(t);
export const isTextType = (t) => TEXT_RE.test(t);
export const isBoolType = (t) => /^BOOL/i.test(t);
export const isNestedType = (t) => NESTED_RE.test(t);

/** Approximate in-memory width (bytes) of a DuckDB column value. */
export function typeWidth(t) {
  const u = String(t).toUpperCase();
  if (/^(BOOLEAN|TINYINT|UTINYINT)/.test(u)) return 1;
  if (/^(SMALLINT|USMALLINT)/.test(u)) return 2;
  if (/^(INTEGER|UINTEGER|FLOAT|REAL|DATE)/.test(u)) return 4;
  if (/^(BIGINT|UBIGINT|DOUBLE|TIME|TIMESTAMP|INTERVAL)/.test(u)) return 8;
  if (/^(HUGEINT|UHUGEINT|UUID)/.test(u)) return 16;
  if (u.startsWith('DECIMAL')) {
    const p = Number(u.match(/\((\d+)/)?.[1] ?? 18);
    return p <= 4 ? 2 : p <= 9 ? 4 : p <= 18 ? 8 : 16;
  }
  if (isTextType(u)) return 16; // string_t header; average payload added separately
  if (isNestedType(u)) return 32;
  return 8;
}

/** Quote a SQL identifier for DuckDB. */
export const qid = (name) => `"${String(name).replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------
// Arrow → display
// ---------------------------------------------------------------------------

/** Map Arrow DataType.toString() to a familiar SQL-ish label. */
export function arrowTypeLabel(type) {
  const s = String(type);
  const m = {
    Utf8: 'VARCHAR',
    LargeUtf8: 'VARCHAR',
    Bool: 'BOOLEAN',
    Int8: 'TINYINT',
    Int16: 'SMALLINT',
    Int32: 'INTEGER',
    Int64: 'BIGINT',
    Uint8: 'UTINYINT',
    Uint16: 'USMALLINT',
    Uint32: 'UINTEGER',
    Uint64: 'UBIGINT',
    Float32: 'FLOAT',
    Float64: 'DOUBLE',
    Binary: 'BLOB',
    Null: 'NULL',
  };
  if (m[s]) return m[s];
  // DuckDB-Wasm (castTimestampToDate) delivers TIMESTAMP as Date64<MILLISECOND>; DATE is Date32<DAY>.
  if (s.startsWith('Date32')) return 'DATE';
  if (s.startsWith('Date64') || s.startsWith('Timestamp')) return 'TIMESTAMP';
  if (s.startsWith('Time')) return 'TIME';
  if (s.startsWith('Decimal')) return 'DECIMAL';
  if (s.startsWith('Struct')) return 'STRUCT';
  if (s.startsWith('List') || s.startsWith('LargeList')) return 'LIST';
  if (s.startsWith('Map')) return 'MAP';
  if (s.startsWith('Dictionary')) return 'VARCHAR';
  if (s.startsWith('Interval') || s.startsWith('Duration')) return 'INTERVAL';
  return s.toUpperCase();
}

/** Classify an Arrow field for cell rendering. */
export function arrowKind(field) {
  const s = String(field.type);
  if (/^(Int|Uint|Float|Decimal)/.test(s)) return 'num';
  if (s === 'Bool') return 'bool';
  if (/^(Date|Timestamp)/.test(s)) return 'date';
  if (/^Time/.test(s)) return 'time';
  if (/^(Struct|List|LargeList|Map|FixedSizeList)/.test(s)) return 'json';
  return 'str';
}

const pad2 = (n) => String(n).padStart(2, '0');
function isoUTC(d, withTime) {
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (!withTime) return date;
  const ms = d.getUTCMilliseconds();
  return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${ms ? '.' + String(ms).padStart(3, '0') : ''}`;
}

/** Convert an Arrow temporal value (Date | number | bigint) to a Date. */
export function toDate(value, typeString) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const s = String(typeString || '');
  let ms;
  if (typeof value === 'bigint') {
    if (/MICROSECOND/.test(s)) ms = Number(value / 1000n);
    else if (/NANOSECOND/.test(s)) ms = Number(value / 1000000n);
    else if (/SECOND>/.test(s) && !/MILLISECOND/.test(s)) ms = Number(value) * 1000;
    else ms = Number(value);
  } else {
    ms = Number(value);
    if (/MICROSECOND/.test(s)) ms /= 1000;
    else if (/NANOSECOND/.test(s)) ms /= 1e6;
  }
  return new Date(ms);
}

function jsonReplacer(_k, v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return v;
}

/**
 * Format one Arrow cell value as text for tables / chart labels.
 * Returns { text, kind } where kind ∈ num|bool|date|time|json|str|null.
 */
export function formatCell(value, field) {
  if (value === null || value === undefined) return { text: 'NULL', kind: 'null' };
  const kind = field ? arrowKind(field) : typeof value === 'number' || typeof value === 'bigint' ? 'num' : 'str';
  const typeStr = field ? String(field.type) : '';
  switch (kind) {
    case 'num': {
      if (typeof value === 'bigint') return { text: value.toLocaleString(), kind };
      if (ArrayBuffer.isView(value)) return { text: String(value), kind }; // raw decimal words (castDecimalToDouble off)
      return { text: fmtNumber(value, 4), kind };
    }
    case 'bool':
      return { text: value ? 'true' : 'false', kind };
    case 'date': {
      const d = toDate(value, typeStr);
      if (!d || Number.isNaN(d.getTime())) return { text: String(value), kind };
      const dateOnly = typeStr.startsWith('Date32'); // Date64 carries a time component (it's a cast TIMESTAMP)
      return { text: isoUTC(d, !dateOnly), kind };
    }
    case 'time':
      return { text: String(value), kind };
    case 'json': {
      const plain = typeof value?.toJSON === 'function' ? value.toJSON() : typeof value?.toArray === 'function' ? value.toArray() : value;
      return { text: JSON.stringify(plain, jsonReplacer), kind };
    }
    default:
      return { text: String(value), kind: 'str' };
  }
}

/** Plain JS value for charts/CSV (numbers stay numbers). */
export function plainValue(value, field) {
  if (value == null) return null;
  const kind = field ? arrowKind(field) : 'str';
  if (kind === 'num') return typeof value === 'bigint' ? Number(value) : Number(value);
  if (kind === 'date') return formatCell(value, field).text;
  if (kind === 'json') return formatCell(value, field).text;
  if (kind === 'bool') return Boolean(value);
  return String(value);
}

export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Tagged template that HTML-escapes interpolations. Arrays are joined raw (already-safe fragments). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    const v = values[i - 1];
    const safe = v == null ? '' : Array.isArray(v) ? v.join('') : v?.__raw ? v.__raw : escapeHtml(v);
    return out + safe + s;
  });
}
export const raw = (s) => ({ __raw: String(s) });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
