// db.js — เลเยอร์ฐานข้อมูล ใช้ libSQL client
//
// จุดเด่น: โค้ดชุดเดียวกันนี้ใช้ได้ทั้ง 2 แบบ ไม่ต้องแก้โค้ดตอน deploy จริง
//   - ตอนพัฒนา/ทดสอบบนเครื่องตัวเอง: เก็บเป็นไฟล์ธรรมดา (file:investlearn.db)
//   - ตอน deploy จริง: ต่อกับ Turso (ฐานข้อมูลออนไลน์ฟรีถาวร) ผ่าน environment variables
//
// วิธีสลับไปใช้ Turso: ตั้งค่า environment variables สองตัวนี้ (ดูวิธีได้ใน README.md)
//   TURSO_DATABASE_URL=libsql://your-db-xxxx.turso.io
//   TURSO_AUTH_TOKEN=xxxxxxxx

const { createClient } = require("@libsql/client");

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:investlearn.db",
  authToken: process.env.TURSO_AUTH_TOKEN || undefined
});

async function init() {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS users (
      student_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('student','teacher')),
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      cash REAL NOT NULL DEFAULT 1000000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS holdings (
      student_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      qty INTEGER NOT NULL,
      avg_cost REAL NOT NULL,
      PRIMARY KEY (student_id, ticker)
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('buy','sell')),
      qty INTEGER NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS stocks (
      ticker TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      sector TEXT,
      history_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      reset_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ]);
}

// ---------- helper functions (คงหน้าตา API คล้ายเดิม แต่เป็น async ทั้งหมด) ----------

async function get(sql, args) {
  const res = await client.execute({ sql, args: args || [] });
  return res.rows[0] || null;
}

async function all(sql, args) {
  const res = await client.execute({ sql, args: args || [] });
  return res.rows;
}

async function run(sql, args) {
  const res = await client.execute({ sql, args: args || [] });
  return { lastInsertRowid: res.lastInsertRowid, rowsAffected: res.rowsAffected };
}

module.exports = { client, init, get, all, run };
