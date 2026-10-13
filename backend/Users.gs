// Users sheet: lookup by LINE uid, first-time profile creation, linking an old profile to a LINE account.

function getUsersTable(ss) {
  const sheet = ss.getSheetByName("Users");
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  return { sheet, values, col: name => headers.indexOf(name) };
}

function findUserByLineUid(ss, lineUid, table) {
  const t = table || getUsersTable(ss);
  const cLine = t.col("Line_UID"), cId = t.col("User_ID"), cName = t.col("DisplayName");
  if (cLine === -1) return null;
  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cLine]).trim() === lineUid) {
      return { User_ID: String(t.values[i][cId]), DisplayName: String(t.values[i][cName]), lineUid };
    }
  }
  return null;
}

function toClientUser(ss, user) {
  return { User_ID: user.User_ID, DisplayName: user.DisplayName, isAdmin: isAdmin(ss, user.lineUid) };
}

// อัปเดตรูปโปรไฟล์ในชีท Users ให้ตรงกับรูป LINE ล่าสุด (เพื่อนจะได้เห็นรูปของกันและกัน)
function syncProfilePic(line, t) {
  if (!line.picture) return;
  const cLine = t.col("Line_UID"), cPic = t.col("Profile_Pic");
  if (cLine === -1) return;
  if (cPic === -1) { ensureColumn(t.sheet, "Profile_Pic"); return; }
  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cLine]).trim() !== line.lineUid) continue;
    if (String(t.values[i][cPic]).trim() !== line.picture) t.sheet.getRange(i + 1, cPic + 1).setValue(line.picture);
    return;
  }
}

function getMe(ss, line) {
  const t = getUsersTable(ss); // อ่านชีท Users ครั้งเดียว ใช้ทั้งหาผู้ใช้และซิงค์รูป
  syncProfilePic(line, t);
  const user = findUserByLineUid(ss, line.lineUid, t);
  return {
    status: "success",
    data: {
      line: { name: line.name, picture: line.picture },
      user: user ? toClientUser(ss, user) : null
    }
  };
}

function createProfile(ss, line, payload) {
  const existing = findUserByLineUid(ss, line.lineUid);
  if (existing) return { status: "success", data: toClientUser(ss, existing) };

  const name = safeText(String(payload.display_name || line.name || "").trim().slice(0, 40));
  if (!name) fail("BAD_INPUT", "กรุณาใส่ชื่อ");

  const newId = "U" + Date.now();
  appendByHeaders(ss.getSheetByName("Users"), {
    User_ID: newId, DisplayName: name, Skill_Level: "C",
    Profile_Pic: line.picture, Join_Date: new Date(), Line_UID: line.lineUid
  });
  return { status: "success", data: { User_ID: newId, DisplayName: name, isAdmin: isAdmin(ss, line.lineUid) } };
}

// ผูกบัญชี LINE กับโปรไฟล์เดิม (ทำได้ครั้งเดียวต่อโปรไฟล์)
function linkProfile(ss, line, payload) {
  if (findUserByLineUid(ss, line.lineUid)) fail("ALREADY_LINKED", "บัญชี LINE นี้ผูกกับโปรไฟล์แล้ว");

  const t = getUsersTable(ss);
  const cId = t.col("User_ID"), cName = t.col("DisplayName"), cLine = t.col("Line_UID"), cPic = t.col("Profile_Pic");
  const targetId = String(payload.user_id || "").trim();

  for (let i = 1; i < t.values.length; i++) {
    if (String(t.values[i][cId]).trim() !== targetId) continue;
    if (String(t.values[i][cLine]).trim()) fail("TAKEN", "โปรไฟล์นี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อแอดมิน");

    t.sheet.getRange(i + 1, cLine + 1).setValue(line.lineUid);
    if (cPic !== -1 && line.picture) t.sheet.getRange(i + 1, cPic + 1).setValue(line.picture);
    return {
      status: "success",
      data: { User_ID: targetId, DisplayName: String(t.values[i][cName]), isAdmin: isAdmin(ss, line.lineUid) }
    };
  }
  fail("NOT_FOUND", "ไม่พบโปรไฟล์นี้");
}
