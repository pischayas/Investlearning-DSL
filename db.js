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
      pe_ratio REAL,
      pb_ratio REAL,
      dividend_yield REAL,
      market_cap REAL,
      history_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      missed_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS splits (
      ticker TEXT NOT NULL,
      split_date TEXT NOT NULL,
      ratio REAL NOT NULL,
      PRIMARY KEY (ticker, split_date)
    )`,
    `CREATE TABLE IF NOT EXISTS split_adjustments (
      student_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      split_date TEXT NOT NULL,
      old_qty INTEGER NOT NULL,
      new_qty INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (student_id, ticker, split_date)
    )`,
    `CREATE TABLE IF NOT EXISTS delisting_losses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      qty INTEGER NOT NULL,
      lost_value REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      reset_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS dividends (
      ticker TEXT NOT NULL,
      pay_date TEXT NOT NULL,
      amount_per_share REAL NOT NULL,
      PRIMARY KEY (ticker, pay_date)
    )`,
    `CREATE TABLE IF NOT EXISTS dividend_distributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      pay_date TEXT NOT NULL,
      qty INTEGER NOT NULL,
      amount_per_share REAL NOT NULL,
      total_amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (student_id, ticker, pay_date)
    )`
  ]);

  // Migration: เติมคอลัมน์ใหม่ให้ฐานข้อมูลเก่าที่สร้างไว้ก่อนหน้านี้ (เช่น Turso ที่ deploy ไปแล้ว)
  // ทำแบบ try/catch ทีละคอลัมน์ เพราะ libSQL ไม่รองรับ "ADD COLUMN IF NOT EXISTS"
  const migrations = [
    "ALTER TABLE stocks ADD COLUMN pe_ratio REAL",
    "ALTER TABLE stocks ADD COLUMN pb_ratio REAL",
    "ALTER TABLE stocks ADD COLUMN dividend_yield REAL",
    "ALTER TABLE stocks ADD COLUMN market_cap REAL",
    "ALTER TABLE stocks ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE stocks ADD COLUMN missed_count INTEGER NOT NULL DEFAULT 0"
  ];
  for (const sql of migrations) {
    try {
      await client.execute(sql);
    } catch (e) {
      // ข้ามได้ถ้า error เพราะคอลัมน์มีอยู่แล้ว (duplicate column name)
      if (!/duplicate column/i.test(e.message)) {
        console.error("Migration warning:", e.message);
      }
    }
  }
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
