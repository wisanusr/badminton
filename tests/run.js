// Backend tests. Run: node tests/run.js
// Loads the Apps Script sources into one vm context (like Apps Script does: all files share one global scope)
// against in-memory mocks of Sheets/Cache/Lock/UrlFetch. Each test builds a fresh world.
// Files are loaded twice, in normal and reverse order, to prove load order does not matter.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { mkSheet, mkWorld, formatDate } = require('./mock-sheets');

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
// noon (Bangkok) of the Bangkok date n days from now; a fixed +6h offset drifts onto the next date when the suite runs after 18:00 Bangkok
const inDays = n => new Date(formatDate(new Date(Date.now() + n * DAY), 'Asia/Bangkok', 'yyyy-MM-dd') + 'T12:00:00+07:00');
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
  const ctx = vm.createContext({ ...world.globals, console: { ...console, warn() {}, log() {} } });
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

test('auth: token cache lives as long as the token (not capped at 10 min), never past 6 h', ({ G, world }) => {
  G('handleRequest')('me', {}, 'tokA'); // exp = now + 3600
  const ttls = [...world.cacheTtl.entries()].filter(([k]) => k.startsWith('tok_')).map(([, v]) => v);
  assert.strictEqual(ttls.length, 1);
  assert.ok(ttls[0] > 3400 && ttls[0] <= 3570, 'ttl follows exp: ' + ttls[0]);
});

