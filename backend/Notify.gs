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

  let remain = "";
  const notes = [];
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
    remain = `18-19 น. ${h1}/${cap} • 19-20 น. ${h2}/${cap}`;
    lines.push(`👥 เหลือ ${remain}`);
  } else {
    remain = `${regs.length} คน (ขั้นต่ำ ${rules.WEEKEND_MIN_PLAYERS})`;
    lines.push(`👥 เหลือ ${remain}`);
    if (regs.length < rules.WEEKEND_MIN_PLAYERS && daysLeft !== null && daysLeft < rules.WEEKEND_CLOSE_DAYS) {
      lines.push("⚠️ ปิดรับแล้วแต่จำนวนคนไม่ถึงขั้นต่ำ");
      notes.push({ text: "⚠️ ปิดรับแล้วแต่จำนวนคนไม่ถึงขั้นต่ำ", color: ORANGE });
    }
  }
  if (daysLeft === 0 || daysLeft === 1) {
    const soon = `⏰ ยกเลิกกระชั้นชิด (เล่น${daysLeft === 0 ? "วันนี้" : "พรุ่งนี้"})`;
    lines.push(soon);
    notes.push({ text: soon, color: ORANGE });
  }

  const text = lines.join("\n");
  pushCardOrText(adminIds, buildNoticeFlex({
    title: "❌ มีคนยกเลิกคิว", color: RED,
    sub: lines[2].replace("📅 ", ""),
    rows: [["ผู้เล่น", user.DisplayName], ["เวลา", hoursText], ["เหลือ", remain]],
    notes, button: { label: "เปิดแอป", uri: LIFF_URL }
  }, text.replace(/\n/g, " ")), text);
}

// ส่งข้อความหาหลายคนพร้อมกันผ่าน LINE Messaging API (multicast)
// text เป็นสตริงเดียว หรืออาร์เรย์ (ส่งเป็นหลายบับเบิลในครั้งเดียว สูงสุด 5) แต่ละตัวเป็นสตริง = ข้อความธรรมดา หรืออ็อบเจ็กต์ที่มี type (เช่น flex) = ส่งตามนั้น
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
      messages: [].concat(text).slice(0, 5).map(t => (t && typeof t === "object" ? t : { type: "text", text: String(t).slice(0, 5000) }))
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
    if (!/^(book|post|point|pexp)_/.test(k)) return;
    const t = Number(all[k]);
    if (!t || t < cutoff) props.deleteProperty(k); // ค่า "1" แบบเก่าไม่มีเวลา ถือว่าเก่า
  });
}

// ทริกเกอร์ทุกวัน 10:00: วันที่มีรอบตี → ส่งข้อความโพสต์กลุ่ม LINE ให้แอดมินคัดลอกไปโพสต์
function dailyAdminNotify() {
  runAdminNotify("post");
  pointExpiryNotify();
}

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
      const notes = [];
      if (days > rules.WEEKEND_CLOSE_DAYS) notes.push({ text: `ยังรับลงชื่อได้ถึง ${formatThaiDate(lastReg)}` });
      else if (days === rules.WEEKEND_CLOSE_DAYS) notes.push({ text: `ยังรับลงชื่อได้ถึงสิ้นวันนี้ (${formatThaiDate(lastReg)})` });
      if (regs.length < rules.WEEKEND_MIN_PLAYERS) notes.push({ text: "⚠️ ตอนนี้ยังไม่ถึงขั้นต่ำ", color: ORANGE });
      notes.forEach(n => lines.push(n.text));
      const text = lines.join("\n");
      const bookRes = pushCardOrText(adminIds, buildNoticeFlex({
        title: "📣 แจ้งจองคอร์ดรอบวันหยุด", color: ORANGE,
        sub: `${formatThaiDate(date)}${session.location ? " • " + session.location : ""} (อีก ${days} วัน)`,
        rows: [["ลงชื่อแล้ว", `${regs.length} คน (ขั้นต่ำ ${rules.WEEKEND_MIN_PLAYERS})`], ["รายชื่อ", names]],
        notes, button: { label: "เปิดแอป", uri: LIFF_URL }
      }, text.replace(/\n/g, " ")), text);
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

