// Last Updated: 2026-10-11 (กติกาใหม่: โควตา 8 คน/ชม., ไม่มี Walk-in, หาร 6, รอบวันหยุดต้องครบ 6 คน)
/**
 * Badminton Queue System — Backend (Google Sheets + LINE LIFF)
 *
 * หน้าเว็บ (index.html) โฮสต์แยก เช่น GitHub Pages แล้วเรียก API นี้ด้วย fetch POST
 * ตัวตนผู้ใช้มาจาก LINE ID token ที่ตรวจกับเซิร์ฟเวอร์ LINE ทุกครั้ง
 * จะไม่เชื่อ user_id ที่ส่งมาจากหน้าเว็บอีกต่อไป
 *
 * Deploy: Deploy > New deployment > Web app
 *         Execute as: Me | Who has access: Anyone
 */

const HIDDEN_SETTINGS = ["ADMIN_PASS", "ADMIN_LINE_IDS"];
const TASK_KEY_PATTERN = /^(Task\d+|Extra_Shuttles)$/;

// ======================= Setup =======================

// รันฟังก์ชันนี้ 1 ครั้งจาก editor หลังวางโค้ด (รันซ้ำได้ ไม่ทับข้อมูลเดิม)
function initialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const defs = [
    { name: "Settings", headers: ["Key", "Value", "Description"] },
    { name: "Users", headers: ["User_ID", "DisplayName", "Skill_Level", "Profile_Pic", "Join_Date", "Line_UID"] },
    { name: "Sessions", headers: ["Session_ID", "Date", "Type", "Location", "Status", "Cost", "Calculated_Price_Per_Head", "Task1", "Task2", "Task3", "Task4"] },
    { name: "Registrations", headers: ["Timestamp", "Session_ID", "User_ID", "Hours_Joined", "Is_Walk_in", "Payment_Status"] }
  ];

  defs.forEach(def => {
    if (!ss.getSheetByName(def.name)) {
      const sheet = ss.insertSheet(def.name);
      styleHeader(sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]));
    }
  });

  ensureColumn(ss.getSheetByName("Users"), "Line_UID");
  ensureColumn(ss.getSheetByName("Sessions"), "Task5"); // เช็คลิสต์ "โอนเงินเข้าบัญชี"
  ensureSetting(ss, "LINE_CHANNEL_ID", "", "Channel ID ของ LINE Login channel (ใช้ตรวจ ID token)");
  ensureSetting(ss, "ADMIN_LINE_IDS", "", "LINE userId ของแอดมิน คั่นด้วยเครื่องหมาย ,");
  ensureSetting(ss, "NOTIFY_CANCEL", "TRUE", "แจ้งเตือนแอดมินทาง LINE เมื่อมีคนยกเลิกคิว (TRUE/FALSE)");
  ensureSetting(ss, "WORKDAY_HOUR_CAP", 8, "วันธรรมดา: จำนวนคนสูงสุดต่อชั่วโมง");
  ensureSetting(ss, "WEEKEND_CLOSE_DAYS", 2, "วันหยุด: ปิดรับลงชื่อก่อนวันเล่นกี่วัน");
  ensureSetting(ss, "WORKDAY_MIN_PLAYERS", 6, "วันธรรมดา: เป้าหมายจำนวนคนขั้นต่ำ (แสดงผลเท่านั้น ไม่งดรอบอัตโนมัติ)");
  ensureSetting(ss, "WEEKEND_MIN_PLAYERS", 6, "วันหยุด: จำนวนคนขั้นต่ำ ถ้าไม่ครบจะงดรอบอัตโนมัติ");
  ensureSetting(ss, "COST_SPLIT_BASE", 6, "ค่าใช้จ่ายหารกี่คน (มากกว่านี้จ่ายเท่าเดิม)");
  ensureSetting(ss, "SHUTTLES_PER_SESSION", 2, "จำนวนลูกแบดที่รวมในราคาต่อรอบ");
  ensureSetting(ss, "SHUTTLECOCK_PRICE", 65, "ราคาลูกแบดต่อลูก (บาท)");
  ensureSetting(ss, "NOTIFY_PLAY_DAY", "TRUE", "แจ้งแอดมินทาง LINE 10:00 ในวันที่มีรอบตี พร้อมข้อความโพสต์กลุ่ม (TRUE/FALSE)");
  ensureSetting(ss, "BOOK_NOTICE_DAYS", 2, "รอบวันหยุด: แจ้งแอดมินจำนวนคนก่อนวันเล่นกี่วัน (เพื่อจองคอร์ด)");
}

// รันครั้งเดียวจาก editor หลังเปลี่ยนเช็คลิสต์เป็น: เพิ่มลูกแบด(Task3) / เก็บเงิน(Task2) / แจกแต้ม(Task4) / โอนเงินเข้าบัญชี(Task5)
// รอบเก่าที่เคลียร์ครบตามระบบเดิม (Task2 และ Task4 เป็น TRUE) จะถูกตั้ง Task5 = TRUE ให้ ไม่งั้นรอบเก่าทุกรอบจะกลับมาเป็น "ค้าง"
function migrateChecklist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Sessions");
  ensureColumn(sheet, "Task5");
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const c2 = headers.indexOf("Task2"), c4 = headers.indexOf("Task4"), c5 = headers.indexOf("Task5");
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (isTruthy(data[i][c2]) && isTruthy(data[i][c4]) && !isTruthy(data[i][c5])) {
      sheet.getRange(i + 1, c5 + 1).setValue(true);
      n++;
    }
  }
  Logger.log("ตั้ง Task5 = TRUE ให้ " + n + " รอบ");
}

function ensureSheetsExist(ss) {
  const missing = ["Settings", "Users", "Sessions", "Registrations"].some(n => !ss.getSheetByName(n));
  const cache = CacheService.getScriptCache();
  if (missing || !cache.get("setup_ok")) {
    initialSetup();
    cache.put("setup_ok", "1", 21600);
  }
}

function styleHeader(range) {
  return range.setFontWeight("bold").setBackground("#f3f4f6");
}

function ensureColumn(sheet, name) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  if (headers.indexOf(name) === -1) styleHeader(sheet.getRange(1, lastCol + 1).setValue(name));
}

let _settingKeys = null; // รายชื่อ Key ในชีท Settings (อ่านครั้งเดียวต่อการรัน แทนการอ่านซ้ำทุก ensureSetting)
function ensureSetting(ss, key, value, desc) {
  const sheet = ss.getSheetByName("Settings");
  if (!_settingKeys) {
    _settingKeys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues().map(r => String(r[0]).trim());
  }
  if (_settingKeys.indexOf(key) === -1) {
    sheet.appendRow([key, value, desc]);
    _settingKeys.push(key);
  }
}

// ======================= HTTP entry =======================

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === "getAllData") return safeRun(() => handleRequest("getAllData", {}, null));
  return createJsonResponse({ status: "success", message: "Badminton API is running" });
}

