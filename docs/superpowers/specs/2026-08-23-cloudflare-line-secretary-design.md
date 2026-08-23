# เลขากลุ่ม LINE บน Cloudflare — Design Specification

วันที่: 2026-08-23  
สถานะ: รอผู้ใช้ตรวจ written spec ก่อนเริ่ม implementation plan

## 1. เป้าหมาย

สร้างต้นแบบเลขากลุ่ม LINE ใน repo ใหม่ชื่อ `line-secretary-cloudflare` โดยไม่ใช้ Vercel และไม่ใช้ Neon ระบบ production ทั้งหมดทำงานบน Cloudflare Free plan:

- Cloudflare Worker รับ LINE webhook และให้ JSON API
- Cloudflare Static Assets ให้บริการ React dashboard
- Cloudflare D1 เก็บข้อมูล
- Cloudflare Cron Trigger ปลุกระบบทุก 30 นาที
- Cloudflare Workflows แยกงานสรุปของแต่ละกลุ่มและ retry งานที่ล้มเหลว
- OpenRouter เป็นค่าใช้จ่ายตามใช้งานเพียงส่วนเดียวของงาน AI

ต้นแบบต้องแสดงสถานการณ์เจ้าของคนเดียวดูแล 100 กลุ่ม โดยใช้ข้อมูลจำลอง 100 กลุ่มควบคู่กับกลุ่ม LINE จริง 5–10 กลุ่ม ข้อมูลจำลองต้องไม่เรียก AI และไม่ส่ง LINE message

## 2. ขอบเขต

### อยู่ในขอบเขต

- รับข้อความ text จากกลุ่ม LINE จริงแบบเงียบ
- ส่งข้อความเปิดเผยการทำงานหนึ่งครั้งเมื่อถูกเชิญเข้ากลุ่ม จากนั้นเงียบตลอด
- ตรวจลายเซ็น webhook และกัน event ซ้ำ
- ตรวจ keyword เร่งด่วนทันทีโดยไม่เรียก AI
- สรุปเฉพาะกลุ่มที่มีข้อความใหม่ทุก 30 นาที
- AI สกัด summary, action items, unresolved questions, priority และหมวดที่แนะนำ
- AI เลือกหมวดจากรายการที่เจ้าของกำหนด เจ้าของแก้และล็อกหมวดได้
- Dashboard แบบ A+B: มุมมอง “ต้องจัดการ” เป็นค่าเริ่มต้นและสลับเป็น “ตามหมวด” ในหน้าเดิม
- ส่ง digest เข้าแชทส่วนตัวของเจ้าของสูงสุด 10 รอบต่อวันทำงาน และไม่ส่งเมื่อไม่มีข้อมูลใหม่
- Seed ข้อมูลจำลอง 100 กลุ่มแบบ deterministic
- เก็บ raw message 30 วัน แล้วลบอัตโนมัติ
- จำกัดจำนวน AI calls/input tokens ต่อวันและรวมข้อความสั้นก่อนเรียก AI
- เจ้าของ pause กลุ่ม, ลบ raw history และตรวจ audit log การเปลี่ยนหมวดได้
- แยก local, preview และ production D1/secrets โดย production LINE push ปิดเป็นค่าเริ่มต้น
- ติดตั้ง ทดสอบ สร้าง D1 ตั้ง secrets และ deploy ผ่าน CLI เท่าที่ credentials ในเครื่องอนุญาต

### ไม่อยู่ในขอบเขตของต้นแบบ

- รองรับหลายเจ้าของหรือหลาย LINE OA ใน deployment เดียว
- รับประกัน Free plan สำหรับกลุ่มจริง 100 กลุ่มที่มี traffic สูง
- ตอบข้อความในกลุ่มหลังจากข้อความเปิดเผยการทำงานครั้งแรก
- ผู้ช่วยแชท 1:1, โน้ตส่วนตัว, to-do ส่วนตัว, สลิป, รายจ่าย, audio transcription และ order extraction จาก repo อ้างอิง
- เก็บหรือประมวลผลรูปและเสียง
- Mobile app แยกจากเว็บ

## 3. สถาปัตยกรรม

### 3.1 Ingest path

