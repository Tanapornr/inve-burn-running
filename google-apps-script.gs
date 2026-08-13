const CONFIG = {
  SPREADSHEET_ID: '1jntQZj1u9nb2eypIQcfrdnbe3CeVvBLY5jphTo-Q1TQ',
  EMPLOYEES_SHEET: 'Employees',
  USERS_SHEET: 'Users',
  RUNS_SHEET: 'Runs',
  DRIVE_FOLDER_ID: '1GuVb0RtKR24dpBiJhO9ITSgrxCpg9J1-',
  REGISTRATION_START: new Date('2026-07-09T00:00:00+07:00'),
  REGISTRATION_END: new Date('2026-07-31T23:59:59+07:00'),
  RUN_START: new Date('2026-08-01T00:00:00+07:00'),
  RUN_END: new Date('2026-08-15T23:59:59+07:00'),
  MAX_RUN_DISTANCE: 100,
  SESSION_TTL_MS: 24 * 60 * 60 * 1000
};

let spreadsheetCache_ = null;
const sheetCache_ = {};

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
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    return jsonOutput(routeAction_(body));
  } catch (err) {
    return jsonOutput({ ok: false, message: friendlyError_(err) });
  }
}

function routeAction_(body) {
  const startedAt = Date.now();
  const action = String(body.action || '');
  const requestId = String(body.clientRunId || body.requestId || Utilities.getUuid());
  try {
    const handlers = {
      listEmployees,
      lookupEmployee,
      register,
      login,
      addRun: addRunV2,
      getRunStatus: getRunStatusV2,
      updateProfilePhoto,
      getDashboard: getDashboardV2,
      systemCheck,
      testDriveUploadAccess
    };
    if (!handlers[action]) throw new Error('ไม่พบ action ที่ร้องขอ');
    ensureSetup_();
    const result = handlers[action](body);
    Logger.log(JSON.stringify({ event: 'request-complete', requestId, action, ok: true, durationMs: Date.now() - startedAt }));
    return result;
  } catch (err) {
    Logger.log(JSON.stringify({ event: 'request-failed', requestId, action, ok: false, durationMs: Date.now() - startedAt, message: friendlyError_(err) }));
    return { ok: false, message: friendlyError_(err) };
  }
}

function setupSheets() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, CONFIG.EMPLOYEES_SHEET, ['Emp ID', 'Prefix', 'FirstName', 'LastName', 'Department', 'Email', 'Status']);
  ensureSheet_(ss, CONFIG.USERS_SHEET, ['code', 'name', 'department', 'goal', 'passwordHash', 'registeredAt', 'profilePhotoBase64']);
  ensureSheet_(ss, CONFIG.RUNS_SHEET, ['id', 'code', 'name', 'department', 'distance', 'date', 'note', 'imageUrl', 'createdAt', 'submissionKey']);
}

function ensureSetup_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'INVE_SHEETS_READY_V3';
  if (cache.get(cacheKey)) return;
  setupSheets();
  cache.put(cacheKey, '1', 21600);
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

  return {
    ok: true,
    employee: buildUserSummary_(code),
    sessionToken: issueSessionToken_(code)
  };
}

function login(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const password = String(body.password || '').trim();
  const user = findUser_(code);

  if (!user || !passwordMatches_(user.passwordHash, password)) {
    throw new Error('รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');
  }
  upgradePlainPasswordIfNeeded_(code, user.passwordHash, password);

  const runs = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  return {
    ok: true,
    employee: buildUserSummaryFromRows_(code, user, runs),
    runs: mapRunsByCode_(code, runs),
    sessionToken: issueSessionToken_(code)
  };
}

