// Backend tests. Run: node tests/run.js
// Loads the Apps Script sources into one vm context (like Apps Script does: all files share one global scope)
// against in-memory mocks of Sheets/Cache/Lock/UrlFetch. Each test builds a fresh world.
// Files are loaded twice, in normal and reverse order, to prove load order does not matter.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { mkSheet, mkWorld } = require('./mock-sheets');

const ROOT = path.join(__dirname, '..');

function backendFiles() {
  const dir = path.join(ROOT, 'backend');
  if (fs.existsSync(dir)) {
    return fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort().map(f => path.join(dir, f));
  }
  throw new Error('backend/ folder not found');
}

// ---------- fixtures ----------
const DAY = 86400000;
const inDays = n => new Date(Date.now() + n * DAY + 6 * 3600000); // mid-day, safely inside the target Bangkok date
const nowSec = () => Math.floor(Date.now() / 1000);

function fixture() {
  const tokens = {
    tokA:     { sub: 'Ua',     name: 'Alice', picture: 'http://pic/a', exp: nowSec() + 3600 },
    tokB:     { sub: 'Ub',     name: 'Bob',   picture: '',             exp: nowSec() + 3600 },
    tokAdmin: { sub: 'Uadmin', name: 'Admin', picture: 'http://pic/x', exp: nowSec() + 3600 },
    tokNew:   { sub: 'Unew',   name: 'Newbie', picture: '',            exp: nowSec() + 3600 }
  };
  const regHeader = ['Timestamp', 'Session_ID', 'User_ID', 'Hours_Joined', 'Is_Walk_in', 'Payment_Status'];
  const full = Array.from({ length: 8 }, (_, i) => [1, 'S1', 'X' + i, '18:00-19:00', false, 'Unpaid']);
  const sheets = {
    Settings: mkSheet([['Key', 'Value', 'Description'],
      ['LINE_CHANNEL_ID', 'chan', ''], ['ADMIN_LINE_IDS', 'Uadmin', ''], ['COST_SPLIT_BASE', 6, ''], ['NOTIFY_CANCEL', 'TRUE', '']]),
    Users: mkSheet([['User_ID', 'DisplayName', 'Skill_Level', 'Profile_Pic', 'Join_Date', 'Line_UID'],
      ['U1', 'Alice', 'C', '', '', 'Ua'], ['U2', 'Bob', 'C', '', '', 'Ub'],
      ['U3', 'Carol', 'C', '', '', ''], ['U4', 'Admin', 'C', '', '', 'Uadmin']]),
    Sessions: mkSheet([['Session_ID', 'Date', 'Type', 'Location', 'Status', 'Cost', 'Calculated_Price_Per_Head', 'Task1', 'Task2', 'Task3', 'Task4', 'Task5'],
      ['S1', inDays(1), 'Workday', 'Court A', 'Open', 200],   // workday tomorrow, 18-19 already full (8)
      ['S2', inDays(1), 'Weekend', 'Court B', 'Open', 240],   // weekend tomorrow -> registration closed (<2 days)
      ['S3', inDays(10), 'Weekend', 'Court B', 'Open', 240],  // weekend in 10 days -> open
      // history (columns: ..., Task1, Task2, Task3, Task4, Task5)
      ['S9',  inDays(-100), 'Workday', 'Old A', 'Open', 200, '', '', true, true, true, true],       // old, checklist done   -> trimmed
      ['S10', inDays(-100), 'Workday', 'Old B', 'Open', 200, '', '', true, '', true, true],        // old, Task3 pending    -> kept
      ['S11', inDays(-100), 'Workday', 'Old C', 'Cancelled', 200, '', '', '', '', '', ''],         // old, cancelled        -> trimmed
      ['S12', inDays(-20), 'Workday', 'Recent', 'Open', 200, '', '', true, true, true, true],  // recent, done          -> kept (inside the 30-day window)
      ['S13', '', 'Workday', 'No date', 'Open', 200]]),                                            // no date               -> trimmed
    Registrations: mkSheet([regHeader, ...full, [1, 'S3', 'U3', 'All', false, 'Unpaid'],
      [1, 'S9', 'U1', 'All', false, 'Paid'], [1, 'S10', 'U1', 'All', false, 'Unpaid'],
      [1, 'S11', 'U2', 'All', false, 'Unpaid'], [1, 'S12', 'U2', 'All', false, 'Paid']])
  };
  return mkWorld({ sheets, tokens });
}

function load(files) {
  const world = fixture();
  const ctx = vm.createContext({ ...world.globals, console: { ...console, warn() {} } });
  files.forEach(f => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }));
  const G = name => vm.runInContext(name, ctx);
  return { world, G, sheets: world.sheets };
}

