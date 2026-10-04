// handle_delisting.js — ตรวจจับหุ้นที่ถูกเพิกถอนจริง แล้วทำให้พอร์ตนักเรียนที่ถือหุ้นนั้น
// "ขาดทุนเต็มจำนวน" แทนที่จะปล่อยให้ราคาค้างอยู่ที่เดิมตลอดไปแบบไม่สมจริง
//
// หลักการ: ทุกครั้งที่ fetch_set_data.py ดึงข้อมูลใหม่ หุ้นที่ Yahoo Finance ไม่มีข้อมูลให้แล้ว
// (เช่น เพิกถอนออกจากตลาด) จะหายไปจาก set_data.json แต่การหายไปแค่ 1 ครั้งอาจเป็นปัญหาชั่วคราว
// ของ Yahoo เอง จึงใช้ตัวนับ "missed_count" — ถ้าหายไปติดต่อกันครบ 3 รอบการอัปเดต (ประมาณ 1 วัน
// ที่อัปเดต 3 รอบ/วัน) ถึงจะถือว่าเพิกถอนจริง แล้วเคลียร์โฮลดิ้งของทุกคนที่ถือหุ้นนั้นทันที
// โดยไม่คืนเงินสดกลับ (ถือเป็นการขาดทุน 100% เหมือนการถือหุ้นที่ล้มละลายในชีวิตจริง)

const db = require("./db");

const MISSED_THRESHOLD = 3;

async function markFetchedTickers(fetchedTickers) {
  const fetchedSet = new Set(fetchedTickers);
  const allStocks = await db.all("SELECT ticker, status, missed_count FROM stocks WHERE status = 'active'", []);

  let newlyDelisted = [];

  for (const s of allStocks) {
    if (fetchedSet.has(s.ticker)) {
      if (s.missed_count !== 0) {
        await db.run("UPDATE stocks SET missed_count = 0 WHERE ticker = ?", [s.ticker]);
      }
      continue;
    }

    const newMissed = s.missed_count + 1;
    if (newMissed >= MISSED_THRESHOLD) {
      await db.run("UPDATE stocks SET status = 'delisted', missed_count = ? WHERE ticker = ?", [newMissed, s.ticker]);
      newlyDelisted.push(s.ticker);
    } else {
      await db.run("UPDATE stocks SET missed_count = ? WHERE ticker = ?", [newMissed, s.ticker]);
    }
  }

  return newlyDelisted;
}

async function liquidateDelistedHoldings(delistedTickers) {
  let totalLostValue = 0;
  let affectedCount = 0;

  for (const ticker of delistedTickers) {
    const holders = await db.all("SELECT student_id, qty, avg_cost FROM holdings WHERE ticker = ? AND qty > 0", [ticker]);

    for (const holder of holders) {
      const lostValue = Math.round(holder.qty * holder.avg_cost * 100) / 100;

      await db.run("DELETE FROM holdings WHERE student_id = ? AND ticker = ?", [holder.student_id, ticker]);
      await db.run(
        "INSERT INTO delisting_losses (student_id, ticker, qty, lost_value) VALUES (?, ?, ?, ?)",
        [holder.student_id, ticker, holder.qty, lostValue]
      );
      // หมายเหตุ: ไม่คืนเงินสดใดๆ ให้ — มูลค่าที่เคยลงทุนไปหายไปทั้งหมด เหมือนหุ้นที่ล้มละลายจริง

      totalLostValue += lostValue;
      affectedCount++;
    }
  }

  return { affectedCount, totalLostValue };
}

module.exports = { markFetchedTickers, liquidateDelistedHoldings, MISSED_THRESHOLD };