test('setup: a warm cache skips the per-request sheet lookups', ({ G, world }) => {
  world.cache.set('setup_ok', '1');
  const ss = G('SpreadsheetApp').getActiveSpreadsheet();
  const orig = ss.getSheetByName;
  let lookups = 0;
  ss.getSheetByName = n => { lookups++; return orig(n); };
  G('ensureSheetsExist')(ss);
  assert.strictEqual(lookups, 0);
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

test('updateTask: admin saves Free_Plays with Extra_Shuttles, other columns are refused', ({ G, sheets }) => {
  const h = G('handleRequest');
  h('updateTask', { session_id: 'S10', tasks: { Extra_Shuttles: 2, Free_Plays: 1 } }, 'tokAdmin');
  const hdr = sheets.Sessions.rows[0];
  const row = sheets.Sessions.rows.find(r => r[0] === 'S10');
  assert.strictEqual(row[hdr.indexOf('Free_Plays')], 1);
  assert.strictEqual(row[hdr.indexOf('Extra_Shuttles')], 2);
  expectCode(() => h('updateTask', { session_id: 'S10', tasks: { Cost: 0 } }, 'tokAdmin'), 'BAD_INPUT');
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

test('adminSaveSession: type is derived from the date (Sat/Sun = Weekend)', ({ G, sheets }) => {
  const h = G('handleRequest');
  const add = date => {
    h('adminSaveSession', { date, location: 'X', status: 'Open', cost: 200 }, 'tokAdmin');
    return sheets.Sessions.rows[sheets.Sessions.rows.length - 1][2];
  };
  assert.strictEqual(add('2030-01-05'), 'Weekend'); // Saturday
  assert.strictEqual(add('2030-01-06'), 'Weekend'); // Sunday
  assert.strictEqual(add('2030-01-07'), 'Workday'); // Monday
  assert.strictEqual(add('2030-01-11'), 'Workday'); // Friday
});

test('adminMergeUsers: keeps the old id, takes the LINE link + registrations, skips duplicate sessions', ({ G, sheets }) => {
  const h = G('handleRequest');
  sheets.Registrations.appendRow([1, 'S3', 'U1', 'All', false, 'Unpaid']); // U1 also in S3 where U3 already is
  const regCount = (u) => sheets.Registrations.rows.slice(1).filter(r => r[2] === u).length;
  expectCode(() => h('adminMergeUsers', { keep_id: 'U2', merge_id: 'U1' }, 'tokAdmin'), 'BAD_INPUT'); // both linked
  expectCode(() => h('adminMergeUsers', { keep_id: 'U3', merge_id: 'U3' }, 'tokAdmin'), 'BAD_INPUT');
  expectCode(() => h('adminMergeUsers', { keep_id: 'U3', merge_id: 'nope' }, 'tokAdmin'), 'NOT_FOUND');
  expectCode(() => h('adminMergeUsers', { keep_id: 'U3', merge_id: 'U1' }, 'tokA'), 'FORBIDDEN');
  const before = regCount('U1') + regCount('U3');
  h('adminMergeUsers', { keep_id: 'U3', merge_id: 'U1' }, 'tokAdmin');
  const users = sheets.Users.rows;
  const lineCol = users[0].indexOf('Line_UID');
  assert(!users.some(r => r[0] === 'U1'), 'merged account is gone');
  assert.strictEqual(users.find(r => r[0] === 'U3')[lineCol], 'Ua', 'old profile now carries the LINE link');
  assert.strictEqual(regCount('U1'), 0);
  assert.strictEqual(regCount('U3'), before - 1, 'S3 duplicate dropped, others moved');
  assert.strictEqual(sheets.Registrations.rows.slice(1).filter(r => r[1] === 'S3' && r[2] === 'U3').length, 1);
});

// ---------- LINE notification cards ----------
function capturePushes(world, failFlex) {
  const sent = [];
  const verify = world.verifyFetch || (world.verifyFetch = world.globals.UrlFetchApp.fetch); // id-token verification still goes through the original mock
  world.globals.UrlFetchApp.fetch = (url, opts) => {
    if (typeof opts.payload !== 'string') return verify(url, opts);
    const body = JSON.parse(opts.payload);
    sent.push(body);
    return { getResponseCode: () => sent.status || (failFlex && body.messages[0].type === 'flex' ? 400 : 200), getContentText: () => '{}' };
  };
  world.props.set('LINE_MESSAGING_TOKEN', 't');
  return sent;
}
const cardTexts = card => JSON.stringify(card.contents);

test('notify: cancelling a seat sends the admins a card (text fallback when LINE rejects cards)', ({ G, world }) => {
  const sent = capturePushes(world);
  const h = G('handleRequest');
  h('register', { session_id: 'S3' }, 'tokA');
  h('cancel', { session_id: 'S3' }, 'tokA');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].to, ['Uadmin']);
  const card = sent[0].messages[0];
  assert.strictEqual(card.type, 'flex');
  assert(cardTexts(card).includes('มีคนยกเลิกคิว') && cardTexts(card).includes('Alice'));
  assert(/^❌Alice • ยกเลิกคิวตีแบด • /.test(card.altText), 'chat-list preview: who cancelled and which day');

  const w2 = capturePushes(world, true);
  h('register', { session_id: 'S3' }, 'tokA');
  h('cancel', { session_id: 'S3' }, 'tokA');
  assert.deepStrictEqual(w2.map(b => b.messages[0].type), ['flex', 'text']);
  assert(w2[1].messages[0].text.includes('Alice'));
});

test('notify: book-court notice to admins is a card with the player count and names', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  sheets.Settings.rows.push(['BOOK_NOTICE_DAYS', 1, '']);
  sheets.Registrations.appendRow([1, 'S2', 'U1', 'All', false, 'Unpaid']);
  G('bookCourtNotify')();
  assert.strictEqual(sent.length, 1);
  const txt = cardTexts(sent[0].messages[0]);
  assert(txt.includes('แจ้งจองคอร์ด') && txt.includes('Alice') && txt.includes('ยังไม่ถึงขั้นต่ำ'));
  assert(/^📣น้องแทนค่ะ! วัน(เสาร์|อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์)นี้ตีแบดไหม มีคนลงชื่อ 1 คน$/.test(sent[0].messages[0].altText), 'chat-list preview of the book-court notice');
  G('bookCourtNotify')();
  assert.strictEqual(sent.length, 1, 'only once per day');
});

test('notify: weekend short of players cancels, players get a card, admins get a card listing who to tell', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  ['U1', 'U2', 'U3'].forEach(u => sheets.Registrations.appendRow([1, 'S2', u, 'All', false, 'Unpaid'])); // 3 < 6, Carol has no LINE
  G('checkWeekendQuorum')();
  assert.strictEqual(sheets.Sessions.rows[2][4], 'Cancelled');
  const toPlayers = sent.find(b => b.to.includes('Ua'));
  assert.deepStrictEqual(toPlayers.to.sort(), ['Ua', 'Ub']);
  assert(cardTexts(toPlayers.messages[0]).includes('งดตีรอบวันหยุด'));
  assert(/^😢ยกเลิกรอบตีแบด • .+ • Court B$/.test(toPlayers.messages[0].altText), 'players preview: day and venue');
  const toAdmin = sent.find(b => b.to.includes('Uadmin'));
  const txt = cardTexts(toAdmin.messages[0]);
  assert(txt.includes('งดรอบอัตโนมัติ') && txt.includes('Carol'), 'admin is told who to notify by hand');
  assert(/^📣ยกเลิกรอบตีแบด • .+ • Court B$/.test(toAdmin.messages[0].altText), 'admin preview: day and venue');
});

