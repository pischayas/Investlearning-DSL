"""
fetch_set_data.py
==================

ดึงข้อมูลราคา + ข้อมูลการเงินจริงของบริษัทจดทะเบียนในตลาดหลักทรัพย์แห่งประเทศไทย (SET)
ให้ครบทุกบริษัท แบบไม่ต้องดาวน์โหลดรายชื่อบริษัทเองและไม่ต้อง scrape เว็บไหนเลย

แหล่งข้อมูล 2 ชั้น (ทั้งคู่ถูกกฎ ไม่มีปัญหาเรื่อง robots.txt/ToS)
-------------------------------------------------------------
1. รายชื่อบริษัท (ticker, ชื่อ, กลุ่มอุตสาหกรรม)
   -> ใช้ไลบรารี "financedatabase" (โอเพนซอร์ส สัญญาอนุญาต MIT)
      เป็นฐานข้อมูลนิ่งที่รวบรวมไว้แล้ว ไม่ใช่การ scrape สดจากเว็บไหน
      ครอบคลุมหุ้นที่จดทะเบียนใน SET ประมาณ 700+ บริษัท
2. ราคา + ข้อมูลการเงิน (P/E, P/B, ปันผล, กราฟราคาย้อนหลัง)
   -> ใช้ yfinance (Yahoo Finance) ตามที่คุยกันไว้ก่อนหน้า

ทำไมไม่ scrape จาก set.or.th หรือ Yahoo โดยตรงเพื่อเอารายชื่อ
--------------------------------------------------------------
- set.or.th มี robots.txt ห้ามการเข้าถึงไฟล์ดาวน์โหลดแบบอัตโนมัติ (เช็คแล้วจริง)
- Yahoo Finance ไม่มี endpoint ทางการสำหรับ "ขอรายชื่อหุ้นทั้งหมดในตลาด" ให้ใช้
  วิธีที่มีคนทำ (scrape หน้า screener) ก็ยังเป็นการดึงจากหน้าเว็บที่ไม่ได้ตั้งใจให้ทำแบบนั้น
- financedatabase แก้ปัญหานี้ตรงจุด: เป็นฐานข้อมูลที่ถูกรวบรวมและเผยแพร่แบบเปิดไว้แล้ว
  เราแค่ import มาใช้ ไม่ได้ไปแตะเว็บของ SET หรือ Yahoo เพื่อเอารายชื่อเลย

ใช้เพื่อการศึกษา/ในห้องเรียนเท่านั้น ไม่ควรนำไปแจกจ่ายต่อสาธารณะแบบเชิงพาณิชย์

วิธีใช้งาน
----------
1. pip install financedatabase yfinance pandas --break-system-packages
2. รันคำสั่ง:
       python fetch_set_data.py --output set_data.json
   (ไม่ต้องเตรียมไฟล์ CSV เองแล้ว สคริปต์จะดึงรายชื่อให้อัตโนมัติจาก financedatabase)

   ถ้าอยากใช้รายชื่อของตัวเอง (เช่น เฉพาะ SET50) ยังส่ง --input ไฟล์ CSV เข้ามาแทนได้เหมือนเดิม

ข้อควรระวังเรื่องความเร็ว/ปริมาณ
--------------------------------
SET มีบริษัทจดทะเบียนกว่า 700 บริษัท การดึงข้อมูล fundamentals (.info) ทีละตัวจาก
Yahoo ใช้เวลานานและอาจโดน rate-limit ได้ สคริปต์นี้จึง:
- ใส่ delay ระหว่างคำขอแต่ละตัว (ปรับได้ที่ SLEEP_SECONDS)
- บันทึกผลแบบ resumable — ถ้ารันค้างไว้แล้วรันใหม่ จะข้ามตัวที่ดึงไปแล้ว
- แนะนำให้เริ่มทดสอบด้วย --limit 20 ก่อน แล้วค่อยรันเต็มทั้งตลาด
"""

import argparse
import json
import math
import os
import sys
import time

try:
    import yfinance as yf
    import pandas as pd
except ImportError:
    print("ต้องติดตั้งไลบรารีก่อน: pip install yfinance pandas financedatabase --break-system-packages")
    sys.exit(1)

