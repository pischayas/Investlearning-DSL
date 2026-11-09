// import_stock_data.js — นำเข้าข้อมูลหุ้นเข้าฐานข้อมูล
// รันด้วย: node import_stock_data.js
//
// ถ้ามีไฟล์ set_data.json (ผลลัพธ์จาก fetch_set_data.py) อยู่ในโฟลเดอร์เดียวกัน
// จะอ่านไฟล์นั้นและนำเข้าข้อมูลจริงทั้งหมด (รวมประวัติการจ่ายปันผลจริง)
// ถ้าไม่มี จะสร้างข้อมูลจำลอง 5 บริษัทไว้ให้ทดสอบระบบได้ทันที (พร้อมปันผลจำลอง)
//
// ใช้ได้ทั้งฐานข้อมูลไฟล์ในเครื่องและ Turso (ตั้งค่า TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
// ก่อนรันคำสั่งนี้ ถ้าต้องการนำเข้าข้อมูลเข้า Turso โดยตรง)
//
// หลังนำเข้าข้อมูลเสร็จ จะเรียก pay_dividends.js ต่อให้อัตโนมัติ เพื่อจ่ายปันผล
// ให้นักเรียนที่ถือหุ้นอยู่ ตามวันจ่ายจริงที่เพิ่งนำเข้ามา

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { distributePendingDividends } = require("./pay_dividends");
const { applyPendingSplits } = require("./apply_splits");
const { markFetchedTickers, liquidateDelistedHoldings } = require("./handle_delisting");
const { takeAllSnapshots } = require("./stats");

const DATA_FILE = path.join(__dirname, "set_data.json");

const UPSERT_SQL = `
  INSERT INTO stocks (ticker, name, price, sector, pe_ratio, pb_ratio, dividend_yield, market_cap, history_json, status, missed_count, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, datetime('now'))
  ON CONFLICT(ticker) DO UPDATE SET
    name = excluded.name, price = excluded.price, sector = excluded.sector,
    pe_ratio = excluded.pe_ratio, pb_ratio = excluded.pb_ratio,
    dividend_yield = excluded.dividend_yield, market_cap = excluded.market_cap,
    history_json = excluded.history_json, status = 'active', missed_count = 0,
    updated_at = excluded.updated_at
`;

const DIVIDEND_UPSERT_SQL = `
  INSERT INTO dividends (ticker, pay_date, amount_per_share)
  VALUES (?, ?, ?)
  ON CONFLICT(ticker, pay_date) DO UPDATE SET amount_per_share = excluded.amount_per_share
`;

const SPLIT_UPSERT_SQL = `
  INSERT INTO splits (ticker, split_date, ratio)
  VALUES (?, ?, ?)
  ON CONFLICT(ticker, split_date) DO UPDATE SET ratio = excluded.ratio
`;

async function saveSplitHistory(ticker, splitHistory) {
  if (!Array.isArray(splitHistory)) return;
  for (const s of splitHistory) {
    if (!s.date || typeof s.ratio !== "number" || s.ratio <= 0) continue;
    await db.run(SPLIT_UPSERT_SQL, [ticker, s.date, s.ratio]);
  }
}

async function saveDividendHistory(ticker, dividendHistory) {
  if (!Array.isArray(dividendHistory)) return;
  for (const d of dividendHistory) {
    if (!d.date || typeof d.amount !== "number" || d.amount <= 0) continue;
    await db.run(DIVIDEND_UPSERT_SQL, [ticker, d.date, d.amount]);
  }
}

async function seedFromRealData() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  let count = 0;
  let divCount = 0;
  let splitCount = 0;
  const fetchedTickers = [];

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
    fetchedTickers.push(ticker);

    if (r.dividend_history && r.dividend_history.length) {
      await saveDividendHistory(ticker, r.dividend_history);
      divCount += r.dividend_history.length;
    }
    if (r.split_history && r.split_history.length) {
      await saveSplitHistory(ticker, r.split_history);
      splitCount += r.split_history.length;
    }
  }
  console.log(`นำเข้าข้อมูลจริงจาก set_data.json สำเร็จ: ${count} บริษัท (ปันผล ${divCount} รายการ, แตกพาร์ ${splitCount} รายการ)`);
  return fetchedTickers;
}