test('notify: weekend with enough players tells the admins in plain text that the round goes ahead', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  for (let i = 0; i < 6; i++) sheets.Registrations.appendRow([1, 'S2', 'X' + i, 'All', false, 'Unpaid']);
  G('checkWeekendQuorum')();
  assert.strictEqual(sheets.Sessions.rows[2][4], 'Open');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].messages[0].type, 'text', 'plain text, not a card');
  assert(sent[0].messages[0].text.includes('ได้ไปต่อ'));
});

const CARD = 'https://lin.ee/real-card';
// initialSetup may already have added the (empty) keys; getSetting reads the first row of a key, so update in place
const setSheetSetting = (sheets, key, value) => {
  const row = sheets.Settings.rows.find(r => r[0] === key);
  if (row) row[1] = value; else sheets.Settings.rows.push([key, value, '']);
};
const setCard = (sheets, url, expires) => { setSheetSetting(sheets, 'POINT_CARD_URL', url); setSheetSetting(sheets, 'POINT_CARD_EXPIRES', expires || ''); };
const dayStr = n => formatDate(new Date(Date.now() + n * DAY), 'Asia/Bangkok', 'yyyy-MM-dd');

test('settings: card link must be https or empty, expiry a real date; admin sees them, the public payload does not', ({ G, sheets }) => {
  const h = G('handleRequest');
  expectCode(() => h('adminSaveSetting', { key: 'POINT_CARD_URL', value: 'http://insecure' }, 'tokAdmin'), 'BAD_INPUT');
  expectCode(() => h('adminSaveSetting', { key: 'POINT_CARD_URL', value: 'javascript:alert(1)' }, 'tokAdmin'), 'BAD_INPUT');
  expectCode(() => h('adminSaveSetting', { key: 'POINT_CARD_EXPIRES', value: '31/12/2026' }, 'tokAdmin'), 'BAD_INPUT');
  expectCode(() => h('adminSaveSetting', { key: 'POINT_CARD_EXPIRES', value: '2026-02-31' }, 'tokAdmin'), 'BAD_INPUT');
  expectCode(() => h('adminSaveSetting', { key: 'POINT_CARD_URL', value: CARD }, 'tokA'), 'FORBIDDEN');
  h('adminSaveSetting', { key: 'POINT_CARD_URL', value: ' ' + CARD + ' ' }, 'tokAdmin'); // key not in the sheet yet: created
  h('adminSaveSetting', { key: 'POINT_CARD_EXPIRES', value: '2026-12-31' }, 'tokAdmin');
  const rows = h('adminGetSettings', {}, 'tokAdmin').data;
  assert.strictEqual(rows.find(r => r.Key === 'POINT_CARD_URL').Value, CARD);
  assert.strictEqual(rows.find(r => r.Key === 'POINT_CARD_EXPIRES').Value, '2026-12-31');
  const pub = h('getAllData', {}, null).data;
  assert(!JSON.stringify(pub).includes('real-card') && !('POINT_CARD_URL' in pub.settings) && !('POINT_CARD_EXPIRES' in pub.settings));
  h('adminSaveSetting', { key: 'POINT_CARD_EXPIRES', value: '' }, 'tokAdmin');
  assert.strictEqual(h('adminGetSettings', {}, 'tokAdmin').data.find(r => r.Key === 'POINT_CARD_EXPIRES').Value, '');
});

