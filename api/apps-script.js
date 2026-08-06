const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyEIQPcHNrlYDqCJCMhGuZzO_RBrtrpIBaBuFvdECmP_ZzDsmsgaTy0-GYCEPh9yMYNVQ/exec";

function friendlyMessage(message) {
  const text = String(message || "");
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
    console.log(JSON.stringify({
      event: "apps-script-request",
      requestId,
      action: payload.action,
      clientRunId: payload.clientRunId || "",
      bodyBytes: Buffer.byteLength(rawBody, "utf8")
    }));

    const upstream = await fetchWithTimeout(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    }, 50000);

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("Apps Script ตอบกลับไม่ถูกต้อง กรุณา deploy เวอร์ชันล่าสุด");
    }
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
    sendJson(res, 500, { ok: false, message: friendlyMessage(err.message) || "เชื่อมต่อระบบข้อมูลไม่สำเร็จ" });
  }
};
