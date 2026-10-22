// Debug / audit trail. Every API action that is not a plain read, and every time-based trigger, leaves one row in the
// "AuditLog" sheet: when, who, what was asked, the outcome, and how many data rows each sheet had before and after.
// If an action makes a sheet lose rows it should not, the row is marked WARN and the admins get a LINE message.
// Each entry is also written to the execution log (Apps Script > Executions) as "AUDIT {...}".
// Logging never breaks the request it describes.

const AUDIT_SHEET = "AuditLog";
const AUDIT_HEADERS = ["Time", "Source", "Action", "Who", "Payload", "Result", "Message", "Rows_Before", "Rows_After", "Ms"];
const AUDIT_MAX_ROWS = 5000;   // when the sheet grows past this, the oldest AUDIT_PRUNE_ROWS rows are dropped
const AUDIT_PRUNE_ROWS = 1000;

// not written to the sheet (only failures go to the execution log): plain reads, and the pairing board (liveSave runs dozens of times an evening)
const READ_ACTIONS = ["getAllData", "me", "claimPoint", "adminGetHistory", "adminGetSettings", "liveGet", "liveSave"];
const PLAYER_ACTIONS = ["register", "cancel", "createProfile", "linkProfile"];    // can only touch Registrations / Users
const COUNTED_SHEETS = { Sessions: "S", Registrations: "R", Users: "U", Settings: "St" };

let _auditNotes = []; // short remarks collected while one action runs (LINE push results, why a trigger skipped, ...)

function auditNote(msg) {
  _auditNotes.push(String(msg));
  console.log(msg);
}

// Data rows per sheet, counted from the first column (getLastRow also counts pre-filled checkbox rows)
function countRows(ss, names) {
  const out = {};
  (names || Object.keys(COUNTED_SHEETS)).forEach(n => {
    const sheet = ss.getSheetByName(n);
    const last = sheet ? sheet.getLastRow() : 0;
    let c = 0;
    if (last > 1) sheet.getRange(2, 1, last - 1, 1).getValues().forEach(r => { if (String(r[0]).trim() !== "") c++; });
    out[n] = c;
  });
  return out;
}

function formatCounts(c) {
  return c ? Object.keys(c).map(n => `${COUNTED_SHEETS[n] || n}:${c[n]}`).join(" ") : "";
}

// Rows that disappeared where the action is not supposed to remove them
function auditWarnings(action, before, after) {
  const w = [];
  if (!before || !after) return w;
  const drop = n => (before[n] !== undefined && after[n] !== undefined ? before[n] - after[n] : 0);
  if (drop("Sessions") > (action === "adminDeleteSession" ? 1 : 0)) w.push(`Sessions ${before.Sessions}→${after.Sessions}`);
  if (drop("Users") > (action === "adminDeleteUser" || action === "adminMergeUsers" ? 1 : 0)) w.push(`Users ${before.Users}→${after.Users}`);
  if (drop("Settings") > 0) w.push(`Settings ${before.Settings}→${after.Settings}`);
  // ลบรอบ/ลบสมาชิก/รวมบัญชี/บันทึกรายชื่อ ลดแถวรายชื่อได้ตามปกติ (สมาชิกคนหนึ่งลงได้หลายสิบรอบ) action อื่นไม่ควรทำให้แถวรายชื่อลดเลย
  const regsMayDrop = ["register", "cancel", "adminUpdateRegistrations", "adminDeleteSession", "adminDeleteUser", "adminMergeUsers"].indexOf(action) !== -1;
  if (drop("Registrations") > (regsMayDrop ? 100 : 0)) w.push(`Registrations ${before.Registrations}→${after.Registrations}`);
  return w;
}

// Payload as text for the log: secrets hidden, long values cut
function auditPayload(action, payload) {
  try {
    let p = payload;
    if (action === "adminSaveSetting" && p && /POINT_CARD_URL|PASS|TOKEN|SECRET|ADMIN_LINE/i.test(String(p.key))) p = Object.assign({}, p, { value: "[hidden]" });
    const text = JSON.stringify(p === undefined || p === null ? {} : p, (k, v) => (/token|pass|secret/i.test(k) ? "[hidden]" : v));
    return text.length > 500 ? text.slice(0, 500) + "…" : text;
  } catch (e) {
    return "(unreadable)";
  }
}

function auditAppend(ss, e) {
  console.log("AUDIT " + JSON.stringify(e));
  const lock = LockService.getScriptLock();
  const got = lock.tryLock(5000);
  try {
    let sheet = ss.getSheetByName(AUDIT_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(AUDIT_SHEET);
      styleHeader(sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]));
    }
    if (sheet.getLastRow() > AUDIT_MAX_ROWS) sheet.deleteRows(2, AUDIT_PRUNE_ROWS);
    appendRowAfterData(sheet, [new Date(e.t0), e.source, e.action, e.who, e.payload, e.result, e.message, formatCounts(e.before), formatCounts(e.after), e.ms]);
  } finally {
    if (got) lock.releaseLock();
  }
}

// audit = { source, action, payload, who, before, after, t0 }; error = the exception thrown by the action (or null)
function finishAudit(audit, error, result) {
  try {
    const code = error ? String(error.code || "ERROR") : "";
    if (READ_ACTIONS.indexOf(audit.action) !== -1) {
      if (error && !/^AUTH_/.test(code)) console.error(`${audit.action} failed: ${code} ${error.message}`);
      return;
    }
    if (error && /^AUTH_/.test(code)) return; // bad or expired token: not worth a sheet row (and cannot be used to fill the sheet)

    const warnings = error ? [] : auditWarnings(audit.action, audit.before, audit.after);
    const notes = _auditNotes.slice();
    const message = (error ? error.message : (result && result.message) || "") + (notes.length ? (error || (result && result.message) ? " | " : "") + notes.join(" | ") : "");
    const entry = {
      t0: audit.t0, source: audit.source, action: audit.action, who: audit.who || "",
      payload: audit.source === "api" ? auditPayload(audit.action, audit.payload) : "",
      result: error ? "ERROR:" + code : (warnings.length ? "WARN" : "OK"),
      message: (warnings.length ? "⚠️ แถวลดลง " + warnings.join(", ") + " | " : "") + message,
      before: audit.before, after: audit.after, ms: Date.now() - audit.t0
    };
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    auditAppend(ss, entry);
    if (warnings.length) {
      const ids = getAdminIds(ss);
      if (ids.length) pushToLine(ids, `⚠️ ตรวจพบข้อมูลลดลงผิดปกติ\nการทำงาน: ${audit.action}\nแถว: ${warnings.join(", ")}\nดูรายละเอียดในชีท ${AUDIT_SHEET} (กู้คืนได้จากประวัติเวอร์ชัน)`);
    }
  } catch (err) {
    console.error("audit failed: " + err);
  }
}

// ครอบงานตามเวลา (trigger) ให้ลงบันทึกเหมือน action ของหน้าเว็บ
function auditRun(name, fn) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const audit = { source: "trigger", action: name, payload: null, who: "", before: null, after: null, t0: Date.now() };
  _auditNotes = [];
  try { audit.before = countRows(ss); } catch (e) { /* counting is best effort */ }
  let error = null;
  try { fn(); } catch (e) { error = e; }
  try { audit.after = countRows(ss); } catch (e) { /* counting is best effort */ }
  finishAudit(audit, error);
  if (error) throw error;
}