function updateProfilePhoto(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  requireSession_(body, code);
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

function addRunV2(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  requireSession_(body, code);
  const user = findUser_(code);
  if (!user) throw new Error('กรุณาเข้าสู่ระบบก่อนบันทึกผล');

  const rawDistance = Number(body.distance);
  if (!Number.isFinite(rawDistance) || rawDistance <= 0) throw new Error('กรุณากรอกระยะทางที่ถูกต้อง');
  if (rawDistance > CONFIG.MAX_RUN_DISTANCE) throw new Error(`ระยะทางต่อครั้งต้องไม่เกิน ${CONFIG.MAX_RUN_DISTANCE} กิโลเมตร`);
  const distance = Math.round(rawDistance * 100) / 100;
  if (!body.imageData) throw new Error('กรุณาอัปโหลดรูปหลักฐานการวิ่ง 1 รูป');
  if (String(body.imageData).length > 7500000) throw new Error('รูปภาพใหญ่เกินไป กรุณาลดขนาดรูปแล้วลองใหม่');

  const runId = normalizeRunId_(body.clientRunId || body.runId || body.id || Utilities.getUuid());
  const submissionKey = normalizeRunId_(body.submissionKey || body.idempotencyKey || runId);
  const runsBeforeUpload = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  const existingBeforeUpload = findRunByIdOrSubmissionKey_(runId, submissionKey, runsBeforeUpload);
  if (existingBeforeUpload) return buildRunResponse_(code, user, true);

  const runDate = parseRunDate_(body.date);
  const runNumber = mapRunsByCode_(code, runsBeforeUpload).length + 1;
  let imageFile = null;
  let rowCommitted = false;

  try {
    imageFile = saveImageFile_(body.imageData, {
      code: user.code,
      name: user.name,
      date: runDate,
      runNumber
    });

    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    try {
      lock.waitLock(10000);
      lockAcquired = true;
      const existingAfterUpload = findRunByIdOrSubmissionKey_(runId, submissionKey);
      if (existingAfterUpload) {
        trashDriveFile_(imageFile.id);
        imageFile = null;
        return buildRunResponse_(code, user, true);
      }

      getSheet_(CONFIG.RUNS_SHEET).appendRow([
        runId,
        user.code,
        user.name,
        user.department,
        distance,
        runDate,
        body.note || '',
        imageFile.url,
        new Date(),
        submissionKey
      ]);
      rowCommitted = true;
    } finally {
      if (lockAcquired) lock.releaseLock();
    }
  } catch (err) {
    if (imageFile && imageFile.id && !rowCommitted) trashDriveFile_(imageFile.id);
    throw err;
  }

  return buildRunResponse_(code, user, false);
}

function getDashboardV2(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const users = sheetToObjects_(getSheet_(CONFIG.USERS_SHEET));
  const runs = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  const leaderboard = buildLeaderboardFromRows_(users, runs);
  const user = code ? users.find(row => codeMatches_(row.code, code)) : null;
  return {
    ok: true,
    employee: code && user ? buildUserSummaryFromRows_(code, user, runs) : null,
    leaderboard,
    stats: buildStatsFromRows_(users, runs, leaderboard),
    runs: code ? mapRunsByCode_(code, runs) : mapAllRuns_(runs)
  };
}

function getRunStatusV2(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  requireSession_(body, code);
  const runId = normalizeRunId_(body.clientRunId || body.runId || body.id);
  const submissionKey = normalizeRunId_(body.submissionKey || body.idempotencyKey || runId);
  if (!runId && !submissionKey) throw new Error('ไม่พบรหัสรายการบันทึกผล');

  const run = findRunByIdOrSubmissionKey_(runId, submissionKey);
  if (run && !codeMatches_(run.code, code)) throw new Error('ไม่มีสิทธิ์ตรวจสอบรายการนี้');
  return {
    ok: true,
    found: Boolean(run),
    run: run ? {
      id: run.id || '',
      code: normalizeCode_(run.code),
      distance: Number(run.distance || 0),
      date: run.date,
      imageUrl: run.imageUrl || ''
    } : null
  };
}

function buildRunResponse_(code, user, duplicate) {
  const runs = sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  return {
    ok: true,
    employee: buildUserSummaryFromRows_(code, user, runs),
    runs: mapRunsByCode_(code, runs),
    duplicate: Boolean(duplicate)
  };
}

function buildStatsFromRows_(users, runs, leaderboard) {
  const totalDistance = runs.reduce((sum, row) => sum + Number(row.distance || 0), 0);
  const top = leaderboard[0] || null;
  return {
    participants: users.length,
    totalDistance,
    averageDistance: users.length ? totalDistance / users.length : 0,
    todayTop: top ? { code: top.code, name: top.name, distance: top.total } : null
  };
}

function buildLeaderboardFromRows_(users, runs) {
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
  })).sort((left, right) => right.total - left.total);
}