// การ์ดแจ้งเตือนรูปแบบเดียวกันทุกชนิด: หัวข้อสี + บรรทัดรอง + ข้อความ + แถว ชื่อ/ค่า + หมายเหตุ + ปุ่ม (ไม่บังคับ)
// o = { title, color, sub, body, rows: [[label, value]], notes: [{ text, color }], button: { label, uri } }
// altText = ข้อความที่เห็นในแชทลิสต์และการแจ้งเตือนบนหน้าจอ
function buildNoticeFlex(o, altText) {
  const gray = "#6B7280", dark = "#1F2937";
  const body = [{ type: "text", text: o.title, weight: "bold", size: "lg", color: o.color, wrap: true }];
  if (o.sub) body.push({ type: "text", text: o.sub, size: "sm", color: gray, wrap: true });
  if (o.body) {
    body.push({ type: "separator", margin: "md" });
    body.push({ type: "text", text: String(o.body).slice(0, 1000), size: "sm", color: "#374151", wrap: true, margin: "md" });
  }
  if (o.rows && o.rows.length) {
    body.push({ type: "separator", margin: "md" });
    o.rows.forEach(r => body.push({
      type: "box", layout: "baseline", spacing: "sm", margin: "md",
      contents: [
        { type: "text", text: String(r[0]), size: "sm", color: gray, flex: 3 },
        { type: "text", text: String(r[1]).slice(0, 800), size: "sm", color: dark, wrap: true, flex: 7 }
      ]
    }));
  }
  (o.notes || []).forEach(n => body.push({ type: "text", text: String(n.text).slice(0, 500), size: "xs", color: n.color || gray, wrap: true, margin: "md" }));

  const bubble = { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", spacing: "sm", contents: body } };
  if (o.button) {
    bubble.footer = {
      type: "box", layout: "vertical",
      contents: [{ type: "button", style: "primary", color: o.color, height: "sm", action: { type: "uri", label: o.button.label, uri: o.button.uri } }]
    };
  }
  return { type: "flex", altText: String(altText).slice(0, 400), contents: bubble };
}

// ส่งการ์ด ถ้า LINE ปฏิเสธ (400 = ยังไม่มีข้อความไปถึงใคร) ส่งเป็นข้อความธรรมดาแทน ข้อผิดพลาดอื่นๆ คืนค่าให้ผู้เรียกจัดการ (เช่น รอบถัดไปลองใหม่)
function pushCardOrText(userIds, card, fallbackText) {
  const res = pushToLine(userIds, card);
  return res.code === 400 ? pushToLine(userIds, fallbackText) : res;
}

const ORANGE = "#FF9500", RED = "#FF3B30", GREEN = "#34C759";

// การ์ด (Flex Message) ชวนสแกนเก็บแต้ม: หัวข้อ + วัน/สนาม + ปุ่มเปิดลิงก์ ถ้าแสดงการ์ดไม่ได้ จะเห็นข้อความ altText แทน
function buildPointFlex(date, location, url) { // url = ลิงก์เข้าระบบ (ไม่ใช่ลิงก์แต้มจริง) ดู pointGateUrl
  const when = formatThaiDate(date) + (location ? " • " + location : "");
  return {
    type: "flex",
    altText: `🏸 ขอบคุณพี่คนเก่ง รับแต้มสะสมได้ที่ ${url}`.slice(0, 400),
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "🏸 ขอบคุณพี่คนเก่ง", weight: "bold", size: "lg", color: "#1F2937", wrap: true },
          { type: "text", text: when, size: "sm", color: "#6B7280", wrap: true },
          { type: "separator", margin: "md" },
          { type: "text", text: "รับแต้มสะสม แล้วมาตบฟรีได้เลย 🎁", size: "sm", color: "#374151", wrap: true, margin: "md" },
          { type: "text", text: "กดรับได้ภายใน 24 ชั่วโมง", size: "xs", color: "#9CA3AF", margin: "sm" }
        ]
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [{ type: "button", style: "primary", color: "#34C759", height: "sm", action: { type: "uri", label: "รับแต้ม", uri: url } }]
      }
    }
  };
}

const CLAIM_WINDOW_MS = 24 * 3600000; // ผู้เล่นกดรับแต้มได้ภายใน 24 ชั่วโมงหลังได้รับการ์ด

// เวลาที่ส่งการ์ดแต้มของรอบนั้นสำเร็จ (ตัวจดกันส่งซ้ำเก็บเวลาไว้) 0 = ยังไม่ได้ส่ง
function pointCardSentAt(session) {
  const d = toSessionDate(session.Date);
  if (!d) return 0;
  const key = `point_${String(session.Session_ID).trim()}_${Utilities.formatDate(d, "Asia/Bangkok", "yyyyMMdd")}`;
  return Number(PropertiesService.getScriptProperties().getProperty(key)) || 0;
}