test('pointReminderNotify: needs the card link; sessions played yesterday only; linked players once; retried until LINE accepts', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  sent.status = 500;
  sheets.Sessions.rows.push(['T1', inDays(-1), 'Workday', 'A', 'Open', 200]);       // played yesterday -> card this morning
  sheets.Sessions.rows.push(['T3', inDays(0), 'Workday', 'C', 'Open', 200]);        // today -> card goes out tomorrow
  sheets.Sessions.rows.push(['T4', inDays(-1), 'Workday', 'D', 'Cancelled', 200]);  // cancelled
  ['T1', 'T3', 'T4'].forEach(sid => ['U1', 'U3', 'U2'].forEach(u => sheets.Registrations.appendRow([1, sid, u, 'All', false, 'Unpaid'])));

  G('pointReminderNotify')();
  assert.strictEqual(sent.length, 0, 'no card link set -> nothing sent');

  setCard(sheets, CARD);
  G('_settingsMap = null');   // a real execution re-reads Settings
  G('pointReminderNotify')();
  assert.strictEqual(sent.length, 1, 'one multicast for T1 only');
  assert.deepStrictEqual(sent[0].to.sort(), ['Ua', 'Ub'], 'U3 has no LINE id');
  const card = sent[0].messages[0];
  assert.strictEqual(card.type, 'flex');
  const gate = G('LIFF_URL') + '?claim=T1';
  assert.strictEqual(card.contents.footer.contents[0].action.uri, gate, 'button goes through the app, not straight to the card link');
  assert.strictEqual(card.altText, '🏸รับแต้มตีแบดด้วยจ้า', 'chat-list preview of the point card');
  assert(!JSON.stringify(sent).includes('real-card'), 'the real card link is never put in a LINE message');
  sent.status = 200;
  G('pointReminderNotify')();   // first send failed -> retried
  assert.strictEqual(sent.length, 2);
  G('pointReminderNotify')();   // now marked -> not sent again
  assert.strictEqual(sent.length, 2);
});

test('dailyAdminNotify: the play-day post goes out as one plain message, the post text alone, once per day', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  sheets.Sessions.rows.push(['T1', inDays(0), 'Workday', 'A', 'Open', 200]);
  sheets.Registrations.appendRow([1, 'T1', 'U1', 'All', false, 'Unpaid']);
  G('dailyAdminNotify')();
  const posts = sent.filter(b => b.messages[0].type === 'text');
  assert.strictEqual(posts.length, 1);
  assert.deepStrictEqual(posts[0].to, ['Uadmin']);
  assert.strictEqual(posts[0].messages.length, 1, 'no header message before the post');
  G('dailyAdminNotify')();
  assert.strictEqual(sent.filter(b => b.messages[0].type === 'text').length, 1, 'once per day');
});

test('pointReminderNotify: falls back to plain text when LINE rejects the card (400)', ({ G, world, sheets }) => {
  const sent = capturePushes(world, true);
  setCard(sheets, CARD);
  sheets.Sessions.rows.push(['T1', inDays(-1), 'Workday', 'A', 'Open', 200]);
  sheets.Registrations.appendRow([1, 'T1', 'U1', 'All', false, 'Unpaid']);
  G('pointReminderNotify')();
  assert.deepStrictEqual(sent.map(b => b.messages[0].type), ['flex', 'text']);
  assert(sent[1].messages[0].text.includes(G('LIFF_URL') + '?claim=T1'));
  assert(!sent[1].messages[0].text.includes('lin.ee'));
  G('pointReminderNotify')();
  assert.strictEqual(sent.length, 2, 'fallback counted as sent');
});

