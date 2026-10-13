// Group rules (Settings with validated ranges), hour slots and date helpers.

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

// ช่วงค่าที่ยอมรับของ Settings ตัวเลข (ใช้ทั้งตอนบันทึกและตอนอ่านกติกา กันหารศูนย์/ค่าติดลบ)
const SETTING_LIMITS = {
  WORKDAY_HOUR_CAP:     { min: 1, max: 50, int: true },
  WEEKEND_CLOSE_DAYS:   { min: 0, max: 14, int: true },
  WORKDAY_MIN_PLAYERS:  { min: 0, max: 50, int: true },
  WEEKEND_MIN_PLAYERS:  { min: 0, max: 50, int: true },
  COST_SPLIT_BASE:      { min: 1, max: 50, int: true },
  SHUTTLES_PER_SESSION: { min: 0, max: 20, int: true },
  SHUTTLECOCK_PRICE:    { min: 0, max: 1000, int: false },
  BOOK_NOTICE_DAYS:     { min: 0, max: 14, int: true }
};

const BOOL_SETTINGS = ["NOTIFY_CANCEL", "NOTIFY_PLAY_DAY"];

function settingInRange(key, n) {
  const lim = SETTING_LIMITS[key];
  if (!lim) return true;
  return isFinite(n) && n >= lim.min && n <= lim.max && (!lim.int || Math.floor(n) === n);
}

// กติกาจากแถวของชีท Settings ([{Key, Value}, ...]) ค่านอกช่วงหรือไม่ใช่ตัวเลข → ใช้ค่าเริ่มต้น
// เป็นแหล่งความจริงเดียวของกติกา: server ใช้เอง และส่งให้หน้าเว็บผ่าน getAllData (rules)
function rulesFromSettings(rows) {
  const rules = Object.assign({}, DEFAULT_RULES);
  const seen = {};
  rows.forEach(s => {
    if (!rules.hasOwnProperty(s.Key) || seen[s.Key]) return; // Key ซ้ำ: ใช้แถวแรก (ตรงกับ getSetting และหน้าตั้งค่า)
    seen[s.Key] = true;
    if (s.Value === "" || isNaN(Number(s.Value))) return;
    if (settingInRange(s.Key, Number(s.Value))) rules[s.Key] = Number(s.Value);
  });
  return rules;
}

function getRules(ss) {
  return rulesFromSettings(getSheetDataAsJSON(ss.getSheetByName("Settings")));
}

function inHour1(h) { h = String(h || "All"); return h === "All" || h.indexOf("18:00") === 0 || h.indexOf("16:00") === 0; }

function inHour2(h) { h = String(h || "All"); return h === "All" || h.indexOf("19:00") === 0 || h.indexOf("17:00") === 0; }

function isTruthy(v) {
  return v === true || /^(TRUE|Y)$/i.test(String(v).trim());
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
