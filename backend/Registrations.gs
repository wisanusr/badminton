// Player actions: find a session, register, cancel.

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
