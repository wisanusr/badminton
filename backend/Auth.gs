// LINE ID-token verification and role checks (admin / registered user).

function verifyIdToken(ss, idToken) {
  if (!idToken) fail("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบด้วย LINE");

  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const channelId = String(getSetting(ss, "LINE_CHANNEL_ID") || "").trim();
  if (!channelId) fail("CONFIG", "ยังไม่ได้ใส่ LINE_CHANNEL_ID ในชีท Settings");

  const res = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText() || "{}");

  if (res.getResponseCode() !== 200) {
    const desc = data.error_description || data.error || "unknown";
    fail(/expired/i.test(desc) ? "AUTH_EXPIRED" : "AUTH_INVALID", "ยืนยันตัวตน LINE ไม่สำเร็จ: " + desc);
  }

  const info = { lineUid: data.sub, name: data.name || "", picture: data.picture || "" };
  // เก็บได้ไม่เกินอายุ token และขีดจำกัด CacheService (6 ชม.) ผู้ใช้ที่เปิดแอปซ้ำในชั่วโมงเดียวกันจะไม่ต้องรอเรียก LINE
  const ttl = Math.max(1, Math.min(21600, data.exp - Math.floor(Date.now() / 1000) - 30));
  cache.put(key, JSON.stringify(info), ttl);
  return info;
}

function getAdminIds(ss) {
  return String(getSetting(ss, "ADMIN_LINE_IDS") || "").split(",").map(s => s.trim()).filter(Boolean);
}

function isAdmin(ss, lineUid) {
  return !!lineUid && getAdminIds(ss).indexOf(lineUid) !== -1;
}

function requireAdmin(ss, line) {
  if (!isAdmin(ss, line.lineUid)) fail("FORBIDDEN", "เฉพาะแอดมินเท่านั้น");
}

function requireUser(ss, line) {
  const user = findUserByLineUid(ss, line.lineUid);
  if (!user) fail("NO_PROFILE", "กรุณาสร้างหรือเลือกโปรไฟล์ก่อน");
  return user;
}