function expectCode(fn, code) {
  try { fn(); } catch (e) { assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return; }
  assert.fail('expected error ' + code);
}

// ---------- tests ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const regsOf = (sheets, sid) => sheets.Registrations.rows.slice(1).filter(r => r[1] === sid);

test('register: workday hour full -> FULL', ({ G }) => {
  expectCode(() => G('handleRequest')('register', { session_id: 'S1', hours_joined: 'All' }, 'tokA'), 'FULL');
});

test('register: weekend inside close window -> CLOSED', ({ G }) => {
  expectCode(() => G('handleRequest')('register', { session_id: 'S2' }, 'tokA'), 'CLOSED');
});

test('register: open weekend adds once, re-register does not duplicate', ({ G, sheets }) => {
  const h = G('handleRequest');
  h('register', { session_id: 'S3' }, 'tokA');
  h('register', { session_id: 'S3' }, 'tokA');
  assert.strictEqual(regsOf(sheets, 'S3').filter(r => r[2] === 'U1').length, 1);
});

test('cancel: removes the row', ({ G, sheets }) => {
  const h = G('handleRequest');
  h('register', { session_id: 'S3' }, 'tokA');
  const res = h('cancel', { session_id: 'S3' }, 'tokA');
  assert.strictEqual(res.count, 1);
  assert.strictEqual(regsOf(sheets, 'S3').filter(r => r[2] === 'U1').length, 0);
});

test('auth: unknown token -> AUTH_INVALID; missing -> AUTH_REQUIRED', ({ G }) => {
  expectCode(() => G('handleRequest')('me', {}, 'nope'), 'AUTH_INVALID');
  expectCode(() => G('handleRequest')('me', {}, null), 'AUTH_REQUIRED');
});

test('auth: verified token is cached (LINE called once)', ({ G, world }) => {
  const h = G('handleRequest');
  h('me', {}, 'tokA'); h('me', {}, 'tokA');
  assert.strictEqual(world.fetchLog.length, 1);
});

test('admin actions are forbidden for non-admins', ({ G }) => {
  expectCode(() => G('handleRequest')('adminSaveSetting', { key: 'COST_SPLIT_BASE', value: 6 }, 'tokA'), 'FORBIDDEN');
});

test('me: linked user, admin flag, profile picture sync', ({ G, sheets }) => {
  const h = G('handleRequest');
  const a = h('me', {}, 'tokA');
  assert.strictEqual(a.data.user.User_ID, 'U1');
  assert.strictEqual(a.data.user.isAdmin, false);
  assert.strictEqual(sheets.Users.rows[1][3], 'http://pic/a'); // Profile_Pic updated
  assert.strictEqual(h('me', {}, 'tokAdmin').data.user.isAdmin, true);
  assert.strictEqual(h('me', {}, 'tokNew').data.user, null);
});

test('getAllData: hides Line_UID/secrets, flags Linked', ({ G }) => {
  const d = G('handleRequest')('getAllData', {}, null).data;
  assert(d.users.every(u => !('Line_UID' in u)));
  assert.strictEqual(d.users.find(u => u.User_ID === 'U1').Linked, true);
  assert.strictEqual(d.users.find(u => u.User_ID === 'U3').Linked, false);
  assert(!('ADMIN_LINE_IDS' in d.settings));
});

test('getAllData: cached, and invalidated by a write', ({ G, sheets }) => {
  const h = G('handleRequest');
  const before = h('getAllData', {}, null).data.registrations.length;
  sheets.Registrations.appendRow([2, 'S3', 'U9', 'All', false, 'Unpaid']); // direct sheet edit: not visible while cached
  assert.strictEqual(h('getAllData', {}, null).data.registrations.length, before);
  h('register', { session_id: 'S3' }, 'tokA');                              // write through the API clears the cache
  assert.strictEqual(h('getAllData', {}, null).data.registrations.length, before + 2);
});

