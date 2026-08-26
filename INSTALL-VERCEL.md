# ทางสำรอง: Deploy บน Vercel (เมื่อบัญชี Cloudflare โดนล็อก workers.dev)

ใช้เมื่อเจอแถบแดง "You cannot register a workers.dev subdomain" (ดู INSTALL.md ข้อ 0) — โค้ดชุดเดียวกันทั้งหมด ต่างแค่ที่รัน:

| ส่วน | Cloudflare (ทางหลัก) | Vercel (ทางสำรอง) |
|---|---|---|
| API + webhook | Worker | Vercel Function (`api/[...path].ts` — Hono ตัวเดียวกัน) |
| Database | D1 | **Turso** (SQLite บนคลาวด์ ฟรี — ผ่าน shim ใน `vercel-adapter/`) |
| Cron รายชั่วโมง | Cron Trigger | **cron-job.org** (ฟรี) ยิง `/api/cron` |
| Workflow สรุป | Cloudflare Workflows | รัน inline ใน cron request (เพดาน 300 วินาที) |
| หน้าเว็บ | Static Assets | Vercel static (`dist-vercel/`) |

ข้อจำกัดเทียบทางหลัก: สรุปทำงานใน request เดียว (≤10 กลุ่ม/รอบ พอดีกับ REAL_GROUP_LIMIT) และไม่มี retry ข้ามเครื่องแบบ Workflows — คุณภาพเดียวกันสำหรับสเกลห้องเรียน

## 1. สร้าง Turso database (ฟรี)

```bash
brew install tursodatabase/tap/turso
turso auth login
turso db create line-secretary
turso db show line-secretary --url
turso db tokens create line-secretary
```

เก็บ URL (`libsql://...`) และ token ไว้

## 2. Migrate + seed demo

```bash
export TURSO_DATABASE_URL="libsql://<ของคุณ>.turso.io"
export TURSO_AUTH_TOKEN="<token>"
npm run migrate:turso
npm run seed:demo:turso
```

## 3. ทดสอบในเครื่องก่อน

```bash
npm run smoke:vercel   # migrate + login + dashboard บนไฟล์ local — ต้องขึ้น "ผ่าน"
```

## 4. Deploy ขึ้น Vercel

```bash
npx vercel link
npx vercel env add TURSO_DATABASE_URL production
npx vercel env add TURSO_AUTH_TOKEN production
npx vercel env add DASHBOARD_PASSWORD production   # ยาว ≥12 ตัวอักษร
openssl rand -base64 32 | npx vercel env add SESSION_SECRET production
npx vercel env add OPENROUTER_API_KEY production
# CRON_SECRET ต้องเก็บค่าไว้ใช้กับ cron-job.org ด้วย — สร้างเป็นตัวแปรก่อน
CRON_SECRET="$(openssl rand -base64 24 | tr -d '=+/')"
echo "จดไว้ใส่ cron-job.org: $CRON_SECRET"
printf '%s' "$CRON_SECRET" | npx vercel env add CRON_SECRET production
npx vercel deploy --prod
# ได้ URL แล้ว ตั้ง DASHBOARD_URL ให้ตรง (ใช้ในลิงก์ digest + header ถึง OpenRouter)
printf '%s' "https://<โปรเจค>.vercel.app" | npx vercel env add DASHBOARD_URL production
npx vercel deploy --prod
```

ค่า LINE (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `OWNER_USER_ID`) เพิ่มแบบเดียวกันเมื่อสร้าง OA แล้ว — webhook ชี้ที่ `https://<โปรเจค>.vercel.app/api/line`

## 5. ตั้ง cron รายชั่วโมง (cron-job.org ฟรี)

1. สมัคร https://cron-job.org แล้วสร้าง job ใหม่
2. URL: `https://<โปรเจค>.vercel.app/api/cron`
3. Schedule: ทุกชั่วโมง นาทีที่ 0
4. Headers: `Authorization: Bearer <CRON_SECRET ที่ตั้งไว้>`
5. เปิด job แล้วดูผลรันแรกต้องได้ **HTTP 202** — endpoint ตอบรับทันทีแล้วสรุปต่อเบื้องหลัง (แผนฟรีของ cron-job.org ตัด request ที่ 30 วินาที จึงออกแบบให้ตอบเร็ว)

## โหมดเดโม่ (โชว์หน้าห้อง ไม่ต้องมี Turso)

ตั้ง env `DEMO_DB=1` (พร้อม `DASHBOARD_PASSWORD` และ `SESSION_SECRET`) — ระบบจะใช้ฐานข้อมูล demo 100 กลุ่มที่ seed มาตอน build เขียนบน `/tmp` ของ function ข้อมูลรีเซ็ตเองเมื่อ instance รีไซเคิล เหมาะกับการสาธิตเท่านั้น

> ⚠️ ถ้า `vercel env add` แบบ pipe แล้วค่าไม่เข้า (เช็คด้วย `npx vercel env ls`) ให้พิมพ์ค่าตอน CLI ถามแทน หรือตั้งผ่านหน้าเว็บ Vercel → Settings → Environment Variables

## หมายเหตุ

- Vercel Hobby มี cron ในตัวแต่**รายวันเท่านั้น** จึงใช้ cron-job.org แทน (รายชั่วโมงฟรี)
- การสรุปรันต่อเบื้องหลังหลังตอบ 202 มีเพดาน 300 วินาที/รอบ — กลุ่มที่สรุปไม่ทันจะถูกเก็บรอบชั่วโมงถัดไปเองตามกลไก lease เดิม
- `LINE_PUSH_ENABLED` ปล่อย `false` เหมือนทางหลัก — บอทเงียบ 100%
- อยากย้ายกลับ Cloudflare เมื่อบัญชีปลดล็อก: ข้อมูลอยู่ Turso ก็ export/import ผ่าน SQL ได้ หรือเริ่ม D1 ใหม่แล้วปล่อยข้อความสะสมใหม่ (retention 30 วันอยู่แล้ว)