// หน้าเว็บส่ง POST แบบ text/plain (ไม่มี custom header) เพื่อไม่ให้ติด CORS preflight
function doPost(e) {
  return safeRun(() => {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    return handleRequest(String(body.action || "").trim(), body.payload || {}, body.idToken || null);
  });
}

function safeRun(fn) {
  try {
    return createJsonResponse(fn());
  } catch (err) {
    return createJsonResponse({ status: "error", code: err.code || "ERROR", message: err.message || String(err) });
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ======================= Router =======================

function handleRequest(action, payload, idToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);

  // อ่านข้อมูลสาธารณะ ไม่ต้อง login (ใช้กับหน้า Public ด้วย)
  if (action === "getAllData") return { status: "success", data: getAllDataCached(ss) };

  // ทุก action ที่เหลือต้องมี LINE ID token ที่ถูกต้อง
  const line = verifyIdToken(ss, idToken);

  if (action === "me") return getMe(ss, line);

  // งานแจ้งเตือนรันหลังปลดล็อก คนอื่นจะได้ไม่ต้องรอ และถ้าส่งไม่สำเร็จก็ไม่กระทบการยกเลิก
  const ctx = { afterUnlock: null };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail("BUSY", "ระบบยุ่งมาก โปรดลองใหม่อีกครั้ง");

  let result;
  try {
    result = dispatchWrite(ss, line, action, payload, ctx);
  } finally {
    CacheService.getScriptCache().remove(ALL_DATA_CACHE_KEY); // ข้อมูลเปลี่ยนแล้ว ให้โหลดใหม่จากชีท
    lock.releaseLock();
  }

  if (ctx.afterUnlock) {
    try { ctx.afterUnlock(); } catch (err) { console.error("Notify failed: " + err); }
  }
  return result;
}

function dispatchWrite(ss, line, action, payload, ctx) {
  switch (action) {
    case "createProfile": return createProfile(ss, line, payload);
    case "linkProfile":   return linkProfile(ss, line, payload);
    case "register":      return register(ss, requireUser(ss, line), payload);

    case "cancel": {
      const user = requireUser(ss, line);
      const res = cancel(ss, user, payload);
      if (res.count > 0) {
        ctx.afterUnlock = () => notifyAdminsCancel(ss, user, payload.session_id, res.removed);
      }
      return { status: res.status, message: res.message, count: res.count };
    }

    case "cancelSession":
      requireAdmin(ss, line);
      return setSessionStatus(ss, payload.session_id, "Cancelled", "ยุบรอบตีนี้เรียบร้อยแล้ว");
    case "openSession":
      requireAdmin(ss, line);
      return setSessionStatus(ss, payload.session_id, "Open", "เปิดรอบตีนี้กลับมาเรียบร้อยแล้ว");
    case "updateTask":
      requireAdmin(ss, line);
      return updateTask(ss, payload);
    case "adminUpdateRegistrations":
      requireAdmin(ss, line);
      return adminUpdateRegistrations(ss, payload);

    // ---- หน้าจัดการข้อมูลของแอดมิน ----
    case "adminGetSettings":
      requireAdmin(ss, line);
      return adminGetSettings(ss);
    case "adminSaveSetting":
      requireAdmin(ss, line);
      return adminSaveSetting(ss, payload);
    case "adminSaveSession":
      requireAdmin(ss, line);
      return adminSaveSession(ss, payload);
    case "adminDeleteSession":
      requireAdmin(ss, line);
      return adminDeleteSession(ss, payload);
    case "adminSaveUser":
      requireAdmin(ss, line);
      return adminSaveUser(ss, payload);
    case "adminUnlinkUser":
      requireAdmin(ss, line);
      return adminUnlinkUser(ss, payload);
    case "adminDeleteUser":
      requireAdmin(ss, line);
      return adminDeleteUser(ss, payload);

    default:
      fail("BAD_ACTION", `ไม่รองรับ action "${action}"`);
  }
}

// ======================= LINE auth =======================

function verifyIdToken(ss, idToken) {
  if (!idToken) fail("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบด้วย LINE");

  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const channelId = String(getSetting(ss, "LINE_CHANNEL_ID") || "").trim();
  if (!channelId) fail("CONFIG", "ยังไม่ได้ใส่ LINE_CHANNEL_ID ในชีท Settings");

  const res = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText() || "{}");

  if (res.getResponseCode() !== 200) {
    const desc = data.error_description || data.error || "unknown";
    fail(/expired/i.test(desc) ? "AUTH_EXPIRED" : "AUTH_INVALID", "ยืนยันตัวตน LINE ไม่สำเร็จ: " + desc);
  }

  const info = { lineUid: data.sub, name: data.name || "", picture: data.picture || "" };
  const ttl = Math.max(1, Math.min(600, data.exp - Math.floor(Date.now() / 1000) - 30));
  cache.put(key, JSON.stringify(info), ttl);
  return info;
}

function getAdminIds(ss) {
  return String(getSetting(ss, "ADMIN_LINE_IDS") || "").split(",").map(s => s.trim()).filter(Boolean);
}

function isAdmin(ss, lineUid) {
  return !!lineUid && getAdminIds(ss).indexOf(lineUid) !== -1;
}

function requireAdmin(ss, line) {
  if (!isAdmin(ss, line.lineUid)) fail("FORBIDDEN", "เฉพาะแอดมินเท่านั้น");
}

function requireUser(ss, line) {
  const user = findUserByLineUid(ss, line.lineUid);
  if (!user) fail("NO_PROFILE", "กรุณาสร้างหรือเลือกโปรไฟล์ก่อน");
  return user;
}

// ======================= Users =======================

function getUsersTable(ss) {
  const sheet = ss.getSheetByName("Users");
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  return { sheet, values, col: name => headers.indexOf(name) };
}

function findUserByLineUid(ss, lineUid, table) {
  const t = table || getUsersTable(ss);
  const cLine = t.col("Line_UID"), cId = t.col("User_ID"), cName = t.col("DisplayName");
  if (cLine === -1) return null;
  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cLine]).trim() === lineUid) {
      return { User_ID: String(t.values[i][cId]), DisplayName: String(t.values[i][cName]), lineUid };
    }
  }
  return null;
}

function toClientUser(ss, user) {
  return { User_ID: user.User_ID, DisplayName: user.DisplayName, isAdmin: isAdmin(ss, user.lineUid) };
}

// อัปเดตรูปโปรไฟล์ในชีท Users ให้ตรงกับรูป LINE ล่าสุด (เพื่อนจะได้เห็นรูปของกันและกัน)
function syncProfilePic(line, t) {
  if (!line.picture) return;
  const cLine = t.col("Line_UID"), cPic = t.col("Profile_Pic");
  if (cLine === -1) return;
  if (cPic === -1) { ensureColumn(t.sheet, "Profile_Pic"); return; }
  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cLine]).trim() !== line.lineUid) continue;
    if (String(t.values[i][cPic]).trim() !== line.picture) t.sheet.getRange(i + 1, cPic + 1).setValue(line.picture);
    return;
  }
}