1. LINE ส่ง `POST /api/line` มาที่ Worker
2. Worker อ่าน raw body และตรวจ `x-line-signature` ด้วย Web Crypto
3. Worker รับเฉพาะ group text event, join event และ leave event ที่รองรับ
4. Text event ถูก insert เข้า D1 โดยมี `line_message_id` เป็น unique key
5. Worker ตรวจ alert words ด้วยกฎ deterministic และสร้าง alert ได้ทันที
6. Worker ตอบ HTTP 200 โดยไม่เรียก OpenRouter และไม่ตอบข้อความเข้า group

เมื่อได้รับ join event ระบบ reply หนึ่งครั้งว่าอ่านข้อความเพื่อสรุปให้เจ้าของ เก็บข้อความดิบ 30 วัน และหลังจากนี้จะไม่ร่วมบทสนทนา ข้อความอื่นทุกชนิดใน group ไม่มี reply เมื่อได้รับ leave event ระบบ mark กลุ่ม inactive และหยุด scheduled processing ทันที

เมื่อพบ group ID ใหม่ Worker จะบันทึกข้อความก่อน แล้วใช้ `ctx.waitUntil()` เรียก LINE Group Summary API เพื่อเติมชื่อกลุ่มภายหลัง ถ้าเรียกไม่สำเร็จให้แสดง group ID แบบย่อและ retry ใน scheduled maintenance โดยห้ามทำให้ webhook หลักช้าลง

หาก D1 ล้มเหลว Worker ตอบ 500 เพื่อให้ LINE retry; unique key ทำให้ retry ไม่สร้างข้อความซ้ำ

### 3.2 Scheduled processing path

Cron expression คือ `*/30 * * * *` และทำงานตาม UTC แต่ business rules คำนวณด้วย `Asia/Bangkok`

ทุกรอบ coordinator จะ:

1. ล้าง raw messages เกิน 30 วัน, reports เกิน 180 วัน และ auth attempts ที่หมดอายุ วันละครั้ง
2. เลือกเฉพาะกลุ่ม `data_mode = real` ที่ active และมีข้อความยังไม่ประมวลผล
3. เรียงกลุ่มจาก alert/ข้อความเก่าสุดก่อน และเลือกสูงสุด 10 กลุ่มต่อรอบ
4. เริ่ม Workflow idempotent หนึ่ง instance ต่อกลุ่มและ time window
5. ตรวจว่าถึง LINE digest slot หรือไม่

กลุ่มมีสิทธิ์เรียก AI เมื่อมี keyword alert, มีข้อความใหม่อย่างน้อย 5 ข้อความ หรือข้อความเก่าสุดรอครบ 120 นาที หาก daily AI call cap 120 ครั้งหรือ input token cap 500,000 tokens เต็มแล้ว ให้คงข้อความใน backlog และแสดง budget warning โดย urgent deterministic alerts ยังทำงานตามปกติ

Workflow ต่อกลุ่มมีสามขั้น:

1. โหลด rolling summary ก่อนหน้าและข้อความเก่าสุดที่ยังไม่ประมวลผล สูงสุด 200 ข้อความ
2. เรียก OpenRouter ให้ตอบ structured JSON ตาม schema
3. validate และบันทึก report, action items, priority, category suggestion และ processed checkpoint ด้วย D1 atomic batch

ถ้ามีมากกว่า 200 ข้อความ ข้อความที่เหลือไม่ถูกทิ้งและจะเข้ารอบถัดไป ถ้า OpenRouter หรือ validation ล้มเหลว Workflow retry และยังไม่ mark ข้อความว่า processed

OpenRouter ใช้ model เริ่มต้น `google/gemini-2.5-flash` ผ่านตัวแปร `OPENROUTER_MODEL` ข้อความจากกลุ่มถูกวางในส่วน data ของ prompt เท่านั้น ไม่มี tool calling, URL fetch หรือคำสั่งที่เปลี่ยนระบบได้ Structured output ต้องผ่าน schema และ length limits ก่อนบันทึก เพื่อให้ prompt injection จากสมาชิกกลุ่มทำได้เพียงปรากฏเป็นเนื้อหาที่ถูกสรุป

LINE digest ที่ top-of-hour ใช้เฉพาะ reports ที่เสร็จสมบูรณ์ก่อน scheduled run นั้น Workflow ที่เพิ่งเริ่มในรอบเดียวกันจะถูกรวมใน slot ถัดไป จึงไม่เกิด race ระหว่างสรุปกับการส่ง

### 3.3 Dashboard path

React SPA ถูกเสิร์ฟเป็น Static Assets ส่วนข้อมูลมาจาก authenticated Worker API ที่ query D1