test('pointReminderNotify: sent on the expiry day (last valid day), not after', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  setCard(sheets, CARD, dayStr(0));
  sheets.Sessions.rows.push(['T1', inDays(-1), 'Workday', 'A', 'Open', 200]);
  sheets.Registrations.appendRow([1, 'T1', 'U1', 'All', false, 'Unpaid']);
  G('pointReminderNotify')();
  assert.strictEqual(sent.length, 1);

  [...world.props.keys()].filter(k => k.startsWith('point_')).forEach(k => world.props.delete(k));
  sheets.Settings.rows.find(r => r[0] === 'POINT_CARD_EXPIRES')[1] = dayStr(-1);   // expired yesterday
  G('_settingsMap = null');   // a real execution re-reads Settings
  G('pointReminderNotify')();
  assert.strictEqual(sent.length, 1, 'expired -> nothing more is sent');
});

test('claimPoint: card link only for registered players, on the day the card arrives, before the link expires', ({ G, world, sheets }) => {
  const h = G('handleRequest');
  setCard(sheets, CARD, dayStr(5));
  const hoursAgo = n => String(Date.now() - n * 3600000);
  const sentKey = (sid, offset) => `point_${sid}_${dayStr(offset).replace(/-/g, '')}`;
  const add = (sid, offset, status) => sheets.Sessions.rows.push([sid, inDays(offset), 'Workday', 'A', status, 200]);
  add('C1', -1, 'Open');       // played yesterday, card sent this morning, Alice registered
  add('C2', -1, 'Open');       // card sent, Alice NOT registered
  add('C3', -2, 'Open');       // card arrived yesterday morning -> its day is over
  add('C4', -1, 'Cancelled');  // cancelled
  add('C5', -3, 'Open');       // long gone
  add('C6', -1, 'Open');       // registered but the card was never sent
  ['C1', 'C3', 'C4', 'C5', 'C6'].forEach(sid => sheets.Registrations.appendRow([1, sid, 'U1', 'All', false, 'Unpaid']));
  world.props.set(sentKey('C1', -1), hoursAgo(1));
  world.props.set(sentKey('C2', -1), hoursAgo(1));
  world.props.set(sentKey('C3', -2), hoursAgo(20));
  world.props.set(sentKey('C4', -1), hoursAgo(1));
  world.props.set(sentKey('C5', -3), hoursAgo(50));

  assert.strictEqual(h('claimPoint', { session_id: 'C1' }, 'tokA').data.url, CARD);
  expectCode(() => h('claimPoint', { session_id: 'C3' }, 'tokA'), 'CLAIM_EXPIRED');
  expectCode(() => h('claimPoint', { session_id: 'C2' }, 'tokA'), 'NOT_REGISTERED');
  expectCode(() => h('claimPoint', { session_id: 'C4' }, 'tokA'), 'CANCELLED');
  expectCode(() => h('claimPoint', { session_id: 'C5' }, 'tokA'), 'CLAIM_EXPIRED');
  expectCode(() => h('claimPoint', { session_id: 'C6' }, 'tokA'), 'NOT_SENT');
  expectCode(() => h('claimPoint', { session_id: 'nope' }, 'tokA'), 'NOT_FOUND');
  expectCode(() => h('claimPoint', { session_id: 'C1' }, 'tokNew'), 'NO_PROFILE');
  expectCode(() => h('claimPoint', { session_id: 'C1' }, null), 'AUTH_REQUIRED');
  ['C2', 'C3', 'C5', 'C6'].forEach(sid => assert.strictEqual(h('claimPoint', { session_id: sid }, 'tokAdmin').data.url, CARD, 'admins can open the link to test'));
});

test('claimPoint: claiming opens when pointReminderNotify really sent the card', ({ G, world, sheets }) => {
  capturePushes(world);
  setCard(sheets, CARD);
  sheets.Sessions.rows.push(['T1', inDays(-1), 'Workday', 'A', 'Open', 200]);
  sheets.Registrations.appendRow([1, 'T1', 'U1', 'All', false, 'Unpaid']);
  expectCode(() => G('handleRequest')('claimPoint', { session_id: 'T1' }, 'tokA'), 'NOT_SENT');
  G('pointReminderNotify')();
  assert.strictEqual(G('handleRequest')('claimPoint', { session_id: 'T1' }, 'tokA').data.url, CARD);
});