function buildUserSummaryFromRows_(code, user, runs) {
  if (!user) throw new Error('ยังไม่ได้ลงทะเบียน');
  const total = runs
    .filter(row => codeMatches_(row.code, code))
    .reduce((sum, row) => sum + Number(row.distance || 0), 0);
  return {
    code: normalizeCode_(user.code),
    name: user.name,
    department: user.department,
    goal: Number(user.goal || 0),
    total,
    profilePhotoBase64: user.profilePhotoBase64 || ''
  };
}

function mapRunsByCode_(code, runs) {
  let cumulative = 0;
  return runs
    .filter(row => codeMatches_(row.code, code))
    .sort((left, right) => new Date(left.date) - new Date(right.date))
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
    .sort((left, right) => new Date(right.date) - new Date(left.date));
}

function mapAllRuns_(runs) {
  return runs.map(row => ({
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

function parseRunDate_(value) {
  const text = String(value || '').trim();
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T12:00:00+07:00`)
    : new Date(text || new Date());
  if (Number.isNaN(runDate.getTime())) throw new Error('วันที่วิ่งไม่ถูกต้อง');
  if (runDate < CONFIG.RUN_START || runDate > CONFIG.RUN_END) {
    throw new Error('บันทึกผลได้เฉพาะวันที่ 1 - 15 สิงหาคม 2569');
  }
  return runDate;
}

function addRun(body) {
  const code = normalizeCode_(body.code || body.employeeCode);
  const user = findUser_(code);
  if (!user) throw new Error('กรุณาเข้าสู่ระบบก่อนบันทึกผล');

  const distance = Number(body.distance);
  if (!distance || distance <= 0) throw new Error('กรุณากรอกระยะทางที่ถูกต้อง');

  const runId = normalizeRunId_(body.clientRunId || body.runId || body.id || Utilities.getUuid());
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existingRun = findRunById_(runId);
    if (existingRun && codeMatches_(existingRun.code, code)) {
      return {
        ok: true,
        employee: buildUserSummary_(code),
        runs: getRunsByCode_(code),
        duplicate: true
      };
    }

    const runDate = body.date ? new Date(body.date) : new Date();
    const runNumber = getRunsByCode_(code).length + 1;
    const imageUrl = saveImage_(body.imageData, {
      code: user.code,
      name: user.name,
      date: runDate,
      runNumber
    });

    getSheet_(CONFIG.RUNS_SHEET).appendRow([
      runId,
      user.code,
      user.name,
      user.department,
      distance,
      runDate,
      body.note || '',
      imageUrl,
      new Date()
    ]);
  } finally {
    lock.releaseLock();
  }

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

function findRunById_(runId) {
  const normalizedRunId = normalizeRunId_(runId);
  if (!normalizedRunId) return null;
  return sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET)).find(row => normalizeRunId_(row.id) === normalizedRunId) || null;
}

function findRunByIdOrSubmissionKey_(runId, submissionKey, runs) {
  const normalizedRunId = normalizeRunId_(runId);
  const normalizedSubmissionKey = normalizeRunId_(submissionKey);
  const rows = Array.isArray(runs) ? runs : sheetToObjects_(getSheet_(CONFIG.RUNS_SHEET));
  return rows.find(row => {
    const sameId = normalizedRunId && normalizeRunId_(row.id) === normalizedRunId;
    const sameSubmission = normalizedSubmissionKey && normalizeRunId_(row.submissionKey) === normalizedSubmissionKey;
    return sameId || sameSubmission;
  }) || null;
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

  const match = String(imageData).match(/^data:(image\/(?:png|jpeg|webp|heic|heif));base64,(.+)$/);
  if (!match) throw new Error('รูปภาพไม่ถูกต้อง');

  const extensionByMime = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif'
  };
  const extension = extensionByMime[match[1]] || 'jpg';
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

function getSessionSecret_() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('INVE_SESSION_SECRET');
  if (secret) return secret;
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    secret = properties.getProperty('INVE_SESSION_SECRET');
    if (!secret) {
      secret = `${Utilities.getUuid()}${Utilities.getUuid()}${Utilities.getUuid()}`;
      properties.setProperty('INVE_SESSION_SECRET', secret);
    }
  } finally {
    lock.releaseLock();
  }
  return secret;
}

function issueSessionToken_(code) {
  const payload = JSON.stringify({
    code: normalizeCode_(code),
    expiresAt: Date.now() + CONFIG.SESSION_TTL_MS,
    nonce: Utilities.getUuid()
  });
  const encoded = Utilities.base64EncodeWebSafe(payload, Utilities.Charset.UTF_8).replace(/=+$/g, '');
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(encoded, getSessionSecret_())
  ).replace(/=+$/g, '');
  return `${encoded}.${signature}`;
}

function requireSession_(body, code) {
  const token = String(body.sessionToken || body.token || '').trim();
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const expectedSignature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], getSessionSecret_())
  ).replace(/=+$/g, '');
  if (!safeTextEquals_(parts[1], expectedSignature)) throw new Error('เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) {
    throw new Error('เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  }
  if (!codeMatches_(payload.code, code) || Number(payload.expiresAt || 0) < Date.now()) {
    throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }
  return payload;
}

function safeTextEquals_(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  if (leftText.length !== rightText.length) return false;
  let difference = 0;
  for (let index = 0; index < leftText.length; index += 1) {
    difference |= leftText.charCodeAt(index) ^ rightText.charCodeAt(index);
  }
  return difference === 0;
}

function hashPassword_(password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password));
  return raw.map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function saveImageFile_(imageData, fileInfo) {
  if (!imageData) throw new Error('กรุณาอัปโหลดรูปหลักฐานการวิ่ง 1 รูป');
  const match = String(imageData).match(/^data:(image\/(?:png|jpeg|webp|heic|heif));base64,(.+)$/);
  if (!match) throw new Error('รูปภาพไม่ถูกต้อง');

  const extensionByMime = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif'
  };
  const extension = extensionByMime[match[1]] || 'jpg';
  const dateText = Utilities.formatDate(new Date(fileInfo.date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const safeName = sanitizeFileName_(`ครั้งที่ ${fileInfo.runNumber} ${fileInfo.code} ${fileInfo.name} ${dateText}.${extension}`);
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], safeName);
    return createDriveFile_(blob, safeName);
  } catch (err) {
    throw new Error(friendlyError_(err));
  }
}

function passwordMatches_(storedPassword, password) {
  const storedText = String(storedPassword || '').trim();
  const plainText = String(password || '');
  const trimmedText = plainText.trim();
  if (!storedText || !plainText) return false;
  if (/^[a-f0-9]{64}$/i.test(storedText)) {
    return storedText.toLowerCase() === hashPassword_(plainText)
      || (trimmedText !== plainText && storedText.toLowerCase() === hashPassword_(trimmedText));
  }
  return safeTextEquals_(storedText, plainText)
    || (trimmedText !== plainText && safeTextEquals_(storedText, trimmedText));
}

function upgradePlainPasswordIfNeeded_(code, storedPassword, password) {
  const storedText = String(storedPassword || '').trim();
  const plainText = String(password || '');
  if (!storedText || storedText !== plainText || /^[a-f0-9]{64}$/i.test(storedText)) return;

  const sheet = getSheet_(CONFIG.USERS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const codeIndex = headers.indexOf('code');
  const passwordIndex = headers.indexOf('passwordHash');
  if (codeIndex < 0 || passwordIndex < 0) return;

  const rowIndex = values.findIndex((row, index) => index > 0 && codeMatches_(row[codeIndex], code));
  if (rowIndex < 1) return;
  sheet.getRange(rowIndex + 1, passwordIndex + 1).setValue(hashPassword_(plainText));
}

function normalizeCode_(code) {
  const value = String(code || '').trim().toUpperCase();
  return /^\d+$/.test(value) ? value.padStart(3, '0') : value;
}

function normalizeRunId_(runId) {
  return String(runId || '').trim();
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
  if (!spreadsheetCache_) {
    spreadsheetCache_ = CONFIG.SPREADSHEET_ID ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID) : SpreadsheetApp.getActive();
  }
  return spreadsheetCache_;
}

function getSheet_(name) {
  if (sheetCache_[name]) return sheetCache_[name];
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`ไม่พบชีต ${name} กรุณารัน setupSheets() ก่อน`);
  sheetCache_[name] = sheet;
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