test('getAllData: sends validated rules and limits (single source for the web page)', ({ G, sheets }) => {
  const h = G('handleRequest');
  sheets.Settings.rows.find(r => r[0] === 'COST_SPLIT_BASE')[1] = 8;
  let d = h('getAllData', {}, null).data;
  assert.strictEqual(d.rules.COST_SPLIT_BASE, 8);
  assert.strictEqual(d.rules.WORKDAY_HOUR_CAP, 8, 'default when the key is absent from the sheet rows');
  assert.deepStrictEqual(Object.keys(d.limits).sort(), Object.keys(G('SETTING_LIMITS')).sort());
  assert.deepStrictEqual(d.rules, G('getRules')(G('SpreadsheetApp').getActiveSpreadsheet()), 'same as what the server uses');
  // an out-of-range value typed straight into the sheet is not forwarded to the page
  G('CacheService').getScriptCache().remove(G('ALL_DATA_CACHE_KEY'));
  sheets.Settings.rows.find(r => r[0] === 'COST_SPLIT_BASE')[1] = 0;
  d = h('getAllData', {}, null).data;
  assert.strictEqual(d.rules.COST_SPLIT_BASE, 6);
});

test('settings: first-time setup takes the lock and re-checks (concurrent requests must not run it twice)', ({ G, world, sheets }) => {
  const h = G('handleRequest');
  // count calls to initialSetup (global function; callers resolve the name at call time)
  G('(function () { globalThis.__origSetup = initialSetup; globalThis.__setupCalls = 0; initialSetup = function () { __setupCalls++; return __origSetup(); }; })')();
  // The cache is cold, so ensureSheetsExist must take the lock. Simulate a concurrent request that
  // finishes the setup while we wait: it fills in the settings and marks setup as done.
  let locks = 0;
  world.hooks.onWaitLock = () => {
    if (locks++) return;
    G('__origSetup')();
    world.cache.set('setup_ok', '1');
  };
  h('getAllData', {}, null);
  assert.strictEqual(locks, 1, 'lock taken while the cache was cold');
  assert.strictEqual(G('globalThis.__setupCalls'), 0, 'setup not repeated: the other request already did it');
  const keys = sheets.Settings.rows.slice(1).map(r => r[0]);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicated keys: ' + keys.join(','));
  h('getAllData', {}, null);
  assert.strictEqual(locks, 1, 'no lock once setup is cached');
});

test('settings: public payload hides secrets and legacy keys', ({ G, sheets }) => {
  sheets.Settings.rows.push(['PRICE_WORKDAY', 200, ''], ['MAX_WORKDAY_INITIAL', 6, ''], ['LINE_POST_TEMPLATE', 'hi {วัน}', '']);
  const s = G('handleRequest')('getAllData', {}, null).data.settings;
  for (const k of ['LINE_CHANNEL_ID', 'ADMIN_LINE_IDS', 'PRICE_WORKDAY', 'MAX_WORKDAY_INITIAL']) assert(!(k in s), k + ' must not be sent');
  assert.strictEqual(s.LINE_POST_TEMPLATE, 'hi {วัน}', 'template is still sent');
  assert.strictEqual(s.COST_SPLIT_BASE, 6);
});

test('settings: admin list has no legacy keys, no secrets, no duplicate rows', ({ G, sheets }) => {
  sheets.Settings.rows.push(['PRICE_HOLIDAY', 120, ''], ['WORKDAY_MIN_PLAYERS', 6, ''], ['WORKDAY_MIN_PLAYERS', 7, '']);
  const keys = G('handleRequest')('adminGetSettings', {}, 'tokAdmin').data.map(r => r.Key);
  assert(!keys.includes('PRICE_HOLIDAY') && !keys.includes('LINE_CHANNEL_ID') && !keys.includes('ADMIN_LINE_IDS'));
  assert.strictEqual(keys.filter(k => k === 'WORKDAY_MIN_PLAYERS').length, 1);
});

test('settings: duplicate keys resolve to the first row everywhere (rules, payload)', ({ G, sheets }) => {
  sheets.Settings.rows.push(['SHUTTLECOCK_PRICE', 70, ''], ['SHUTTLECOCK_PRICE', 99, '']);
  const d = G('handleRequest')('getAllData', {}, null).data;
  assert.strictEqual(d.rules.SHUTTLECOCK_PRICE, 70);
  assert.strictEqual(d.settings.SHUTTLECOCK_PRICE, 70);
  assert.strictEqual(G('getSetting')(G('SpreadsheetApp').getActiveSpreadsheet(), 'SHUTTLECOCK_PRICE'), 70);
});

