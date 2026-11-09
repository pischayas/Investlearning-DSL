// stats.js — ฟังก์ชันคำนวณสถิติกลางที่ใช้ร่วมกัน: อันดับ, badge, สรุปรายสัปดาห์, รายงานสรุปผล
const db = require("./db");

const STARTING_CASH = 1000000;

// ---------- ตั้งค่าระบบ (ครูเปิด/ปิดการแสดงอันดับให้นักเรียนเห็นได้) ----------
async function getSetting(key, defaultValue) {
  const row = await db.get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  await db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, String(value)]
  );
}

async function isLeaderboardEnabled() {
  return (await getSetting("leaderboard_enabled", "1")) === "1";
}

// ---------- มูลค่าพอร์ตของนักเรียนทุกคน (ดึงครั้งเดียว ไม่วนยิง query ทีละคน) ----------
async function loadAllStudentValues() {
  const students = await db.all("SELECT student_id, name, cash FROM users WHERE role = 'student'", []);
  const holdings = await db.all("SELECT student_id, ticker, qty, avg_cost FROM holdings WHERE qty > 0", []);
  const stocks = await db.all("SELECT ticker, price FROM stocks", []);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.ticker, s.price]));
  const tradeCounts = await db.all("SELECT student_id, COUNT(*) AS n FROM transactions GROUP BY student_id", []);
  const tradeCountMap = Object.fromEntries(tradeCounts.map((t) => [t.student_id, t.n]));

  const holdingsByStudent = {};
  for (const h of holdings) {
    (holdingsByStudent[h.student_id] = holdingsByStudent[h.student_id] || []).push(h);
  }

  return students.map((s) => {
    const hs = holdingsByStudent[s.student_id] || [];
    const holdingsValue = hs.reduce((sum, h) => sum + (priceMap[h.ticker] || h.avg_cost) * h.qty, 0);
    const total = holdingsValue + s.cash;
    return {
      studentId: s.student_id,
      name: s.name,
      totalValue: total,
      returnPercent: ((total - STARTING_CASH) / STARTING_CASH) * 100,
      tradeCount: tradeCountMap[s.student_id] || 0
    };
  });
}

function firstName(fullName) {
  return String(fullName || "").trim().split(/\s+/)[0] || "-";
}

// ---------- อันดับ (นักเรียนเห็นเฉพาะชื่อต้น เพื่อความเป็นส่วนตัว) ----------
async function buildLeaderboard(myStudentId) {
  const enabled = await isLeaderboardEnabled();
  if (!enabled) return { enabled: false };

  const everyone = await loadAllStudentValues();
  // อันดับนับเฉพาะคนที่เคยซื้อขายอย่างน้อย 1 ครั้ง (ไม่งั้นคนที่ไม่ลงทุนเลยจะได้อันดับ 1 เพราะไม่โดนค่าคอม/spread)
  const all = everyone.filter((s) => s.tradeCount > 0);
  all.sort((a, b) => b.returnPercent - a.returnPercent);

  const ranked = all.map((s, i) => ({
    rank: i + 1,
    name: firstName(s.name),
    returnPercent: s.returnPercent,
    isMe: s.studentId === myStudentId
  }));

  const top = ranked.slice(0, 10);
  const me = ranked.find((r) => r.isMe) || null;
  const meInfo = everyone.find((s) => s.studentId === myStudentId);
  return {
    enabled: true,
    total: ranked.length,
    top,
    me: me && me.rank > 10 ? me : null,
    notRankedYet: !!meInfo && meInfo.tradeCount === 0
  };
}

async function getMyRank(studentId) {
  if (!(await isLeaderboardEnabled())) return null;
  const all = (await loadAllStudentValues()).filter((s) => s.tradeCount > 0);
  all.sort((a, b) => b.returnPercent - a.returnPercent);
  const idx = all.findIndex((s) => s.studentId === studentId);
  return idx === -1 ? null : { rank: idx + 1, total: all.length };
}

// ---------- Snapshot มูลค่าพอร์ต (เอาไว้ทำสรุปรายสัปดาห์ + กราฟในรายงาน) ----------
async function upsertSnapshot(studentId, totalValue) {
  await db.run(
    `INSERT INTO portfolio_snapshots (student_id, snap_date, total_value)
     VALUES (?, date('now'), ?)
     ON CONFLICT(student_id, snap_date) DO UPDATE SET total_value = excluded.total_value`,
    [studentId, Math.round(totalValue * 100) / 100]
  );
}