SLEEP_SECONDS = 1.2  # หน่วงเวลาระหว่างบริษัท กันโดน rate-limit
HISTORY_PERIODS = {
    "1mo": "1mo",
    "6mo": "6mo",
    "1y": "1y",
}


def to_yahoo_ticker(set_ticker: str) -> str:
    """แปลงชื่อย่อหุ้นไทย (เช่น PTT) เป็นรูปแบบที่ Yahoo Finance ใช้ (PTT.BK)"""
    t = set_ticker.strip().upper()
    if not t.endswith(".BK"):
        t += ".BK"
    return t


def load_company_list_from_financedatabase():
    """ดึงรายชื่อบริษัททั้งหมดที่จดทะเบียนใน SET จากฐานข้อมูลเปิด (MIT license)
    ไม่ต้องดาวน์โหลดไฟล์เอง ไม่ต้อง scrape เว็บไหน"""
    import financedatabase as fd
    equities = fd.Equities()
    df = equities.select(country="Thailand")
    set_df = df[df["exchange"] == "SET"]
    clean = set_df[~set_df.index.str.contains("-")]  # ตัดหุ้น NVDR/rights ที่ซ้ำออก
    records = []
    for ticker, row in clean.iterrows():
        records.append({
            "ticker": ticker.replace(".BK", ""),
            "name": row.get("name", ""),
            "sector": row.get("sector", ""),
        })
    return records


def load_company_list(csv_path: str):
    df = pd.read_csv(csv_path)
    df.columns = [c.strip().lower() for c in df.columns]
    if "ticker" not in df.columns:
        raise ValueError("ไฟล์ CSV ต้องมีคอลัมน์ชื่อ 'ticker' อย่างน้อย")
    records = []
    for _, row in df.iterrows():
        records.append({
            "ticker": str(row["ticker"]).strip().upper(),
            "name": str(row.get("name", "")).strip(),
        })
    return records