function getMe(ss, line) {
  const t = getUsersTable(ss); // อ่านชีท Users ครั้งเดียว ใช้ทั้งหาผู้ใช้และซิงค์รูป
  syncProfilePic(line, t);
  const user = findUserByLineUid(ss, line.lineUid, t);
  return {
    status: "success",
    data: {
      line: { name: line.name, picture: line.picture },
      user: user ? toClientUser(ss, user) : null
    }
  };
}

function createProfile(ss, line, payload) {
  const existing = findUserByLineUid(ss, line.lineUid);
  if (existing) return { status: "success", data: toClientUser(ss, existing) };

  const name = safeText(String(payload.display_name || line.name || "").trim().slice(0, 40));
  if (!name) fail("BAD_INPUT", "กรุณาใส่ชื่อ");

  const newId = "U" + Date.now();
  appendByHeaders(ss.getSheetByName("Users"), {
    User_ID: newId, DisplayName: name, Skill_Level: "C",
    Profile_Pic: line.picture, Join_Date: new Date(), Line_UID: line.lineUid
  });
  return { status: "success", data: { User_ID: newId, DisplayName: name, isAdmin: isAdmin(ss, line.lineUid) } };
}

// ผูกบัญชี LINE กับโปรไฟล์เดิม (ทำได้ครั้งเดียวต่อโปรไฟล์)
function linkProfile(ss, line, payload) {
  if (findUserByLineUid(ss, line.lineUid)) fail("ALREADY_LINKED", "บัญชี LINE นี้ผูกกับโปรไฟล์แล้ว");

  const t = getUsersTable(ss);
  const cId = t.col("User_ID"), cName = t.col("DisplayName"), cLine = t.col("Line_UID"), cPic = t.col("Profile_Pic");
  const targetId = String(payload.user_id || "").trim();

  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cId]).trim() !== targetId) continue;
    if (String(t.values[i][cLine]).trim()) fail("TAKEN", "โปรไฟล์นี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อแอดมิน");

    t.sheet.getRange(i + 1, cLine + 1).setValue(line.lineUid);
    if (cPic !== -1 && line.picture) t.sheet.getRange(i + 1, cPic + 1).setValue(line.picture);
    return {
      status: "success",
      data: { User_ID: targetId, DisplayName: String(t.values[i][cName]), isAdmin: isAdmin(ss, line.lineUid) }
    };
  }
  fail("NOT_FOUND", "ไม่พบโปรไฟล์นี้");
}

// ======================= Registrations =======================

function findSession(ss, sessionId) {
  const sheet = ss.getSheetByName("Sessions");
  const data = sheet.getDataRange().getValues();
  const sid = String(sessionId || "").trim();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === sid) {
      return {
        sheet, row: i + 1,
        status: String(data[i][4]).trim(),
        date: data[i][1],
        type: String(data[i][2]).trim(),
        location: String(data[i][3]).trim()
      };
    }
  }
  return null;
}

// ---------- กติกา (ค่าจริงอ่านจากชีท Settings) ----------
const DEFAULT_RULES = {
  WORKDAY_HOUR_CAP: 8,
  WEEKEND_CLOSE_DAYS: 2,
  WORKDAY_MIN_PLAYERS: 6,
  WEEKEND_MIN_PLAYERS: 6,
  COST_SPLIT_BASE: 6,
  SHUTTLES_PER_SESSION: 2,
  SHUTTLECOCK_PRICE: 65
};
const WORKDAY_HOURS = ["All", "18:00-19:00", "19:00-20:00"];

function getRules(ss) {
  const rules = Object.assign({}, DEFAULT_RULES);
  getSheetDataAsJSON(ss.getSheetByName("Settings")).forEach(s => {
    if (rules.hasOwnProperty(s.Key) && s.Value !== "" && !isNaN(Number(s.Value))) rules[s.Key] = Number(s.Value);
  });
  return rules;
}

function inHour1(h) { h = String(h || "All"); return h === "All" || h.indexOf("18:00") === 0 || h.indexOf("16:00") === 0; }
function inHour2(h) { h = String(h || "All"); return h === "All" || h.indexOf("19:00") === 0 || h.indexOf("17:00") === 0; }

function isTruthy(v) {
  return v === true || /^(TRUE|Y)$/i.test(String(v).trim());
}

// เช็คกติกาทั้งหมดที่ server ภายใต้ Lock กดพร้อมกันก็ไม่เกินโควตา
function register(ss, user, payload) {
  const rules = getRules(ss);
  const session = findSession(ss, payload.session_id);
  if (!session) fail("NOT_FOUND", "ไม่พบรอบตีนี้");
  if (session.status !== "Open") fail("CLOSED", "รอบนี้ไม่ได้เปิดรับลงชื่อ");

  const sessionDate = toSessionDate(session.date);
  const days = sessionDate ? daysUntil(sessionDate) : 0;
  if (days < 0) fail("PAST", "รอบนี้จบไปแล้ว");

  const isWorkday = session.type === "Workday";
  if (!isWorkday && days < rules.WEEKEND_CLOSE_DAYS) {
    fail("CLOSED", `รอบวันหยุดปิดรับลงชื่อก่อนวันเล่น ${rules.WEEKEND_CLOSE_DAYS} วัน`);
  }

  let hours = "All";
  if (isWorkday) {
    hours = String(payload.hours_joined || "All");
    if (WORKDAY_HOURS.indexOf(hours) === -1) fail("BAD_INPUT", "เวลาที่เลือกไม่ถูกต้อง");
  }

  const sid = String(payload.session_id).trim();
  const sheet = ss.getSheetByName("Registrations");
  const data = sheet.getDataRange().getValues();
  const myRows = [];
  let h1 = 0, h2 = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() !== sid) continue;
    if (String(data[i][2]).trim() === user.User_ID) { myRows.push(i + 1); continue; }
    if (inHour1(data[i][3])) h1++;
    if (inHour2(data[i][3])) h2++;
  }

  if (isWorkday) {
    const cap = rules.WORKDAY_HOUR_CAP;
    if (inHour1(hours) && h1 >= cap) fail("FULL", `ชั่วโมง 18:00-19:00 เต็ม ${cap} คนแล้ว`);
    if (inHour2(hours) && h2 >= cap) fail("FULL", `ชั่วโมง 19:00-20:00 เต็ม ${cap} คนแล้ว`);
  }

  if (myRows.length > 0) {
    sheet.getRange(myRows[0], 4, 1, 2).setValues([[hours, false]]);
    for (let j = myRows.length - 1; j >= 1; j--) sheet.deleteRow(myRows[j]);
  } else {
    sheet.appendRow([new Date(), sid, user.User_ID, hours, false, "Unpaid"]);
  }
  return { status: "success", message: "ลงชื่อเรียบร้อย" };
}