async function seedMockData() {
  const MOCK = {
    PTT:    { name: "ปตท.",           price: 34.50, sector: "Energy",           pe: 8.4,  pb: 0.9, div: 0.042, cap: 980000000000, divAmt: 1.20 },
    AOT:    { name: "ท่าอากาศยานไทย", price: 66.00, sector: "Industrials",      pe: 32.1, pb: 5.2, div: 0.012, cap: 950000000000, divAmt: 0.40 },
    KBANK:  { name: "กสิกรไทย",       price: 143.00, sector: "Financials",      pe: 7.8,  pb: 0.7, div: 0.048, cap: 340000000000, divAmt: 3.50 },
    CPALL:  { name: "ซีพี ออลล์",     price: 58.25, sector: "Consumer Staples", pe: 24.6, pb: 4.1, div: 0.021, cap: 630000000000, divAmt: 0.65 },
    ADVANC: { name: "แอดวานซ์",       price: 282.00, sector: "Communication",   pe: 18.3, pb: 8.6, div: 0.035, cap: 780000000000, divAmt: 4.85 }
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

  // สร้างวันจ่ายปันผลจำลอง: จ่ายปีละ 2 ครั้ง ย้อนหลัง 2 ปี บวกอีก 1 ครั้งที่ "เพิ่งจ่ายไปเมื่อวาน"
  // (เอาไว้ทดสอบว่าระบบจ่ายปันผลอัตโนมัติทำงานจริงได้ทันทีหลังรันสคริปต์นี้)
  function mockDividendDates() {
    const dates = [];
    const now = new Date();
    for (let yearsAgo = 2; yearsAgo >= 0; yearsAgo--) {
      [3, 9].forEach((month) => {
        const d = new Date(now.getFullYear() - yearsAgo, month, 15);
        if (d < now) dates.push(d.toISOString().slice(0, 10));
      });
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    dates.push(yesterday.toISOString().slice(0, 10));
    return dates;
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

    const dividendHistory = mockDividendDates().map((date) => ({ date, amount: s.divAmt }));
    await saveDividendHistory(ticker, dividendHistory);
  }
  console.log(`ไม่พบ set_data.json — สร้างข้อมูลจำลอง ${Object.keys(MOCK).length} บริษัทแทน (พร้อมปันผลจำลอง ใช้ทดสอบระบบได้)`);
  return Object.keys(MOCK);
}

async function main() {
  await db.init();

  let fetchedTickers;
  if (fs.existsSync(DATA_FILE)) {
    fetchedTickers = await seedFromRealData();
  } else {
    fetchedTickers = await seedMockData();
  }

  console.log("กำลังตรวจสอบหุ้นที่อาจถูกเพิกถอน...");
  const newlyDelisted = await markFetchedTickers(fetchedTickers);
  if (newlyDelisted.length > 0) {
    console.log(`พบหุ้นที่ถูกเพิกถอนจริง: ${newlyDelisted.join(", ")}`);
    const delistResult = await liquidateDelistedHoldings(newlyDelisted);
    console.log(`ล้างพอร์ตนักเรียนที่ถือหุ้นเหล่านี้ ${delistResult.affectedCount} รายการ (มูลค่าที่สูญเสีย ${delistResult.totalLostValue.toLocaleString("th-TH")} บาท)`);
  } else {
    console.log("ไม่พบหุ้นที่ถูกเพิกถอนใหม่");
  }

  console.log("กำลังตรวจสอบและปรับหุ้นที่แตกพาร์/รวมพาร์...");
  const splitResult = await applyPendingSplits();
  console.log(`ปรับพอร์ตนักเรียนจากการแตกพาร์/รวมพาร์ ${splitResult.count} รายการ`);

  console.log("กำลังตรวจสอบและจ่ายเงินปันผลที่ถึงกำหนด...");
  const result = await distributePendingDividends();
  console.log(`จ่ายปันผลให้นักเรียนรวม ${result.count} รายการ (${result.totalAmount.toLocaleString("th-TH")} บาท)`);

  // บันทึกมูลค่าพอร์ตของนักเรียนทุกคน (ใช้ทำสรุปรายสัปดาห์ และกราฟในรายงานสรุปผล)
  const snapCount = await takeAllSnapshots();
  console.log(`บันทึกมูลค่าพอร์ตของนักเรียน ${snapCount} คน`);
}

main().catch((e) => { console.error(e); process.exit(1); });