// ลิงก์ในการ์ดแต้ม: เปิดแอป (LIFF) พร้อมรหัสรอบ แอปจะให้ผู้เล่นเข้าสู่ระบบ ตรวจสิทธิ์ แล้วพาไปลิงก์แต้มจริง
function pointGateUrl(sessionId) {
  return LIFF_URL + "?claim=" + encodeURIComponent(sessionId);
}

// บัตรสะสมแต้มของ LINE OA: ลิงก์เดียวใช้ทุกรอบ (Settings POINT_CARD_URL) + วันหมดอายุ (POINT_CARD_EXPIRES ไม่ใส่ = ไม่หมดอายุ)
// daysLeft: 0 = วันนี้เป็นวันสุดท้ายที่ใช้ได้, ติดลบ = หมดอายุแล้ว
function getPointCard(ss) {
  const url = String(getSetting(ss, "POINT_CARD_URL") || "").trim();
  const expires = parseCardExpiry(getSetting(ss, "POINT_CARD_EXPIRES"));
  const daysLeft = expires ? daysUntil(expires) : null;
  return { url, expires, daysLeft, expired: daysLeft !== null && daysLeft < 0 };
}

// ชีทเก็บวันหมดอายุเป็นข้อความ yyyy-MM-dd แต่ Google Sheets อาจแปลงเป็นวันที่เอง จึงรับได้ทั้งสองแบบ
function parseCardExpiry(v) {
  if (v === "" || v === null || v === undefined) return null;
  const t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Utilities.parseDate(t, "Asia/Bangkok", "yyyy-MM-dd");
  return toSessionDate(v);
}

function cardExpiryText(v) {
  const d = parseCardExpiry(v);
  return d ? Utilities.formatDate(d, "Asia/Bangkok", "yyyy-MM-dd") : "";
}

// ทริกเกอร์ทุกวัน 21:00: วันเล่น → ส่งการ์ดให้ผู้เล่นที่ลงชื่อ (ผูก LINE แล้ว) ไปรับแต้มบัตรสะสมแต้มของ LINE OA
// ส่งเมื่อตั้งลิงก์บัตรไว้และบัตรยังไม่หมดอายุ (วันสุดท้ายยังส่ง) รอบที่งดไม่ส่ง ผู้เล่นรับเอง ระบบไม่รู้ว่าใครรับแล้ว
function pointReminderNotify() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);
  pruneSentMarkers();
  const card = getPointCard(ss);
  if (!card.url || card.expired) return;

  const todayKey = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd");
  const lineById = {};
  getSheetDataAsJSON(ss.getSheetByName("Users")).forEach(u => { lineById[String(u.User_ID).trim()] = String(u.Line_UID || "").trim(); });
  const allRegs = getSheetDataAsJSON(ss.getSheetByName("Registrations"));

  getSheetDataAsJSON(ss.getSheetByName("Sessions")).forEach(row => {
    if (!row.Session_ID || String(row.Status).trim() === "Cancelled") return;
    const date = toSessionDate(row.Date);
    if (!date || daysUntil(date) !== 0) return;
    const sid = String(row.Session_ID).trim();
    const key = `point_${sid}_${todayKey}`;
    if (wasSent(key)) return;

    const lineIds = allRegs
      .filter(r => String(r.Session_ID).trim() === sid)
      .map(r => lineById[String(r.User_ID).trim()])
      .filter((id, i, a) => id && a.indexOf(id) === i);
    if (!lineIds.length) return;

    // การ์ดชี้ไปที่ระบบ (LIFF) ก่อน ระบบเช็กว่าคนกดลงชื่ออยู่ในรอบนี้แล้วค่อยพาไปลิงก์บัตรจริง ลิงก์จริงไม่ถูกส่งออกไปในข้อความ
    const gateUrl = pointGateUrl(sid);
    const res = pushCardOrText(lineIds, buildPointFlex(date, String(row.Location || "").trim(), gateUrl),
      `🏸 ขอบคุณพี่คนเก่ง (${formatThaiDate(date)})\nรับแต้มสะสม แล้วมาตบฟรีได้เลย 🎁\n${gateUrl}`);
    if (res.code === 200) markSent(key);
  });
}