// ยกเลิกได้ตลอดจนถึงวันเล่น (ทุกครั้งจะแจ้งแอดมิน)
function cancel(ss, user, payload) {
  const sid = String(payload.session_id || "").trim();
  const session = findSession(ss, sid);
  if (session) {
    const d = toSessionDate(session.date);
    if (d && daysUntil(d) < 0) fail("PAST", "รอบนี้จบไปแล้ว ยกเลิกไม่ได้");
  }

  const sheet = ss.getSheetByName("Registrations");
  const data = sheet.getDataRange().getValues();
  const removed = [];
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]).trim() === sid && String(data[i][2]).trim() === user.User_ID) {
      removed.push({ hours: String(data[i][3] || "All") });
      sheet.deleteRow(i + 1);
    }
  }
  return { status: "success", message: "ยกเลิกสำเร็จ", count: removed.length, removed };
}

// ======================= Admin =======================

function setSessionStatus(ss, sessionId, status, okMessage) {
  const session = findSession(ss, sessionId);
  if (!session) return { status: "error", message: "ไม่พบข้อมูลรอบตีนี้" };
  session.sheet.getRange(session.row, 5).setValue(status);
  return { status: "success", message: okMessage };
}

function updateTask(ss, payload) {
  const session = findSession(ss, payload.session_id);
  if (!session) return { status: "error", message: "ไม่พบข้อมูลรอบตีนี้" };

  const tasks = payload.tasks || { [payload.task_key]: payload.task_value };
  Object.keys(tasks).forEach(k => {
    if (!TASK_KEY_PATTERN.test(k)) fail("BAD_INPUT", "ไม่อนุญาตให้แก้คอลัมน์ " + k);
  });

  const sheet = session.sheet;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  Object.keys(tasks).forEach(key => {
    let colIdx = headers.indexOf(key);
    if (colIdx === -1) {
      styleHeader(sheet.getRange(1, headers.length + 1).setValue(key));
      headers.push(key);
      colIdx = headers.length - 1;
    }
    sheet.getRange(session.row, colIdx + 1).setValue(tasks[key]);
  });
  return { status: "success", message: "อัปเดต Checklist สำเร็จ" };
}

// เขียนรายชื่อของรอบใหม่ทั้งชุดในครั้งเดียว (เร็วกว่าการ deleteRow ทีละแถว)
function adminUpdateRegistrations(ss, payload) {
  const sid = String(payload.session_id || "").trim();
  const sheet = ss.getSheetByName("Registrations");
  const usersSheet = ss.getSheetByName("Users");
  const values = sheet.getDataRange().getValues();
  const width = values[0].length;

  const kept = values.slice(1).filter(r => String(r[1]).trim() !== sid);
  const added = (payload.registrations || []).map(reg => {
    let uid = String(reg.User_ID || "");
    if (uid.startsWith("NEW_")) {
      uid = "U" + Date.now() + Math.floor(Math.random() * 1000);
      appendByHeaders(usersSheet, {
        User_ID: uid, DisplayName: safeText(String(reg.DisplayName || "Guest").slice(0, 40)),
        Skill_Level: "C", Profile_Pic: "", Join_Date: new Date(), Line_UID: ""
      });
    }
    return [
      reg.Timestamp ? new Date(reg.Timestamp) : new Date(),
      sid, uid,
      WORKDAY_HOURS.indexOf(String(reg.Hours_Joined)) !== -1 ? String(reg.Hours_Joined) : "All",
      false, // ยกเลิกระบบ Walk-in แล้ว
      reg.Payment_Status || "Unpaid"
    ];
  });

  const all = kept.concat(added).map(r => {
    const row = r.slice(0, width);
    while (row.length < width) row.push("");
    return row;
  });

  if (values.length > 1) sheet.getRange(2, 1, values.length - 1, width).clearContent();
  if (all.length) sheet.getRange(2, 1, all.length, width).setValues(all);
  return { status: "success", message: "อัปเดตรายชื่อสำเร็จ" };
}

// ======================= Admin: จัดการชีท =======================

const SESSION_TYPES = ["Workday", "Weekend"];
const SESSION_STATUSES = ["Open", "Closed", "Cancelled"];
const READONLY_SETTINGS = ["ADMIN_PASS", "ADMIN_LINE_IDS", "LINE_CHANNEL_ID"]; // ไม่ส่งออก ไม่ให้แก้ผ่านหน้าเว็บ

const CREATABLE_SETTINGS = ["LINE_POST_TEMPLATE"];

function adminGetSettings(ss) {
  const rows = getSheetDataAsJSON(ss.getSheetByName("Settings"))
    .filter(r => r.Key && READONLY_SETTINGS.indexOf(String(r.Key)) === -1)
    .map(r => ({ Key: String(r.Key), Value: r.Value, Description: r.Description || "" }));
  return { status: "success", data: rows };
}

function adminSaveSetting(ss, payload) {
  const key = String(payload.key || "").trim();
  if (!key) fail("BAD_INPUT", "ไม่มีชื่อ Key");
  if (READONLY_SETTINGS.indexOf(key) !== -1) fail("FORBIDDEN", "ค่านี้แก้ผ่านหน้าเว็บไม่ได้");
  const value = typeof payload.value === "string" ? safeText(payload.value.trim()) : payload.value;

  const sheet = ss.getSheetByName("Settings");
  const keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues().map(r => String(r[0]).trim());
  const idx = keys.indexOf(key);
  if (idx === -1) {
    // Key ที่หน้าเว็บสร้างเองได้ (ยังไม่เคยตั้งค่าในชีท)
    if (CREATABLE_SETTINGS.indexOf(key) === -1) fail("NOT_FOUND", "ไม่พบ Key นี้ในชีท Settings");
    sheet.appendRow([key, value, "รูปแบบข้อความโพสต์กลุ่ม LINE (แก้จากหน้าจัดการข้อมูล)"]);
  } else {
    sheet.getRange(idx + 1, 2).setValue(value);
  }
  CacheService.getScriptCache().remove("setup_ok");
  return { status: "success", message: "บันทึกการตั้งค่าแล้ว" };
}