test('dedupeSettings: keeps the first row, removes repeats, reports conflicting values', ({ G, sheets }) => {
  sheets.Settings.rows.push(['NOTIFY_PLAY_DAY', 'TRUE', ''], ['NOTIFY_PLAY_DAY', 'TRUE', ''],
    ['WORKDAY_MIN_PLAYERS', 6, ''], ['WORKDAY_MIN_PLAYERS', 7, ''], ['', '', 'blank key row stays']);
  const removed = G('dedupeSettings')();
  const keys = sheets.Settings.rows.slice(1).map(r => r[0]).filter(Boolean);
  assert.strictEqual(new Set(keys).size, keys.length);
  assert.strictEqual(removed.length, 2);
  assert.strictEqual(removed.find(r => r.key === 'NOTIFY_PLAY_DAY').differs, false);
  assert.strictEqual(removed.find(r => r.key === 'WORKDAY_MIN_PLAYERS').differs, true);
  assert.strictEqual(sheets.Settings.rows.find(r => r[0] === 'WORKDAY_MIN_PLAYERS')[1], 6, 'first value kept');
  assert(sheets.Settings.rows.some(r => r[2] === 'blank key row stays'));
  assert.strictEqual(G('dedupeSettings')().length, 0, 'second run finds nothing');
});

test('cache: getAllData is cached for 5 minutes; hand edits show after clearDataCache', ({ G, world, sheets }) => {
  const h = G('handleRequest');
  const n = h('getAllData', {}, null).data.registrations.length;
  assert.strictEqual(world.cacheTtl.get(G('ALL_DATA_CACHE_KEY')), 300);
  sheets.Registrations.appendRow([3, 'S3', 'U9', 'All', false, 'Unpaid']);
  assert.strictEqual(h('getAllData', {}, null).data.registrations.length, n, 'still cached');
  G('clearDataCache')();
  assert.strictEqual(h('getAllData', {}, null).data.registrations.length, n + 1);
});

test('cache: the quorum trigger clears it when it cancels a session', ({ G, sheets }) => {
  const h = G('handleRequest');
  assert.strictEqual(h('getAllData', {}, null).data.sessions.find(s => s.Session_ID === 'S2').Status, 'Open');
  G('checkWeekendQuorum')(); // S2 is a weekend session tomorrow with no players -> cancelled
  assert.strictEqual(sheets.Sessions.rows[2][4], 'Cancelled');
  assert.strictEqual(h('getAllData', {}, null).data.sessions.find(s => s.Session_ID === 'S2').Status, 'Cancelled');
});

const sessionIds = d => d.sessions.map(s => s.Session_ID).sort().join(',');

test('getAllData: sends upcoming, recent and checklist-pending sessions only', ({ G }) => {
  const d = G('handleRequest')('getAllData', {}, null).data;
  assert.strictEqual(sessionIds(d), 'S1,S10,S12,S2,S3');
  const regSessions = [...new Set(d.registrations.map(r => r.Session_ID))].sort().join(',');
  assert.strictEqual(regSessions, 'S1,S10,S12,S3', 'registrations of trimmed sessions are not sent');
  assert.strictEqual(d.users.length, 4, 'all users are still sent (names, profile picker)');
});

test('getAllData: a pending old session drops out once its checklist is complete', ({ G }) => {
  const h = G('handleRequest');
  assert(sessionIds(h('getAllData', {}, null).data).includes('S10'));
  h('updateTask', { session_id: 'S10', tasks: { Task3: true } }, 'tokAdmin');
  assert(!sessionIds(h('getAllData', {}, null).data).includes('S10'));
});

test('adminGetHistory: admins get every session and registration, others are refused', ({ G, sheets }) => {
  const h = G('handleRequest');
  const d = h('adminGetHistory', {}, 'tokAdmin').data;
  assert.strictEqual(sessionIds(d), 'S1,S10,S11,S12,S13,S2,S3,S9');
  assert.strictEqual(d.registrations.length, sheets.Registrations.rows.length - 1);
  expectCode(() => h('adminGetHistory', {}, 'tokA'), 'FORBIDDEN');
  expectCode(() => h('adminGetHistory', {}, null), 'AUTH_REQUIRED');
});

test('adminGetHistory: not cached (sees sheet edits at once) and larger than the trimmed payload', ({ G, sheets }) => {
  const h = G('handleRequest');
  const trimmed = h('getAllData', {}, null).data;
  const before = h('adminGetHistory', {}, 'tokAdmin').data;
  sheets.Registrations.appendRow([4, 'S9', 'U3', 'All', false, 'Unpaid']); // direct edit, no API write -> getAllData cache untouched
  const after = h('adminGetHistory', {}, 'tokAdmin').data;
  assert.strictEqual(after.registrations.length, before.registrations.length + 1);
  assert(before.sessions.length > trimmed.sessions.length);
  assert(before.registrations.length > trimmed.registrations.length);
});

