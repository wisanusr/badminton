// Sheet read/write helpers and the cached getAllData payload.

// ไม่ส่งให้หน้าเว็บ (payload สาธารณะ): ความลับ/ค่าฝั่ง server และคีย์เก่าที่ไม่มีโค้ดอ่านแล้ว (แถวยังอยู่ในชีท ไม่ได้ลบ)
const LEGACY_SETTINGS = ["PRICE_WORKDAY", "PRICE_HOLIDAY", "MAX_WORKDAY_INITIAL", "MAX_WORKDAY_EXTENDED"];
const HIDDEN_SETTINGS = ["ADMIN_PASS", "ADMIN_LINE_IDS", "LINE_CHANNEL_ID"].concat(LEGACY_SETTINGS);

const ALL_DATA_CACHE_KEY = "all_data_v4"; // เปลี่ยนเลขเมื่อโครงสร้าง payload เปลี่ยน (v2 เพิ่ม rules/limits, v3 ตัดรอบเก่า, v4 แทน Point_URL ด้วย Has_Point_URL)

const ALL_DATA_TTL = 300; // วินาที ล้างทุกครั้งที่เขียนผ่าน API/trigger ส่วนการแก้ชีทด้วยมือจะเห็นผลภายในเวลานี้ (หรือรัน clearDataCache)

// ล้าง cache ของ getAllData หลังข้อมูลในชีทเปลี่ยน (เรียกจากทุกที่ที่เขียนชีท) รันจาก editor ได้หลังแก้ชีทด้วยมือ
function clearDataCache() {
  CacheService.getScriptCache().remove(ALL_DATA_CACHE_KEY);
}

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

// ช่วงที่หน้าแรกต้องใช้: รอบข้างหน้า + รอบที่เพิ่งผ่านไปไม่เกิน RECENT_DAYS วัน + รอบเก่ากว่านั้นที่ยังค้างเช็คลิสต์
// (แอดมินเห็นเป็น "รอสรุปยอด") ประวัติทั้งหมดดึงแยกผ่าน adminGetHistory ตอนแอดมินเปิดหน้า "จัดการข้อมูล"
const RECENT_DAYS = 30;
const CHECKLIST_TASKS = ["Task2", "Task3", "Task4", "Task5"]; // ต้องตรงกับ TASKS ใน index.html

function isCurrentSession(s) {
  const d = toSessionDate(s.Date);
  if (!d) return false; // วันที่ว่าง/ผิดรูปแบบ: หน้าแรกไม่แสดงอยู่แล้ว (ยังเห็นในประวัติของแอดมิน)
  if (daysUntil(d) >= -RECENT_DAYS) return true;
  return String(s.Status).trim() !== "Cancelled" && !CHECKLIST_TASKS.every(k => isTruthy(s[k]));
}

// รอบและรายชื่อทั้งหมดในชีท (ไม่ตัด)
function getHistory(ss) {
  return {
    sessions: getSheetDataAsJSON(ss.getSheetByName("Sessions")).filter(s => s.Session_ID),
    registrations: getSheetDataAsJSON(ss.getSheetByName("Registrations")).filter(r => r.Session_ID)
  };
}

function getAllData(ss) {
  const all = getHistory(ss);
  // ลิงก์สแกนเก็บแต้มไม่ส่งออกใน payload สาธารณะ (ไม่ให้ใครสแกนก่อนมาตี) ส่งแค่ว่าตั้งแล้วหรือยัง
  const sessions = all.sessions.filter(isCurrentSession).map(s => {
    const { Point_URL, ...rest } = s;
    rest.Has_Point_URL = !!String(Point_URL || "").trim();
    return rest;
  });
  const keep = {};
  sessions.forEach(s => { keep[String(s.Session_ID).trim()] = true; });
  const registrations = all.registrations.filter(r => keep[String(r.Session_ID).trim()]);

  // ไม่ส่ง LINE userId ออกไป ส่งแค่ว่าผูกแล้วหรือยัง
  const users = getSheetDataAsJSON(ss.getSheetByName("Users")).filter(u => u.User_ID).map(u => {
    const { Line_UID, ...rest } = u;
    rest.Linked = !!String(Line_UID || "").trim();
    return rest;
  });

  const settingRows = getSheetDataAsJSON(ss.getSheetByName("Settings"));
  const settings = {};
  settingRows.forEach(s => {
    // Key ซ้ำ: ใช้แถวแรก (ตรงกับ getSetting และหน้าตั้งค่า)
    if (s.Key && HIDDEN_SETTINGS.indexOf(s.Key) === -1 && !settings.hasOwnProperty(s.Key)) settings[s.Key] = s.Value;
  });

  // rules = กติกาที่ตรวจช่วงแล้ว (ตัวเดียวกับที่ server ใช้), limits = ช่วงที่ยอมรับ (ใช้กับช่องกรอกในหน้าตั้งค่า)
  return { sessions, users, registrations, settings, rules: rulesFromSettings(settingRows), limits: SETTING_LIMITS };
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
