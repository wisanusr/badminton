// Admin actions: session status, checklist tasks, registration edits, and sheet management (settings, sessions, users).

const TASK_KEY_PATTERN = /^(Task\d+|Extra_Shuttles)$/;

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
  let value = typeof payload.value === "string" ? safeText(payload.value.trim()) : payload.value;

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

function adminDeleteUser(ss, payload) {
  const uid = String(payload.user_id || "").trim();
  const { t, row } = findUserRow(ss, uid);
  deleteRowsWhere(ss.getSheetByName("Registrations"), 2, uid);
  t.sheet.deleteRow(row);
  return { status: "success", message: "ลบสมาชิกแล้ว" };
}