- Summary และ priority เปลี่ยนเมื่อ Workflow จบรอบประมาณทุก 30 นาที
- หน้า dashboard poll lightweight alert endpoint ทุก 60 วินาทีขณะเปิดอยู่ เพื่อเห็น deterministic urgent alert โดยไม่รอ summary
- API รองรับ incremental reads ด้วย `updated_after` และ pagination ห้ามโหลด 100 กลุ่มพร้อม raw messages
- Static asset requests ไม่เรียก Worker; เฉพาะ `/api/*` เท่านั้นที่ใช้ Worker request quota

### 3.4 Demo path

คำสั่ง seed สร้าง 100 groups, reports, alerts และ action items แบบ deterministic โดยกำหนด `data_mode = demo` ระบบ scheduled processing และ LINE digest ต้อง filter `data_mode = real` เสมอ

## 4. Components และขอบเขตความรับผิดชอบ

- `src/worker.ts` — ประกอบ router, fetch handler และ scheduled handler
- `src/routes/line.ts` — verify และ normalize LINE webhook เท่านั้น
- `src/routes/api/*` — authenticated dashboard endpoints
- `src/workflows/summarize-group.ts` — orchestration และ retries ของงาน AI ต่อกลุ่ม
- `src/services/openrouter.ts` — prompt, model call, structured output validation
- `src/services/line.ts` — push digest พร้อม retry key
- `src/services/categories.ts` — category suggestion/override/lock rules
- `src/services/digests.ts` — schedule, content selection และ quota guard
- `src/repositories/*` — D1 queries แยกตาม aggregate
- `web/*` — React SPA; ไม่มี database หรือ secret access
- `scripts/seed-demo.ts` — deterministic demo dataset เท่านั้น
- `migrations/*` — D1 schema migrations แบบเรียงลำดับ

แต่ละ service รับ dependency ผ่าน parameter เพื่อให้ unit test ได้โดยไม่ต่อ Cloudflare หรือ API จริง

