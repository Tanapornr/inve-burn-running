const CONFIG = {
  SPREADSHEET_ID: '1jntQZj1u9nb2eypIQcfrdnbe3CeVvBLY5jphTo-Q1TQ',
  EMPLOYEES_SHEET: 'Employees',
  USERS_SHEET: 'Users',
  RUNS_SHEET: 'Runs',
  DRIVE_FOLDER_ID: '1GuVb0RtKR24dpBiJhO9ITSgrxCpg9J1-',
  REGISTRATION_START: new Date('2026-07-09T00:00:00+07:00'),
  REGISTRATION_END: new Date('2026-07-31T23:59:59+07:00')
};

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const data = params.action
    ? routeAction_(params)
    : { ok: true, message: 'INVE BURN RUNNING 2026 API is running' };

  if (params.callback) {
    return ContentService
      .createTextOutput(`${params.callback}(${JSON.stringify(data)})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return jsonOutput(data);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  return jsonOutput(routeAction_(body));
}

function routeAction_(body) {
  try {
    const handlers = {
      listEmployees,
      lookupEmployee,
      register,
      login,
      addRun,
      updateProfilePhoto,
      getDashboard,
      systemCheck,
      testDriveUploadAccess
    };
    const action = body.action;
    if (!handlers[action]) throw new Error('ไม่พบ action ที่ร้องขอ');
    setupSheets();
    return handlers[action](body);
  } catch (err) {
    return { ok: false, message: friendlyError_(err) };
  }
}

function setupSheets() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, CONFIG.EMPLOYEES_SHEET, ['Emp ID', 'Prefix', 'FirstName', 'LastName', 'Department', 'Email', 'Status']);
  ensureSheet_(ss, CONFIG.USERS_SHEET, ['code', 'name', 'department', 'goal', 'passwordHash', 'registeredAt', 'profilePhotoBase64']);
  ensureSheet_(ss, CONFIG.RUNS_SHEET, ['id', 'code', 'name', 'department', 'distance', 'date', 'note', 'imageUrl', 'createdAt']);
}

function authorizeDriveAccess() {
  const result = systemCheck();
  Logger.log(JSON.stringify(result));
  return result;
}

function systemCheck() {
  setupSheets();
  const spreadsheet = getSpreadsheet_();
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  return {
    ok: true,
    spreadsheet: spreadsheet.getName(),
    folder: folder.getName(),
    folderId: CONFIG.DRIVE_FOLDER_ID,
    message: 'ระบบพร้อมใช้งาน Google Sheet และ Google Drive'
  };
}

function testDriveUploadAccess() {
  setupSheets();
  const fileName = `INVE_UPLOAD_TEST_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss')}.txt`;
  try {
    const created = createDriveFile_(Utilities.newBlob('INVE BURN RUNNING upload test', 'text/plain', fileName), fileName);
    trashDriveFile_(created.id);
    return {
      ok: true,
      message: 'ทดสอบเขียนไฟล์ Google Drive สำเร็จ ระบบอัปโหลดพร้อมใช้งาน',
      fileName,
      url: created.url,
      method: created.method
    };
  } catch (err) {
    throw new Error(friendlyError_(err));
  }
}

function lookupEmployee(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const employee = findEmployee_(code);
  if (!employee) throw new Error('ไม่พบรหัสพนักงานนี้');
  return { ok: true, employee: employeeToDto_(employee) };
}

function listEmployees() {
  const employees = sheetToObjects_(getSheet_(CONFIG.EMPLOYEES_SHEET))
    .map(employeeToDto_)
    .filter(employee => employee.code && String(employee.status || 'active').toLowerCase() !== 'inactive');
  return { ok: true, employees };
}

function register(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const goal = Number(body.goal);
  const password = String(body.password || '');

  const now = new Date();
  if (now > CONFIG.REGISTRATION_END) throw new Error('ปิดการรับสมัครลงทะเบียนแล้ว');
  if (now < CONFIG.REGISTRATION_START) throw new Error('ยังไม่อยู่ในช่วงรับสมัคร เปิดรับสมัครวันที่ 9 - 31 กรกฎาคม 2569');
  if (![10, 20].includes(goal)) throw new Error('กรุณาเลือกระยะ 10 หรือ 20 KM');
  if (password.length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');

  const employee = findEmployee_(code);
  if (!employee) throw new Error('ไม่พบข้อมูลพนักงาน');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const usersSheet = getSheet_(CONFIG.USERS_SHEET);
    const users = sheetToObjects_(usersSheet);
    const userIndex = users.findIndex(row => codeMatches_(row.code, code));
    if (userIndex >= 0) throw new Error('บัญชีนี้มีอยู่แล้ว กรุณาเข้าสู่ระบบ');

    const employeeDto = employeeToDto_(employee);
    const userRow = [employeeDto.code, employeeDto.name, employeeDto.department, goal, hashPassword_(password), new Date(), ''];
    usersSheet.appendRow(userRow);
  } finally {
    lock.releaseLock();
  }

  return { ok: true, employee: buildUserSummary_(code) };
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

function updateProfilePhoto(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const profilePhotoBase64 = String(body.profilePhotoBase64 || body.imageData || '');
  if (!code) throw new Error('กรุณาระบุรหัสพนักงาน');
  if (!findUser_(code)) throw new Error('ยังไม่ได้ลงทะเบียน');
  if (!/^data:image\/(?:png|jpeg);base64,/i.test(profilePhotoBase64)) throw new Error('รูปโปรไฟล์ไม่ถูกต้อง');
  if (profilePhotoBase64.length > 45000) throw new Error('รูปโปรไฟล์ใหญ่เกินไป กรุณาเลือกรูปใหม่');

  const sheet = getSheet_(CONFIG.USERS_SHEET);
  ensureSheet_(getSpreadsheet_(), CONFIG.USERS_SHEET, ['code', 'name', 'department', 'goal', 'passwordHash', 'registeredAt', 'profilePhotoBase64']);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const codeIndex = headers.indexOf('code');
  const photoIndex = headers.indexOf('profilePhotoBase64');
  if (codeIndex < 0 || photoIndex < 0) throw new Error('ชีต Users ยังไม่พร้อมใช้งาน');

  const rowIndex = values.findIndex((row, index) => index > 0 && codeMatches_(row[codeIndex], code));
  if (rowIndex < 1) throw new Error('ยังไม่ได้ลงทะเบียน');
  sheet.getRange(rowIndex + 1, photoIndex + 1).setValue(profilePhotoBase64);

  return {
    ok: true,
    employee: buildUserSummary_(code),
    leaderboard: getLeaderboard_()
  };
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
    runs: code ? getRunsByCode_(code) : getAllRuns_()
  };
}

function getStats_() {
  const users = sheetToObjects_(getSheet_(CONFIG.USERS_SHEET));
  const runs = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  const totalDistance = runs.reduce((sum, row) => sum + Number(row.distance || 0), 0);
  const leaderboard = getLeaderboard_();
  const top = leaderboard[0] || null;
  return {
    participants: users.length,
    totalDistance,
    averageDistance: users.length ? totalDistance / users.length : 0,
    todayTop: top ? { code: top.code, name: top.name, distance: top.total } : null
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

  return users.map(user => ({
    code: normalizeCode_(user.code),
    name: user.name,
    department: user.department,
    goal: Number(user.goal || 0),
    total: Number(totals[normalizeCode_(user.code)] || 0),
    profilePhotoBase64: user.profilePhotoBase64 || ''
  })).sort((a, b) => b.total - a.total);
}

function buildUserSummary_(code) {
  const user = findUser_(code);
  if (!user) throw new Error('ยังไม่ได้ลงทะเบียน');
  const total = getRunsByCode_(code).reduce((sum, row) => sum + Number(row.distance || 0), 0);
  return {
    code: normalizeCode_(user.code),
    name: user.name,
    department: user.department,
    goal: Number(user.goal || 0),
    total,
    profilePhotoBase64: user.profilePhotoBase64 || ''
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
        code: normalizeCode_(row.code),
        distance: Number(row.distance || 0),
        date: row.date,
        note: row.note || '',
        imageUrl: row.imageUrl || '',
        cumulative
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getAllRuns_() {
  return sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET)).map(row => ({
    id: row.id || '',
    code: normalizeCode_(row.code),
    name: row.name || '',
    department: row.department || '',
    distance: Number(row.distance || 0),
    date: row.date,
    note: row.note || '',
    imageUrl: row.imageUrl || '',
    createdAt: row.createdAt || ''
  }));
}

function findEmployee_(code) {
  return sheetToObjects_(getSheet_(CONFIG.EMPLOYEES_SHEET)).find(row => {
    const employee = employeeToDto_(row);
    return codeMatches_(employee.code, code) && String(employee.status || 'active').toLowerCase() !== 'inactive';
  });
}

function findUser_(code) {
  return sheetToObjects_(getSheet_(CONFIG.USERS_SHEET)).find(row => codeMatches_(row.code, code));
}

function saveImage_(imageData, fileInfo) {
  if (!imageData) return '';
  if (!CONFIG.DRIVE_FOLDER_ID) return imageData;

  const match = String(imageData).match(/^data:(image\/(?:png|jpeg));base64,(.+)$/);
  if (!match) throw new Error('รูปภาพไม่ถูกต้อง');

  const extension = match[1] === 'image/png' ? 'png' : 'jpg';
  const dateText = Utilities.formatDate(new Date(fileInfo.date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const safeName = sanitizeFileName_(`ครั้งที่ ${fileInfo.runNumber} ${fileInfo.code} ${fileInfo.name} ${dateText}.${extension}`);
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], safeName);
    return createDriveFile_(blob, safeName).url;
  } catch (err) {
    throw new Error(friendlyError_(err));
  }
}

function createDriveFile_(blob, fileName) {
  try {
    const file = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (sharingErr) {
      Logger.log(`Skip public sharing for ${fileName}: ${sharingErr.message}`);
    }
    return { id: file.getId(), url: file.getUrl(), method: 'DriveApp' };
  } catch (driveErr) {
    Logger.log(`DriveApp upload failed, fallback to Drive API: ${driveErr.message}`);
    return createDriveFileWithApi_(blob, fileName);
  }
}

function createDriveFileWithApi_(blob, fileName) {
  const boundary = `inve_burn_${Utilities.getUuid()}`;
  const metadata = {
    name: fileName,
    parents: [CONFIG.DRIVE_FOLDER_ID]
  };
  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${blob.getContentType()}`,
    '',
    ''
  ].join('\r\n');
  const tail = `\r\n--${boundary}--`;
  const payload = Utilities.newBlob(head).getBytes()
    .concat(blob.getBytes())
    .concat(Utilities.newBlob(tail).getBytes());

  const response = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'post',
    contentType: `multipart/related; boundary=${boundary}`,
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`
    },
    payload,
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`Google Drive API upload failed (${status}): ${text}`);
  }
  const data = JSON.parse(text);
  return {
    id: data.id,
    url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    method: 'Drive API'
  };
}

