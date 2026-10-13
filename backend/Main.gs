// HTTP entry points (doGet/doPost) and the request router. Every API call goes through handleRequest.

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === "getAllData") return safeRun(() => handleRequest("getAllData", {}, null));
  return createJsonResponse({ status: "success", message: "Badminton API is running" });
}

// หน้าเว็บส่ง POST แบบ text/plain (ไม่มี custom header) เพื่อไม่ให้ติด CORS preflight
function doPost(e) {
  return safeRun(() => {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    return handleRequest(String(body.action || "").trim(), body.payload || {}, body.idToken || null);
  });
}

function safeRun(fn) {
  try {
    return createJsonResponse(fn());
  } catch (err) {
    return createJsonResponse({ status: "error", code: err.code || "ERROR", message: err.message || String(err) });
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handleRequest(action, payload, idToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);

  // อ่านข้อมูลสาธารณะ ไม่ต้อง login (ใช้กับหน้า Public ด้วย)
  if (action === "getAllData") return { status: "success", data: getAllDataCached(ss) };

  // ทุก action ที่เหลือต้องมี LINE ID token ที่ถูกต้อง
  const line = verifyIdToken(ss, idToken);

  if (action === "me") return getMe(ss, line);

  // อ่านอย่างเดียว ไม่ต้องถือ lock: ผู้เล่นกดการ์ดแต้ม หน้าเว็บขอลิงก์แต้มจริงของรอบนั้น
  if (action === "claimPoint") return claimPoint(ss, line, payload);

  // อ่านอย่างเดียว ไม่ต้องถือ lock: ประวัติรอบ/รายชื่อทั้งหมดสำหรับหน้า "จัดการข้อมูล" ของแอดมิน (ไม่ผ่าน cache)
  if (action === "adminGetHistory") {
    requireAdmin(ss, line);
    return { status: "success", data: getHistory(ss) };
  }

  // งานแจ้งเตือนรันหลังปลดล็อก คนอื่นจะได้ไม่ต้องรอ และถ้าส่งไม่สำเร็จก็ไม่กระทบการยกเลิก
  const ctx = { afterUnlock: null };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail("BUSY", "ระบบยุ่งมาก โปรดลองใหม่อีกครั้ง");

  let result;
  try {
    result = dispatchWrite(ss, line, action, payload, ctx);
  } finally {
    clearDataCache(); // ข้อมูลเปลี่ยนแล้ว ให้โหลดใหม่จากชีท
    lock.releaseLock();
  }

  if (ctx.afterUnlock) {
    try { ctx.afterUnlock(); } catch (err) { console.error("Notify failed: " + err); }
  }
  return result;
}

function dispatchWrite(ss, line, action, payload, ctx) {
  switch (action) {
    case "createProfile": return createProfile(ss, line, payload);
    case "linkProfile":   return linkProfile(ss, line, payload);
    case "register":      return register(ss, requireUser(ss, line), payload);

    case "cancel": {
      const user = requireUser(ss, line);
      const res = cancel(ss, user, payload);
      if (res.count > 0) {
        ctx.afterUnlock = () => notifyAdminsCancel(ss, user, payload.session_id, res.removed);
      }
      return { status: res.status, message: res.message, count: res.count };
    }

    case "cancelSession":
      requireAdmin(ss, line);
      return setSessionStatus(ss, payload.session_id, "Cancelled", "ยุบรอบตีนี้เรียบร้อยแล้ว");
    case "openSession":
      requireAdmin(ss, line);
      return setSessionStatus(ss, payload.session_id, "Open", "เปิดรอบตีนี้กลับมาเรียบร้อยแล้ว");
    case "updateTask":
      requireAdmin(ss, line);
      return updateTask(ss, payload);
    case "adminUpdateRegistrations":
      requireAdmin(ss, line);
      return adminUpdateRegistrations(ss, payload);

    // ---- หน้าจัดการข้อมูลของแอดมิน ----
    case "adminGetSettings":
      requireAdmin(ss, line);
      return adminGetSettings(ss);
    case "adminSaveSetting":
      requireAdmin(ss, line);
      return adminSaveSetting(ss, payload);
    case "adminSaveSession":
      requireAdmin(ss, line);
      return adminSaveSession(ss, payload);
    case "adminDeleteSession":
      requireAdmin(ss, line);
      return adminDeleteSession(ss, payload);
    case "adminSaveUser":
      requireAdmin(ss, line);
      return adminSaveUser(ss, payload);
    case "adminUnlinkUser":
      requireAdmin(ss, line);
      return adminUnlinkUser(ss, payload);
    case "adminMergeUsers":
      requireAdmin(ss, line);
      return adminMergeUsers(ss, payload);
    case "adminDeleteUser":
      requireAdmin(ss, line);
      return adminDeleteUser(ss, payload);

    default:
      fail("BAD_ACTION", `ไม่รองรับ action "${action}"`);
  }
}