async function takeAllSnapshots() {
  const all = await loadAllStudentValues();
  for (const s of all) await upsertSnapshot(s.studentId, s.totalValue);
  return all.length;
}

// ---------- สรุปรายสัปดาห์ ----------
async function pastValueFor(studentId) {
  // snapshot ล่าสุดที่เก่ากว่าหรือเท่ากับ 7 วันก่อน ถ้าไม่มี ใช้ snapshot เก่าที่สุดที่ไม่ใช่ของวันนี้
  let row = await db.get(
    `SELECT snap_date, total_value FROM portfolio_snapshots
     WHERE student_id = ? AND snap_date <= date('now', '-7 day')
     ORDER BY snap_date DESC LIMIT 1`,
    [studentId]
  );
  if (!row) {
    row = await db.get(
      `SELECT snap_date, total_value FROM portfolio_snapshots
       WHERE student_id = ? AND snap_date < date('now')
       ORDER BY snap_date ASC LIMIT 1`,
      [studentId]
    );
  }
  return row;
}

async function buildWeeklySummary(studentId) {
  const all = await loadAllStudentValues();
  const me = all.find((s) => s.studentId === studentId);
  if (!me) return { hasData: false };

  await upsertSnapshot(studentId, me.totalValue); // บันทึกของวันนี้ไว้ให้ด้วย

  const returns = [];
  let myReturn = null;
  let spanDays = null;

  for (const s of all) {
    const past = await pastValueFor(s.studentId);
    if (!past || past.total_value <= 0) continue;
    const r = ((s.totalValue - past.total_value) / past.total_value) * 100;
    returns.push(r);
    if (s.studentId === studentId) {
      myReturn = r;
      const ms = Date.now() - new Date(past.snap_date + "T00:00:00Z").getTime();
      spanDays = Math.max(1, Math.round(ms / 86400000));
    }
  }

  if (myReturn === null) return { hasData: false };

  const classAvg = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const rank = await getMyRank(studentId);

  return {
    hasData: true,
    spanDays,
    myReturnPercent: myReturn,
    classAvgPercent: classAvg,
    rank: rank ? rank.rank : null,
    total: rank ? rank.total : null
  };
}

// ---------- Badge (คำนวณสดจากข้อมูลจริง ไม่ต้องเก็บแยก) ----------
const BADGE_DEFS = [
  { id: "first_trade", icon: "🎯", title: "ก้าวแรก", description: "ซื้อขายหุ้นครั้งแรก" },
  { id: "diversified", icon: "🌐", title: "นักกระจายความเสี่ยง", description: "ถือหุ้นอย่างน้อย 3 กลุ่มอุตสาหกรรมพร้อมกัน" },
  { id: "profit_taker", icon: "📈", title: "ทำกำไรสำเร็จ", description: "ขายหุ้นแล้วได้กำไรอย่างน้อย 1 ครั้ง" },
  { id: "cut_loss", icon: "🛡️", title: "กล้าตัดขาดทุน", description: "ขายหุ้นที่ขาดทุนเพื่อรักษาเงินต้น อย่างน้อย 1 ครั้ง" },
  { id: "dividend_collector", icon: "💰", title: "นักลงทุนปันผล", description: "ได้รับเงินปันผลจากอย่างน้อย 3 บริษัท" },
  { id: "long_hold", icon: "⏳", title: "นักลงทุนระยะยาว", description: "ถือหุ้นตัวเดิมต่อเนื่องอย่างน้อย 30 วัน" }
];

