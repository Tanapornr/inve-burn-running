# INVE BURN RUNNING 2026

ชุดไฟล์นี้เป็นเว็บต้นแบบ HTML/CSS/JavaScript ตามภาพอ้างอิง 4 หน้า พร้อมโค้ด Google Apps Script สำหรับเก็บข้อมูลใน Google Sheet

## ไฟล์ที่มี

- `index.html` — หน้าเว็บหลัก มีหน้าแรก, ลงทะเบียน, เข้าสู่ระบบ, ลืมรหัสผ่าน, Dashboard พนักงาน และบันทึกผลวิ่ง
- `google-apps-script.gs` — API สำหรับ Google Sheet และ Google Drive

## โครงสร้าง Google Sheet

ใช้ Google Sheet นี้เป็นฐานข้อมูลพนักงาน:

https://docs.google.com/spreadsheets/d/1jntQZj1u9nb2eypIQcfrdnbe3CeVvBLY5jphTo-Q1TQ/edit

เปิด Extensions → Apps Script จากไฟล์ Google Sheet นี้ จากนั้นวางโค้ดใน `google-apps-script.gs`

ตอนนี้เตรียมแท็บใน Google Sheet ให้แล้ว 4 แท็บ:

- `Employees` — ข้อมูลพนักงานตั้งต้น
- `Users` — ข้อมูลผู้สมัครและรหัสผ่านแบบ hash
- `Runs` — ประวัติการบันทึกผลวิ่ง
- `Otp` — OTP สำหรับเปลี่ยนรหัสผ่าน

หากมีการลบแท็บหรือเริ่มไฟล์ใหม่ สามารถรันฟังก์ชัน `setupSheets()` 1 ครั้งเพื่อสร้างหัวตารางใหม่ได้

## ข้อมูลพนักงาน

ชีตจริงของคุณมีแท็บ `Employees` และหัวตารางนี้แล้ว:

| Emp ID | Prefix | FirstName | LastName | Department |
|---|---|---|---|---|
| 018 | นาย | มารุต | ทับหุ่น | Production |
| 025 | นาย | สุทน | จิตต์บุรุษ | Quality |

เมื่อพนักงานกรอกรหัสในหน้าลงทะเบียน ระบบจะดึงชื่อและแผนกให้อัตโนมัติ

สคริปต์รองรับทั้งกรณีพิมพ์ `018` และ `18` โดยจะเทียบเป็นรหัสเดียวกัน

## Deploy API

1. ใน Apps Script กด Deploy → New deployment
2. เลือก type เป็น Web app
3. Execute as: Me
4. Who has access: Anyone
5. กด Deploy แล้ว copy Web app URL
6. เปิด `index.html` แล้วแก้ส่วนนี้:

```js
const CONFIG = {
  apiUrl: "https://script.google.com/macros/s/xxxxx/exec",
  demoMode: false
};
```

ถ้า `demoMode: true` เว็บจะใช้ข้อมูลตัวอย่างในไฟล์ HTML โดยไม่เชื่อม Google Sheet

## การอัปโหลดรูปหลักฐาน

รูปหลักฐานจะถูกบันทึกลงโฟลเดอร์ Google Drive นี้:

https://drive.google.com/drive/folders/1GuVb0RtKR24dpBiJhO9ITSgrxCpg9J1-

ใน `google-apps-script.gs` ตั้งค่าไว้แล้ว:

```js
DRIVE_FOLDER_ID: '1GuVb0RtKR24dpBiJhO9ITSgrxCpg9J1-'
```

ชื่อไฟล์ตอนอัปโหลดจะถูกตั้งเป็น:

```js
ครั้งที่ 1 018 นาย มารุต ทับหุ่น 2026-07-08.jpg
```

รูปแบบคือ `ครั้งที่ X รหัสพนักงาน ชื่อ วันที่`

## การทดสอบเร็ว

- เปิด `index.html` ใน Browser ได้ทันที
- รหัสเดโม: `018`
- รหัสผ่านเดโม: `123456`
- OTP เดโม: `123456`

## หมายเหตุ

เว็บนี้เป็น HTML ไฟล์เดียวเพื่อให้นำไปแก้ต่อได้ง่าย หากจะใช้งานจริง แนะนำเพิ่ม HTTPS hosting, session token, การตรวจสิทธิ์ฝั่ง server และการจำกัดชนิด/ขนาดไฟล์เพิ่มเติม
