// Admin actions: session status, checklist tasks, registration edits, and sheet management (settings, sessions, users).

const TASK_KEY_PATTERN = /^(Task\d+|Extra_Shuttles)$/;

// ลิงก์บัตรสะสมแต้ม (Settings POINT_CARD_URL): ว่าง (ล้างค่า) หรือ https:// เท่านั้น กันค่าอื่นหลุดไปเป็นปลายทางที่ผู้เล่นถูกพาไป
const POINT_URL_PATTERN = /^https:\/\/[^\s]{1,480}$/;

function normalizePointUrl(v) {
  const url = String(v === null || v === undefined ? "" : v).trim();
  if (url !== "" && !POINT_URL_PATTERN.test(url)) fail("BAD_INPUT", "ลิงก์ต้องขึ้นต้นด้วย https://");
  return url;
}

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

// แก้รายชื่อของรอบแบบ delta: { session_id, add:[{User_ID|NEW_x, DisplayName, Hours_Joined, Timestamp?, Payment_Status?}],
// remove:[User_ID], update:[{User_ID, Hours_Joined}], session_status? ("Open"|"Cancelled") }
// แตะเฉพาะคนที่แอดมินแก้ ไม่ทับคนที่ลงชื่อ/ยกเลิกระหว่างที่แอดมินเปิดหน้าแก้ไขค้างไว้
// ยังรับรูปแบบเก่า { registrations:[...] } (เขียนทับทั้งรอบ) ชั่วคราวระหว่างรอ deploy หน้าเว็บใหม่
function adminUpdateRegistrations(ss, payload) {
  const sid = String(payload.session_id || "").trim();
  if (payload.session_status !== undefined) {
    if (["Open", "Cancelled"].indexOf(payload.session_status) === -1) fail("BAD_INPUT", "สถานะไม่ถูกต้อง");
    const res = setSessionStatus(ss, sid, payload.session_status, "");
    if (res.status !== "success") fail("NOT_FOUND", res.message);
  }
  if (payload.add === undefined && payload.remove === undefined && payload.update === undefined && payload.registrations === undefined) {
    return { status: "success", message: "อัปเดตรายชื่อสำเร็จ" };
  }

  const sheet = ss.getSheetByName("Registrations");
  const usersSheet = ss.getSheetByName("Users");
  const values = sheet.getDataRange().getValues();
  const width = values[0].length;
  const hoursOk = h => WORKDAY_HOURS.indexOf(String(h)) !== -1 ? String(h) : "All";

  const newUserId = reg => {
    const uid = String(reg.User_ID || "");
    if (!uid.startsWith("NEW_")) return uid;
    const id = "U" + Date.now() + Math.floor(Math.random() * 1000);
    appendByHeaders(usersSheet, {
      User_ID: id, DisplayName: safeText(String(reg.DisplayName || "Guest").slice(0, 40)),
      Skill_Level: "C", Profile_Pic: "", Join_Date: new Date(), Line_UID: ""
    });
    return id;
  };
  const toRow = (reg, uid) => [
    reg.Timestamp ? new Date(reg.Timestamp) : new Date(),
    sid, uid, hoursOk(reg.Hours_Joined), false, reg.Payment_Status || "Unpaid"
  ];

  let rows = values.slice(1);
  if (payload.registrations !== undefined) {
    // รูปแบบเก่า: แทนที่ทั้งรอบ
    rows = rows.filter(r => String(r[1]).trim() !== sid)
      .concat((payload.registrations || []).map(reg => toRow(reg, newUserId(reg))));
  } else {
    const inSession = r => String(r[1]).trim() === sid;
    const removeIds = (payload.remove || []).map(x => String(x).trim());
    const updates = {};
    (payload.update || []).forEach(u => { updates[String(u.User_ID).trim()] = hoursOk(u.Hours_Joined); });

    rows = rows.filter(r => !(inSession(r) && removeIds.indexOf(String(r[2]).trim()) !== -1));
    rows.forEach(r => {
      const uid = String(r[2]).trim();
      if (inSession(r) && updates.hasOwnProperty(uid)) r[3] = updates[uid];
    });
    const present = {};
    rows.forEach(r => { if (inSession(r)) present[String(r[2]).trim()] = true; });
    (payload.add || []).forEach(reg => {
      const existing = String(reg.User_ID || "");
      if (!existing.startsWith("NEW_") && present[existing.trim()]) return; // มีอยู่แล้ว ไม่เพิ่มซ้ำ
      const uid = newUserId(reg);
      present[uid] = true;
      rows.push(toRow(reg, uid));
    });
  }

  const all = rows.map(r => {
    const row = r.slice(0, width);
    while (row.length < width) row.push("");
    return row;
  });
  if (values.length > 1) sheet.getRange(2, 1, values.length - 1, width).clearContent();
  if (all.length) sheet.getRange(2, 1, all.length, width).setValues(all);
  return { status: "success", message: "อัปเดตรายชื่อสำเร็จ" };
}

