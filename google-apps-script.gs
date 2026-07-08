const CONFIG = {
  SPREADSHEET_ID: '1jntQZj1u9nb2eypIQcfrdnbe3CeVvBLY5jphTo-Q1TQ',
  EMPLOYEES_SHEET: 'Employees',
  USERS_SHEET: 'Users',
  RUNS_SHEET: 'Runs',
  OTP_SHEET: 'Otp',
  DRIVE_FOLDER_ID: '1GuVb0RtKR24dpBiJhO9ITSgrxCpg9J1-'
};

function doGet() {
  return jsonOutput({
    ok: true,
    message: 'INVE BURN RUNNING 2026 API is running'
  });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    const handlers = {
      lookupEmployee,
      register,
      login,
      requestOtp,
      resetPassword,
      addRun,
      getDashboard
    };

    if (!handlers[action]) {
      throw new Error('ไม่พบ action ที่ร้องขอ');
    }

    return jsonOutput(handlers[action](body));
  } catch (err) {
    return jsonOutput({
      ok: false,
      message: err.message
    });
  }
}

function setupSheets() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, CONFIG.EMPLOYEES_SHEET, ['Emp ID', 'Prefix', 'FirstName', 'LastName', 'Department', 'Email', 'Status']);
  ensureSheet_(ss, CONFIG.USERS_SHEET, ['code', 'name', 'department', 'goal', 'passwordHash', 'registeredAt']);
  ensureSheet_(ss, CONFIG.RUNS_SHEET, ['id', 'code', 'name', 'department', 'distance', 'date', 'note', 'imageUrl', 'createdAt']);
  ensureSheet_(ss, CONFIG.OTP_SHEET, ['code', 'otp', 'expiresAt', 'used', 'createdAt']);
}

function lookupEmployee(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const employee = findEmployee_(code);
  if (!employee) throw new Error('ไม่พบรหัสพนักงานนี้');

  return {
    ok: true,
    employee: employeeToDto_(employee)
  };
}