test('adminUpdateRegistrations: delta keeps other people, no duplicates', ({ G, sheets }) => {
  const h = G('handleRequest');
  h('register', { session_id: 'S3' }, 'tokB'); // someone registers meanwhile
  h('adminUpdateRegistrations', {
    session_id: 'S3',
    remove: ['U3'],
    add: [{ User_ID: 'NEW_1', DisplayName: 'Guest', Hours_Joined: 'All' }, { User_ID: 'U2', Hours_Joined: 'All' }],
    update: []
  }, 'tokAdmin');
  const s3 = regsOf(sheets, 'S3');
  assert(!s3.some(r => r[2] === 'U3'), 'U3 removed');
  assert.strictEqual(s3.filter(r => r[2] === 'U2').length, 1, 'U2 not duplicated');
  assert.strictEqual(s3.length, 2, 'U2 + guest only');
  assert.strictEqual(regsOf(sheets, 'S1').length, 8, 'other sessions untouched');
  assert.strictEqual(sheets.Users.rows.length, 6, 'guest user created');
});

test('adminUpdateRegistrations: updates hours + sets session status in one call', ({ G, sheets }) => {
  G('handleRequest')('adminUpdateRegistrations', {
    session_id: 'S1', update: [{ User_ID: 'X0', Hours_Joined: '19:00-20:00' }], session_status: 'Cancelled'
  }, 'tokAdmin');
  assert.strictEqual(regsOf(sheets, 'S1').find(r => r[2] === 'X0')[3], '19:00-20:00');
  assert.strictEqual(sheets.Sessions.rows[1][4], 'Cancelled');
});

test('adminUpdateRegistrations: legacy full-list payload still replaces the session', ({ G, sheets }) => {
  G('handleRequest')('adminUpdateRegistrations', {
    session_id: 'S3', registrations: [{ User_ID: 'U1', Hours_Joined: 'All' }]
  }, 'tokAdmin');
  assert.deepStrictEqual(regsOf(sheets, 'S3').map(r => r[2]), ['U1']);
});

test('adminSaveSetting: rejects out-of-range values, accepts valid', ({ G, sheets }) => {
  const h = G('handleRequest');
  for (const bad of [0, -1, 'abc', '', 7.5, 999]) {
    expectCode(() => h('adminSaveSetting', { key: 'COST_SPLIT_BASE', value: bad }, 'tokAdmin'), 'BAD_INPUT');
  }
  expectCode(() => h('adminSaveSetting', { key: 'NOTIFY_CANCEL', value: 'maybe' }, 'tokAdmin'), 'BAD_INPUT');
  h('adminSaveSetting', { key: 'COST_SPLIT_BASE', value: '8' }, 'tokAdmin');
  assert.strictEqual(sheets.Settings.rows.find(r => r[0] === 'COST_SPLIT_BASE')[1], 8);
});

test('getRules: out-of-range sheet value falls back to default (no divide-by-zero)', ({ G, sheets }) => {
  sheets.Settings.rows.find(r => r[0] === 'COST_SPLIT_BASE')[1] = 0;
  const ss = G('SpreadsheetApp').getActiveSpreadsheet();
  assert.strictEqual(G('getRules')(ss).COST_SPLIT_BASE, 6);
});

test('deleteRowsWhere: removes matching rows in one pass', ({ G, sheets }) => {
  const n = G('deleteRowsWhere')(sheets.Registrations, 1, 'S1');
  assert.strictEqual(n, 8);
  assert(sheets.Registrations.rows.slice(1).every(r => r[1] !== 'S1'));
  assert.strictEqual(regsOf(sheets, 'S3').length, 1);
});

test('notifications: sent markers older than 7 days are pruned', ({ G, world }) => {
  world.props.set('post_S1_old', String(Date.now() - 8 * DAY));
  world.props.set('post_S1_new', String(Date.now()));
  world.props.set('book_S9_legacy', '1'); // legacy marker without a timestamp
  world.props.set('LINE_MESSAGING_TOKEN', 'keep');
  G('pruneSentMarkers')();
  assert(!world.props.has('post_S1_old') && !world.props.has('book_S9_legacy'));
  assert(world.props.has('post_S1_new') && world.props.has('LINE_MESSAGING_TOKEN'));
});

// ---------- runner ----------
let failed = 0;
const orders = [['normal', f => f], ['reversed', f => f.slice().reverse()]];
for (const [label, order] of orders) {
  const files = order(backendFiles());
  if (label === 'reversed' && files.length < 2) continue; // load order only matters with several files
  console.log(`\n# load order: ${label} (${files.map(f => path.basename(f)).join(', ')})`);
  for (const t of tests) {
    try { t.fn(load(files)); console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
  }
}
console.log(failed ? `\n${failed} test(s) failed` : '\nALL OK');
process.exit(failed ? 1 : 0);
