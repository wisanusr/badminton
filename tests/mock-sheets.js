// Minimal in-memory mocks of the Apps Script services used by the backend.
// Only what the code under test actually calls is implemented.
const crypto = require('crypto');

function mkSheet(rows) {
  return {
    rows,
    getDataRange() { return { getValues: () => this.rows.map(r => r.slice()) }; },
    getLastRow() { return this.rows.length; },
    getLastColumn() { return Math.max(...this.rows.map(r => r.length)); },
    getRange(r, c, nr = 1, nc = 1) {
      const s = this;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            out.push([]);
            for (let j = 0; j < nc; j++) out[i].push((s.rows[r - 1 + i] || [])[c - 1 + j] ?? '');
          }
          return out;
        },
        setValues(v) {
          for (let i = 0; i < v.length; i++) {
            s.rows[r - 1 + i] = s.rows[r - 1 + i] || [];
            for (let j = 0; j < v[i].length; j++) s.rows[r - 1 + i][c - 1 + j] = v[i][j];
          }
          return this;
        },
        setValue(v) { s.rows[r - 1] = s.rows[r - 1] || []; s.rows[r - 1][c - 1] = v; return this; },
        clearContent() {
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) s.rows[r - 1 + i][c - 1 + j] = '';
          return this;
        },
        setFontWeight() { return this; },
        setBackground() { return this; }
      };
    },
    appendRow(r) { this.rows.push(r); },
    deleteRow(i) { this.rows.splice(i - 1, 1); },
    deleteRows(i, n) { this.rows.splice(i - 1, n); }
  };
}

// Format a Date in a time zone for the few patterns the backend uses.
function formatDate(d, tz, pattern) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(d).map(x => [x.type, x.value]));
  const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  switch (pattern) {
    case 'yyyy-MM-dd': return `${p.year}-${p.month}-${p.day}`;
    case 'yyyyMMdd': return `${p.year}${p.month}${p.day}`;
    case 'yyyy': return p.year;
    case 'M': return String(+p.month);
    case 'd': return String(+p.day);
    case 'u': return String(iso);
    default: throw new Error('formatDate pattern not mocked: ' + pattern);
  }
}

// Build a fresh world: sheets + services. `tokens` maps id_token -> LINE verify response body.
function mkWorld({ sheets, tokens = {} }) {
  const cache = new Map();
  const cacheTtl = new Map();
  const hooks = { onWaitLock: null }; // tests can simulate another request finishing while we wait for the lock
  const props = new Map();
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet([[]])) };
  const fetchLog = [];
  return {
    sheets, cache, cacheTtl, props, fetchLog, hooks,
    globals: {
      console,
      SpreadsheetApp: { getActiveSpreadsheet: () => ss },
      CacheService: { getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v, ttl) => { cache.set(k, v); cacheTtl.set(k, ttl); },
        remove: k => { cache.delete(k); }
      }) },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, v); },
        deleteProperty: k => { props.delete(k); },
        getProperties: () => Object.fromEntries(props)
      }) },
      LockService: { getScriptLock: () => ({
        tryLock: () => true,
        waitLock() { if (hooks.onWaitLock) hooks.onWaitLock(); },
        releaseLock() {}
      }) },
      ContentService: {
        MimeType: { JSON: 'json' },
        createTextOutput: s => ({ text: s, setMimeType() { return this; } })
      },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' },
        computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(s).digest()),
        base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
        formatDate,
        parseDate: (s) => new Date(s + 'T00:00:00+07:00')
      },
      UrlFetchApp: {
        fetch: (url, opts) => {
          fetchLog.push(url);
          const body = tokens[opts.payload.id_token];
          return body
            ? { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) }
            : { getResponseCode: () => 400, getContentText: () => JSON.stringify({ error_description: 'invalid' }) };
        }
      },
      Logger: { log() {} },
      ScriptApp: {}
    }
  };
}

module.exports = { mkSheet, mkWorld, formatDate };