async function computeBadges(studentId) {
  const trades = await db.all(
    "SELECT ticker, type, realized_pl, created_at FROM transactions WHERE student_id = ?",
    [studentId]
  );
  const holdings = await db.all(
    `SELECT h.ticker, s.sector FROM holdings h
     LEFT JOIN stocks s ON s.ticker = h.ticker
     WHERE h.student_id = ? AND h.qty > 0`,
    [studentId]
  );
  const divRow = await db.get(
    "SELECT COUNT(DISTINCT ticker) AS n FROM dividend_distributions WHERE student_id = ?",
    [studentId]
  );

  const sectors = new Set(holdings.map((h) => h.sector || "อื่นๆ"));
  const sells = trades.filter((t) => t.type === "sell" && t.realized_pl != null);

  // ถือต่อเนื่อง 30 วัน: หุ้นที่ยังถืออยู่ และซื้อครั้งแรกเมื่อ >= 30 วันก่อน
  const heldTickers = new Set(holdings.map((h) => h.ticker));
  const now = Date.now();
  const longHold = trades.some((t) => {
    if (t.type !== "buy" || !heldTickers.has(t.ticker)) return false;
    const ts = new Date(String(t.created_at).replace(" ", "T") + "Z").getTime();
    return now - ts >= 30 * 86400000;
  });

  const earnedMap = {
    first_trade: trades.length >= 1,
    diversified: sectors.size >= 3,
    profit_taker: sells.some((t) => t.realized_pl > 0),
    cut_loss: sells.some((t) => t.realized_pl < 0),
    dividend_collector: (divRow ? divRow.n : 0) >= 3,
    long_hold: longHold
  };

  return BADGE_DEFS.map((b) => ({ ...b, earned: !!earnedMap[b.id] }));
}