Dashboard API ที่เปิดในรุ่นแรกมีเฉพาะ:

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET /api/dashboard`, `GET /api/alerts?updated_after=...`
- `GET /api/groups`, `GET /api/groups/:id`
- `PATCH /api/groups/:id/category`
- `PATCH /api/groups/:id/status`, `DELETE /api/groups/:id/raw-history`
- `GET /api/categories`, `POST /api/categories`, `PATCH /api/categories/:id`
- `PATCH /api/alerts/:id`
- `GET /api/audit-log`
- `GET /api/system/health`

## 5. โครงสร้างข้อมูล D1

### `categories`

- `id`, `slug`, `name`, `color`, `sort_order`, `active`
- ค่าเริ่มต้น: ลูกค้า, ทีมงาน, ออเดอร์, คู่ค้า, โปรเจกต์, อื่น ๆ
- เจ้าของเพิ่ม เปลี่ยนชื่อ และปิดหมวดได้ แต่ `slug` ที่ถูกใช้อยู่ไม่ถูกลบแบบ hard delete

### `groups`

- `source_id` primary key
- `title`, `data_mode` (`real` หรือ `demo`), `active`
- `category_id`, `category_source` (`ai` หรือ `manual`), `category_locked`
- `category_confidence`, `needs_category_review`
- `priority_score`, `last_message_at`, `last_summary_at`, `created_at`, `updated_at`

AI เปลี่ยน `category_id` ได้เฉพาะเมื่อ `category_locked = 0` ถ้าความมั่นใจต่ำกว่า `0.75` ให้ตั้ง `needs_category_review = 1` การแก้หมวดด้วยเจ้าของตั้ง `category_source = manual`, ปิด `needs_category_review` และเปิด lock เป็นค่าเริ่มต้น

### `messages`

- `id`, `line_message_id` unique, `group_id`, `user_id`
- `kind`, `text`, `sent_at`, `ingested_at`, `processed_at`, `retention_expires_at`
- indexes บน `(group_id, processed_at, sent_at)` และ `retention_expires_at`

### `reports`

- `id`, `group_id`, `period_start`, `period_end`
- `summary`, `action_items_json`, `unresolved_json`, `priority_score`
- `model`, `prompt_version`, `created_at`, `notified_at`

### `alerts`

- `id`, `group_id`, `message_id`, `kind`, `severity`, `status`
- `excerpt`, `created_at`, `acknowledged_at`, `resolved_at`
- unique `(kind, message_id)` ป้องกัน alert ซ้ำ

### `digest_deliveries`

- `id`, `slot_key` unique, `retry_key` unique, `period_start`, `period_end`
- `status`, `message_count`, `line_request_id`, `created_at`, `sent_at`, `error`

### `job_runs`

- `id`, `scheduled_for` unique, `status`, `groups_selected`, `groups_completed`, `error`, timestamps

### `settings`

- `key` primary key, `value_json`, `updated_at`
- ค่าเริ่มต้นประกอบด้วย alert words, workdays จันทร์–ศุกร์, digest hours 08–17, retention 30 วัน และ automated monthly push cap 280

### `auth_attempts`

- `ip_hash`, `window_start`, `attempts`, `blocked_until`
- Login ผิดได้ 5 ครั้งต่อ 15 นาทีต่อ IP hash จากนั้น block 15 นาที; เก็บเฉพาะ HMAC hash ไม่เก็บ IP ดิบ

### `usage_daily`

- `day` primary key, `ai_calls`, `ai_input_tokens`, `ai_output_tokens`, `line_pushes`, `updated_at`
- Scheduled coordinator reserve call budget ก่อนสร้าง Workflow; Workflow reconcile token usage จาก OpenRouter response หลังจบ

### `audit_log`

- `id`, `actor` (`owner`, `ai`, `system`), `action`, `entity_type`, `entity_id`, `before_json`, `after_json`, `created_at`
- เก็บเฉพาะ metadata ของการเปลี่ยน category/status/retention ห้ามเก็บ raw group message ในตารางนี้

## 6. Dashboard UX

### Shared controls

- Search ชื่อกลุ่ม เนื้อหา summary และ action item
- Filter: หมวด, priority, real/demo, ช่วงเวลา
- View toggle อยู่บนหน้าเดิมและใช้ dataset/filter ชุดเดียวกัน
- จำ view ล่าสุดใน local storage; ค่าเริ่มต้นเป็น action view

### Action view

- KPI: เร่งด่วน, รอตอบ, มีข้อความใหม่, ปกติ
- คิว “ต้องจัดการก่อน” เรียง severity → age → AI priority
- แต่ละรายการแสดงกลุ่ม, หมวด, เวลา, เหตุผล และ action item
- acknowledge/resolve alert ได้จากหน้า detail

### Category view

- การ์ดหมวดแสดงจำนวนกลุ่ม, urgent count, open action count และ activity ล่าสุด
- เปิดหมวดแล้วเห็นกลุ่มเรียง priority
- กลุ่มที่ AI ยังไม่มั่นใจอยู่ใน “รอยืนยันหมวด”

### Group detail

- แสดง badge `REAL` หรือ `DEMO`, summary ล่าสุด, reports ย้อนหลัง, action items, unresolved questions และ alerts
- แสดง excerpt ที่เกี่ยวข้อง ไม่โหลด raw conversation ทั้งหมดโดยอัตโนมัติ
- เจ้าของแก้หมวด, lock/unlock หมวด และ mark alert status ได้
- เจ้าของ pause/resume กลุ่ม, ลบ raw history และเปิดดู audit log ของกลุ่มได้

### States

ทุกหน้าต้องมี loading, empty, stale-data, partial-error และ offline state โดยข้อมูลเก่ายังคงอ่านได้เมื่อ refresh API ล้มเหลว

## 7. Authentication และความปลอดภัย

- ต้นแบบมีเจ้าของคนเดียว
- `DASHBOARD_PASSWORD` และ `SESSION_SECRET` เก็บด้วย `wrangler secret`
- Login แลก signed HttpOnly, Secure, SameSite=Strict session cookie อายุ 12 ชั่วโมง
- ทุก data API ตรวจ session; mutation ตรวจ `Origin` เพิ่มเติม
- LINE token, channel secret และ OpenRouter key ไม่ส่งไป browser และไม่เก็บใน D1
- Log มีเฉพาะ request/job IDs, group hash, status และ latency ห้าม log raw message, token หรือ AI prompt content
- Raw messages ถูกลบหลัง 30 วัน; reports เก็บ 180 วัน; demo reset ได้ทุกเมื่อ
- หน้า join disclosure ระบุ retention 30 วันและการส่ง summary ให้เจ้าของอย่างชัดเจน

## 8. LINE digest และ quota guard

- ส่งหา `OWNER_USER_ID` แบบ push message เท่านั้น และไม่ส่งเข้ากลุ่ม
- ค่าเริ่มต้นวันจันทร์–ศุกร์ เวลา 08:00–17:00 Asia/Bangkok รวมสูงสุด 10 slots/วัน
- หนึ่ง slot ส่งได้ไม่เกินหนึ่ง digest และส่งเฉพาะเมื่อมี report/alert ใหม่ที่ยังไม่เคยแจ้ง
- Digest เรียง urgent → action items → category summaries และแนบ dashboard URL
- Automated hard cap คือ 280 push messages ต่อเดือน เหลือ buffer 20 ข้อความจากโควตา 300
- ก่อน push ระบบ insert delivery row พร้อม UUID retry key; LINE request ใช้ `X-Line-Retry-Key`; จากนั้นอัปเดต sent status
- 5xx/timeout retry ด้วย retry key เดิมภายใน 24 ชั่วโมง; 4xx บันทึก error และหยุด retry

## 9. Free-tier guardrails

- รับกลุ่มจริงสูงสุด 10 กลุ่มในต้นแบบ; กลุ่มถัดไปถูกบันทึกเป็น inactive พร้อม warning
- Workflow สูงสุด 10 กลุ่มต่อ cron run และ 200 messages ต่อกลุ่มต่อ run
- AI สูงสุด 120 calls และ 500,000 input tokens ต่อวัน; ข้อความต่ำกว่า 5 ข้อความถูกรวมได้ไม่เกิน 120 นาที
- ไม่มีข้อความใหม่หมายถึงไม่มี OpenRouter call และไม่มี LINE push
- Demo rows ไม่เข้าคิวงานและไม่เข้ารายงาน LINE
- Queries ทุกตัวใช้ index และ pagination เพื่อควบคุม D1 rows read
- Dashboard แสดง system status: Worker requests, D1 reads/writes, Workflow steps, AI calls และ LINE push count ที่แอปวัดได้
- เมื่อ guard ใกล้เต็ม ระบบหยุดงาน non-critical ก่อนและแสดง warning; webhook ingest กับ urgent keyword detection มี priority สูงสุด

เป้าหมาย Free plan นี้ใช้กับ 100 demo + 5–10 real groups ไม่ใช่คำรับประกันสำหรับ 100 real high-traffic groups

## 10. Error handling และ recovery

- Webhook database error: ตอบ 500 ให้ LINE retry; dedupe ด้วย message ID
- Duplicate webhook: ตอบ 200 โดยไม่ทำซ้ำ
- AI timeout/5xx/invalid JSON: Workflow retry; ไม่ mark processed
- Workflow backlog: dashboard แสดง stale/backlog badge; รอบต่อไปทำงานต่อจาก oldest message
- LINE push timeout/5xx: retry ด้วย persisted `X-Line-Retry-Key`; ไม่สร้าง delivery ใหม่
- D1 quota/Worker limit: บันทึก health state เท่าที่ทำได้, หยุด demo/AI/digest ก่อน และยังรับ webhook จน platform ปฏิเสธ request
- Frontend API failure: คงข้อมูลล่าสุดบนหน้าจอและแสดงเวลาที่ sync สำเร็จครั้งล่าสุด

## 11. Testing

### Unit

- LINE signature verification และ duplicate handling
- urgent keyword matching
- AI output schema validation
- category suggestion, manual override และ lock
- AI daily call/token reservation และ low-signal batching 5 ข้อความ/120 นาที
- Bangkok work-hour calculation
- daily/monthly digest quota และ empty-digest skip
- demo exclusion จาก Workflow และ LINE
- retention boundary และ priority ordering

### Integration

- D1 migrations และ repository queries บน local Wrangler/Miniflare
- webhook fixture → D1 rows → HTTP 200
- join fixture → disclosure reply หนึ่งครั้ง; text fixture อื่นไม่มี group reply
- leave fixture → group inactive และไม่ถูก scheduled processing เลือก
- scheduled event → active group selection → mocked Workflow creation
- mocked OpenRouter output → D1 atomic batch → processed checkpoint
- LINE retry key ถูกใช้ซ้ำเมื่อ retry
- protected API ปฏิเสธ missing/expired session
- login rate limit block หลังผิด 5 ครั้งใน 15 นาที
- prompt injection fixture ไม่สร้าง tool call, URL fetch หรือข้อความนอก structured schema

### Frontend/E2E

- login/logout
- dashboard เริ่มที่ action view
- toggle A+B รักษา filters และ dataset เดิม
- real/demo filter, search, category drill-down
- edit และ lock category
- pause/resume group, delete raw history และดู audit log
- acknowledge alert
- loading/empty/error/stale states

### CLI acceptance

ก่อนประกาศว่าสำเร็จต้องผ่าน:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run db:migrate:local
npm run seed:demo:local
npx wrangler deploy --dry-run
```