// ทริกเกอร์ 10:00 (ต่อจาก dailyAdminNotify): ถึงวันหมดอายุของลิงก์รับแต้ม → แจ้งแอดมินให้ไปใส่ลิงก์ใหม่/วันหมดอายุใหม่ในหน้าตั้งค่า
// ถึงวันหมดอายุแจ้งหนึ่งครั้ง หลังจากนั้นถ้ายังไม่อัปเดต แจ้งซ้ำเฉพาะวันที่มีรอบเล่น (วันที่ผู้เล่นจะพลาดแต้ม)
function pointExpiryNotify() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);
  const card = getPointCard(ss);
  if (!card.url || card.daysLeft === null || card.daysLeft > 0) return;
  const adminIds = getAdminIds(ss);
  if (!adminIds.length) return;

  const key = `pexp_${Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd")}`;
  if (wasSent(key)) return;

  if (card.expired) {
    const playToday = getSheetDataAsJSON(ss.getSheetByName("Sessions")).some(s => {
      const d = toSessionDate(s.Date);
      return s.Session_ID && String(s.Status).trim() !== "Cancelled" && d && daysUntil(d) === 0;
    });
    if (!playToday) return;
  }

  const when = formatThaiDate(card.expires);
  const title = card.expired ? "⚠️ ลิงก์รับแต้มหมดอายุแล้ว" : "⏰ ลิงก์รับแต้มหมดอายุวันนี้";
  const note = card.expired
    ? "วันนี้มีรอบเล่น แต่ผู้เล่นจะไม่ได้รับการ์ดแต้ม จนกว่าจะใส่ลิงก์ใหม่และวันหมดอายุใหม่ในหน้าตั้งค่า"
    : "อย่าลืมใส่ลิงก์ใหม่และวันหมดอายุใหม่ในหน้าตั้งค่า หลังจากวันนี้ผู้เล่นจะไม่ได้รับการ์ดแต้ม";
  const res = pushCardOrText(adminIds, buildNoticeFlex({
    title, color: card.expired ? RED : ORANGE,
    rows: [["หมดอายุ", when]], body: note,
    button: { label: "ไปหน้าตั้งค่า", uri: LIFF_URL }
  }, `${title} (${when})`), `${title}\n📅 หมดอายุ ${when}\n${note}`);
  if (res.code === 200) markSent(key);
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
      if (adminIds.length) pushToLine(adminIds, `✅ รอบวันหยุดได้ไปต่อ
📅 ${when}
👥 ${people.length} คน: ${names}`);
      return;
    }

    const lineIds = people.map(u => String(u.Line_UID || "").trim()).filter(Boolean);
    const noLine = people.filter(u => !String(u.Line_UID || "").trim()).map(u => u.DisplayName);

    if (lineIds.length) {
      const reason = `มีคนลงชื่อ ${people.length} คน ไม่ถึง ${rules.WEEKEND_MIN_PLAYERS} คนตามเงื่อนไข จึงขอยกเลิกรอบนี้นะครับ\nไว้เจอกันรอบหน้า 🏸`;
      pushCardOrText(lineIds, buildNoticeFlex({
        title: "😢 งดตีรอบวันหยุด", color: RED, sub: when, body: reason
      }, `😢 งดตีรอบวันหยุด ${when}`), `😢 งดตีรอบวันหยุด\n📅 ${when}\n${reason}`);
    }
    if (adminIds.length) {
      let msg = `📣 ระบบงดรอบวันหยุดอัตโนมัติ\n📅 ${when}\n👥 ลงชื่อ ${people.length}/${rules.WEEKEND_MIN_PLAYERS} คน: ${names}\n` +
                `แจ้งผู้เล่นทาง LINE แล้ว ${lineIds.length} คน`;
      const notes = noLine.length ? [{ text: `⚠️ คนที่ต้องแจ้งเอง (ไม่ได้ผูก LINE): ${noLine.join(", ")}`, color: ORANGE }] : [];
      if (noLine.length) msg += `\n${notes[0].text}`;
      pushCardOrText(adminIds, buildNoticeFlex({
        title: "📣 งดรอบอัตโนมัติ", color: RED, sub: when,
        rows: [["ลงชื่อ", `${people.length}/${rules.WEEKEND_MIN_PLAYERS} คน`], ["รายชื่อ", names], ["แจ้งแล้ว", `${lineIds.length} คน ทาง LINE`]],
        notes, button: { label: "เปิดแอป", uri: LIFF_URL }
      }, `📣 ระบบงดรอบวันหยุดอัตโนมัติ ${when}`), msg);
    }
  });
}
