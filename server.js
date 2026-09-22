// server.js — ระบบจำลองการลงทุนเพื่อการศึกษา (backend จริง)
// รันด้วย: node server.js
// ครูคนแรกถูกสร้างอัตโนมัติตอนรันครั้งแรก (ดูรหัสผ่านชั่วคราวในคอนโซล)

const express = require("express");
const path = require("path");
const db = require("./db");
const { hashPassword, verifyPassword, generateTempPassword, generateToken } = require("./auth");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = 0.0015;
const COMMISSION_MIN = 50;
const STARTING_CASH = 1000000;

// ---------- session เก็บใน memory (ง่ายพอสำหรับโปรเจกต์ห้องเรียน) ----------
const sessions = new Map(); // token -> student_id

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const studentId = token && sessions.get(token);
  if (!studentId) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบ" });
  const user = await db.get("SELECT * FROM users WHERE student_id = ?", [studentId]);
  if (!user) return res.status(401).json({ error: "ไม่พบบัญชีผู้ใช้" });
  req.user = user;
  next();
}

function requireTeacher(req, res, next) {
  if (req.user.role !== "teacher") return res.status(403).json({ error: "เฉพาะครูเท่านั้น" });
  next();
}

function wrap(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
  });
}

// ---------- seed: สร้างครูคนแรกอัตโนมัติถ้ายังไม่มีใครในระบบเลย ----------
async function seedFirstTeacher() {
  const row = await db.get("SELECT COUNT(*) AS c FROM users WHERE role='teacher'", []);
  if (row.c > 0) return;
  const tempPw = generateTempPassword();
  await db.run(`
    INSERT INTO users (student_id, name, role, password_hash, must_change_password, cash)
    VALUES (?, ?, 'teacher', ?, 1, 0)
  `, ["teacher1", "ครูผู้ดูแลระบบ", hashPassword(tempPw)]);
  console.log("=".repeat(50));
  console.log("สร้างบัญชีครูเริ่มต้นแล้ว (ใช้ล็อกอินครั้งแรกเท่านั้น)");
  console.log("รหัสผู้ใช้: teacher1");
  console.log("รหัสผ่านชั่วคราว:", tempPw);
  console.log("=".repeat(50));
}

// ==================== AUTH ====================

app.post("/api/login", wrap(async (req, res) => {
  const { student_id, password } = req.body || {};
  if (!student_id || !password) return res.status(400).json({ error: "กรุณากรอกรหัสผู้ใช้และรหัสผ่าน" });

  const user = await db.get("SELECT * FROM users WHERE student_id = ?", [student_id.trim()]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
  }

  const token = generateToken();
  sessions.set(token, user.student_id);

  res.json({
    token,
    name: user.name,
    role: user.role,
    mustChangePassword: !!user.must_change_password
  });
}));

app.post("/api/change-password", auth, wrap(async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
  }
  await db.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE student_id = ?",
    [hashPassword(newPassword), req.user.student_id]);
  res.json({ ok: true });
}));

app.post("/api/logout", auth, wrap(async (req, res) => {
  const header = req.headers.authorization || "";
  sessions.delete(header.slice(7));
  res.json({ ok: true });
}));

// ==================== STOCKS (ทุกคนดูได้ ไม่ต้อง login) ====================

app.get("/api/stocks", wrap(async (req, res) => {
  const rows = await db.all("SELECT ticker, name, price, sector, history_json FROM stocks ORDER BY ticker", []);
  res.json(rows.map(r => ({
    ticker: r.ticker,
    name: r.name,
    price: r.price,
    sector: r.sector,
    history: JSON.parse(r.history_json || "{}")
  })));
}));

app.get("/api/stocks/:ticker", wrap(async (req, res) => {
  const r = await db.get("SELECT * FROM stocks WHERE ticker = ?", [req.params.ticker.toUpperCase()]);
  if (!r) return res.status(404).json({ error: "ไม่พบหุ้นนี้" });
  res.json({ ticker: r.ticker, name: r.name, price: r.price, sector: r.sector, history: JSON.parse(r.history_json || "{}") });
}));