const SESSION_TYPES = ["Workday", "Weekend"];

const SESSION_STATUSES = ["Open", "Closed", "Cancelled"];

function sessionTypeForDate(date) {
  return +Utilities.formatDate(date, "Asia/Bangkok", "u") >= 6 ? "Weekend" : "Workday"; // u: 1=จันทร์ ... 7=อาทิตย์
}

const READONLY_SETTINGS = ["ADMIN_PASS", "ADMIN_LINE_IDS", "LINE_CHANNEL_ID"]; // ไม่ส่งออก ไม่ให้แก้ผ่านหน้าเว็บ

const CREATABLE_SETTINGS = ["LINE_POST_TEMPLATE", "POINT_CARD_URL", "POINT_CARD_EXPIRES"];

const CREATABLE_SETTING_DESC = {
  LINE_POST_TEMPLATE: "รูปแบบข้อความโพสต์กลุ่ม LINE (แก้จากหน้าจัดการข้อมูล)",
  POINT_CARD_URL: "ลิงก์บัตรสะสมแต้มของ LINE OA (ผู้เล่นเห็นหลังระบบเช็กว่าลงชื่อ ว่าง = ไม่ส่งการ์ดแต้ม)",
  POINT_CARD_EXPIRES: "วันหมดอายุของลิงก์รับแต้ม yyyy-MM-dd (ถึงวันนี้แจ้งแอดมินให้ใส่ลิงก์ใหม่ ว่าง = ไม่มีวันหมดอายุ)"
};

function adminGetSettings(ss) {
  const seen = {};
  const rows = getSheetDataAsJSON(ss.getSheetByName("Settings"))
    .filter(r => r.Key && READONLY_SETTINGS.indexOf(String(r.Key)) === -1 && LEGACY_SETTINGS.indexOf(String(r.Key)) === -1)
    .filter(r => !seen[r.Key] && (seen[r.Key] = true)) // Key ซ้ำในชีท: แสดงแถวแรกแถวเดียว
    // วันหมดอายุ: ชีทอาจแปลงเป็นวันที่เอง ส่งให้หน้าเว็บเป็น yyyy-MM-dd เสมอ
    .map(r => ({ Key: String(r.Key), Value: r.Key === "POINT_CARD_EXPIRES" ? cardExpiryText(r.Value) : r.Value, Description: r.Description || "" }));
  return { status: "success", data: rows };
}

