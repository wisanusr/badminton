// Sheet read/write helpers and the cached getAllData payload.

const HIDDEN_SETTINGS = ["ADMIN_PASS", "ADMIN_LINE_IDS"];

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
