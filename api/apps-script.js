const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx72kRdiVL_FS1LQOtTHKlM9Hjr3KRhT1HLr1UCTJJ-tsJiakmuLARR8gNugcHWjbA/exec";

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

    sendJson(res, upstream.ok ? 200 : upstream.status, data);
  } catch (err) {
    sendJson(res, 500, { ok: false, message: err.message || "เชื่อมต่อระบบข้อมูลไม่สำเร็จ" });
  }
};
