// auth.js — จัดการการ hash/ตรวจสอบรหัสผ่าน และการสุ่มรหัสผ่านชั่วคราว
// ใช้ crypto.scrypt ที่มากับ Node.js เอง ไม่ต้องพึ่งไลบรารีภายนอก (เช่น bcrypt)

const crypto = require("crypto");

function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(plainPassword, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  // ใช้ timingSafeEqual กันการโจมตีแบบ timing attack
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateTempPassword() {
  // เลี่ยงตัวอักษร/ตัวเลขที่สับสนกันง่าย เช่น 0/O, 1/I
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = { hashPassword, verifyPassword, generateTempPassword, generateToken };