function adminSaveSession(ss, payload) {
  const type = String(payload.type || "").trim();
  const status = String(payload.status || "Open").trim();
  const location = safeText(String(payload.location || "").trim().slice(0, 60));
  const cost = Number(payload.cost);
  if (SESSION_TYPES.indexOf(type) === -1) fail("BAD_INPUT", "ประเภทรอบไม่ถูกต้อง");
  if (SESSION_STATUSES.indexOf(status) === -1) fail("BAD_INPUT", "สถานะไม่ถูกต้อง");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date || ""))) fail("BAD_INPUT", "วันที่ไม่ถูกต้อง");
  if (!location) fail("BAD_INPUT", "กรุณาใส่สนาม");
  if (isNaN(cost) || cost < 0) fail("BAD_INPUT", "ค่าคอร์ดไม่ถูกต้อง");
  const date = Utilities.parseDate(payload.date, "Asia/Bangkok", "yyyy-MM-dd");

  const sheet = ss.getSheetByName("Sessions");
  const sid = String(payload.session_id || "").trim();
  if (sid) {
    const session = findSession(ss, sid);
    if (!session) fail("NOT_FOUND", "ไม่พบรอบตีนี้");
    sheet.getRange(session.row, 2, 1, 4).setValues([[date, type, location, status]]);
    sheet.getRange(session.row, 6).setValue(cost);
    return { status: "success", message: "บันทึกรอบตีแล้ว" };
  }

  let max = 0;
  sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().forEach(r => {
    const m = /^S(\d+)$/.exec(String(r[0]).trim());
    if (m) max = Math.max(max, Number(m[1]));
  });
  const newId = "S" + ("000" + (max + 1)).slice(-3);
  appendByHeaders(sheet, { Session_ID: newId, Date: date, Type: type, Location: location, Status: status, Cost: cost });
  return { status: "success", message: "เพิ่มรอบตีแล้ว (" + newId + ")" };
}

function deleteRowsWhere(sheet, colIndex, value) {
  const data = sheet.getDataRange().getValues();
  let n = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][colIndex]).trim() === value) { sheet.deleteRow(i + 1); n++; }
  }
  return n;
}

function adminDeleteSession(ss, payload) {
  const sid = String(payload.session_id || "").trim();
  const session = findSession(ss, sid);
  if (!session) fail("NOT_FOUND", "ไม่พบรอบตีนี้");
  deleteRowsWhere(ss.getSheetByName("Registrations"), 1, sid);
  session.sheet.deleteRow(session.row);
  return { status: "success", message: "ลบรอบตีแล้ว" };
}

function findUserRow(ss, userId) {
  const t = getUsersTable(ss);
  const cId = t.col("User_ID");
  const uid = String(userId || "").trim();
  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cId]).trim() === uid) return { t, row: i + 1 };
  }
  fail("NOT_FOUND", "ไม่พบสมาชิกนี้");
}

function adminSaveUser(ss, payload) {
  const name = safeText(String(payload.display_name || "").trim().slice(0, 40));
  const skill = safeText(String(payload.skill_level || "").trim().slice(0, 10));
  if (!name) fail("BAD_INPUT", "กรุณาใส่ชื่อ");

  const uid = String(payload.user_id || "").trim();
  if (!uid) {
    appendByHeaders(ss.getSheetByName("Users"), {
      User_ID: "U" + Date.now(), DisplayName: name, Skill_Level: skill || "C",
      Profile_Pic: "", Join_Date: new Date(), Line_UID: ""
    });
    return { status: "success", message: "เพิ่มสมาชิกแล้ว" };
  }
  const { t, row } = findUserRow(ss, uid);
  t.sheet.getRange(row, t.col("DisplayName") + 1).setValue(name);
  if (t.col("Skill_Level") !== -1) t.sheet.getRange(row, t.col("Skill_Level") + 1).setValue(skill);
  return { status: "success", message: "บันทึกสมาชิกแล้ว" };
}

// ปลดการผูก LINE เพื่อให้เจ้าของโปรไฟล์ผูกใหม่ด้วยบัญชีอื่นได้
function adminUnlinkUser(ss, payload) {
  const { t, row } = findUserRow(ss, payload.user_id);
  t.sheet.getRange(row, t.col("Line_UID") + 1).setValue("");
  return { status: "success", message: "ปลดการผูก LINE แล้ว" };
}

function adminDeleteUser(ss, payload) {
  const uid = String(payload.user_id || "").trim();
  const { t, row } = findUserRow(ss, uid);
  deleteRowsWhere(ss.getSheetByName("Registrations"), 2, uid);
  t.sheet.deleteRow(row);
  return { status: "success", message: "ลบสมาชิกแล้ว" };
}

// ======================= Notifications =======================

function notifyAdminsCancel(ss, user, sessionId, removed) {
  if (String(getSetting(ss, "NOTIFY_CANCEL")).trim().toUpperCase() === "FALSE") return;
  const adminIds = getAdminIds(ss);
  if (!adminIds.length) return;

  const rules = getRules(ss);
  const sid = String(sessionId).trim();
  const session = findSession(ss, sid);
  const regs = getSheetDataAsJSON(ss.getSheetByName("Registrations"))
    .filter(r => String(r.Session_ID).trim() === sid);

  const isWorkday = !!session && session.type === "Workday";
  const r = removed[0] || {};
  const hoursText = isWorkday
    ? (r.hours === "All" ? "18:00-20:00 (2 ชม.)" : r.hours)
    : "16:00-18:00";
  const sessionDate = session ? toSessionDate(session.date) : null;
  const daysLeft = sessionDate ? daysUntil(sessionDate) : null;

  const lines = [
    "❌ มีคนยกเลิกคิว",
    `👤 ${user.DisplayName}`,
    `📅 ${sessionDate ? formatThaiDate(sessionDate) : sid}${session && session.location ? " • " + session.location : ""}`,
    `⌚ ${hoursText}`
  ];

  if (isWorkday) {
    const cap = rules.WORKDAY_HOUR_CAP;
    const h1 = regs.filter(x => inHour1(x.Hours_Joined)).length;
    const h2 = regs.filter(x => inHour2(x.Hours_Joined)).length;
    lines.push(`👥 เหลือ 18-19 น. ${h1}/${cap} • 19-20 น. ${h2}/${cap}`);
  } else {
    lines.push(`👥 เหลือ ${regs.length} คน (ขั้นต่ำ ${rules.WEEKEND_MIN_PLAYERS})`);
    if (regs.length < rules.WEEKEND_MIN_PLAYERS && daysLeft !== null && daysLeft < rules.WEEKEND_CLOSE_DAYS) {
      lines.push("⚠️ ปิดรับแล้วแต่จำนวนคนไม่ถึงขั้นต่ำ");
    }
  }
  if (daysLeft === 0 || daysLeft === 1) {
    lines.push(`⏰ ยกเลิกกระชั้นชิด (เล่น${daysLeft === 0 ? "วันนี้" : "พรุ่งนี้"})`);
  }

  pushToLine(adminIds, lines.join("\n"));
}

