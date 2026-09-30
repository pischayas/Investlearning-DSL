// import_stock_data.js — นำเข้าข้อมูลหุ้นเข้าฐานข้อมูล
// รันด้วย: node import_stock_data.js
//
// ถ้ามีไฟล์ set_data.json (ผลลัพธ์จาก fetch_set_data.py) อยู่ในโฟลเดอร์เดียวกัน
// จะอ่านไฟล์นั้นและนำเข้าข้อมูลจริงทั้งหมด
// ถ้าไม่มี จะสร้างข้อมูลจำลอง 5 บริษัทไว้ให้ทดสอบระบบได้ทันที
//
// ใช้ได้ทั้งฐานข้อมูลไฟล์ในเครื่องและ Turso (ตั้งค่า TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
// ก่อนรันคำสั่งนี้ ถ้าต้องการนำเข้าข้อมูลเข้า Turso โดยตรง)

const fs = require("fs");
const path = require("path");
const db = require("./db");

const DATA_FILE = path.join(__dirname, "set_data.json");

const UPSERT_SQL = `
  INSERT INTO stocks (ticker, name, price, sector, pe_ratio, pb_ratio, dividend_yield, market_cap, history_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(ticker) DO UPDATE SET
    name = excluded.name, price = excluded.price, sector = excluded.sector,
    pe_ratio = excluded.pe_ratio, pb_ratio = excluded.pb_ratio,
    dividend_yield = excluded.dividend_yield, market_cap = excluded.market_cap,
    history_json = excluded.history_json, updated_at = excluded.updated_at
`;

async function seedFromRealData() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  let count = 0;
  for (const ticker of Object.keys(raw)) {
    const r = raw[ticker];
    const h1m = (r.history && r.history["1mo"]) || [];
    const h6m = (r.history && r.history["6mo"]) || [];
    const h1y = (r.history && r.history["1y"]) || [];
    if (h1m.length < 2 && h6m.length < 2 && h1y.length < 2) continue;

    const price = r.current_price || h1m[h1m.length - 1] || h6m[h6m.length - 1] || h1y[h1y.length - 1];
    const history = {
      "1D": h1m.slice(-10).length >= 2 ? h1m.slice(-10) : h1m,
      "1M": h1m,
      "6M": h6m,
      "1Y": h1y
    };

    await db.run(UPSERT_SQL, [
      ticker,
      r.name || ticker,
      Math.round(price * 100) / 100,
      r.sector || null,
      r.pe_ratio ?? null,
      r.pb_ratio ?? null,
      r.dividend_yield ?? null,
      r.market_cap ?? null,
      JSON.stringify(history)
    ]);
    count++;
  }
  console.log(`นำเข้าข้อมูลจริงจาก set_data.json สำเร็จ: ${count} บริษัท`);
}

async function seedMockData() {
  const MOCK = {
    PTT:    { name: "ปตท.",           price: 34.50, sector: "Energy",           pe: 8.4,  pb: 0.9, div: 0.042, cap: 980000000000 },
    AOT:    { name: "ท่าอากาศยานไทย", price: 66.00, sector: "Industrials",      pe: 32.1, pb: 5.2, div: 0.012, cap: 950000000000 },
    KBANK:  { name: "กสิกรไทย",       price: 143.00, sector: "Financials",      pe: 7.8,  pb: 0.7, div: 0.048, cap: 340000000000 },
    CPALL:  { name: "ซีพี ออลล์",     price: 58.25, sector: "Consumer Staples", pe: 24.6, pb: 4.1, div: 0.021, cap: 630000000000 },
    ADVANC: { name: "แอดวานซ์",       price: 282.00, sector: "Communication",   pe: 18.3, pb: 8.6, div: 0.035, cap: 780000000000 }
  };

  function randomWalk(base, n, vol) {
    let v = base * (1 - vol * n * 0.3);
    const arr = [];
    for (let i = 0; i < n - 1; i++) {
      v = v * (1 + (Math.random() - 0.48) * vol);
      arr.push(Math.round(Math.max(v, base * 0.5) * 100) / 100);
    }
    arr.push(base);
    return arr;
  }

  for (const ticker of Object.keys(MOCK)) {
    const s = MOCK[ticker];
    const history = {
      "1D": randomWalk(s.price, 12, 0.004),
      "1M": randomWalk(s.price, 20, 0.012),
      "6M": randomWalk(s.price, 26, 0.02),
      "1Y": randomWalk(s.price, 30, 0.03)
    };
    await db.run(UPSERT_SQL, [ticker, s.name, s.price, s.sector, s.pe, s.pb, s.div, s.cap, JSON.stringify(history)]);
  }
  console.log(`ไม่พบ set_data.json — สร้างข้อมูลจำลอง ${Object.keys(MOCK).length} บริษัทแทน (ใช้ทดสอบระบบได้)`);
}

async function main() {
  await db.init();
  if (fs.existsSync(DATA_FILE)) {
    await seedFromRealData();
  } else {
    await seedMockData();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
