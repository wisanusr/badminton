// LINE messages to admins/players, daily post text, weekend quorum check and the time-based trigger handlers.

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
// markSent เรียกหลังส่งสำเร็จเท่านั้น ถ้า LINE ตอบไม่ใช่ 200 รอบถัดไปของ trigger จะลองส่งใหม่
function wasSent(key) {
  return !!PropertiesService.getScriptProperties().getProperty(key);
}

function markSent(key) {
  PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
}

// ล้างเครื่องหมายที่เก่ากว่า 7 วัน ไม่ให้ Script Properties โตขึ้นเรื่อยๆ
function pruneSentMarkers() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const cutoff = Date.now() - 7 * 86400000;
  Object.keys(all).forEach(k => {
    if (!/^(book|post|point)_/.test(k)) return;
    const t = Number(all[k]);
    if (!t || t < cutoff) props.deleteProperty(k); // ค่า "1" แบบเก่าไม่มีเวลา ถือว่าเก่า
  });
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
  pruneSentMarkers();

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
    if (kind === "book" && session.type === "Weekend" && days === bookDays && !wasSent(`book_${sid}_${todayKey}`)) {
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
      const bookRes = pushToLine(adminIds, lines.join("\n"));
      if (bookRes.code === 200) markSent(`book_${sid}_${todayKey}`);
    }

    // 2) วันเล่น: ส่งข้อความโพสต์กลุ่ม
    if (kind === "post" && playDayOn && days === 0 && !wasSent(`post_${sid}_${todayKey}`)) {
      let post;
      try { post = buildPostText(ss, session, regs, nameById, rules); }
      catch (err) { console.error("buildPostText failed: " + err); return; }
      const postRes = pushToLine(adminIds, ["📋 ข้อความสำหรับโพสต์กลุ่ม LINE วันนี้ (คัดลอกข้อความถัดไปได้เลย)", post]);
      if (postRes.code === 200) markSent(`post_${sid}_${todayKey}`);
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

// ทริกเกอร์ทุกวัน 21:00: วันเล่น → ส่งข้อความให้ผู้เล่นที่ลงชื่อ (ผูก LINE แล้ว) ไปสแกนเก็บแต้มบัตรสะสมแต้มของ LINE OA
// ลิงก์เป็นของแต่ละรอบ (คอลัมน์ Point_URL ในชีท Sessions ที่แอดมินวางในหน้ารอบ) รอบที่ไม่มีลิงก์ = ไม่ส่ง
// ผู้เล่นสแกนเอง ระบบไม่รู้ว่าใครสแกนแล้ว
function pointReminderNotify() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);
  pruneSentMarkers();

  const todayKey = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd");
  const lineById = {};
  getSheetDataAsJSON(ss.getSheetByName("Users")).forEach(u => { lineById[String(u.User_ID).trim()] = String(u.Line_UID || "").trim(); });
  const allRegs = getSheetDataAsJSON(ss.getSheetByName("Registrations"));

  getSheetDataAsJSON(ss.getSheetByName("Sessions")).forEach(row => {
    if (!row.Session_ID || String(row.Status).trim() === "Cancelled") return;
    const date = toSessionDate(row.Date);
    const pointUrl = String(row.Point_URL || "").trim();
    if (!pointUrl || !date || daysUntil(date) !== 0) return;
    const sid = String(row.Session_ID).trim();
    const key = `point_${sid}_${todayKey}`;
    if (wasSent(key)) return;

    const lineIds = allRegs
      .filter(r => String(r.Session_ID).trim() === sid)
      .map(r => lineById[String(r.User_ID).trim()])
      .filter((id, i, a) => id && a.indexOf(id) === i);
    if (!lineIds.length) return;

    const res = pushToLine(lineIds, `🏸 ขอบคุณที่มาตีวันนี้ (${formatThaiDate(date)})\nอย่าลืมสแกนเก็บแต้มสะสมนะครับ 🎁\n${pointUrl}`);
    if (res.code === 200) markSent(key);
  });
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
  clearDataCache(); // สถานะรอบอาจถูกเปลี่ยนเป็น Cancelled

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
