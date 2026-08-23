# คู่มือติดตั้ง Cloudflare + LINE

คู่มือนี้แยก `preview` และ `production` คนละ Worker, D1, Workflow และ secrets ตั้งแต่ต้น ทุกขั้นตอนเริ่มด้วย `LINE_PUSH_ENABLED=false`

## 1. ตรวจเครื่องมือและ login

```bash
npm ci
npx wrangler whoami
gh auth status
```

ถ้า Wrangler ยังไม่ login ให้รัน `npx wrangler login` ใน terminal ของตัวเอง อย่าส่ง API token หรือภาพ secret มาในแชต/ล็อก

## 2. สร้าง D1 สองชุด

ตรวจชื่อก่อน หากมีอยู่แล้วไม่ต้องสร้างซ้ำ

```bash
npx wrangler d1 list
npx wrangler d1 create line-secretary-cloudflare-preview --location apac
npx wrangler d1 create line-secretary-cloudflare-production --location apac
node scripts/configure-cloudflare.mjs preview line-secretary-cloudflare-preview
node scripts/configure-cloudflare.mjs production line-secretary-cloudflare-production
```

สคริปต์ configure หา database ด้วยชื่อที่ตรงกัน ตรวจ UUID และแก้เฉพาะ `database_id` ของ environment นั้นใน `wrangler.jsonc` โดยไม่รับหรือแสดง secret

## 3. เตรียม Preview ที่ปลอดภัย

```bash
npx wrangler d1 migrations apply line-secretary-cloudflare-preview --remote --env preview
npm run seed:demo:preview
npx wrangler secret put DASHBOARD_PASSWORD --env preview
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET --env preview
mkdir -p .generated
npm run deploy:preview | tee .generated/preview-deploy.log
node scripts/configure-worker-url.mjs preview .generated/preview-deploy.log
npm run deploy:preview | tee .generated/preview-deploy-final.log
node scripts/smoke-worker.mjs .generated/preview-deploy-final.log
```

ยืนยันว่ามี demo 100 กลุ่มและไม่มี real group:

```bash
npx wrangler d1 execute line-secretary-cloudflare-preview --remote --env preview --command "select data_mode,count(*) n from groups group by data_mode"
```

Preview ต้องเปิดเว็บและ `/api/health` ได้ แต่จะไม่ส่ง LINE และไม่เรียก OpenRouter เพราะไม่มี real messages

## 4. เตรียม Production-safe demo

ทำหลัง preview ผ่านเท่านั้น ใช้รหัส dashboard จริงที่ไม่ซ้ำกับระบบอื่น และอย่าใส่รหัสผ่านลงใน command/history

```bash
npx wrangler d1 migrations apply line-secretary-cloudflare-production --remote --env production
npm run seed:demo:production
npx wrangler secret put DASHBOARD_PASSWORD --env production
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET --env production
npm run deploy:production | tee .generated/production-deploy.log
node scripts/configure-worker-url.mjs production .generated/production-deploy.log
npm run deploy:production | tee .generated/production-deploy-final.log
node scripts/smoke-worker.mjs .generated/production-deploy-final.log
```

Production ณ จุดนี้ยังเป็น demo-safe: เว็บใช้งานได้, Cron ทำ maintenance ได้ แต่ `LINE_PUSH_ENABLED=false` และยังไม่ได้เชื่อม webhook

## 5. ตั้งค่า LINE และ OpenRouter

สร้าง LINE Official Account และ Messaging API channel แล้วตั้งค่าต่อไปนี้ผ่านคำสั่ง interactive ห้ามวางค่าจริงไว้ในไฟล์ที่ commit หรือ pipe ผ่านคำสั่งที่พิมพ์ secret ออกจอ

```bash
npx wrangler secret put LINE_CHANNEL_SECRET --env production
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env production
npx wrangler secret put OWNER_USER_ID --env production
npx wrangler secret put OPENROUTER_API_KEY --env production
```

จากนั้นใน LINE Developers Console:

1. เปิด “Allow bot to join group chats” เพราะค่าเริ่มต้นปิดอยู่
2. กำหนด Webhook URL เป็น `https://<production-worker>.workers.dev/api/line/webhook`
3. กด Verify และยืนยันว่าได้ HTTP 200
4. เปิด Use webhook
5. ทดสอบเชิญบอทเข้ากลุ่มทดลองหนึ่งกลุ่ม ต้องมีข้อความเปิดเผยตัวหนึ่งครั้ง
6. ส่งข้อความธรรมดาในกลุ่มและยืนยันว่าบอทเงียบ แต่ dashboard เห็นกิจกรรม

LINE ระบุว่า group message webhook มี `groupId` และต้องตรวจ signature; โปรเจกต์นี้ทำทั้งสองส่วนแล้ว อ้างอิง [group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/) และ [receiving webhooks](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

## 6. เปิด digest ภายหลังการทดสอบ

อย่าเปิดใน commit เดียวกับการตั้ง webhook ให้ตรวจอย่างน้อย:

- owner dashboard login/logout ผ่าน
- dashboard URL ใน digest เป็น production จริง
- `OWNER_USER_ID` เป็นผู้รับเพียงคนเดียว
- LINE OA Manager ยังมีโควตาเหลือ
- Cron/Workflow/D1 metrics ไม่มี error
- กลุ่มจริงไม่เกิน 10 กลุ่ม

จากนั้นเปลี่ยนเฉพาะ `env.production.vars.LINE_PUSH_ENABLED` เป็น `"true"`, review diff, รัน test/build และ deploy ใหม่ ระบบยังบังคับ 10 work-hour slots/วันทำงาน และ 280 pushes/เดือน

Cloudflare Vite plugin เลือก environment ตอน build จึงห้ามใช้ `vite build && wrangler deploy --env production` โดยตรง ให้ใช้ `npm run deploy:production` ซึ่งตั้ง `CLOUDFLARE_ENV=production` ทั้ง build/deploy และตรวจ Worker, D1, Workflow ก่อนส่งขึ้นจริง

หากต้องหยุดฉุกเฉิน ให้เปลี่ยนกลับเป็น `"false"` แล้ว deploy production ใหม่ การดู dashboard และรับ webhook จะยังทำงานต่อ

## 7. GitHub repo แยก

สร้างเป็น private repository เท่านั้น:

```bash
gh repo view gobank01/line-secretary-cloudflare
gh repo create gobank01/line-secretary-cloudflare --private --source . --remote origin --push
```

ถ้าชื่อ repo มีอยู่แล้ว ให้หยุดและตรวจ remote ห้าม force-push หรือเขียนทับ repo เดิม

## Production checklist

- [ ] Full tests, E2E, typecheck, build และ Wrangler dry-run ผ่าน
- [ ] Preview และ production ใช้ UUID D1 คนละค่าและไม่ใช่ UUID ศูนย์
- [ ] Secrets อยู่ใน Wrangler secrets เท่านั้น
- [ ] `LINE_PUSH_ENABLED=false` จนกว่าจะ smoke test LINE จริงผ่าน
- [ ] LINE webhook เป็น HTTPS production URL และ Verify ผ่าน
- [ ] กลุ่มทดลองได้รับ disclosure ครั้งเดียว ข้อความทั่วไปไม่มี reply
- [ ] มี owner user ID เพียงคนเดียวสำหรับ digest
- [ ] ตรวจ Cloudflare Analytics, D1 row metrics, Workflow steps และ LINE monthly usage
- [ ] ทดสอบ pause group และ emergency disable