หลังมี Cloudflare credentials ให้รัน migration, seed และ smoke test บน preview ก่อน production ผ่าน Wrangler CLI แล้วตรวจ webhook และ scheduled handler โดยไม่ส่ง LINE จริงจนกว่าจะเปิด production flag

## 12. Deployment และ secrets

Repo แยกอยู่ที่ `/Users/gobank01/Documents/All AI/line-secretary-cloudflare` และใช้ branch `main`

Repo นี้เป็น Git repository ของตัวเอง ไม่ share history หรือ worktree กับ repo อ้างอิง ถ้า GitHub CLI authenticated และชื่อยังว่าง ให้สร้าง remote แบบ private ชื่อ `line-secretary-cloudflare`; ถ้าไม่ authenticated งานทั้งหมดต้องยัง build, test และ deploy จาก local repo ได้

Bindings:

- D1: `DB`
- Workflow: `GROUP_SUMMARIZER`
- Static assets: `ASSETS`

Wrangler environments `preview` และ `production` ต้องใช้ D1 database IDs และ secrets คนละชุด Local development ใช้ local D1 ของ Miniflare เท่านั้น ห้ามให้ preview test เขียน production D1

Secrets:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `OWNER_USER_ID`
- `OPENROUTER_API_KEY`
- `DASHBOARD_PASSWORD`
- `SESSION_SECRET`

