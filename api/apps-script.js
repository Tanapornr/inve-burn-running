const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyEIQPcHNrlYDqCJCMhGuZzO_RBrtrpIBaBuFvdECmP_ZzDsmsgaTy0-GYCEPh9yMYNVQ/exec";

const PROXY_VERSION = "2026-08-15-run-deadline-v3";
const RUN_SUBMISSION_START_MS = Date.parse("2026-08-01T00:00:00+07:00");
const RUN_SUBMISSION_END_MS = Date.parse("2026-08-15T23:59:59.999+07:00");
const RUN_SUBMISSION_CLOSED_MESSAGE = "ปิดรับการอัปโหลดผลวิ่งแล้ว ระบบสิ้นสุดการรับผลเมื่อวันที่ 15 สิงหาคม 2569 เวลา 23.59 น.";

const RETRY_SAFE_ACTIONS = new Set([
  "login",
  "lookupEmployee",
  "listEmployees",
  "getDashboard",
  "getRunStatus",
  "systemCheck"
]);

function friendlyMessage(message) {
  const text = String(message || "");
  if (/Apps Script.*(?:ตอบกลับไม่ถูกต้อง|ตอบกลับไม่ครบถ้วน)/i.test(text)) {
    return "ระบบ Google ขัดข้องชั่วคราวและยังไม่ได้ตรวจรหัสผ่าน กรุณารอประมาณ 10 วินาทีแล้วลองอีกครั้ง";
  }
  if (/AbortError|aborted|timeout|timed out/i.test(text)) {
    return "เชื่อมต่อระบบช้าเกินไป กรุณาตรวจสอบ Wi‑Fi หรือสลับเป็น 4G/5G แล้วลองใหม่";
  }
  if (/Access denied:\s*DriveApp|DriveApp|Authorization is required|required permissions|permission/i.test(text)) {
    return "อัปโหลดรูปไม่ได้ เพราะ Google Apps Script ยังไม่มีสิทธิ์เขียนไฟล์ใน Google Drive หรือ Deploy ไม่ได้ตั้ง Execute as Me: ให้เปิด Apps Script แล้ว Run ฟังก์ชัน testDriveUploadAccess() จากนั้นกดอนุญาตสิทธิ์ และ Deploy เป็นเวอร์ชันล่าสุด";
  }
  if (/No item with the given ID|File not found|folder/i.test(text)) {
    return "อัปโหลดรูปไม่ได้ เพราะไม่พบโฟลเดอร์ Google Drive ที่ตั้งไว้ กรุณาตรวจสอบ DRIVE_FOLDER_ID ใน Apps Script";
  }
  return text;
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-INVE-Proxy-Version", PROXY_VERSION);
  res.end(JSON.stringify(data));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function hasExpectedPayload(action, data) {
  if (!data || typeof data !== "object" || typeof data.ok !== "boolean") return false;
  if (!data.ok) return true;
  if (action === "login") return Boolean(data.employee && data.employee.code && data.sessionToken);
  if (action === "lookupEmployee") return Boolean(data.employee && data.employee.code);
  if (action === "listEmployees") return Array.isArray(data.employees);
  if (action === "getDashboard") {
    return Array.isArray(data.leaderboard) && data.stats && Array.isArray(data.runs);
  }
  if (action === "getRunStatus") return typeof data.found === "boolean";
  return true;
}

async function requestAppsScript(payload, timeoutMs, attemptId = "1") {
  const deadline = Date.now() + timeoutMs;
  const requestUrl = new URL(SCRIPT_URL);
  requestUrl.searchParams.set("source", "vercel");
  requestUrl.searchParams.set("attempt", attemptId);
  requestUrl.searchParams.set("_", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const remainingTime = () => Math.max(1000, deadline - Date.now());
  let upstream = await fetchWithTimeout(requestUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Accept": "application/json, text/plain, */*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    },
    body: JSON.stringify(payload),
    redirect: "manual",
    cache: "no-store"
  }, remainingTime());

  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get("location");
    if (!location) {
      const redirectError = new Error("Apps Script ตอบกลับไม่ถูกต้อง กรุณาลองใหม่");
      redirectError.retryable = true;
      throw redirectError;
    }
    upstream = await fetchWithTimeout(new URL(location, requestUrl).toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      redirect: "follow",
      cache: "no-store"
    }, remainingTime());
  }

  const responseText = await upstream.text();
  let data;
  try {
    data = JSON.parse(responseText.replace(/^\uFEFF/, "").trim());
  } catch (err) {
    const invalidResponse = new Error("Apps Script ตอบกลับไม่ถูกต้อง กรุณาลองใหม่");
    invalidResponse.retryable = true;
    invalidResponse.upstreamStatus = upstream.status;
    invalidResponse.upstreamType = upstream.headers.get("content-type") || "";
    throw invalidResponse;
  }
  if (!hasExpectedPayload(payload.action, data)) {
    const invalidPayload = new Error("Apps Script ตอบกลับไม่ครบถ้วน กรุณาลองใหม่");
    invalidPayload.retryable = true;
    throw invalidPayload;
  }
  return { upstream, data };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestLoginWithRetry(payload, requestId) {
  const attemptTimeouts = [14000, 17000, 20000];
  let lastError;
  for (let index = 0; index < attemptTimeouts.length; index += 1) {
    try {
      return await requestAppsScript(payload, attemptTimeouts[index], `login-${index + 1}`);
    } catch (err) {
      lastError = err;
      const retryable = err && (err.retryable || /AbortError|aborted|timeout/i.test(String(err.message || err)));
      if (!retryable || index === attemptTimeouts.length - 1) throw err;
      console.warn(JSON.stringify({
        event: "apps-script-login-retry",
        requestId,
        attempt: index + 1,
        upstreamStatus: err.upstreamStatus || 0,
        upstreamType: err.upstreamType || "",
        message: String(err.message || err)
      }));
      await sleep(350 + (index * 350));
    }
  }
  throw lastError;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 9 * 1024 * 1024) {
        reject(new Error("รูปภาพใหญ่เกินไป กรุณาลดขนาดรูปแล้วลองใหม่"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isRunSubmissionOpen(nowMs = Date.now()) {
  return nowMs >= RUN_SUBMISSION_START_MS && nowMs <= RUN_SUBMISSION_END_MS;
}

module.exports = async function handler(req, res) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "Method not allowed" });
    return;
  }

  try {
    const rawBody = await readBody(req);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    if (!payload.action) throw new Error("ไม่พบ action ที่ร้องขอ");
    if (payload.action === "addRun" && !isRunSubmissionOpen()) {
      sendJson(res, 403, { ok: false, message: RUN_SUBMISSION_CLOSED_MESSAGE });
      return;
    }
    if (payload.action === "login" && /^[a-f0-9]{64}$/i.test(String(payload.password || "").trim())) {
      throw new Error("รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง");
    }
    console.log(JSON.stringify({
      event: "apps-script-request",
      requestId,
      action: payload.action,
      clientRunId: payload.clientRunId || "",
      bodyBytes: Buffer.byteLength(rawBody, "utf8")
    }));

    const maxAttempts = payload.action === "login" ? 1 : (RETRY_SAFE_ACTIONS.has(payload.action) ? 2 : 1);
    let upstream;
    let data;
    let upstreamError;
    if (payload.action === "login") {
      ({ upstream, data } = await requestLoginWithRetry(payload, requestId));
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (upstream && data) break;
      try {
        ({ upstream, data } = await requestAppsScript(payload, maxAttempts > 1 ? 26000 : 50000, `${payload.action}-${attempt}`));
        upstreamError = null;
        break;
      } catch (err) {
        upstreamError = err;
        const canRetry = attempt < maxAttempts
          && (err.retryable || /AbortError|aborted|timeout/i.test(String(err && err.message)));
        if (!canRetry) throw err;
        console.warn(JSON.stringify({
          event: "apps-script-retry",
          requestId,
          action: payload.action,
          attempt,
          message: String(err && err.message ? err.message : err)
        }));
      }
    }
    if (upstreamError) throw upstreamError;
    if (data && data.ok === false) {
      data.message = friendlyMessage(data.message);
    }

    console.log(JSON.stringify({
      event: "apps-script-response",
      requestId,
      action: payload.action,
      ok: Boolean(data && data.ok),
      upstreamStatus: upstream.status,
      durationMs: Date.now() - startedAt
    }));

    sendJson(res, upstream.ok ? 200 : upstream.status, data);
  } catch (err) {
    console.error(JSON.stringify({
      event: "apps-script-error",
      requestId,
      message: String(err && err.message ? err.message : err),
      durationMs: Date.now() - startedAt
    }));
    sendJson(res, err && err.retryable ? 503 : 500, {
      ok: false,
      message: friendlyMessage(err.message) || "เชื่อมต่อระบบข้อมูลไม่สำเร็จ"
    });
  }
};