function adminSaveSetting(ss, payload) {
  const key = String(payload.key || "").trim();
  if (!key) fail("BAD_INPUT", "ไม่มีชื่อ Key");
  if (READONLY_SETTINGS.indexOf(key) !== -1) fail("FORBIDDEN", "ค่านี้แก้ผ่านหน้าเว็บไม่ได้");
  let value = typeof payload.value === "string" ? safeText(payload.value.trim()) : payload.value;

  if (key === "POINT_CARD_URL") value = normalizePointUrl(value);
  if (key === "POINT_CARD_EXPIRES") {
    value = String(value === null || value === undefined ? "" : value).trim();
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
    if (value !== "" && !ok) fail("BAD_INPUT", "วันหมดอายุไม่ถูกต้อง");
  }

  const lim = SETTING_LIMITS[key];
  if (lim) {
    const n = Number(value);
    if (String(value).trim() === "" || !settingInRange(key, n)) {
      fail("BAD_INPUT", `ค่าต้องเป็น${lim.int ? "จำนวนเต็ม" : "ตัวเลข"}ระหว่าง ${lim.min}–${lim.max}`);
    }
    value = n;
  } else if (BOOL_SETTINGS.indexOf(key) !== -1) {
    const v = String(value).trim().toUpperCase();
    if (v !== "TRUE" && v !== "FALSE") fail("BAD_INPUT", "ค่าต้องเป็น TRUE หรือ FALSE");
    value = v;
  }

  const sheet = ss.getSheetByName("Settings");
  const keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues().map(r => String(r[0]).trim());
  const idx = keys.indexOf(key);
  if (idx === -1) {
    // Key ที่หน้าเว็บสร้างเองได้ (ยังไม่เคยตั้งค่าในชีท)
    if (CREATABLE_SETTINGS.indexOf(key) === -1) fail("NOT_FOUND", "ไม่พบ Key นี้ในชีท Settings");
    appendRowAfterData(sheet, [key, value, CREATABLE_SETTING_DESC[key] || ""]);
  } else {
    sheet.getRange(idx + 1, 2).setValue(value);
  }
  CacheService.getScriptCache().remove("setup_ok");
  return { status: "success", message: "บันทึกการตั้งค่าแล้ว" };
}

function adminSaveSession(ss, payload) {
  const status = String(payload.status || "Open").trim();
  const location = safeText(String(payload.location || "").trim().slice(0, 60));
  const cost = Number(payload.cost);
  if (SESSION_STATUSES.indexOf(status) === -1) fail("BAD_INPUT", "สถานะไม่ถูกต้อง");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date || ""))) fail("BAD_INPUT", "วันที่ไม่ถูกต้อง");
  if (!location) fail("BAD_INPUT", "กรุณาใส่สนาม");
  if (isNaN(cost) || cost < 0) fail("BAD_INPUT", "ค่าคอร์ดไม่ถูกต้อง");
  const date = Utilities.parseDate(payload.date, "Asia/Bangkok", "yyyy-MM-dd");
  // ประเภทรอบดูจากวันที่เอง: เสาร์-อาทิตย์ = วันหยุด ที่เหลือ = วันธรรมดา (ยังรับ payload.type เพื่อรองรับหน้าเว็บเวอร์ชันเก่า)
  const type = payload.type !== undefined && String(payload.type).trim() !== "" ? String(payload.type).trim() : sessionTypeForDate(date);
  if (SESSION_TYPES.indexOf(type) === -1) fail("BAD_INPUT", "ประเภทรอบไม่ถูกต้อง");
  const sheet = ss.getSheetByName("Sessions");
  const formulaCols = formulaDrivenColumns(sheet, ["Type", "Location", "Cost"]);
  if (formulaCols.length) {
    fail("FORMULA_COLUMN", `คอลัมน์ ${formulaCols.join(", ")} ในชีท Sessions เป็นสูตร ระบบจึงไม่บันทึกให้ (เขียนทับสูตรแล้วทั้งคอลัมน์จะว่างเป็น #REF!) แปลงเป็นค่าธรรมดาก่อน (คัดลอก แล้ววางเฉพาะค่า) หรือเพิ่ม/แก้รอบในชีทโดยตรง`);
  }
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