// ==================== TRADING (นักเรียน) ====================

app.post("/api/trade", auth, wrap(async (req, res) => {
  const { ticker, type, qty, reason } = req.body || {};
  if (!ticker || !["buy", "sell"].includes(type) || !Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: "ข้อมูลคำสั่งซื้อขายไม่ถูกต้อง" });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "กรุณากรอกเหตุผลการตัดสินใจ" });
  }

  const stock = await db.get("SELECT * FROM stocks WHERE ticker = ?", [ticker.toUpperCase()]);
  if (!stock) return res.status(404).json({ error: "ไม่พบหุ้นนี้" });

  const value = stock.price * qty;
  const fee = Math.max(value * COMMISSION_RATE, COMMISSION_MIN);
  const studentId = req.user.student_id;
  const holding = await db.get("SELECT * FROM holdings WHERE student_id = ? AND ticker = ?", [studentId, stock.ticker]);

  if (type === "buy") {
    if (value + fee > req.user.cash) return res.status(400).json({ error: "เงินสดไม่พอสำหรับคำสั่งซื้อนี้" });

    const newQty = (holding ? holding.qty : 0) + qty;
    const newAvg = ((holding ? holding.avg_cost * holding.qty : 0) + stock.price * qty) / newQty;

    if (holding) {
      await db.run("UPDATE holdings SET qty = ?, avg_cost = ? WHERE student_id = ? AND ticker = ?",
        [newQty, newAvg, studentId, stock.ticker]);
    } else {
      await db.run("INSERT INTO holdings (student_id, ticker, qty, avg_cost) VALUES (?, ?, ?, ?)",
        [studentId, stock.ticker, newQty, newAvg]);
    }
    await db.run("UPDATE users SET cash = cash - ? WHERE student_id = ?", [value + fee, studentId]);
  } else {
    if (!holding || holding.qty < qty) return res.status(400).json({ error: "จำนวนหุ้นที่ถืออยู่ไม่พอสำหรับคำสั่งขายนี้" });

    const remaining = holding.qty - qty;
    if (remaining === 0) {
      await db.run("DELETE FROM holdings WHERE student_id = ? AND ticker = ?", [studentId, stock.ticker]);
    } else {
      await db.run("UPDATE holdings SET qty = ? WHERE student_id = ? AND ticker = ?", [remaining, studentId, stock.ticker]);
    }
    await db.run("UPDATE users SET cash = cash + ? WHERE student_id = ?", [value - fee, studentId]);
  }

  await db.run(`
    INSERT INTO transactions (student_id, ticker, type, qty, price, fee, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [studentId, stock.ticker, type, qty, stock.price, Math.round(fee * 100) / 100, reason.trim()]);

  const updatedUser = await db.get("SELECT cash FROM users WHERE student_id = ?", [studentId]);
  res.json({ ok: true, cash: updatedUser.cash });
}));

app.get("/api/portfolio", auth, wrap(async (req, res) => {
  const holdings = await db.all("SELECT * FROM holdings WHERE student_id = ?", [req.user.student_id]);
  const stocks = await db.all("SELECT ticker, price FROM stocks", []);
  const priceMap = Object.fromEntries(stocks.map(s => [s.ticker, s.price]));

  const holdingsOut = holdings.map(h => {
    const price = priceMap[h.ticker] || h.avg_cost;
    const value = price * h.qty;
    const cost = h.avg_cost * h.qty;
    return {
      ticker: h.ticker,
      qty: h.qty,
      avgCost: h.avg_cost,
      currentPrice: price,
      value,
      plPercent: cost > 0 ? ((value - cost) / cost) * 100 : 0
    };
  });

  const holdingsValue = holdingsOut.reduce((sum, h) => sum + h.value, 0);
  const total = holdingsValue + req.user.cash;

  res.json({
    cash: req.user.cash,
    holdings: holdingsOut,
    totalValue: total,
    totalReturnPercent: ((total - STARTING_CASH) / STARTING_CASH) * 100
  });
}));

app.get("/api/transactions", auth, wrap(async (req, res) => {
  const rows = await db.all("SELECT * FROM transactions WHERE student_id = ? ORDER BY id DESC LIMIT 200",
    [req.user.student_id]);
  res.json(rows);
}));

// ==================== TEACHER ====================

app.get("/api/teacher/students", auth, requireTeacher, wrap(async (req, res) => {
  const students = await db.all("SELECT student_id, name, cash, must_change_password, created_at FROM users WHERE role = 'student' ORDER BY name", []);
  const stocks = await db.all("SELECT ticker, price FROM stocks", []);
  const priceMap = Object.fromEntries(stocks.map(s => [s.ticker, s.price]));

  const out = [];
  for (const s of students) {
    const holdings = await db.all("SELECT * FROM holdings WHERE student_id = ?", [s.student_id]);
    const holdingsValue = holdings.reduce((sum, h) => sum + (priceMap[h.ticker] || h.avg_cost) * h.qty, 0);
    const total = holdingsValue + s.cash;
    const txCountRow = await db.get(`
      SELECT COUNT(*) AS c FROM transactions
      WHERE student_id = ? AND date(created_at) = date('now')
    `, [s.student_id]);

    out.push({
      studentId: s.student_id,
      name: s.name,
      totalValue: total,
      returnPercent: ((total - STARTING_CASH) / STARTING_CASH) * 100,
      holdingCount: holdings.length,
      mustChangePassword: !!s.must_change_password,
      tradesToday: txCountRow.c
    });
  }

  res.json(out.sort((a, b) => b.returnPercent - a.returnPercent));
}));

app.post("/api/teacher/students", auth, requireTeacher, wrap(async (req, res) => {
  const { student_id, name } = req.body || {};
  if (!student_id || !name) return res.status(400).json({ error: "กรุณากรอกรหัสนักเรียนและชื่อ" });

  const existing = await db.get("SELECT student_id FROM users WHERE student_id = ?", [student_id.trim()]);
  if (existing) return res.status(409).json({ error: "มีรหัสนักเรียนนี้อยู่แล้ว" });

  const tempPw = generateTempPassword();
  await db.run(`
    INSERT INTO users (student_id, name, role, password_hash, must_change_password, cash)
    VALUES (?, ?, 'student', ?, 1, ?)
  `, [student_id.trim(), name.trim(), hashPassword(tempPw), STARTING_CASH]);

  res.json({ ok: true, studentId: student_id.trim(), tempPassword: tempPw });
}));

app.post("/api/teacher/students/:id/reset-password", auth, requireTeacher, wrap(async (req, res) => {
  const studentId = req.params.id;
  const student = await db.get("SELECT * FROM users WHERE student_id = ? AND role='student'", [studentId]);
  if (!student) return res.status(404).json({ error: "ไม่พบนักเรียนนี้" });

  const tempPw = generateTempPassword();
  await db.run("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE student_id = ?",
    [hashPassword(tempPw), studentId]);
  await db.run("INSERT INTO password_reset_log (student_id, reset_by) VALUES (?, ?)",
    [studentId, req.user.student_id]);

  res.json({ ok: true, tempPassword: tempPw });
}));

app.get("/api/teacher/students/:id/transactions", auth, requireTeacher, wrap(async (req, res) => {
  const rows = await db.all("SELECT * FROM transactions WHERE student_id = ? ORDER BY id DESC LIMIT 200",
    [req.params.id]);
  res.json(rows);
}));

// ==================== START ====================

async function start() {
  await db.init();
  await seedFirstTeacher();
  app.listen(PORT, () => {
    console.log(`InvestLearn server กำลังทำงานที่ http://localhost:${PORT}`);
    console.log(`ฐานข้อมูล: ${process.env.TURSO_DATABASE_URL ? "Turso (ออนไลน์)" : "ไฟล์ในเครื่อง (investlearn.db)"}`);
  });
}

start();