// ---------- รายงานสรุปผลท้ายเทอม ----------
async function buildReport(studentId) {
  const user = await db.get("SELECT student_id, name, cash FROM users WHERE student_id = ? AND role = 'student'", [studentId]);
  if (!user) return null;

  const holdings = await db.all(
    `SELECT h.ticker, h.qty, h.avg_cost, s.price, s.sector, s.name AS stock_name
     FROM holdings h LEFT JOIN stocks s ON s.ticker = h.ticker
     WHERE h.student_id = ? AND h.qty > 0`,
    [studentId]
  );
  const trades = await db.all("SELECT * FROM transactions WHERE student_id = ? ORDER BY id ASC", [studentId]);
  const divs = await db.all("SELECT ticker, total_amount FROM dividend_distributions WHERE student_id = ?", [studentId]);
  const losses = await db.all("SELECT ticker, lost_value FROM delisting_losses WHERE student_id = ?", [studentId]);
  const snapshots = await db.all(
    "SELECT snap_date, total_value FROM portfolio_snapshots WHERE student_id = ? ORDER BY snap_date ASC LIMIT 400",
    [studentId]
  );

  const holdingRows = holdings.map((h) => {
    const price = h.price != null ? h.price : h.avg_cost;
    const value = price * h.qty;
    const cost = h.avg_cost * h.qty;
    return {
      ticker: h.ticker,
      name: h.stock_name || h.ticker,
      sector: h.sector || "อื่นๆ",
      qty: h.qty,
      avgCost: h.avg_cost,
      price,
      value,
      plPercent: cost > 0 ? ((value - cost) / cost) * 100 : 0
    };
  });

  const holdingsValue = holdingRows.reduce((s, h) => s + h.value, 0);
  const totalValue = holdingsValue + user.cash;
  const totalReturn = totalValue - STARTING_CASH;

  const buys = trades.filter((t) => t.type === "buy");
  const sells = trades.filter((t) => t.type === "sell");
  const realizedSells = sells.filter((t) => t.realized_pl != null);
  const wins = realizedSells.filter((t) => t.realized_pl > 0);
  const lossSells = realizedSells.filter((t) => t.realized_pl < 0);
  const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const totalDividends = divs.reduce((s, d) => s + d.total_amount, 0);
  const totalDelistingLoss = losses.reduce((s, l) => s + l.lost_value, 0);
  const realizedTotal = realizedSells.reduce((s, t) => s + t.realized_pl, 0);

  const sortedByPl = [...holdingRows].sort((a, b) => b.plPercent - a.plPercent);
  const badges = await computeBadges(studentId);
  const rank = await getMyRank(studentId);

  // ข้อสังเกตอัตโนมัติ (กฎง่ายๆ ไว้เป็นจุดเริ่มต้นให้ครูใช้ชวนคุยต่อ)
  const insights = [];
  if (trades.length === 0) {
    insights.push("ยังไม่เคยซื้อขายหุ้นเลย ลองเริ่มจากการศึกษาข้อมูลบริษัทแล้วตัดสินใจลงทุนจำนวนน้อยๆ ก่อน");
  } else {
    if (holdingsValue > 0 && holdingRows.length > 0) {
      const top = [...holdingRows].sort((a, b) => b.value - a.value)[0];
      const share = (top.value / holdingsValue) * 100;
      if (share >= 50 && holdingRows.length > 1) {
        insights.push(`พอร์ตหุ้นกระจุกตัว: ${top.ticker} คิดเป็น ${share.toFixed(0)}% ของมูลค่าหุ้นทั้งหมด ลองพิจารณากระจายไปกลุ่มอุตสาหกรรมอื่นเพื่อลดความเสี่ยง`);
      } else if (holdingRows.length === 1) {
        insights.push(`ถือหุ้นแค่ตัวเดียว (${top.ticker}) ความเสี่ยงสูงกว่าการกระจายหลายตัว`);
      }
      const sectorSet = new Set(holdingRows.map((h) => h.sector));
      if (sectorSet.size >= 3) insights.push(`กระจายการลงทุนได้ดี: ถือหุ้นใน ${sectorSet.size} กลุ่มอุตสาหกรรม`);
    }
    const deepLoss = holdingRows.filter((h) => h.plPercent <= -10);
    if (deepLoss.length > 0 && lossSells.length === 0) {
      insights.push(`ยังไม่เคยตัดขาดทุน แต่มีหุ้นที่ขาดทุนเกิน 10% อยู่ (${deepLoss.map((h) => h.ticker).join(", ")}) ลองทบทวนว่าเหตุผลที่ซื้อยังเป็นจริงอยู่หรือไม่`);
    }
    if (lossSells.length > 0) insights.push(`เคยตัดขาดทุน ${lossSells.length} ครั้ง ซึ่งเป็นวินัยที่ดีในการรักษาเงินต้น`);
    if (trades.length >= 8 && Math.abs(totalReturn) > 0 && totalFees > Math.abs(totalReturn) * 0.2) {
      insights.push(`ค่าคอมมิชชั่นรวม ${Math.round(totalFees).toLocaleString("th-TH")} บาท คิดเป็นสัดส่วนสูงเมื่อเทียบกับกำไร/ขาดทุนสุทธิ การซื้อขายถี่เพิ่มต้นทุนแฝง`);
    }
    if (totalDividends > 0) insights.push(`ได้รับเงินปันผลรวม ${Math.round(totalDividends).toLocaleString("th-TH")} บาท ซึ่งเป็นรายได้ระหว่างทางโดยไม่ต้องขายหุ้น`);
    if (totalDelistingLoss > 0) insights.push(`เคยถือหุ้นที่ถูกเพิกถอน สูญเสียเงินลงทุน ${Math.round(totalDelistingLoss).toLocaleString("th-TH")} บาท เป็นบทเรียนเรื่องความเสี่ยงของบริษัทรายตัว`);
  }

  return {
    studentId: user.student_id,
    name: user.name,
    generatedAt: new Date().toISOString().slice(0, 10),
    startingCash: STARTING_CASH,
    cash: user.cash,
    holdingsValue,
    totalValue,
    totalReturn,
    returnPercent: (totalReturn / STARTING_CASH) * 100,
    rank,
    trades: {
      total: trades.length,
      buys: buys.length,
      sells: sells.length,
      winningSells: wins.length,
      losingSells: lossSells.length,
      realizedTotal,
      totalFees
    },
    dividends: { total: totalDividends, count: divs.length },
    delistingLoss: totalDelistingLoss,
    holdings: holdingRows.sort((a, b) => b.value - a.value),
    best: sortedByPl[0] || null,
    worst: sortedByPl.length > 1 ? sortedByPl[sortedByPl.length - 1] : null,
    badges: badges.filter((b) => b.earned),
    timeline: snapshots.map((s) => ({ date: s.snap_date, value: s.total_value })),
    insights
  };
}

module.exports = {
  STARTING_CASH,
  getSetting,
  setSetting,
  isLeaderboardEnabled,
  loadAllStudentValues,
  buildLeaderboard,
  getMyRank,
  upsertSnapshot,
  takeAllSnapshots,
  buildWeeklySummary,
  computeBadges,
  buildReport
};
