# InvestLearn — ระบบจำลองการลงทุนเพื่อการศึกษา (backend จริง)

ระบบเต็มรูปแบบที่มี server + database จริง เพื่อให้ครูเห็นข้อมูลนักเรียนทุกคนจากส่วนกลาง
รองรับหลายคนใช้งานพร้อมกันผ่านลิงก์เดียว **ตั้งค่าให้ deploy แบบฟรี 100% ได้ (Render + Turso)**

## สิ่งที่อยู่ในนี้

```
investlearn-server/
├── server.js              ← เซิร์ฟเวอร์หลัก (Express + REST API)
├── db.js                  ← เลเยอร์ฐานข้อมูล (libSQL — ใช้ได้ทั้งไฟล์ในเครื่องและ Turso)
├── auth.js                ← จัดการรหัสผ่าน (hash) และ session token
├── import_stock_data.js   ← นำเข้าข้อมูลหุ้น (จาก set_data.json หรือข้อมูลจำลอง)
├── package.json
└── public/
    └── index.html          ← หน้าเว็บแอป (นักเรียน + ครู)
```

## รันบนเครื่องตัวเอง (สำหรับทดสอบ)

```bash
cd investlearn-server
npm install
node import_stock_data.js      # นำเข้าข้อมูลหุ้น (ใส่ set_data.json ไว้โฟลเดอร์นี้ก่อนถ้ามีข้อมูลจริง)
node server.js
```

เปิดเบราว์เซอร์ไปที่ `http://localhost:3000` — ตอนนี้ข้อมูลจะถูกเก็บในไฟล์ `investlearn.db` ที่เครื่องคุณ

**ครั้งแรกที่รัน** ระบบจะสร้างบัญชีครูให้อัตโนมัติ 1 บัญชี แล้วพิมพ์รหัสผ่านชั่วคราวออกมาในคอนโซล

## Deploy ออนไลน์แบบฟรี 100% (Render + Turso)

แผนนี้ **ไม่มีค่าใช้จ่ายเลย** ต่างจากการใช้ไฟล์ SQLite ตรงๆ บน Render ที่ข้อมูลจะหายทุกครั้งที่ deploy ใหม่
(เพราะ Render ฟรีมีระบบไฟล์แบบ ephemeral) — Turso แก้ปัญหานี้โดยเก็บข้อมูลไว้ที่อื่นแทน

### ขั้นตอนที่ 1: สร้างฐานข้อมูลบน Turso (ฟรี ไม่ต้องผูกบัตรเครดิต)

1. สมัครที่ [turso.tech](https://turso.tech) (ใช้ GitHub login ได้เลย)
2. สร้างฐานข้อมูลใหม่ 1 ตัว (จากหน้าเว็บหรือ Turso CLI)
3. คัดลอกค่า 2 ตัวนี้จากหน้าฐานข้อมูล:
   - **Database URL** (ขึ้นต้นด้วย `libsql://...`)
   - **Auth Token** (กดสร้าง token ใหม่ได้จากหน้าเดียวกัน)

### ขั้นตอนที่ 2: อัปโหลดโค้ดขึ้น GitHub

อัปโหลดโฟลเดอร์นี้ขึ้น GitHub repo ของคุณ (ไม่ต้องอัปโหลด `node_modules` และ `investlearn.db`)

### ขั้นตอนที่ 3: สร้าง Web Service บน Render

1. สมัคร/ล็อกอินที่ [render.com](https://render.com) ด้วย GitHub
2. New → Web Service → เลือก repo นี้
3. ตั้งค่า:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
4. ในหน้า Environment เพิ่มตัวแปร 2 ตัวจากขั้นตอนที่ 1:
   - `TURSO_DATABASE_URL` = ค่าที่คัดลอกมา
   - `TURSO_AUTH_TOKEN` = ค่าที่คัดลอกมา
5. กด Deploy

### ขั้นตอนที่ 4: นำเข้าข้อมูลหุ้นเข้า Turso

รันคำสั่งนี้ **บนเครื่องตัวเอง** โดยตั้งค่า environment variables ให้ชี้ไปที่ Turso ก่อน:

```bash
export TURSO_DATABASE_URL="libsql://your-db-xxxx.turso.io"
export TURSO_AUTH_TOKEN="your-token-here"
node import_stock_data.js
```

เสร็จแล้ว เปิดลิงก์ที่ Render ให้มา (เช่น `https://investlearn-xxxx.onrender.com`) — ใช้งานได้จริง ฟรีตลอด

## ข้อจำกัดของแผนฟรีที่ควรรู้

- **Cold start บน Render ฟรี** — ถ้าไม่มีคนเข้าใช้นาน (~15 นาที) เซิร์ฟเวอร์จะ "หลับ" คนเข้าครั้งแรกหลังจากนั้น
  ต้องรอ ~30-50 วินาทีให้ตื่น (ปกติสำหรับแอปห้องเรียนที่ไม่ได้ใช้ตลอด 24 ชม.)
- **Session เก็บใน memory ของเซิร์ฟเวอร์** — ถ้าเซิร์ฟเวอร์ restart/หลับแล้วตื่น ทุกคนต้อง login ใหม่
  (ข้อมูลพอร์ต/เงินสด/ประวัติไม่หาย เพราะอยู่ใน Turso แยกต่างหาก หายแค่สถานะ "login ค้างไว้")
- **ราคาหุ้นอัปเดตแบบ manual** — รัน `fetch_set_data.py` แล้ว `node import_stock_data.js`
  (ตั้งค่า TURSO env vars ก่อน) เพื่ออัปเดตราคาใหม่เป็นระยะ
- **Turso free tier** — 5GB, อ่านได้ 500 ล้านครั้ง/เดือน, เขียนได้ 10 ล้านครั้ง/เดือน
  เกินพอสำหรับห้องเรียนขนาดปกติ แต่ควรเช็คราคา/เงื่อนไขปัจจุบันที่ turso.tech/pricing ก่อนใช้จริง
  เพราะแผนอาจเปลี่ยนแปลงได้

## คำสั่งที่ใช้บ่อย

```bash
node import_stock_data.js   # นำเข้า/อัปเดตข้อมูลหุ้นใหม่
rm investlearn.db           # ล้างข้อมูลทดสอบในเครื่อง (ไม่กระทบข้อมูลบน Turso)
```