def load_existing_output(output_path: str) -> dict:
    if os.path.exists(output_path):
        try:
            with open(output_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def fetch_one(set_ticker: str, name: str) -> dict | None:
    yahoo_ticker = to_yahoo_ticker(set_ticker)
    try:
        tk = yf.Ticker(yahoo_ticker)
        info = tk.info or {}

        history = {}
        for label, period in HISTORY_PERIODS.items():
            hist_df = tk.history(period=period)
            if not hist_df.empty:
                history[label] = [round(float(x), 2) for x in hist_df["Close"].tolist()]

        if not history and not info.get("currentPrice"):
            # ไม่มีข้อมูลเลย น่าจะเป็น ticker ที่ไม่ตรงกับ Yahoo หรือถูกเพิกถอนแล้ว
            return None

        def clean_num(v):
            # Yahoo บางครั้งส่งค่า NaN มา ซึ่งเขียนเป็น JSON ตรงๆ ไม่ได้ (JS อ่านไม่ได้)
            # แปลงเป็น None (จะกลายเป็น null ใน JSON ที่ถูกต้อง) แทน
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                return None
            return v

        # ดึงประวัติการจ่ายปันผลจริง (วันที่ + จำนวนเงินต่อหุ้น) ย้อนหลังสูงสุด 3 ปี
        dividend_history = []
        try:
            div_series = tk.dividends
            if div_series is not None and not div_series.empty:
                cutoff = div_series.index.max() - pd.Timedelta(days=365 * 3)
                recent = div_series[div_series.index >= cutoff]
                for pay_date, amount in recent.items():
                    amt = clean_num(round(float(amount), 4))
                    if amt is not None and amt > 0:
                        dividend_history.append({
                            "date": pay_date.strftime("%Y-%m-%d"),
                            "amount": amt
                        })
        except Exception:
            pass  # บริษัทบางตัวไม่มีประวัติปันผล ไม่ต้องทำให้สคริปต์หยุด

        # ดึงประวัติการแตกพาร์/รวมพาร์จริง (วันที่ + อัตราส่วน) ย้อนหลังสูงสุด 1 ปี
        # เอาไว้ปรับจำนวนหุ้น/ต้นทุนเฉลี่ยของนักเรียนให้ถูกต้องเมื่อเกิดเหตุการณ์นี้จริง
        split_history = []
        try:
            split_series = tk.splits
            if split_series is not None and not split_series.empty:
                cutoff = split_series.index.max() - pd.Timedelta(days=365)
                recent = split_series[split_series.index >= cutoff]
                for split_date, ratio in recent.items():
                    r = clean_num(round(float(ratio), 6))
                    if r is not None and r > 0 and r != 1:
                        split_history.append({
                            "date": split_date.strftime("%Y-%m-%d"),
                            "ratio": r
                        })
        except Exception:
            pass

        return {
            "ticker": set_ticker,
            "name": name or info.get("longName", ""),
            "yahoo_ticker": yahoo_ticker,
            "sector": info.get("sector", ""),
            "industry": info.get("industry", ""),
            "current_price": clean_num(info.get("currentPrice") or info.get("regularMarketPrice")),
            "pe_ratio": clean_num(info.get("trailingPE")),
            "pb_ratio": clean_num(info.get("priceToBook")),
            "dividend_yield": clean_num(info.get("dividendYield")),
            "market_cap": clean_num(info.get("marketCap")),
            "history": history,
            "dividend_history": dividend_history,
            "split_history": split_history,
            "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        print(f"  ⚠ ดึงข้อมูล {set_ticker} ไม่สำเร็จ: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="ดึงข้อมูลหุ้น SET ทุกบริษัทผ่าน yfinance")
    parser.add_argument("--input", default=None, help="ไฟล์ CSV รายชื่อบริษัทของตัวเอง (ticker,name) ถ้าไม่ระบุจะดึงอัตโนมัติจาก financedatabase")
    parser.add_argument("--output", default="set_data.json", help="ไฟล์ JSON ผลลัพธ์")
    parser.add_argument("--limit", type=int, default=None, help="จำกัดจำนวนบริษัทสำหรับทดสอบ")
    args = parser.parse_args()

    if args.input:
        companies = load_company_list(args.input)
    else:
        print("ไม่ได้ระบุ --input จะดึงรายชื่อบริษัททั้งหมดจาก financedatabase อัตโนมัติ...")
        companies = load_company_list_from_financedatabase()

    if args.limit:
        companies = companies[: args.limit]

    results = load_existing_output(args.output)
    total = len(companies)
    print(f"พบบริษัททั้งหมด {total} รายการ | มีข้อมูลอยู่แล้ว {len(results)} รายการ")

    for i, company in enumerate(companies, start=1):
        ticker = company["ticker"]
        if ticker in results:
            continue  # ข้ามตัวที่ดึงไปแล้ว (resumable)

        print(f"[{i}/{total}] กำลังดึง {ticker} ...")
        data = fetch_one(ticker, company["name"])
        if data:
            results[ticker] = data
            # เซฟทุกครั้งที่ได้ข้อมูลใหม่ กันข้อมูลหายถ้าสคริปต์ถูกหยุดกลางทาง
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2, allow_nan=False)

        time.sleep(SLEEP_SECONDS)

    print(f"\nเสร็จสิ้น ดึงข้อมูลได้ {len(results)}/{total} บริษัท -> บันทึกที่ {args.output}")

    # ถ้าสำเร็จน้อยกว่า 70% แปลว่า Yahoo น่าจะบล็อก/จำกัดการเข้าถึง ให้รอบนี้ "ล้มเหลว" (❌ ใน GitHub Actions)
    # ขั้นตอนนำเข้า Turso ที่ตามมาจะถูกข้ามไปอัตโนมัติ ข้อมูลเดิมในระบบจึงไม่ถูกแตะ
    # (ปกติสำเร็จประมาณ 90% เพราะบางบริษัทไม่มีข้อมูลใน Yahoo)
    if total >= 20 and len(results) < total * 0.7:
        print(f"ผิดปกติ: สำเร็จเพียง {len(results)}/{total} (ต่ำกว่า 70%) — Yahoo Finance อาจจำกัดการเข้าถึง", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