test('claimPoint: refused after the link expired (players), and when no link is set', ({ G, world, sheets }) => {
  const h = G('handleRequest');
  sheets.Sessions.rows.push(['C1', inDays(-1), 'Workday', 'A', 'Open', 200]);
  sheets.Registrations.appendRow([1, 'C1', 'U1', 'All', false, 'Unpaid']);
  world.props.set(`point_C1_${dayStr(-1).replace(/-/g, '')}`, String(Date.now() - 3600000));
  expectCode(() => h('claimPoint', { session_id: 'C1' }, 'tokA'), 'NO_LINK');
  setCard(sheets, CARD, dayStr(-1));
  G('_settingsMap = null');
  expectCode(() => h('claimPoint', { session_id: 'C1' }, 'tokA'), 'EXPIRED');
  assert.strictEqual(h('claimPoint', { session_id: 'C1' }, 'tokAdmin').data.url, CARD, 'admin can still test');
});

test('pointExpiryNotify: tells admins on the expiry day, then again only on days a card was due, once per day', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  const exp = () => sheets.Settings.rows.find(r => r[0] === 'POINT_CARD_EXPIRES');
  const rerun = () => { G('_settingsMap = null'); G('pointExpiryNotify')(); };
  const clearMarkers = () => [...world.props.keys()].filter(k => k.startsWith('pexp_')).forEach(k => world.props.delete(k));
  const text = i => JSON.stringify(sent[i].messages[0]);

  setCard(sheets, CARD, dayStr(1));                      // expires tomorrow -> nothing yet
  rerun();
  assert.strictEqual(sent.length, 0);

  exp()[1] = dayStr(0);                                  // expires today
  rerun();
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].to, ['Uadmin']);
  assert(text(0).includes('หมดอายุวันนี้'));
  assert.strictEqual(sent[0].messages[0].altText, '⚠️แจ้งพี่นิวส์! อัพเดทลิงก์รับแต้ม Line OA ด้วยคะ', 'chat-list preview of the expiry notice');
  rerun();
  assert.strictEqual(sent.length, 1, 'once per day');

  clearMarkers(); exp()[1] = dayStr(-2);                 // expired, no session yesterday -> quiet
  sheets.Sessions.rows.push(['T0', inDays(0), 'Workday', 'A', 'Open', 200]);   // playing today: its card is tomorrow's business
  rerun();
  assert.strictEqual(sent.length, 1);

  sheets.Sessions.rows.push(['T1', inDays(-1), 'Workday', 'A', 'Open', 200]);  // expired and yesterday's players miss their card -> remind
  clearMarkers();
  rerun();
  assert.strictEqual(sent.length, 2);
  assert(text(1).includes('หมดอายุแล้ว'));

  const w = capturePushes(world, true);                  // LINE rejects the card -> plain text with the same news
  clearMarkers();
  rerun();
  assert.deepStrictEqual(w.map(b => b.messages[0].type), ['flex', 'text']);
  assert(w[1].messages[0].text.includes('หมดอายุแล้ว'));
});

test('adding rows lands right after the real data even when the sheet is padded with checkbox rows', ({ G, sheets }) => {
  const h = G('handleRequest');
  const realRows = sheets.Sessions.rows.length;
  // Google counts rows whose other columns hold FALSE checkboxes as used: pad 30 rows with an empty id but FALSE tasks
  for (let i = 0; i < 30; i++) sheets.Sessions.rows.push(['', '', '', '', '', '', '', false, false, false, false, false]);
  h('adminSaveSession', { date: '2030-03-04', location: 'Court Z', status: 'Open', cost: 200 }, 'tokAdmin');
  const added = sheets.Sessions.rows.findIndex(r => String(r[3]) === 'Court Z');
  assert.strictEqual(added, realRows, 'the new session is written into the first free row, not after the padding');
  assert.strictEqual(sheets.Sessions.rows.length, realRows + 30, 'no extra rows added at the bottom');
  assert.strictEqual(sheets.Sessions.rows[realRows - 1][0] === '', false, 'rows above are untouched');
});