// ลบทุกแถวที่คอลัมน์ตรงค่า ด้วยการเขียนกลับครั้งเดียว (เร็วกว่า deleteRow ทีละแถว)
function deleteRowsWhere(sheet, colIndex, value) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return 0;
  const width = data[0].length;
  const kept = data.slice(1).filter(r => String(r[colIndex]).trim() !== value);
  const n = data.length - 1 - kept.length;
  if (n === 0) return 0;
  sheet.getRange(2, 1, data.length - 1, width).clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, width).setValues(kept);
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

// รวมบัญชี: คนที่เคยลงชื่อด้วยโปรไฟล์เก่า (ไม่ผูก LINE) แต่มาสร้างโปรไฟล์ใหม่ตอนผูก LINE
// เก็บ User_ID เก่า (keep_id) ย้ายการผูก LINE + รูปจากบัญชีใหม่ (merge_id) มาไว้ที่บัญชีเก่า ย้ายรายชื่อที่ลงไว้ แล้วลบบัญชีใหม่
// รอบที่ keep_id ลงไว้แล้ว ไม่ย้ายซ้ำ (เก็บของเดิม)
function adminMergeUsers(ss, payload) {
  const keepId = String(payload.keep_id || "").trim();
  const mergeId = String(payload.merge_id || "").trim();
  if (!keepId || !mergeId || keepId === mergeId) fail("BAD_INPUT", "เลือกบัญชีที่จะรวมให้ถูกต้อง");

  const keep = findUserRow(ss, keepId);
  const merge = findUserRow(ss, mergeId);
  const t = keep.t;
  const cLine = t.col("Line_UID"), cPic = t.col("Profile_Pic");
  const keepLine = String(t.values[keep.row - 1][cLine] || "").trim();
  const mergeLine = String(t.values[merge.row - 1][cLine] || "").trim();
  if (keepLine && mergeLine) fail("BAD_INPUT", "ทั้งสองบัญชีผูก LINE อยู่ ปลดการผูกของบัญชีใดบัญชีหนึ่งก่อน");

  // ย้ายรายชื่อก่อน (ยังไม่แตะชีท Users) ถ้าขั้นนี้พลาด ข้อมูลสมาชิกยังอยู่ครบ
  const regSheet = ss.getSheetByName("Registrations");
  const data = regSheet.getDataRange().getValues();
  const width = data[0].length;
  const inKeep = {};
  data.slice(1).forEach(r => { if (String(r[2]).trim() === keepId) inKeep[String(r[1]).trim()] = true; });
  let moved = 0, dropped = 0;
  const rows = data.slice(1).map(r => {
    if (String(r[2]).trim() !== mergeId) return r;
    if (inKeep[String(r[1]).trim()]) { dropped++; return null; }
    moved++;
    const out = r.slice();
    out[2] = keepId;
    return out;
  }).filter(Boolean);
  if (moved || dropped) {
    regSheet.getRange(2, 1, data.length - 1, width).clearContent();
    if (rows.length) regSheet.getRange(2, 1, rows.length, width).setValues(rows);
  }

  if (mergeLine) {
    t.sheet.getRange(keep.row, cLine + 1).setValue(mergeLine);
    const pic = cPic === -1 ? "" : String(t.values[merge.row - 1][cPic] || "").trim();
    if (pic) t.sheet.getRange(keep.row, cPic + 1).setValue(pic);
  }
  t.sheet.deleteRow(merge.row);
  return { status: "success", message: `รวมบัญชีแล้ว (ย้ายรายชื่อ ${moved} รอบ${dropped ? `, ข้ามที่ซ้ำ ${dropped}` : ""})` };
}

function adminDeleteUser(ss, payload) {
  const uid = String(payload.user_id || "").trim();
  const { t, row } = findUserRow(ss, uid);
  deleteRowsWhere(ss.getSheetByName("Registrations"), 2, uid);
  t.sheet.deleteRow(row);
  return { status: "success", message: "ลบสมาชิกแล้ว" };
}
