// apply_splits.js — ปรับจำนวนหุ้น/ต้นทุนเฉลี่ยของนักเรียนอัตโนมัติ เมื่อบริษัทมีการแตกพาร์/รวมพาร์จริง
//
// หลักการ: ถ้าหุ้น A แตกพาร์ 1:2 (ratio = 2) นักเรียนที่เคยถือ 100 หุ้น ต้นทุนเฉลี่ย 34 บาท
// จะกลายเป็นถือ 200 หุ้น ต้นทุนเฉลี่ย 17 บาท โดยอัตโนมัติ (มูลค่ารวมเท่าเดิม ไม่ได้กำไร/ขาดทุน
// จากเหตุการณ์นี้ — แค่ปรับตัวเลขให้ตรงกับความเป็นจริงของตลาด)
//
// ตารางเดียวที่ sensitive คือ holdings.qty ต้องเป็นจำนวนเต็ม จึงปัดเศษหุ้นที่ได้เพิ่มลง
// (เศษหุ้นที่ปัดออกถือเป็นความคลาดเคลื่อนเล็กน้อยที่ยอมรับได้สำหรับการจำลองเพื่อการศึกษา)

const db = require("./db");

async function applyPendingSplits() {
  const today = new Date().toISOString().slice(0, 10);

  const pendingSplits = await db.all(
    "SELECT ticker, split_date, ratio FROM splits WHERE split_date <= ?",
    [today]
  );

  let count = 0;

  for (const split of pendingSplits) {
    const holders = await db.all(
      "SELECT student_id, qty, avg_cost FROM holdings WHERE ticker = ? AND qty > 0",
      [split.ticker]
    );

    for (const holder of holders) {
      const already = await db.get(
        "SELECT 1 AS x FROM split_adjustments WHERE student_id = ? AND ticker = ? AND split_date = ?",
        [holder.student_id, split.ticker, split.split_date]
      );
      if (already) continue; // กันปรับซ้ำ

      const newQty = Math.round(holder.qty * split.ratio);
      const newAvgCost = (holder.qty * holder.avg_cost) / newQty;

      await db.run(
        "UPDATE holdings SET qty = ?, avg_cost = ? WHERE student_id = ? AND ticker = ?",
        [newQty, Math.round(newAvgCost * 10000) / 10000, holder.student_id, split.ticker]
      );
      await db.run(
        "INSERT INTO split_adjustments (student_id, ticker, split_date, old_qty, new_qty) VALUES (?, ?, ?, ?, ?)",
        [holder.student_id, split.ticker, split.split_date, holder.qty, newQty]
      );

      count++;
    }
  }

  return { count };
}

module.exports = { applyPendingSplits };
