// One-time setup run by hand from the Apps Script editor: sheets, columns, default Settings, time-based triggers.

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
  ensureSetting(ss, "POINT_CARD_URL", "", "ลิงก์บัตรสะสมแต้มของ LINE OA (ผู้เล่นเห็นหลังระบบเช็กว่าลงชื่อ ว่าง = ไม่ส่งการ์ดแต้ม)");
  ensureSetting(ss, "POINT_CARD_EXPIRES", "", "วันหมดอายุของลิงก์รับแต้ม yyyy-MM-dd (ถึงวันนี้แจ้งแอดมินให้ใส่ลิงก์ใหม่ ว่าง = ไม่มีวันหมดอายุ)");
  clearDataCache();
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
  clearDataCache();
  Logger.log("ตั้ง Task5 = TRUE ให้ " + n + " รอบ");
}

function ensureSheetsExist(ss) {
  const cache = CacheService.getScriptCache();
  const needsSetup = () => ["Settings", "Users", "Sessions", "Registrations"].some(n => !ss.getSheetByName(n)) || !cache.get("setup_ok");
  if (!needsSetup()) return;

  // ตอน cache ว่าง หลายคำขอ (เช่น me กับ getAllData ตอนเปิดแอป) เข้ามาพร้อมกัน ถ้าต่างคนต่างรัน initialSetup
  // จะเพิ่มแถว Settings ซ้ำ จึงให้ทำทีละคนและเช็คซ้ำหลังได้ lock (คนก่อนหน้าอาจทำเสร็จแล้ว)
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    _settingKeys = null; // อ่านรายชื่อ Key ใหม่หลังได้ lock
    if (!needsSetup()) return;
    initialSetup();
    cache.put("setup_ok", "1", 21600);
  } finally {
    lock.releaseLock();
  }
}

// รันจาก editor ครั้งเดียวถ้าชีท Settings มี Key ซ้ำ: เก็บแถวแรกของแต่ละ Key (ตรงกับที่ getSetting และหน้าตั้งค่าอ่าน/แก้)
// แล้วลบแถวที่ซ้ำ ถ้าค่าของแถวที่ซ้ำต่างจากแถวที่เก็บไว้ จะแสดงใน log เพื่อให้ตรวจเอง
function dedupeSettings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ss.getSheetByName("Settings");
    const values = sheet.getDataRange().getValues();
    const width = values[0].length;
    const seen = {};
    const kept = [];
    const removed = [];
    for (let i = 1; i < values.length; i++) {
      const key = String(values[i][0]).trim();
      if (key && seen.hasOwnProperty(key)) {
        removed.push({ key, kept: seen[key], dropped: values[i][1], differs: String(seen[key]) !== String(values[i][1]) });
        continue;
      }
      if (key) seen[key] = values[i][1];
      kept.push(values[i]);
    }
    if (!removed.length) { Logger.log("ไม่มี Key ซ้ำ"); return removed; }
    sheet.getRange(2, 1, values.length - 1, width).clearContent();
    if (kept.length) sheet.getRange(2, 1, kept.length, width).setValues(kept);
    clearDataCache();
    removed.forEach(r => Logger.log(`ลบแถวซ้ำ ${r.key}: เก็บ "${r.kept}" ลบ "${r.dropped}"${r.differs ? "  ⚠️ ค่าต่างกัน ตรวจว่าค่าที่เก็บไว้ถูกต้อง" : ""}`));
    return removed;
  } finally {
    lock.releaseLock();
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

// รันครั้งเดียวจาก editor (รันซ้ำได้ ไม่สร้างซ้ำ) เพื่อตั้งเวลา
//  - checkWeekendQuorum  ทุกวันช่วง 08:00-09:00
//  - dailyAdminNotify    ทุกวันช่วง 10:00-11:00 (ข้อความโพสต์ในวันเล่น)
//  - bookCourtNotify     ทุกวันช่วง 12:00-13:00 (แจ้งจำนวนคนรอบวันหยุดเพื่อจองคอร์ด)
//  - pointReminderNotify ทุกวันช่วง 21:00-22:00 (ส่งการ์ดรับแต้มให้ผู้ลงชื่อ ถ้าตั้งลิงก์บัตรไว้และบัตรยังไม่หมดอายุ)
function setupTriggers() {
  const handlers = ["checkWeekendQuorum", "dailyAdminNotify", "bookCourtNotify", "pointReminderNotify"];
  ScriptApp.getProjectTriggers()
    .filter(t => handlers.indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkWeekendQuorum")
    .timeBased().everyDays(1).atHour(8).inTimezone("Asia/Bangkok").create();
  ScriptApp.newTrigger("dailyAdminNotify")
    .timeBased().everyDays(1).atHour(10).inTimezone("Asia/Bangkok").create();
  ScriptApp.newTrigger("bookCourtNotify")
    .timeBased().everyDays(1).atHour(12).inTimezone("Asia/Bangkok").create();
  ScriptApp.newTrigger("pointReminderNotify")
    .timeBased().everyDays(1).atHour(21).inTimezone("Asia/Bangkok").create();
}
