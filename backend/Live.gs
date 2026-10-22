// On-court pairing board shared between admins: one row per session in the "Live" sheet holding the whole board
// (check-ins, queue with match numbers, games played) as JSON. The page plans the games itself; the server only stores
// the latest board and refuses a save that was based on an older version, so two admins tapping at once never overwrite
// each other (the page re-applies its taps on the newer board and saves again).

const LIVE_SHEET = "Live";
const LIVE_HEADERS = ["Session_ID", "State", "Version", "Updated_At", "Updated_By"];
const LIVE_MAX_CHARS = 45000; // เซลล์ของชีทเก็บได้ไม่เกิน 50,000 ตัวอักษร (คืนหนึ่งใช้ไม่กี่ KB)

// สร้างชีท Live ให้เองครั้งแรกที่ใช้ (ไม่ต้องรอ initialSetup)
function liveSheet(ss) {
  let sheet = ss.getSheetByName(LIVE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LIVE_SHEET);
    styleHeader(sheet.getRange(1, 1, 1, LIVE_HEADERS.length).setValues([LIVE_HEADERS]));
  }
  return sheet;
}

function findLiveRow(sheet, sid) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const values = sheet.getRange(2, 1, last - 1, 3).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === sid) {
      let state = null;
      try { state = JSON.parse(String(values[i][1] || "null")); } catch (e) { state = null; }
      return { row: i + 2, state, version: Number(values[i][2]) || 0 };
    }
  }
  return null;
}

function liveSessionId(payload) {
  const sid = String((payload && payload.session_id) || "").trim();
  if (!sid) fail("BAD_INPUT", "ไม่มีรหัสรอบ");
  return sid;
}

// อ่านกระดานล่าสุดของรอบ (ยังไม่มี = state null, version 0)
function liveGet(ss, payload) {
  const found = findLiveRow(liveSheet(ss), liveSessionId(payload));
  return { status: "success", data: found ? { state: found.state, version: found.version } : { state: null, version: 0 } };
}

// บันทึกกระดาน payload = { session_id, state, base_version } (base_version = เวอร์ชันที่หน้าเว็บแก้ต่อจาก)
// ถ้ามีคนบันทึกไปก่อนแล้ว (เวอร์ชันไม่ตรง) ไม่บันทึก แต่ตอบ status "conflict" พร้อมกระดานล่าสุดให้หน้าเว็บแก้ต่อ
// ต้องถือ lock ตอนเรียก (routeRequest ทำให้)
function liveSave(ss, line, payload) {
  const sid = liveSessionId(payload);
  const state = payload.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("BAD_INPUT", "ข้อมูลจัดคู่ไม่ถูกต้อง");
  const json = JSON.stringify(state);
  if (json.length > LIVE_MAX_CHARS) fail("TOO_BIG", "ข้อมูลจัดคู่ของรอบนี้ใหญ่เกินไป ลองกด \"ล้างทั้งหมด เริ่มใหม่\"");
  if (!findSession(ss, sid)) fail("NOT_FOUND", "ไม่พบรอบตีนี้");

  const sheet = liveSheet(ss);
  const found = findLiveRow(sheet, sid);
  const current = found ? found.version : 0;
  if (Number(payload.base_version) !== current) {
    return { status: "conflict", data: { state: found ? found.state : null, version: current } };
  }
  const version = current + 1;
  const row = [sid, json, version, new Date(), safeText(String(line.name || "").slice(0, 40))];
  if (found) sheet.getRange(found.row, 1, 1, row.length).setValues([row]);
  else appendRowAfterData(sheet, row);
  return { status: "success", data: { version } };
}