// ส่งข้อความหาหลายคนพร้อมกันผ่าน LINE Messaging API (multicast)
// text เป็นสตริงเดียว หรืออาร์เรย์ของสตริง (ส่งเป็นหลายบับเบิลในครั้งเดียว สูงสุด 5)
function pushToLine(userIds, text) {
  const token = PropertiesService.getScriptProperties().getProperty("LINE_MESSAGING_TOKEN");
  if (!token) {
    console.warn("ยังไม่ได้ตั้ง LINE_MESSAGING_TOKEN ใน Script Properties");
    return { code: 0, body: "missing token" };
  }
  const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/multicast", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      to: userIds,
      messages: [].concat(text).slice(0, 5).map(t => ({ type: "text", text: String(t).slice(0, 5000) }))
    }),
    muteHttpExceptions: true
  });
  const out = { code: res.getResponseCode(), body: res.getContentText() };
  if (out.code !== 200) console.error("LINE push failed: " + out.code + " " + out.body);
  return out;
}

// รันจาก editor เพื่อทดสอบว่าแอดมินได้รับข้อความ
function testNotify() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ids = getAdminIds(ss);
  if (!ids.length) throw new Error("ยังไม่ได้ใส่ ADMIN_LINE_IDS ในชีท Settings");
  const res = pushToLine(ids, "✅ ทดสอบการแจ้งเตือนจากระบบตีแบด");
  if (res.code !== 200) throw new Error("ส่งไม่สำเร็จ: " + res.code + " " + res.body);
  Logger.log("ส่งสำเร็จถึง " + ids.length + " คน");
}

function toSessionDate(v) {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() > 2400) d.setFullYear(d.getFullYear() - 543);
  return d;
}