Vars ที่ไม่ลับ:

- `APP_ENV`
- `APP_TIMEZONE=Asia/Bangkok`
- `DASHBOARD_URL`
- `OPENROUTER_MODEL=google/gemini-2.5-flash`
- `REAL_GROUP_LIMIT=10`
- `AUTOMATED_MONTHLY_PUSH_CAP=280`
- `AI_DAILY_CALL_CAP=120`
- `AI_DAILY_INPUT_TOKEN_CAP=500000`
- `AI_MIN_MESSAGES=5`
- `AI_MAX_WAIT_MINUTES=120`
- `LINE_PUSH_ENABLED=false` จนกว่า production smoke test จะผ่าน

Deploy production และเปลี่ยน LINE webhook URL ทำหลัง automated tests กับ preview ผ่านแล้วเท่านั้น การเปิด LINE push จริงต้องใช้ flag แยกเพื่อป้องกันข้อมูลจำลองหรือ smoke test กินโควตา

## 13. เกณฑ์ความสำเร็จ

- Repo ใหม่ไม่มี Vercel config/dependency และ deploy target มี Cloudflare เพียงเจ้าเดียว
- Local seed แสดง 100 demo groups ครบ พร้อมหมวด, priority, alerts และ reports
- ต่อ LINE จริงได้ 5–10 กลุ่มและบอทไม่ตอบในกลุ่ม
- Duplicate webhook ไม่สร้างข้อมูลซ้ำ
- Deterministic urgent keyword ปรากฏบน dashboard โดยไม่เรียก AI
- Cron ทุก 30 นาทีสร้าง summary เฉพาะ real groups ที่มีข้อความใหม่
- AI แนะนำหมวด แต่เปลี่ยนหมวดที่ owner lock แล้วไม่ได้
- Action/Category views สลับในหน้าเดิมและรักษา filters
- LINE digest ไม่ส่งเมื่อไม่มีข้อมูลใหม่ ไม่เกิน 10 ครั้ง/วันทำงาน และไม่เกิน 280 ครั้ง/เดือน
- Raw messages เกิน 30 วันถูกลบ
- AI budget เต็มแล้วไม่สร้าง call เพิ่มและ backlog ยังไม่สูญหาย
- join disclosure ส่งครั้งเดียว, leave/pause หยุดประมวลผล และ owner ลบ raw history ได้
- Preview และ production ใช้ D1/secrets แยกกัน และ LINE push เปิดด้วย explicit production flag เท่านั้น
- Test suite, production build และ Wrangler dry-run ผ่าน
- ถ้า Cloudflare CLI authenticated: D1, migrations, secrets ที่ผู้ใช้มี, deployment และ smoke test ถูกทำผ่าน CLI

## 14. เอกสารอ้างอิงแพลตฟอร์ม

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [LINE retry failed API requests](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)
