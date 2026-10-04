// pay_dividends.js — จ่ายเงินปันผลให้นักเรียนที่ถือหุ้นอยู่ ตามวันจ่ายจริงที่ดึงมาจาก Yahoo Finance
//
// หลักการ (และข้อจำกัดที่ควรรู้):
//   ระบบนี้เช็คว่า "วันจ่ายปันผล" (pay_date) ของหุ้นแต่ละตัวถึงกำหนดแล้วหรือยัง
//   (pay_date <= วันนี้) ถ้าถึงแล้วและยังไม่เคยจ่ายให้นักเรียนคนนั้นมาก่อน (เช็คจากตาราง
//   dividend_distributions) จะจ่ายเงินสดเข้าบัญชีทันที คำนวณจาก "จำนวนหุ้นที่ถืออยู่ ณ
//   ตอนนี้" (ไม่ใช่ ณ วันที่ประกาศสิทธิ์จริง เพราะระบบนี้ไม่ได้เก็บประวัติการถือหุ้นย้อนหลัง
//   แบบรายวัน) ดังนั้นถ้านักเรียนเพิ่งซื้อหุ้นหลังวันจ่ายปันผลแต่ก่อนรันสคริปต์นี้รอบถัดไป
//   ก็ยังมีสิทธิ์ได้ปันผลก้อนนั้นไปด้วย — เป็นการลดทอนความซับซ้อนที่ยอมรับได้สำหรับ
//   การจำลองเพื่อการศึกษา แต่ไม่ใช่กลไกจริงของตลาดหุ้น (ตลาดจริงต้องถือก่อน "วันขึ้นเครื่องหมาย XD")
//
// ฟังก์ชันนี้ถูกเรียกอัตโนมัติท้าย import_stock_data.js ทุกครั้งที่มีการอัปเดตข้อมูล

const db = require("./db");

async function distributePendingDividends() {
  const today = new Date().toISOString().slice(0, 10);

  const pendingDividends = await db.all(
    "SELECT ticker, pay_date, amount_per_share FROM dividends WHERE pay_date <= ?",
    [today]
  );

  let count = 0;
  let totalAmount = 0;

  for (const div of pendingDividends) {
    const holders = await db.all(
      "SELECT student_id, qty FROM holdings WHERE ticker = ? AND qty > 0",
      [div.ticker]
    );

    for (const holder of holders) {
      const alreadyPaid = await db.get(
        "SELECT id FROM dividend_distributions WHERE student_id = ? AND ticker = ? AND pay_date = ?",
        [holder.student_id, div.ticker, div.pay_date]
      );
      if (alreadyPaid) continue; // กันจ่ายซ้ำ

      const totalForHolder = Math.round(holder.qty * div.amount_per_share * 100) / 100;
      if (totalForHolder <= 0) continue;

      await db.run(
        `INSERT INTO dividend_distributions (student_id, ticker, pay_date, qty, amount_per_share, total_amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [holder.student_id, div.ticker, div.pay_date, holder.qty, div.amount_per_share, totalForHolder]
      );
      await db.run("UPDATE users SET cash = cash + ? WHERE student_id = ?", [totalForHolder, holder.student_id]);

      count++;
      totalAmount += totalForHolder;
    }
  }

  return { count, totalAmount };
}

module.exports = { distributePendingDividends };