test('adding a registration also lands after the real data on a padded Registrations sheet', ({ G, sheets }) => {
  const real = sheets.Registrations.rows.length;
  for (let i = 0; i < 10; i++) sheets.Registrations.rows.push(['', '', '', '', false, '']);
  G('handleRequest')('register', { session_id: 'S3' }, 'tokA');
  assert.strictEqual(String(sheets.Registrations.rows[real][1]), 'S3');
  assert.strictEqual(sheets.Registrations.rows.length, real + 10);
});

// ---------- audit log ----------
const auditRows = sheets => (sheets.AuditLog ? sheets.AuditLog.rows.slice(1) : []);
const AC = { time: 0, source: 1, action: 2, who: 3, payload: 4, result: 5, message: 6, before: 7, after: 8 };

test('audit: writes are logged with who / payload / result / row counts; plain reads are not', ({ G, sheets }) => {
  const h = G('handleRequest');
  h('getAllData', {}, null);
  h('adminGetHistory', {}, 'tokAdmin');
  assert(!sheets.AuditLog || auditRows(sheets).length === 0, 'reads leave no row');

  const regsBefore = sheets.Registrations.rows.length - 1;
  h('register', { session_id: 'S3' }, 'tokA');
  const [row] = auditRows(sheets);
  assert.strictEqual(row[AC.source], 'api');
  assert.strictEqual(row[AC.action], 'register');
  assert(String(row[AC.who]).includes('Alice'));
  assert(String(row[AC.payload]).includes('S3'));
  assert.strictEqual(row[AC.result], 'OK');
  assert(String(row[AC.before]).includes(`R:${regsBefore}`) && String(row[AC.after]).includes(`R:${regsBefore + 1}`), 'row counts before/after');
  assert(!String(row[AC.before]).includes('S:'), 'player actions only count Registrations and Users');

  h('adminSaveSession', { date: '2030-03-04', location: 'Court Z', status: 'Open', cost: 200 }, 'tokAdmin');
  const sess = auditRows(sheets)[1];
  assert(String(sess[AC.before]).includes('S:') && String(sess[AC.after]).includes('St:'), 'admin actions count every sheet');
});

test('audit: failures are logged with their code; bad tokens are not; secrets are hidden', ({ G, sheets }) => {
  const h = G('handleRequest');
  expectCode(() => h('register', { session_id: 'S2' }, 'tokA'), 'CLOSED');
  assert.strictEqual(auditRows(sheets)[0][AC.result], 'ERROR:CLOSED');
  expectCode(() => h('register', { session_id: 'S3' }, 'nope'), 'AUTH_INVALID');
  expectCode(() => h('register', { session_id: 'S3' }, null), 'AUTH_REQUIRED');
  assert.strictEqual(auditRows(sheets).length, 1, 'auth failures do not fill the sheet');

  h('adminSaveSetting', { key: 'POINT_CARD_URL', value: 'https://secret.example/card' }, 'tokAdmin');
  const last = auditRows(sheets).pop();
  assert(String(last[AC.payload]).includes('[hidden]') && !String(last[AC.payload]).includes('secret.example'));
});

