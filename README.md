# Land for Loan → Telegram Tracker

รันบน GitHub Actions (ฟรี, ทำงานบนคลาวด์ ปิดคอม/มือถือได้)

| เวลา | ทำอะไร |
|---|---|
| ทุกวัน 07:00 | ส่งสรุป + ทรัพย์ที่เปิดรับนักลงทุนทั้งหมด ทีละทรัพย์ (ขายฝากก่อน จำนอง) |
| ทุก 30 นาที | 🆕 แจ้งทรัพย์ใหม่ / ✅ แจ้งทรัพย์ที่ปิดดีล (รูปปกเปลี่ยนเป็น MATCH) |

ข้อมูลดึงจาก API ของเว็บ `landforloan.co.th/wp-json/wp/v2/listing`
ทรัพย์ที่ "เปิดอยู่" = มีวงเงินขายฝาก/จำนอง และรูปปกไม่ใช่รูป MATCH

## ติดตั้ง (ครั้งเดียว)

1. **สร้างบอท** — คุยกับ [@BotFather](https://t.me/BotFather) → `/newbot` → ได้ **Bot Token**
2. **เพิ่มบอทเข้ากลุ่ม** Telegram แล้วพิมพ์อะไรก็ได้ในกลุ่ม 1 ข้อความ
3. **หา Chat ID** — เปิด `https://api.telegram.org/bot<TOKEN>/getUpdates`
   หา `"chat":{"id":-100xxxxxxxxxx` (เลขติดลบคือ Chat ID ของกลุ่ม)
4. **สร้าง repo บน GitHub** (แนะนำ Public — นาทีรันฟรีไม่จำกัด) แล้วอัปโหลดไฟล์ในโฟลเดอร์นี้ทั้งหมด
5. ไปที่ repo → **Settings → Secrets and variables → Actions → New repository secret**
   - `TELEGRAM_BOT_TOKEN` = token จากข้อ 1
   - `TELEGRAM_CHAT_ID` = เลขจากข้อ 3
6. ไปที่แท็บ **Actions** → เลือก *Land for Loan tracker* → **Run workflow**
   - เลือก `morning` เพื่อทดสอบส่งทันที

## ทดสอบบนเครื่อง (ไม่ส่งจริง)

```bash
DRY_RUN=1 node tracker.mjs morning
```

## หมายเหตุ
- GitHub อาจเริ่มงานช้ากว่าเวลาตั้งไว้ 5–15 นาทีในบางวัน
- `state.json` คือความจำของบอทว่าทรัพย์ไหนเคยแจ้งแล้ว ระบบ commit ให้อัตโนมัติ อย่าลบ