function register(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const goal = Number(body.goal);
  const password = String(body.password || '');

  if (!goal) throw new Error('กรุณาเลือกระยะกิโล');
  if (password.length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');

  const employee = findEmployee_(code);
  if (!employee) throw new Error('ไม่พบข้อมูลพนักงาน');

  const usersSheet = getSheet_(CONFIG.USERS_SHEET);
  const users = sheetToObjects_(usersSheet);
  const userIndex = users.findIndex(row => codeMatches_(row.code, code));
  const employeeDto = employeeToDto_(employee);
  const userRow = [employeeDto.code, employeeDto.name, employeeDto.department, goal, hashPassword_(password), new Date()];

  if (userIndex >= 0) {
    usersSheet.getRange(userIndex + 2, 1, 1, userRow.length).setValues([userRow]);
  } else {
    usersSheet.appendRow(userRow);
  }

  return {
    ok: true,
    employee: buildUserSummary_(code)
  };
}

function login(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const password = String(body.password || '');
  const user = findUser_(code);

  if (!user || user.passwordHash !== hashPassword_(password)) {
    throw new Error('รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');
  }

  return {
    ok: true,
    employee: buildUserSummary_(code),
    runs: getRunsByCode_(code)
  };
}

function requestOtp(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const employee = findEmployee_(code);
  if (!employee) throw new Error('ไม่พบรหัสพนักงานนี้');

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  getSheet_(CONFIG.OTP_SHEET).appendRow([code, otp, expiresAt, false, new Date()]);

  if (employee.email) {
    MailApp.sendEmail({
      to: employee.email,
      subject: 'OTP เปลี่ยนรหัสผ่าน INVE BURN RUNNING 2026',
      htmlBody: `<p>รหัส OTP ของคุณคือ <b>${otp}</b></p><p>รหัสนี้หมดอายุภายใน 10 นาที</p>`
    });
  }

  return {
    ok: true,
    message: employee.email ? 'ส่ง OTP ไปยังอีเมลพนักงานแล้ว' : `สร้าง OTP แล้ว: ${otp}`
  };
}

function resetPassword(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const otp = String(body.otp || '').trim();
  const newPassword = String(body.newPassword || '');

  if (newPassword.length < 6) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  validateOtp_(code, otp);

  const usersSheet = getSheet_(CONFIG.USERS_SHEET);
  const users = sheetToObjects_(usersSheet);
  const userIndex = users.findIndex(row => normalizeCode_(row.code) === code);
  if (userIndex < 0) throw new Error('ยังไม่ได้ลงทะเบียน');

  usersSheet.getRange(userIndex + 2, 5).setValue(hashPassword_(newPassword));
  markOtpUsed_(code, otp);

  return { ok: true };
}

function addRun(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const user = findUser_(code);
  if (!user) throw new Error('กรุณาเข้าสู่ระบบก่อนบันทึกผล');

  const distance = Number(body.distance);
  if (!distance || distance <= 0) throw new Error('กรุณากรอกระยะทางที่ถูกต้อง');

  const runDate = body.date ? new Date(body.date) : new Date();
  const runNumber = getRunsByCode_(code).length + 1;
  const imageUrl = saveImage_(body.imageData, {
    code: user.code,
    name: user.name,
    date: runDate,
    runNumber
  });
  getSheet_(CONFIG.RUNS_SHEET).appendRow([
    Utilities.getUuid(),
    user.code,
    user.name,
    user.department,
    distance,
    runDate,
    body.note || '',
    imageUrl,
    new Date()
  ]);

  return {
    ok: true,
    employee: buildUserSummary_(code),
    runs: getRunsByCode_(code)
  };
}

function getDashboard(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  return {
    ok: true,
    employee: code ? buildUserSummary_(code) : null,
    leaderboard: getLeaderboard_(),
    stats: getStats_(),
    runs: code ? getRunsByCode_(code) : []
  };
}

function getStats_() {
  const users = sheetToObjects_(getSheet_(CONFIG.USERS_SHEET));
  const runs = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  const totalDistance = runs.reduce((sum, row) => sum + Number(row.distance || 0), 0);
  const leaderboard = getLeaderboard_();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const todayRuns = runs.filter(row => Utilities.formatDate(new Date(row.date), Session.getScriptTimeZone(), 'yyyy-MM-dd') === today);
  const todayByCode = todayRuns.reduce((map, row) => {
    map[row.code] = (map[row.code] || 0) + Number(row.distance || 0);
    return map;
  }, {});
  const todayTopCode = Object.keys(todayByCode).sort((a, b) => todayByCode[b] - todayByCode[a])[0];
  const todayTop = todayTopCode ? users.find(row => row.code === todayTopCode) : leaderboard[0];

  return {
    participants: users.length,
    totalDistance,
    averageDistance: users.length ? totalDistance / users.length : 0,
    todayTop: todayTop ? {
      code: todayTop.code,
      name: todayTop.name,
      distance: todayTopCode ? todayByCode[todayTopCode] : Number(todayTop.total || 0)
    } : null
  };
}

function getLeaderboard_() {
  const users = sheetToObjects_(getSheet_(CONFIG.USERS_SHEET));
  const runs = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  const totals = runs.reduce((map, row) => {
    const code = normalizeCode_(row.code);
    map[code] = (map[code] || 0) + Number(row.distance || 0);
    return map;
  }, {});

  return users
    .map(user => ({
      code: user.code,
      name: user.name,
      department: user.department,
      goal: Number(user.goal || 0),
      total: Number(totals[normalizeCode_(user.code)] || 0)
    }))
    .sort((a, b) => b.total - a.total);
}

function buildUserSummary_(code) {
  const user = findUser_(code);
  if (!user) throw new Error('ยังไม่ได้ลงทะเบียน');
  const total = getRunsByCode_(code).reduce((sum, row) => sum + Number(row.distance || 0), 0);

  return {
    code: user.code,
    name: user.name,
    department: user.department,
    goal: Number(user.goal || 0),
    total
  };
}

function getRunsByCode_(code) {
  let cumulative = 0;
  return sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET))
    .filter(row => codeMatches_(row.code, code))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(row => {
      cumulative += Number(row.distance || 0);
      return {
        id: row.id,
        code: row.code,
        distance: Number(row.distance || 0),
        date: row.date,
        note: row.note || '',
        imageUrl: row.imageUrl || '',
        cumulative
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function findEmployee_(code) {
  return sheetToObjects_(getSheet_(CONFIG.EMPLOYEES_SHEET))
    .find(row => {
      const employee = employeeToDto_(row);
      return codeMatches_(employee.code, code) && String(employee.status || 'active').toLowerCase() !== 'inactive';
    });
}

function findUser_(code) {
  return sheetToObjects_(getSheet_(CONFIG.USERS_SHEET))
    .find(row => codeMatches_(row.code, code));
}

function validateOtp_(code, otp) {
  const rows = sheetToObjects_(getSheet_(CONFIG.OTP_SHEET));
  const match = rows
    .map((row, index) => ({ ...row, rowNumber: index + 2 }))
    .reverse()
    .find(row => codeMatches_(row.code, code) && String(row.otp) === otp && String(row.used).toLowerCase() !== 'true');

  if (!match) throw new Error('OTP ไม่ถูกต้อง');
  if (new Date(match.expiresAt).getTime() < Date.now()) throw new Error('OTP หมดอายุแล้ว');
}

function markOtpUsed_(code, otp) {
  const sheet = getSheet_(CONFIG.OTP_SHEET);
  const rows = sheetToObjects_(sheet);
  const index = rows.findIndex(row => codeMatches_(row.code, code) && String(row.otp) === otp && String(row.used).toLowerCase() !== 'true');
  if (index >= 0) sheet.getRange(index + 2, 4).setValue(true);
}

function saveImage_(imageData, fileInfo) {
  if (!imageData) return '';
  if (!CONFIG.DRIVE_FOLDER_ID) return imageData;

  const match = String(imageData).match(/^data:(image\/(?:png|jpeg));base64,(.+)$/);
  if (!match) throw new Error('รูปภาพไม่ถูกต้อง');

  const extension = match[1] === 'image/png' ? 'png' : 'jpg';
  const dateText = Utilities.formatDate(new Date(fileInfo.date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const safeName = sanitizeFileName_(`ครั้งที่ ${fileInfo.runNumber} ${fileInfo.code} ${fileInfo.name} ${dateText}.${extension}`);
  const blob = Utilities.newBlob(
    Utilities.base64Decode(match[2]),
    match[1],
    safeName
  );
  const file = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function sanitizeFileName_(fileName) {
  return String(fileName)
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashPassword_(password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password));
  return raw.map(byte => {
    const value = (byte + 256) % 256;
    return value.toString(16).padStart(2, '0');
  }).join('');
}

function normalizeCode_(code) {
  return String(code || '').trim().toUpperCase();
}

function codeMatches_(left, right) {
  const leftCode = normalizeCode_(left);
  const rightCode = normalizeCode_(right);
  if (leftCode === rightCode) return true;
  if (/^\d+$/.test(leftCode) && /^\d+$/.test(rightCode)) {
    return Number(leftCode) === Number(rightCode);
  }
  return false;
}

function employeeToDto_(row) {
  const code = getRowValue_(row, ['code', 'Emp ID', 'Employee ID', 'รหัสพนักงาน']);
  const prefix = getRowValue_(row, ['prefix', 'Prefix', 'คำนำหน้า']);
  const firstName = getRowValue_(row, ['firstName', 'FirstName', 'First Name', 'ชื่อ']);
  const lastName = getRowValue_(row, ['lastName', 'LastName', 'Last Name', 'นามสกุล']);
  const explicitName = getRowValue_(row, ['name', 'Name', 'FullName', 'Full Name', 'ชื่อ-นามสกุล']);
  const department = getRowValue_(row, ['department', 'Department', 'แผนก']);
  const email = getRowValue_(row, ['email', 'Email', 'อีเมล']);
  const status = getRowValue_(row, ['status', 'Status', 'สถานะ']);
  const name = explicitName || [prefix, firstName, lastName].filter(Boolean).join(' ').trim();

  return {
    code: normalizeCode_(code),
    prefix,
    firstName,
    lastName,
    name,
    department,
    email,
    status: status || 'active'
  };
}

function getRowValue_(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return '';
}

function getSpreadsheet_() {
  return CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActive();
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`ไม่พบชีต ${name} กรุณารัน setupSheets() ก่อน`);
  return sheet;
}

function ensureSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(row => row.some(Boolean)).map(row => {
    return headers.reduce((obj, header, index) => {
      obj[header] = row[index];
      return obj;
    }, {});
  });
}

function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