test('audit: a write that loses rows it should not is flagged WARN and the admins are told', ({ G, world, sheets }) => {
  const sent = capturePushes(world);
  const h = G('handleRequest');
  G('adminSaveUser = (ss) => { ss.getSheetByName("Sessions").rows.splice(2); return { status: "success", message: "x" }; }'); // simulate a bug
  h('adminSaveUser', { user_id: 'U1', display_name: 'Alice' }, 'tokAdmin');
  const row = auditRows(sheets).pop();
  assert.strictEqual(row[AC.result], 'WARN');
  assert(String(row[AC.message]).includes('Sessions'));
  assert(sent.some(b => b.to.includes('Uadmin') && /ลดลง/.test(b.messages[0].text)), 'admins get a LINE alert');

  assert.strictEqual(G('auditWarnings')('adminDeleteSession', { Sessions: 10, Users: 5, Registrations: 100, Settings: 3 }, { Sessions: 9, Users: 5, Registrations: 40, Settings: 3 }).length, 0, 'deleting one session and its registrations is expected');
  assert.strictEqual(G('auditWarnings')('adminSaveSession', { Registrations: 100 }, { Registrations: 99 }).length, 1, 'other actions must not drop registrations');
  assert.strictEqual(G('auditWarnings')('adminDeleteSession', { Sessions: 10 }, { Sessions: 8 }).length, 1);
  assert.strictEqual(G('auditWarnings')('adminSaveSession', { Sessions: 10 }, { Sessions: 9 }).length, 1);
  assert.strictEqual(G('auditWarnings')('adminMergeUsers', { Users: 10 }, { Users: 9 }).length, 0);
});

test('audit: time-based triggers are logged too, with the reason they did nothing', ({ G, world, sheets }) => {
  capturePushes(world);
  G('pointReminderNotify')();
  const r = auditRows(sheets).pop();
  assert.strictEqual(r[AC.source], 'trigger');
  assert.strictEqual(r[AC.action], 'pointReminderNotify');
  assert(String(r[AC.message]).includes('POINT_CARD_URL'), 'explains why nothing was sent');
  G('checkWeekendQuorum')();
  assert.strictEqual(auditRows(sheets).pop()[AC.action], 'checkWeekendQuorum');
});

test('audit: a broken log sheet never breaks the request; the log is pruned when it grows too large', ({ G, sheets }) => {
  const h = G('handleRequest');
  const good = sheets.AuditLog;
  sheets.AuditLog = { getLastRow() { throw new Error('boom'); }, getRange() { throw new Error('boom'); } };
  assert.strictEqual(h('register', { session_id: 'S3' }, 'tokA').status, 'success');

  sheets.AuditLog = good || undefined;
  if (!sheets.AuditLog) delete sheets.AuditLog;
  h('cancel', { session_id: 'S3' }, 'tokA');      // creates the sheet
  const rows = sheets.AuditLog.rows;
  for (let i = 0; i < 5100; i++) rows.push([new Date(), 'api', 'x' + i, '', '', 'OK', '', '', '', 1]);
  h('register', { session_id: 'S3' }, 'tokA');
  assert(rows.length < 5100 + 3, 'oldest rows were dropped');
  assert.strictEqual(rows[rows.length - 1][AC.action], 'register');
});

test('adminSaveSession: refuses to write when Type/Location/Cost are formula columns (would turn the sheet into #REF!)', ({ G, sheets }) => {
  const h = G('handleRequest');
  const before = JSON.stringify(sheets.Sessions.rows);
  sheets.Sessions.formulas = { '2,3': '=ARRAYFORMULA(IF(B2:B<>"", IF(WEEKDAY(B2:B, 2)<=5, "Workday", "Weekend"), ""))' };   // C2 = Type
  expectCode(() => h('adminSaveSession', { date: '2030-03-04', location: 'Court Z', status: 'Open', cost: 200 }, 'tokAdmin'), 'FORMULA_COLUMN');
  expectCode(() => h('adminSaveSession', { session_id: 'S3', date: '2030-03-04', location: 'Court Z', status: 'Open', cost: 200 }, 'tokAdmin'), 'FORMULA_COLUMN');
  assert.strictEqual(JSON.stringify(sheets.Sessions.rows), before, 'nothing was written');
  const last = auditRows(sheets).pop();
  assert.strictEqual(last[AC.result], 'ERROR:FORMULA_COLUMN', 'the refusal is in the audit log');

  sheets.Sessions.formulas = {};   // after the columns are converted to plain values the app writes again
  h('adminSaveSession', { date: '2030-03-04', location: 'Court Z', status: 'Open', cost: 200 }, 'tokAdmin');
  assert(sheets.Sessions.rows.some(r => String(r[3]) === 'Court Z'));
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