function formatThaiDate(d) {
  const tz = "Asia/Bangkok";
  const days = ["", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส.", "อา."];
  const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${days[+Utilities.formatDate(d, tz, "u")]} ${Utilities.formatDate(d, tz, "d")} ${months[+Utilities.formatDate(d, tz, "M") - 1]}`;
}

function daysUntil(d) {
  const tz = "Asia/Bangkok";
  const target = new Date(Utilities.formatDate(d, tz, "yyyy-MM-dd"));
  const today = new Date(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
  return Math.round((target - today) / 86400000);
}

// ======================= รอบวันหยุด: เช็คจำนวนคนขั้นต่ำ =======================

// รันครั้งเดียวจาก editor (รันซ้ำได้ ไม่สร้างซ้ำ) เพื่อตั้งเวลา
//  - checkWeekendQuorum  ทุกวันช่วง 08:00-09:00
//  - dailyAdminNotify    ทุกวันช่วง 10:00-11:00 (ข้อความโพสต์ในวันเล่น)
//  - bookCourtNotify     ทุกวันช่วง 12:00-13:00 (แจ้งจำนวนคนรอบวันหยุดเพื่อจองคอร์ด)
function setupTriggers() {
  const handlers = ["checkWeekendQuorum", "dailyAdminNotify", "bookCourtNotify"];
  ScriptApp.getProjectTriggers()
    .filter(t => handlers.indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkWeekendQuorum")
    .timeBased().everyDays(1).atHour(8).inTimezone("Asia/Bangkok").create();
  ScriptApp.newTrigger("dailyAdminNotify")
    .timeBased().everyDays(1).atHour(10).inTimezone("Asia/Bangkok").create();
  ScriptApp.newTrigger("bookCourtNotify")
    .timeBased().everyDays(1).atHour(12).inTimezone("Asia/Bangkok").create();
}

// ======================= แจ้งแอดมินทุกวัน 10:00 =======================

const LIFF_URL = "https://liff.line.me/2011972483-Ji3vTjW3"; // ลิงก์ LIFF ใช้ในข้อความโพสต์ LINE (ตัวแปร {ลิงก์})
const DEFAULT_LINE_TEMPLATE = "{วัน}\n{สนาม}\n\n{รายชื่อ}\n\n🏸🏸🏸🏸🏸\nลงชื่อตีแบด {ลิงก์}";
const TH_DAY_NAMES = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const TH_MONTH_NAMES = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

// สร้างข้อความโพสต์กลุ่ม LINE ฝั่ง server ให้ตรงกับที่หน้าเว็บสร้าง (ใช้เทมเพลต LINE_POST_TEMPLATE ในชีท Settings)
function buildPostText(ss, session, regs, nameById, rules) {
  const tz = "Asia/Bangkok";
  const d = toSessionDate(session.date);
  const isWorkday = session.type === "Workday";
  const dayIdx = +Utilities.formatDate(d, tz, "u") % 7; // 1=จันทร์ ... 7=อาทิตย์ → 0=อาทิตย์
  const dd = +Utilities.formatDate(d, tz, "d"), mm = +Utilities.formatDate(d, tz, "M"), yyyy = +Utilities.formatDate(d, tz, "yyyy");
  const yy = String(yyyy).slice(-2);

  const court = parseFloat(session.cost) || (isWorkday ? 200 : 120);
  const extra = Math.max(0, Number(session.extra) || 0); // ลูกที่เติมเพิ่มหน้างาน รวมอยู่ใน "คนละ"
  const shuttle = rules.SHUTTLECOCK_PRICE * (rules.SHUTTLES_PER_SESSION + extra);
  const total = court + shuttle;
  const splitBy = regs.length > 0 ? Math.min(regs.length, rules.COST_SPLIT_BASE) : rules.COST_SPLIT_BASE;
  const perHead = Math.ceil(total / splitBy);
  const fullPerHead = Math.ceil(total / rules.COST_SPLIT_BASE);
  const costStr = `ค่าคอร์ด ${court} บาท + ค่าลูก ${shuttle} บาท\nคนละ ${perHead} บาท (หาร ${splitBy} คน` +
    `${splitBy < rules.COST_SPLIT_BASE ? ` ถ้าครบ ${rules.COST_SPLIT_BASE} คนเหลือคนละ ${fullPerHead} บาท` : ""})`;

  const numbered = (list, minLines) => {
    let t = "";
    const n = Math.max(minLines, list.length);
    for (let i = 0; i < n; i++) t += `${i + 1}.${list[i] ? " " + (nameById[list[i]] || "") : ""}\n`;
    return t;
  };

  let body;
  if (isWorkday) {
    const cap = rules.WORKDAY_HOUR_CAP;
    if (regs.every(r => String(r.hours || "All") === "All")) {
      body = `⌚18:00 - 20:00\n${numbered(regs.map(r => r.userId), cap)}`;
    } else {
      const l1 = regs.filter(r => inHour1(r.hours)).map(r => r.userId);
      const l2 = regs.filter(r => inHour2(r.hours)).map(r => r.userId);
      body = `⌚18:00 - 19:00\n${numbered(l1, cap)}\n⌚19:00 - 20:00\n${numbered(l2, cap)}`;
    }
  } else {
    const last = new Date(d.getTime() - rules.WEEKEND_CLOSE_DAYS * 86400000);
    const min = rules.WEEKEND_MIN_PLAYERS;
    body = `⌚16:00 - 18:00 (ขั้นต่ำ ${min} คน ลงได้ถึง ${formatThaiDate(last)})\n` +
      numbered(regs.map(r => r.userId), Math.max(min, regs.length + 1));
  }

  const vars = {
    "วัน": `วัน${TH_DAY_NAMES[dayIdx]} ${dd}-${mm}-${yy}`,
    "หัวข้อ": `วัน${TH_DAY_NAMES[dayIdx]}/${dd}/${mm}/${yy}${session.location ? " " + session.location : ""}`,
    "วันที่": `${TH_DAY_NAMES[dayIdx]} ${dd} ${TH_MONTH_NAMES[mm - 1]} ${yyyy + 543}`,
    "สนาม": session.location || "",
    "เวลา": isWorkday ? "18:00-20:00" : "16:00-18:00",
    "ค่าคอร์ด": court, "ค่าลูก": shuttle, "คนละ": perHead, "หาร": splitBy,
    "ค่าใช้จ่าย": costStr,
    "รายชื่อ": body.replace(/\n+$/, ""),
    "ลิงก์": LIFF_URL
  };
  const tpl = String(getSetting(ss, "LINE_POST_TEMPLATE") || "").trim() ? String(getSetting(ss, "LINE_POST_TEMPLATE")) : DEFAULT_LINE_TEMPLATE;
  return tpl.replace(/\{([^{}\n]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// กันส่งซ้ำ ถ้ารันฟังก์ชันซ้ำในวันเดียวกัน
function alreadySent(key) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(key)) return true;
  props.setProperty(key, "1");
  return false;
}

// ทริกเกอร์ทุกวัน 10:00: วันที่มีรอบตี → ส่งข้อความโพสต์กลุ่ม LINE ให้แอดมินคัดลอกไปโพสต์
function dailyAdminNotify() { runAdminNotify("post"); }

// ทริกเกอร์ทุกวัน 12:00: รอบวันหยุดที่อีก BOOK_NOTICE_DAYS วันจะเล่น → แจ้งจำนวนคนที่ลงชื่อ เพื่อให้จองคอร์ด
function bookCourtNotify() { runAdminNotify("book"); }

function runAdminNotify(kind) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);
  const adminIds = getAdminIds(ss);
  if (!adminIds.length) return;

  const rules = getRules(ss);
  const playDayOn = String(getSetting(ss, "NOTIFY_PLAY_DAY")).trim().toUpperCase() !== "FALSE";
  const noticeDays = Number(getSetting(ss, "BOOK_NOTICE_DAYS"));
  const bookDays = !isNaN(noticeDays) && String(getSetting(ss, "BOOK_NOTICE_DAYS")).trim() !== "" ? noticeDays : 2;
  const todayKey = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd");

  const nameById = {};
  getSheetDataAsJSON(ss.getSheetByName("Users")).forEach(u => { nameById[String(u.User_ID).trim()] = String(u.DisplayName); });
  const allRegs = getSheetDataAsJSON(ss.getSheetByName("Registrations"));
  const sessions = getSheetDataAsJSON(ss.getSheetByName("Sessions")).filter(s => s.Session_ID);

  sessions.forEach(row => {
    if (String(row.Status).trim() !== "Open") return;
    const date = toSessionDate(row.Date);
    if (!date) return;
    const days = daysUntil(date);
    const sid = String(row.Session_ID).trim();
    const session = { date: row.Date, type: String(row.Type).trim(), location: String(row.Location).trim(), cost: row.Cost, extra: row.Extra_Shuttles };
    const regs = allRegs
      .filter(r => String(r.Session_ID).trim() === sid)
      .map(r => ({ userId: String(r.User_ID).trim(), hours: String(r.Hours_Joined || "All") }));

    // 1) แจ้งจำนวนคนก่อนวันเล่น เพื่อจองคอร์ด (เฉพาะวันหยุด)
    if (kind === "book" && session.type === "Weekend" && days === bookDays && !alreadySent(`book_${sid}_${todayKey}`)) {
      const names = regs.map(r => nameById[r.userId] || "?").join(", ") || "-";
      const lastReg = new Date(date.getTime() - rules.WEEKEND_CLOSE_DAYS * 86400000);
      const lines = [
        "📣 แจ้งจองคอร์ดรอบวันหยุด",
        `📅 ${formatThaiDate(date)}${session.location ? " • " + session.location : ""} (อีก ${days} วัน)`,
        `👥 ลงชื่อแล้ว ${regs.length} คน (ขั้นต่ำ ${rules.WEEKEND_MIN_PLAYERS})`,
        `📝 ${names}`
      ];
      if (days > rules.WEEKEND_CLOSE_DAYS) lines.push(`ยังรับลงชื่อได้ถึง ${formatThaiDate(lastReg)}`);
      else if (days === rules.WEEKEND_CLOSE_DAYS) lines.push(`ยังรับลงชื่อได้ถึงสิ้นวันนี้ (${formatThaiDate(lastReg)})`);
      if (regs.length < rules.WEEKEND_MIN_PLAYERS) lines.push("⚠️ ตอนนี้ยังไม่ถึงขั้นต่ำ");
      pushToLine(adminIds, lines.join("\n"));
    }

    // 2) วันเล่น: ส่งข้อความโพสต์กลุ่ม
    if (kind === "post" && playDayOn && days === 0 && !alreadySent(`post_${sid}_${todayKey}`)) {
      let post;
      try { post = buildPostText(ss, session, regs, nameById, rules); }
      catch (err) { console.error("buildPostText failed: " + err); return; }
      pushToLine(adminIds, ["📋 ข้อความสำหรับโพสต์กลุ่ม LINE วันนี้ (คัดลอกข้อความถัดไปได้เลย)", post]);
    }
  });
}

// รันจาก editor เพื่อลองส่งข้อความโพสต์ของรอบที่ใกล้ที่สุดให้แอดมิน (ไม่เช็กวัน ไม่กันส่งซ้ำ)
function testDailyNotify() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ids = getAdminIds(ss);
  if (!ids.length) throw new Error("ยังไม่ได้ใส่ ADMIN_LINE_IDS ในชีท Settings");
  const rules = getRules(ss);
  const nameById = {};
  getSheetDataAsJSON(ss.getSheetByName("Users")).forEach(u => { nameById[String(u.User_ID).trim()] = String(u.DisplayName); });
  const allRegs = getSheetDataAsJSON(ss.getSheetByName("Registrations"));
  const next = getSheetDataAsJSON(ss.getSheetByName("Sessions"))
    .filter(s => s.Session_ID && String(s.Status).trim() === "Open" && toSessionDate(s.Date) && daysUntil(toSessionDate(s.Date)) >= 0)
    .sort((a, b) => toSessionDate(a.Date) - toSessionDate(b.Date))[0];
  if (!next) throw new Error("ไม่มีรอบที่เปิดรับอยู่");
  const sid = String(next.Session_ID).trim();
  const regs = allRegs.filter(r => String(r.Session_ID).trim() === sid)
    .map(r => ({ userId: String(r.User_ID).trim(), hours: String(r.Hours_Joined || "All") }));
  const post = buildPostText(ss, { date: next.Date, type: String(next.Type).trim(), location: String(next.Location).trim(), cost: next.Cost, extra: next.Extra_Shuttles }, regs, nameById, rules);
  const res = pushToLine(ids, ["🧪 ทดสอบ: ข้อความโพสต์ของรอบ " + sid, post]);
  if (res.code !== 200) throw new Error("ส่งไม่สำเร็จ: " + res.code + " " + res.body);
}

// รอบวันหยุดที่ปิดรับแล้ว: ถ้าคนไม่ถึงขั้นต่ำ → งดรอบ + แจ้งผู้เล่นทุกคน + แจ้งแอดมิน
// ถ้าครบ → แจ้งแอดมินว่ารอบได้ไปต่อ (แต่ละรอบเช็คครั้งเดียว บันทึกไว้ในคอลัมน์ Quorum_Checked)
function checkWeekendQuorum() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);
  const rules = getRules(ss);
  const results = [];

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ss.getSheetByName("Sessions");
    ensureColumn(sheet, "Quorum_Checked");
    const data = sheet.getDataRange().getValues();
    const cChecked = data[0].map(String).indexOf("Quorum_Checked");
    const regs = getSheetDataAsJSON(ss.getSheetByName("Registrations"));

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[2]).trim() !== "Weekend" || String(row[4]).trim() !== "Open" || isTruthy(row[cChecked])) continue;
      const d = toSessionDate(row[1]);
      if (!d) continue;
      const days = daysUntil(d);
      if (days < 0 || days >= rules.WEEKEND_CLOSE_DAYS) continue;

      const sid = String(row[0]).trim();
      const players = regs.filter(r => String(r.Session_ID).trim() === sid);
      const ok = players.length >= rules.WEEKEND_MIN_PLAYERS;
      if (!ok) sheet.getRange(i + 1, 5).setValue("Cancelled");
      sheet.getRange(i + 1, cChecked + 1).setValue(true);
      results.push({ ok, date: d, location: String(row[3]).trim(), userIds: players.map(p => String(p.User_ID).trim()) });
    }
  } finally {
    lock.releaseLock();
  }
  if (!results.length) return;

  const byId = {};
  getSheetDataAsJSON(ss.getSheetByName("Users")).forEach(u => { byId[String(u.User_ID).trim()] = u; });
  const adminIds = getAdminIds(ss);

  results.forEach(res => {
    const when = `${formatThaiDate(res.date)}${res.location ? " • " + res.location : ""}`;
    const people = res.userIds.map(id => byId[id]).filter(Boolean);
    const names = people.map(u => u.DisplayName).join(", ") || "-";

    if (res.ok) {
      if (adminIds.length) pushToLine(adminIds, `✅ รอบวันหยุดได้ไปต่อ\n📅 ${when}\n👥 ${people.length} คน: ${names}`);
      return;
    }

    const lineIds = people.map(u => String(u.Line_UID || "").trim()).filter(Boolean);
    const noLine = people.filter(u => !String(u.Line_UID || "").trim()).map(u => u.DisplayName);

    if (lineIds.length) {
      pushToLine(lineIds,
        `😢 งดตีรอบวันหยุด\n📅 ${when}\n` +
        `มีคนลงชื่อ ${people.length} คน ไม่ถึง ${rules.WEEKEND_MIN_PLAYERS} คนตามเงื่อนไข จึงขอยกเลิกรอบนี้นะครับ\n` +
        `ไว้เจอกันรอบหน้า 🏸`);
    }
    if (adminIds.length) {
      let msg = `📣 ระบบงดรอบวันหยุดอัตโนมัติ\n📅 ${when}\n👥 ลงชื่อ ${people.length}/${rules.WEEKEND_MIN_PLAYERS} คน: ${names}\n` +
                `แจ้งผู้เล่นทาง LINE แล้ว ${lineIds.length} คน`;
      if (noLine.length) msg += `\n⚠️ คนที่ต้องแจ้งเอง (ไม่ได้ผูก LINE): ${noLine.join(", ")}`;
      pushToLine(adminIds, msg);
    }
  });
}

// ======================= Read helpers =======================

const ALL_DATA_CACHE_KEY = "all_data_v1";
const ALL_DATA_TTL = 30; // วินาที (แก้ชีทด้วยมือจะเห็นผลภายในเวลานี้)

// ผู้ใช้ทุกคนเรียก getAllData ตอนเปิดแอป อ่านชีท 4 แผ่นทุกครั้งช้า จึงแคชไว้สั้นๆ
function getAllDataCached(ss) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(ALL_DATA_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const data = getAllData(ss);
  try {
    const json = JSON.stringify(data);
    if (json.length < 95000) cache.put(ALL_DATA_CACHE_KEY, json, ALL_DATA_TTL); // ขีดจำกัดของ CacheService ~100KB
  } catch (e) {}
  return data;
}

function getAllData(ss) {
  const sessions = getSheetDataAsJSON(ss.getSheetByName("Sessions")).filter(s => s.Session_ID);
  const registrations = getSheetDataAsJSON(ss.getSheetByName("Registrations")).filter(r => r.Session_ID);

  // ไม่ส่ง LINE userId ออกไป ส่งแค่ว่าผูกแล้วหรือยัง
  const users = getSheetDataAsJSON(ss.getSheetByName("Users")).filter(u => u.User_ID).map(u => {
    const { Line_UID, ...rest } = u;
    rest.Linked = !!String(Line_UID || "").trim();
    return rest;
  });

  const settings = {};
  getSheetDataAsJSON(ss.getSheetByName("Settings")).forEach(s => {
    if (s.Key && HIDDEN_SETTINGS.indexOf(s.Key) === -1) settings[s.Key] = s.Value;
  });

  return { sessions, users, registrations, settings };
}

let _settingsMap = null; // อ่านชีท Settings ครั้งเดียวต่อการรัน (เดิมอ่านทั้งชีททุกครั้งที่เรียก getSetting)
function getSetting(ss, key) {
  if (!_settingsMap) {
    _settingsMap = {};
    getSheetDataAsJSON(ss.getSheetByName("Settings")).forEach(s => {
      if (s.Key && !_settingsMap.hasOwnProperty(s.Key)) _settingsMap[s.Key] = s.Value;
    });
  }
  return _settingsMap.hasOwnProperty(key) ? _settingsMap[key] : "";
}

function getSheetDataAsJSON(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      const val = row[i];
      if (val instanceof Date) obj[h] = val.toISOString();
      else if (typeof val === "boolean") obj[h] = val;
      else obj[h] = val === null || val === undefined ? "" : val;
    });
    return obj;
  });
}

function appendByHeaders(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.appendRow(headers.map(h => (obj[h] !== undefined ? obj[h] : "")));
}

// กันชื่อที่ขึ้นต้นด้วย = + - @ ไม่ให้ชีทตีความเป็นสูตร
function safeText(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