function trashDriveFile_(fileId) {
  if (!fileId) return;
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    return;
  } catch (driveErr) {
    Logger.log(`DriveApp trash failed, fallback to Drive API: ${driveErr.message}`);
  }
  UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`
    },
    payload: JSON.stringify({ trashed: true }),
    muteHttpExceptions: true
  });
}

function friendlyError_(err) {
  const message = err && err.message ? String(err.message) : String(err || '');
  if (/Access denied:\s*DriveApp|DriveApp|Authorization is required|required permissions|permission/i.test(message)) {
    return 'อัปโหลดรูปไม่ได้ เพราะ Google Apps Script ยังไม่มีสิทธิ์เขียนไฟล์ใน Google Drive หรือ Deploy ไม่ได้ตั้ง Execute as Me: ให้เปิด Apps Script แล้ว Run ฟังก์ชัน testDriveUploadAccess() จากนั้นกดอนุญาตสิทธิ์ และ Deploy เป็นเวอร์ชันล่าสุด';
  }
  if (/No item with the given ID|File not found|folder/i.test(message)) {
    return 'อัปโหลดรูปไม่ได้ เพราะไม่พบโฟลเดอร์ Google Drive ที่ตั้งไว้ กรุณาตรวจสอบ DRIVE_FOLDER_ID ใน Apps Script';
  }
  return message || 'ระบบข้อมูลไม่สำเร็จ กรุณาลองใหม่';
}

function sanitizeFileName_(fileName) {
  return String(fileName).replace(/[\\/:*?"<>|#%{}~&]/g, '-').replace(/\s+/g, ' ').trim();
}

function hashPassword_(password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password));
  return raw.map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function normalizeCode_(code) {
  const value = String(code || '').trim().toUpperCase();
  return /^\d+$/.test(value) ? value.padStart(3, '0') : value;
}

function codeMatches_(left, right) {
  const leftCode = normalizeCode_(left);
  const rightCode = normalizeCode_(right);
  if (leftCode === rightCode) return true;
  if (/^\d+$/.test(leftCode) && /^\d+$/.test(rightCode)) return Number(leftCode) === Number(rightCode);
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
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return '';
}

function getSpreadsheet_() {
  return CONFIG.SPREADSHEET_ID ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID) : SpreadsheetApp.getActive();
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`ไม่พบชีต ${name} กรุณารัน setupSheets() ก่อน`);
  return sheet;
}

function ensureSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String);
  const missingHeaders = headers.filter(header => !currentHeaders.includes(header));
  if (missingHeaders.length) {
    sheet.getRange(1, currentHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
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
