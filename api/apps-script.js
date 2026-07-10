const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxci5eV98fL9yS4EjCq453f2DpQWUCn_zbIDOvl4HWnerhqXrtt5YWZEtYasvQXNDVr_A/exec";

function friendlyMessage(message) {
  const text = String(message || "");
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

    const upstream = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });

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

    sendJson(res, upstream.ok ? 200 : upstream.status, data);
  } catch (err) {
    sendJson(res, 500, { ok: false, message: friendlyMessage(err.message) || "เชื่อมต่อระบบข้อมูลไม่สำเร็จ" });
  }
};
