# Cloudflare LINE Secretary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a separate Cloudflare-native prototype that silently monitors 5–10 real LINE groups, demonstrates 100 seeded groups, summarizes new activity every 30 minutes, and exposes the approved action/category dashboard without Vercel.

**Architecture:** A React SPA is served as Cloudflare Static Assets and calls a Hono API Worker backed by D1. LINE webhook ingestion is synchronous and AI-free; a 30-minute scheduled coordinator creates one durable Workflow per eligible real group, while deterministic urgent alerts, AI/LINE budget guards, authentication, retention, and demo isolation remain enforced in D1.

**Tech Stack:** TypeScript, React 19, Vite, Cloudflare Vite plugin, Hono, Zod, Cloudflare Workers/Workflows/D1, Vitest 4 with Cloudflare Vitest plugin, Testing Library, Playwright, OpenRouter, LINE Messaging API.

**Source spec:** `docs/superpowers/specs/2026-08-23-cloudflare-line-secretary-design.md`

---

## File map

Configuration:

- `package.json` — scripts and pinned dependency ranges
- `wrangler.jsonc` — Worker, assets, D1, Workflow, cron, preview/production configuration
- `vite.config.ts` — React and Cloudflare Vite plugins
- `vitest.config.ts` — Workers-runtime tests with local D1 migrations
- `vitest.ui.config.ts` — jsdom React component tests
- `playwright.config.ts` — browser acceptance tests
- `worker-configuration.d.ts` — generated binding types
- `.gitignore` — secrets, Wrangler state, build and generated seed artifacts

Backend:

- `worker/index.ts` — Hono fetch entrypoint, Workflow export, scheduled handler
- `worker/env.ts` — application binding/variable types
- `worker/app.ts` — route composition and error boundary
- `worker/db/types.ts` — row and API DTO types
- `worker/db/repositories.ts` — prepared D1 queries grouped by aggregate
- `worker/line/signature.ts` — Web Crypto signature verification
- `worker/line/client.ts` — LINE summary/reply/push API calls
- `worker/line/events.ts` — webhook event parsing and normalization
- `worker/routes/line.ts` — ingest orchestration only
- `worker/auth/session.ts` — signed session cookies
- `worker/auth/login-limit.ts` — hashed-IP login throttling
- `worker/routes/auth.ts` — login/logout/session endpoints
- `worker/routes/dashboard.ts` — read-only dashboard/group/health endpoints
- `worker/routes/controls.ts` — categories, group status/history, alert and audit mutations
- `worker/ai/schema.ts` — structured summary Zod schema
- `worker/ai/policy.ts` — eligibility and daily budget decisions
- `worker/ai/openrouter.ts` — OpenRouter fetch client
- `worker/workflows/group-summarizer.ts` — durable per-group summary flow
- `worker/scheduler/coordinator.ts` — cron selection, maintenance and Workflow creation
- `worker/scheduler/digest.ts` — work-hour slots, formatting, quota and LINE retry key

Database and data:

- `migrations/0001_initial.sql` — all production tables and indexes
- `scripts/demo-data.ts` — deterministic 100-group fixtures
- `scripts/seed-demo.ts` — generate SQL and execute through Wrangler
- `scripts/configure-cloudflare.mjs` — write CLI-created D1 IDs into Wrangler config without handling secrets

Frontend:

- `index.html`, `src/main.tsx`, `src/App.tsx` — SPA entry and route state
- `src/api.ts` — typed fetch client with credentials
- `src/types.ts` — frontend DTOs matching Worker responses
- `src/styles.css` — design tokens, responsive layout and states
- `src/components/Login.tsx` — owner login
- `src/components/Dashboard.tsx` — shared filter/view state
- `src/components/ActionView.tsx` — default triage queue
- `src/components/CategoryView.tsx` — category board using the same filtered data
- `src/components/GroupDetail.tsx` — reports, controls and audit history
- `src/components/SystemStatus.tsx` — measured quota/backlog health

Tests:

- `test/setup.ts` — D1 migrations and per-test cleanup
- `test/worker/*.test.ts` — Worker-runtime unit/integration tests
- `test/ui/*.test.tsx` — React behavior/accessibility tests
- `e2e/dashboard.spec.ts` — login, A+B views, filters and group controls

## Task 1: Scaffold the Cloudflare React + Worker runtime

**Files:**

- Create: `package.json`
- Create: `.gitignore`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `vitest.ui.config.ts`
- Create: `wrangler.jsonc`
- Create: `index.html`
- Create: `worker/env.ts`
- Create: `worker/app.ts`
- Create: `worker/index.ts`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Test: `test/worker/health.test.ts`

- [ ] **Step 1: Install the runtime and test dependencies**

Run:

```bash
npm init -y
npm install react@^19 react-dom@^19 hono@^4 zod@^4
npm install -D typescript@^5 vite@^7 @vitejs/plugin-react@^5 @cloudflare/vite-plugin wrangler @cloudflare/workers-types vitest@^4.1 @cloudflare/vitest-plugin @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom playwright tsx
```

Expected: `package-lock.json` is created and `npm audit` reports no unresolved critical installation failure.

- [ ] **Step 2: Define scripts and the local Cloudflare configuration**

Set `package.json` scripts to:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "deploy": "vite build && wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test:worker": "vitest run --config vitest.config.ts",
    "test:ui": "vitest run --config vitest.ui.config.ts",
    "test": "npm run test:worker && npm run test:ui",
    "test:e2e": "playwright test",
    "db:migrate:local": "wrangler d1 migrations apply line-secretary-cloudflare --local",
    "seed:demo:local": "tsx scripts/seed-demo.ts --local"
  },
  "type": "module"
}
```

Create `wrangler.jsonc` with an intentionally non-deployable local UUID that later CLI configuration replaces:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "line-secretary-cloudflare",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-08-23",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "line-secretary-cloudflare",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }],
  "triggers": { "crons": ["*/30 * * * *"] },
  "vars": {
    "APP_ENV": "local",
    "APP_TIMEZONE": "Asia/Bangkok",
    "OPENROUTER_MODEL": "google/gemini-2.5-flash",
    "REAL_GROUP_LIMIT": "10",
    "AUTOMATED_MONTHLY_PUSH_CAP": "280",
    "AI_DAILY_CALL_CAP": "120",
    "AI_DAILY_INPUT_TOKEN_CAP": "500000",
    "AI_MIN_MESSAGES": "5",
    "AI_MAX_WAIT_MINUTES": "120",
    "LINE_PUSH_ENABLED": "false"
  }
}
```

- [ ] **Step 3: Write a failing health endpoint test**

Create `test/worker/health.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("identifies the Cloudflare service", async () => {
    const response = await exports.default.fetch("http://example.com/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "line-secretary-cloudflare",
      environment: "local",
    });
  });
});
```

Run: `npm run test:worker -- test/worker/health.test.ts`  
Expected: FAIL because the Worker entrypoint and test configuration do not exist yet.

- [ ] **Step 4: Add the minimum Worker and SPA implementation**

Create `worker/env.ts`:

```ts
export interface AppEnv {
  DB: D1Database;
  GROUP_SUMMARIZER: Workflow<{ groupId: string; windowEnd: number }>;
  ASSETS: Fetcher;
  APP_ENV: string;
  APP_TIMEZONE: string;
  OPENROUTER_MODEL: string;
  REAL_GROUP_LIMIT: string;
  AUTOMATED_MONTHLY_PUSH_CAP: string;
  AI_DAILY_CALL_CAP: string;
  AI_DAILY_INPUT_TOKEN_CAP: string;
  AI_MIN_MESSAGES: string;
  AI_MAX_WAIT_MINUTES: string;
  LINE_PUSH_ENABLED: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  OWNER_USER_ID: string;
  OPENROUTER_API_KEY: string;
  DASHBOARD_PASSWORD: string;
  SESSION_SECRET: string;
  DASHBOARD_URL: string;
}
```

Create `worker/app.ts`:

```ts
import { Hono } from "hono";
import type { AppEnv } from "./env";

export const createApp = () => {
  const app = new Hono<{ Bindings: AppEnv }>();
  app.get("/api/health", (c) => c.json({
    ok: true,
    service: "line-secretary-cloudflare",
    environment: c.env.APP_ENV,
  }));
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error("request_failed", { path: c.req.path, name: error.name });
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
};
```

Create `worker/index.ts`:

```ts
import { createApp } from "./app";
import type { AppEnv } from "./env";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_controller, _env, _ctx) => undefined,
} satisfies ExportedHandler<AppEnv>;
```

Create `src/App.tsx`, `src/main.tsx`, and `index.html` with a minimal “กำลังเตรียม dashboard” page. Configure `vite.config.ts` with `plugins: [react(), cloudflare()]`, `vitest.config.ts` with `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`, and `vitest.ui.config.ts` with `environment: "jsdom"` and `include: ["test/ui/**/*.test.tsx"]`.

- [ ] **Step 5: Verify scaffold and commit**

Run:

```bash
npm run test:worker -- test/worker/health.test.ts
npm run typecheck
npm run build
```

Expected: health test PASS, TypeScript exits 0, Vite emits client and Worker build output.

Commit:

```bash
git add package.json package-lock.json .gitignore tsconfig.json vite.config.ts vitest.config.ts vitest.ui.config.ts wrangler.jsonc index.html worker src test/worker/health.test.ts
git commit -m "chore: scaffold Cloudflare React worker"
```

## Task 2: Create D1 schema and deterministic 100-group demo seed

**Files:**

- Create: `migrations/0001_initial.sql`
- Create: `worker/db/types.ts`
- Create: `worker/db/repositories.ts`
- Create: `scripts/demo-data.ts`
- Create: `scripts/seed-demo.ts`
- Create: `test/setup.ts`
- Test: `test/worker/database.test.ts`
- Test: `test/worker/demo-data.test.ts`

- [ ] **Step 1: Write failing schema and seed tests**

Create tests that apply migrations, then assert:

```ts
expect(await env.DB.prepare("select count(*) n from categories").first("n")).toBe(6);
expect(buildDemoGroups(100, 20260823)).toHaveLength(100);
expect(new Set(buildDemoGroups(100, 20260823).map((g) => g.sourceId)).size).toBe(100);
expect(buildDemoGroups(100, 20260823)).toEqual(buildDemoGroups(100, 20260823));
```

Run: `npm run test:worker -- test/worker/database.test.ts test/worker/demo-data.test.ts`  
Expected: FAIL because migrations and seed builder do not exist.

- [ ] **Step 2: Create the complete initial migration**

`migrations/0001_initial.sql` must create these tables with foreign keys enabled:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE groups (
  source_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('real','demo')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  category_id INTEGER REFERENCES categories(id),
  category_source TEXT CHECK (category_source IN ('ai','manual')),
  category_locked INTEGER NOT NULL DEFAULT 0 CHECK (category_locked IN (0,1)),
  category_confidence REAL,
  needs_category_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_category_review IN (0,1)),
  priority_score INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  last_summary_at INTEGER,
  disclosure_sent_at INTEGER,
  joined_at INTEGER,
  left_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_message_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL REFERENCES groups(source_id),
  user_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  sent_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  processed_at INTEGER,
  retention_expires_at INTEGER NOT NULL
);
CREATE INDEX messages_processing ON messages(group_id, processed_at, sent_at);
CREATE INDEX messages_retention ON messages(retention_expires_at);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(source_id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  summary TEXT NOT NULL,
  action_items_json TEXT NOT NULL DEFAULT '[]',
  unresolved_json TEXT NOT NULL DEFAULT '[]',
  priority_score INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notified_at INTEGER
);
CREATE INDEX reports_group_created ON reports(group_id, created_at DESC);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(source_id),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  UNIQUE(kind, message_id)
);
CREATE INDEX alerts_status_created ON alerts(status, created_at DESC);

CREATE TABLE digest_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL UNIQUE,
  retry_key TEXT NOT NULL UNIQUE,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  message_count INTEGER NOT NULL DEFAULT 0,
  line_request_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_for INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,
  groups_selected INTEGER NOT NULL DEFAULT 0,
  groups_completed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE auth_attempts (ip_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL, blocked_until INTEGER);
CREATE TABLE usage_daily (day TEXT PRIMARY KEY, ai_calls INTEGER NOT NULL DEFAULT 0, ai_input_tokens INTEGER NOT NULL DEFAULT 0, ai_output_tokens INTEGER NOT NULL DEFAULT 0, line_pushes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at INTEGER NOT NULL);

INSERT INTO settings(key,value_json,updated_at) VALUES
('alert_words','["ยกเลิก","คืนเงิน","ไม่พอใจ","ด่วน","เคลม","แย่มาก"]',unixepoch()),
('workdays','[1,2,3,4,5]',unixepoch()),
('digest_hours','[8,9,10,11,12,13,14,15,16,17]',unixepoch()),
('retention_days','30',unixepoch()),
('automated_monthly_push_cap','280',unixepoch());

INSERT INTO categories(slug,name,color,sort_order) VALUES
('customer','ลูกค้า','#0ea5e9',1),('team','ทีมงาน','#8b5cf6',2),('order','ออเดอร์','#10b981',3),
('partner','คู่ค้า','#f59e0b',4),('project','โปรเจกต์','#ec4899',5),('other','อื่น ๆ','#64748b',6);
```

- [ ] **Step 3: Implement focused repository interfaces**

Define typed functions instead of a generic query wrapper:

```ts
export const countActiveRealGroups = (db: D1Database) =>
  db.prepare("SELECT count(*) AS count FROM groups WHERE data_mode='real' AND active=1")
    .first<number>("count");

export const insertMessage = (db: D1Database, message: NewMessage) =>
  db.prepare(`INSERT INTO messages(line_message_id,group_id,user_id,kind,text,sent_at,ingested_at,retention_expires_at)
              VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(line_message_id) DO NOTHING`)
    .bind(message.lineMessageId, message.groupId, message.userId, message.kind, message.text,
      message.sentAt, message.ingestedAt, message.retentionExpiresAt).run();
```

Add separate functions for group upsert/lifecycle, alert insertion, dashboard reads, category mutation, usage reservation, report persistence, retention cleanup and audit insertion. Every dynamic value must use `bind()`.

Configure D1 migrations in `vitest.config.ts`:

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      d1Databases: ["DB"],
      bindings: {
        TEST_MIGRATIONS: migrations,
        APP_ENV: "local",
        DASHBOARD_PASSWORD: "local-owner-password",
        SESSION_SECRET: "local-test-session-secret-at-least-32-characters",
        LINE_CHANNEL_SECRET: "line-test-secret",
        LINE_CHANNEL_ACCESS_TOKEN: "line-test-token",
        OWNER_USER_ID: "U-test-owner",
        OPENROUTER_API_KEY: "openrouter-test-key",
        DASHBOARD_URL: "http://localhost:5173"
      }
    }
  })],
  test: { setupFiles: ["./test/setup.ts"], include: ["test/worker/**/*.test.ts"] }
});
```

`test/setup.ts` applies `env.TEST_MIGRATIONS` with `applyD1Migrations(env.DB, ...)`, then clears mutable tables in foreign-key order before each test.

- [ ] **Step 4: Implement deterministic demo data and CLI seeding**

`buildDemoGroups(count, seed)` must use a small seeded PRNG and return exactly 100 groups distributed across all six categories, with reproducible priority, reports, action items and alerts. `scripts/seed-demo.ts` must accept `--local|--remote`, optional `--env preview|production`, and optional `--config wrangler.e2e.jsonc`, then:

```ts
const mode = process.argv.includes("--remote") ? "--remote" : "--local";
const envIndex = process.argv.indexOf("--env");
const configIndex = process.argv.indexOf("--config");
const sql = renderDemoSeedSql(buildDemoDataset(100, 20260823));
await mkdir(".generated", { recursive: true });
await writeFile(".generated/demo-seed.sql", sql);
const args = ["wrangler", "d1", "execute", "line-secretary-cloudflare", mode, "--file", ".generated/demo-seed.sql"];
if (envIndex >= 0) args.push("--env", process.argv[envIndex + 1]);
if (configIndex >= 0) args.push("--config", process.argv[configIndex + 1]);
const result = spawnSync("npx", args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
```

Use SQL string escaping that doubles `'`, delete only `data_mode='demo'` rows before reseeding, and never delete real rows.

- [ ] **Step 5: Run migrations, seed, verify and commit**

Run:

```bash
npm run db:migrate:local
npm run seed:demo:local
npx wrangler d1 execute line-secretary-cloudflare --local --command "select data_mode,count(*) n from groups group by data_mode"
npm run test:worker -- test/worker/database.test.ts test/worker/demo-data.test.ts
```

Expected: D1 reports `demo | 100`; tests PASS.

Commit:

```bash
git add migrations worker/db scripts test vitest.config.ts package.json
git commit -m "feat: add D1 schema and demo dataset"
```

## Task 3: Implement silent LINE webhook ingestion and lifecycle disclosure

**Files:**

- Create: `worker/line/signature.ts`
- Create: `worker/line/events.ts`
- Create: `worker/line/client.ts`
- Create: `worker/routes/line.ts`
- Modify: `worker/app.ts`
- Modify: `worker/db/repositories.ts`
- Test: `test/worker/line-webhook.test.ts`

- [ ] **Step 1: Write failing signature, duplicate, urgent, join and leave tests**

Cover these exact outcomes:

```ts
expect(await verifyLineSignature(raw, validSignature, "secret")).toBe(true);
expect((await postWebhook(unsignedBody)).status).toBe(401);
expect((await postWebhook(textEvent)).status).toBe(200);
expect(await messageCount("m-001")).toBe(1);
expect(await alertCount("keyword", "m-urgent")).toBe(1);
expect(lineFetchesFor(textEvent)).toHaveLength(0);
expect(lineFetchesFor(joinEvent)).toContainEqual(expect.objectContaining({ path: "reply" }));
expect(lineFetchesFor(repeatedJoinEvent)).toHaveLength(0);
expect((await groupRowAfter(leaveEvent)).active).toBe(0);
expect((await eleventhRealGroup()).active).toBe(0);
expect(await messageCountForInactiveGroup()).toBe(0);
```

Run: `npm run test:worker -- test/worker/line-webhook.test.ts`  
Expected: FAIL because `/api/line` is not registered.

- [ ] **Step 2: Implement Web Crypto signature verification and event normalization**

`verifyLineSignature` must import an HMAC SHA-256 key, sign the raw UTF-8 body and compare decoded bytes without early exit:

```ts
const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)));
const actual = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
let difference = expected.length ^ actual.length;
for (let i = 0; i < expected.length; i += 1) difference |= expected[i] ^ (actual[i] ?? 0);
return difference === 0;
```

`parseLineEvents` must reject malformed payloads, ignore user/room sources, and return discriminated `join | leave | text` group events.

- [ ] **Step 3: Implement the LINE client without logging bodies**

Expose:

```ts
getGroupSummary(groupId, token): Promise<{ groupName: string }>;
replyDisclosure(replyToken, token): Promise<LineResult>;
pushDigest(ownerUserId, text, retryKey, token): Promise<LineResult>;
```

The disclosure text is fixed Thai copy that says the bot reads group messages for summaries, retains raw text for 30 days, sends results privately to the owner, and will otherwise remain silent.

- [ ] **Step 4: Implement `/api/line` orchestration**

The handler must:

1. verify signature before JSON parsing;
2. insert/upsert D1 rows before external calls;
3. use `ON CONFLICT DO NOTHING` for message dedupe;
4. create deterministic keyword alerts from the `settings.alert_words` list;
5. activate a newly seen real group only when the active-real count is below `REAL_GROUP_LIMIT`; otherwise save it inactive and create a system warning; text events for inactive/paused groups return 200 without storing content;
6. reply only when `groups.disclosure_sent_at` is null, then persist the successful disclosure timestamp;
7. mark leave inactive;
8. use `executionCtx.waitUntil()` for group-name lookup;
9. return `{ ok: true }` after D1 success and never call AI.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test:worker -- test/worker/line-webhook.test.ts
npm run typecheck
```

Expected: all webhook cases PASS; no raw body appears in captured logs.

Commit:

```bash
git add worker/line worker/routes/line.ts worker/app.ts worker/db test/worker/line-webhook.test.ts
git commit -m "feat: ingest LINE groups silently"
```

## Task 4: Add owner authentication and protected API middleware

**Files:**

- Create: `worker/auth/session.ts`
- Create: `worker/auth/login-limit.ts`
- Create: `worker/routes/auth.ts`
- Modify: `worker/app.ts`
- Modify: `worker/db/repositories.ts`
- Test: `test/worker/auth.test.ts`

- [ ] **Step 1: Write failing auth behavior tests**

Test missing session `401`, correct password setting a secure cookie, tampered/expired cookie rejection, logout clearing cookie, wrong-password count, and sixth attempt returning `429`:

```ts
expect(login.headers.get("set-cookie")).toMatch(/owner_session=.*HttpOnly.*Secure.*SameSite=Strict/);
expect((await protectedRequest()).status).toBe(401);
expect((await protectedRequest(validCookie)).status).toBe(200);
expect((await sixthWrongLogin()).status).toBe(429);
```

Run: `npm run test:worker -- test/worker/auth.test.ts`  
Expected: FAIL with auth routes missing.

- [ ] **Step 2: Implement signed 12-hour sessions**

Use a base64url JSON payload `{ sub: "owner", exp: epochSeconds }` and HMAC SHA-256 signature. Export:

```ts
createSession(secret: string, now: number): Promise<string>;
verifySession(cookie: string, secret: string, now: number): Promise<boolean>;
sessionCookie(value: string): string;
expiredSessionCookie(): string;
```

Use constant-work byte comparison for signatures and password SHA-256 digests.

- [ ] **Step 3: Implement hashed-IP rate limiting and routes**

Hash `CF-Connecting-IP` with HMAC `SESSION_SECRET`, store only the hex digest, reset after 15 minutes, block for 15 minutes after five failures, and clear the row after successful login. Add `/api/auth/login`, `/logout`, `/session`.

- [ ] **Step 4: Add `requireOwner` and mutation-origin middleware**

Protected routes must return JSON `401`. Mutation routes also require `new URL(Origin).host === new URL(request.url).host`; absent/mismatched Origin returns `403` except Worker-runtime tests that explicitly set the matching Origin.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:worker -- test/worker/auth.test.ts`  
Expected: PASS.

Commit:

```bash
git add worker/auth worker/routes/auth.ts worker/app.ts worker/db test/worker/auth.test.ts
git commit -m "feat: protect owner dashboard APIs"
```

## Task 5: Implement dashboard read models and APIs

**Files:**

- Modify: `worker/db/types.ts`
- Modify: `worker/db/repositories.ts`
- Create: `worker/routes/dashboard.ts`
- Modify: `worker/app.ts`
- Test: `test/worker/dashboard-api.test.ts`

- [ ] **Step 1: Write failing seeded-dashboard API tests**

After seeding D1, authenticate and assert:

```ts
expect(dashboard.kpis.totalGroups).toBe(100);
expect(dashboard.groups.every((group) => group.dataMode === "demo")).toBe(true);
expect(dashboard.actionQueue[0].priorityScore).toBeGreaterThanOrEqual(dashboard.actionQueue[1].priorityScore);
expect((await get("/api/groups?mode=real")).groups).toHaveLength(0);
expect((await get("/api/groups?limit=25")).groups).toHaveLength(25);
```

Also assert `/api/groups/:id`, `updated_after` alert polling, and `/api/system/health` return bounded DTOs without raw message text.

- [ ] **Step 2: Define a shared response contract**

`DashboardPayload` must include:

```ts
type DashboardPayload = {
  generatedAt: number;
  kpis: { totalGroups: number; urgent: number; waiting: number; active: number; normal: number };
  categories: Array<{ id: number; slug: string; name: string; color: string; groupCount: number; urgentCount: number; openActionCount: number }>;
  groups: GroupSummaryDto[];
  actionQueue: ActionQueueItemDto[];
  health: { backlogGroups: number; aiCallsToday: number; aiInputTokensToday: number; linePushesMonth: number; warnings: string[] };
};
```

Frontend `src/types.ts` will later mirror this exact shape.

- [ ] **Step 3: Implement indexed, paginated read queries**

Use explicit `limit` clamped to 1–100, opaque numeric offset for the prototype, indexed ordering, and a separate group-detail query limited to 30 reports and 50 alerts. Never select `messages.text` in dashboard list queries.

- [ ] **Step 4: Register protected read routes**

Routes: `/api/dashboard`, `/api/alerts`, `/api/groups`, `/api/groups/:id`, `/api/categories`, `/api/system/health`. Return `404` for unknown groups and `400` for invalid filters.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:worker -- test/worker/dashboard-api.test.ts`  
Expected: PASS with exactly 100 demo groups after seed.

Commit:

```bash
git add worker/db worker/routes/dashboard.ts worker/app.ts test/worker/dashboard-api.test.ts
git commit -m "feat: expose dashboard read APIs"
```

## Task 6: Add categories, alerts, pause/history deletion and audit controls

**Files:**

- Create: `worker/routes/controls.ts`
- Modify: `worker/db/repositories.ts`
- Modify: `worker/app.ts`
- Test: `test/worker/controls.test.ts`

- [ ] **Step 1: Write failing mutation and audit tests**

Cover:

```ts
expect((await patchCategory(groupId, categoryId)).categoryLocked).toBe(true);
expect((await applyAiCategoryToLockedGroup(groupId)).categoryId).toBe(categoryId);
expect((await patchStatus(groupId, false)).active).toBe(false);
expect(await rawMessageCountAfterDelete(groupId)).toBe(0);
expect((await auditFor(groupId)).map((row) => row.actor)).toContain("owner");
expect((await patchAlert(alertId, "resolved")).status).toBe("resolved");
```

Run: `npm run test:worker -- test/worker/controls.test.ts`  
Expected: FAIL because mutations do not exist.

- [ ] **Step 2: Implement category CRUD and lock semantics**

Owner category assignment performs an atomic batch that updates `category_source='manual'`, `category_locked=1`, `needs_category_review=0`, then inserts an audit record containing before/after category IDs. Category delete is soft (`active=0`). Slugs are lower-case `[a-z0-9-]` and immutable after creation.

- [ ] **Step 3: Implement group and alert controls**

Pause/resume writes `active`, raw-history deletion removes only `messages` for that group and preserves reports/alerts, alert status sets the corresponding timestamp, and every mutation inserts audit metadata without raw message text.

- [ ] **Step 4: Register routes with auth and Origin checks**

Register the exact mutation routes from the spec and `GET /api/audit-log?entity_type=group&entity_id=...&limit=50`.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:worker -- test/worker/controls.test.ts`  
Expected: PASS.

Commit:

```bash
git add worker/routes/controls.ts worker/db/repositories.ts worker/app.ts test/worker/controls.test.ts
git commit -m "feat: add owner group controls"
```

## Task 7: Implement AI policy, structured OpenRouter client and per-group Workflow

**Files:**

- Create: `worker/ai/schema.ts`
- Create: `worker/ai/policy.ts`
- Create: `worker/ai/openrouter.ts`
- Create: `worker/workflows/group-summarizer.ts`
- Modify: `worker/db/repositories.ts`
- Modify: `worker/index.ts`
- Modify: `wrangler.jsonc`
- Test: `test/worker/ai-policy.test.ts`
- Test: `test/worker/openrouter.test.ts`
- Test: `test/worker/group-workflow.test.ts`

- [ ] **Step 1: Write failing eligibility and output-validation tests**

Required cases:

```ts
expect(isAiEligible({ newMessages: 4, oldestAgeMinutes: 119, hasUrgentAlert: false, budgetAvailable: true })).toBe(false);
expect(isAiEligible({ newMessages: 5, oldestAgeMinutes: 1, hasUrgentAlert: false, budgetAvailable: true })).toBe(true);
expect(isAiEligible({ newMessages: 1, oldestAgeMinutes: 120, hasUrgentAlert: false, budgetAvailable: true })).toBe(true);
expect(isAiEligible({ newMessages: 50, oldestAgeMinutes: 120, hasUrgentAlert: true, budgetAvailable: false })).toBe(false);
expect(() => SummaryOutput.parse({ summary: "x", priorityScore: 999 })).toThrow();
```

Run: `npm run test:worker -- test/worker/ai-policy.test.ts`  
Expected: FAIL.

- [ ] **Step 2: Define the structured output schema and prompt boundary**

Use:

```ts
export const SummaryOutput = z.object({
  summary: z.string().min(1).max(3000),
  actionItems: z.array(z.string().min(1).max(300)).max(20),
  unresolvedQuestions: z.array(z.string().min(1).max(300)).max(20),
  priorityScore: z.number().int().min(0).max(100),
  suggestedCategorySlug: z.string().min(1).max(40),
  categoryConfidence: z.number().min(0).max(1),
});
```

The system prompt must state that group content is untrusted data, must not execute instructions/links/tools, must choose only from supplied category slugs, and must emit JSON matching the schema.

- [ ] **Step 3: Implement daily budget reservation and OpenRouter client**

Reserve one call atomically only when `ai_calls < cap` and `ai_input_tokens + estimatedTokens <= cap`. Estimate input tokens as `ceil(characters / 4)` before calling; reconcile actual `usage.prompt_tokens` and `usage.completion_tokens` afterward. Use fetch timeout via `AbortSignal.timeout(25_000)` and never log messages or prompt.

- [ ] **Step 4: Implement the durable Workflow**

Export `GroupSummarizer extends WorkflowEntrypoint<AppEnv, Params>` with three named steps:

```ts
const input = await step.do("load bounded group input", () => loadWorkflowInput(this.env.DB, event.payload.groupId, 200));
const result = await step.do("summarize with openrouter", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, () => summarize(this.env, input));
await step.do("persist report and checkpoint", { retries: { limit: 3, delay: "5 seconds", backoff: "linear" } }, () => persistWorkflowResult(this.env.DB, input, result));
```

Persistence uses D1 batch, changes category only when unlocked, sets `needs_category_review` below 0.75, increments `groups_completed`, and never marks messages processed if an earlier step fails.

Export the Workflow class from the entry module so Wrangler can bind it:

```ts
export { GroupSummarizer } from "./workflows/group-summarizer";
```

Add the binding to `wrangler.jsonc` in the same task:

```jsonc
"workflows": [{
  "name": "line-secretary-group-summarizer",
  "binding": "GROUP_SUMMARIZER",
  "class_name": "GroupSummarizer"
}]
```

- [ ] **Step 5: Verify Workflow retry/idempotency tests**

Use the Cloudflare Workflow introspector or a fake `WorkflowStep` adapter to assert stable step names, three OpenRouter retries, one report after replay, locked-category preservation, and unprocessed messages after invalid JSON.

Run:

```bash
npm run test:worker -- test/worker/ai-policy.test.ts test/worker/openrouter.test.ts test/worker/group-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/ai worker/workflows worker/db worker/index.ts test/worker
git commit -m "feat: summarize groups with guarded workflows"
```

## Task 8: Implement the 30-minute coordinator, retention and LINE digest

**Files:**

- Create: `worker/scheduler/coordinator.ts`
- Create: `worker/scheduler/digest.ts`
- Modify: `worker/line/client.ts`
- Modify: `worker/db/repositories.ts`
- Modify: `worker/index.ts`
- Test: `test/worker/coordinator.test.ts`
- Test: `test/worker/digest.test.ts`

- [ ] **Step 1: Write failing Bangkok schedule, cap and demo-exclusion tests**

Cover Monday 08:00–17:00 Bangkok slots, weekend skip, half-hour non-slot, empty digest skip, daily 10 cap, monthly 280 cap, demo exclusion, oldest/urgent ordering, retention and duplicate scheduled event:

```ts
expect(isDigestSlot(epochForBangkok("2026-08-24 08:00"))).toBe(true);
expect(isDigestSlot(epochForBangkok("2026-08-24 08:30"))).toBe(false);
expect(isDigestSlot(epochForBangkok("2026-08-23 08:00"))).toBe(false);
expect(selectedGroups.every((group) => group.dataMode === "real")).toBe(true);
expect(await deliveriesForSameSlot()).toHaveLength(1);
expect(await runDigest({ LINE_PUSH_ENABLED: "false" })).toEqual({ status: "disabled" });
```

Run: `npm run test:worker -- test/worker/coordinator.test.ts test/worker/digest.test.ts`  
Expected: FAIL.

- [ ] **Step 2: Implement coordinator idempotency and maintenance**

Insert `job_runs.scheduled_for` before work; duplicate insert means return without reprocessing. Once per Bangkok date delete expired messages, reports older than 180 days and expired auth attempts. Retry LINE Group Summary lookup for real groups whose title is still the shortened source ID. Select at most 10 eligible active real groups and create Workflow IDs `${groupId}:${scheduledTime}`.

- [ ] **Step 3: Implement digest formatting and quota reservation**

Format one Thai text under 5,000 characters, ordered critical/high alerts → action items → category summaries, ending in `DASHBOARD_URL`. If `LINE_PUSH_ENABLED !== "true"`, return `{ status: "disabled" }` before reserving a delivery. Otherwise insert a pending delivery with a persisted `crypto.randomUUID()` retry key before network send. Send only completed, unnotified reports and alerts; mark `notified_at` only after accepted LINE response.

- [ ] **Step 4: Implement safe LINE retries**

`pushDigest` always includes `X-Line-Retry-Key`. Retry only timeout/5xx/429 with the same key within 24 hours; treat `200` and duplicate-retry `409` as accepted; record 4xx body only as sanitized status/code, never token or message text.

- [ ] **Step 5: Wire the scheduled handler and verify**

`worker/index.ts`:

```ts
scheduled(controller, env, ctx) {
  ctx.waitUntil(runScheduled(env, controller.scheduledTime));
}
```

Run:

```bash
npm run test:worker -- test/worker/coordinator.test.ts test/worker/digest.test.ts
npx wrangler dev
```

In a second terminal trigger: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*&format=json"`  
Expected: HTTP 200 and one local `job_runs` row; LINE push remains disabled.

- [ ] **Step 6: Commit**

```bash
git add worker/scheduler worker/line/client.ts worker/db/repositories.ts worker/index.ts test/worker
git commit -m "feat: schedule summaries and guarded digests"
```

## Task 9: Build login, API client and resilient dashboard shell

**Files:**

- Create: `src/types.ts`
- Create: `src/api.ts`
- Create: `src/components/Login.tsx`
- Create: `src/components/Dashboard.tsx`
- Create: `src/components/SystemStatus.tsx`
- Create: `src/styles.css`
- Modify: `src/App.tsx`
- Test: `test/ui/login.test.tsx`
- Test: `test/ui/dashboard-shell.test.tsx`

- [ ] **Step 1: Write failing login and stale-state tests**

Mock fetch and assert unauthenticated login, submitted password, cookie-based session refresh, loading skeleton, cached data retention after poll error, stale timestamp, and logout:

```tsx
expect(screen.getByRole("heading", { name: "เลขากลุ่ม" })).toBeVisible();
await user.type(screen.getByLabelText("รหัสผ่าน"), "owner-pass");
await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ credentials: "include" }));
```

Run: `npm run test:ui -- test/ui/login.test.tsx test/ui/dashboard-shell.test.tsx`  
Expected: FAIL.

- [ ] **Step 2: Implement typed fetch functions**

`src/api.ts` exports `getSession`, `login`, `logout`, `getDashboard`, `getAlertsSince`, `getGroup`, and mutation functions. Every request uses `credentials: "include"`; non-2xx throws `ApiError(status, code)`; `401` resets auth state.

- [ ] **Step 3: Implement login and data lifecycle**

`App` performs one session check, shows `Login` when unauthorized, and mounts `Dashboard` after success. Dashboard loads once, polls `/api/alerts?updated_after=` every 60 seconds while visible, pauses polling when `document.hidden`, retains last good data on error, and shows “อัปเดตล่าสุด …” plus stale/error banner. Listen for browser `online`/`offline` events and show a persistent offline banner without clearing cached data.

- [ ] **Step 4: Create the visual system**

Use plain CSS with these tokens:

```css
:root { --ink:#111827; --muted:#64748b; --surface:#fff; --canvas:#f6f7fb; --line:#e5e7eb; --danger:#dc2626; --warning:#d97706; --ok:#059669; --radius:14px; }
body { margin:0; min-width:320px; background:var(--canvas); color:var(--ink); font-family:Inter,"Noto Sans Thai",system-ui,sans-serif; }
:focus-visible { outline:3px solid #38bdf8; outline-offset:2px; }
```

Layouts must work at 360px, 768px and 1440px, respect reduced motion, use semantic buttons/headings, and never encode severity by color alone.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test:ui -- test/ui/login.test.tsx test/ui/dashboard-shell.test.tsx
npm run build
```

Expected: PASS and production assets build.

Commit:

```bash
git add src test/ui index.html
git commit -m "feat: add authenticated dashboard shell"
```

## Task 10: Implement the approved shared-filter Action + Category views

**Files:**

- Create: `src/components/Filters.tsx`
- Create: `src/components/ActionView.tsx`
- Create: `src/components/CategoryView.tsx`
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/styles.css`
- Test: `test/ui/dashboard-views.test.tsx`

- [ ] **Step 1: Write failing shared-context view tests**

Test that Action is default, the view is restored from localStorage, filters persist across the toggle, search/category/mode filters affect both views, KPIs remain shared, and no group appears from a different filtered dataset:

```tsx
expect(screen.getByRole("button", { name: "ต้องจัดการ", pressed: true })).toBeVisible();
await user.selectOptions(screen.getByLabelText("แหล่งข้อมูล"), "real");
await user.click(screen.getByRole("button", { name: "ตามหมวด" }));
expect(screen.getByLabelText("แหล่งข้อมูล")).toHaveValue("real");
```

Run: `npm run test:ui -- test/ui/dashboard-views.test.tsx`  
Expected: FAIL.

- [ ] **Step 2: Implement one shared filter state**

Dashboard owns:

```ts
type ViewMode = "action" | "category";
type Filters = { query: string; categoryId: number | "all"; priority: "all" | "urgent" | "waiting" | "normal"; dataMode: "all" | "real" | "demo" };
```

Compute `filteredGroups`, `filteredActions` and `filteredCategories` once with `useMemo`, then pass them to either view. Persist only `viewMode`, not filters, to localStorage.

- [ ] **Step 3: Implement Action view**

Render four KPI cards and a priority queue sorted severity, age and AI score. Every row includes text label/icon for severity, group, category, reason, age, action and REAL/DEMO badge. Clicking opens the same group detail route used by Category view.

- [ ] **Step 4: Implement Category view**

Render category cards with group count, urgent count, open actions and most recent activity. “รอยืนยันหมวด” is a separate card driven by `needsCategoryReview`. Drilling into a card narrows the shared category filter rather than loading a second product/page.

- [ ] **Step 5: Verify responsive UI and commit**

Run:

```bash
npm run test:ui -- test/ui/dashboard-views.test.tsx
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/components src/styles.css test/ui/dashboard-views.test.tsx
git commit -m "feat: add action and category dashboard views"
```

## Task 11: Implement group details, controls, audit and system health UI

**Files:**

- Create: `src/components/GroupDetail.tsx`
- Modify: `src/components/SystemStatus.tsx`
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/api.ts`
- Modify: `src/styles.css`
- Test: `test/ui/group-detail.test.tsx`
- Test: `test/ui/system-status.test.tsx`

- [ ] **Step 1: Write failing detail/control tests**

Cover report history, action/unresolved sections, category change locking by default, explicit unlock, category create/rename/disable, alert acknowledgement, pause confirmation, raw-history destructive confirmation, audit rows, demo badge and budget/backlog warnings.

Run: `npm run test:ui -- test/ui/group-detail.test.tsx test/ui/system-status.test.tsx`  
Expected: FAIL.

- [ ] **Step 2: Implement accessible group details**

Use `new URLSearchParams(location.search).get("group")` and `history.pushState()` with `URLSearchParams.set("group", sourceId)` for the in-app detail panel so browser refresh and back work without adding a routing library. Load detail only when opened. Separate summary, action items, unresolved questions, alerts and audit with real headings and show raw text only as short server-provided excerpts.

- [ ] **Step 3: Implement guarded controls**

Category save sends `{ categoryId, locked: true }`; unlock is a separate button. Add a category manager that creates a validated slug/name/color, renames active categories and disables rather than deletes them. Pause and raw-history deletion require confirmation dialogs naming the group. After success, refetch detail and dashboard; on error preserve controls and show a Thai inline error.

- [ ] **Step 4: Implement system health**

Show backlog groups, AI calls/tokens today, LINE pushes this month, last successful cron and warnings. Warning text must explain the action taken: AI paused, digest paused, or stale summaries; never show raw provider errors or secrets.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test:ui -- test/ui/group-detail.test.tsx test/ui/system-status.test.tsx
npm run build
```

Expected: PASS.

Commit:

```bash
git add src test/ui
git commit -m "feat: add group controls and system health"
```

## Task 12: Add end-to-end acceptance, setup docs and CLI deployment automation

**Files:**

- Create: `playwright.config.ts`
- Create: `e2e/dashboard.spec.ts`
- Create: `scripts/configure-cloudflare.mjs`
- Create: `scripts/configure-worker-url.mjs`
- Create: `scripts/smoke-worker.mjs`
- Create: `wrangler.e2e.jsonc`
- Create: `.dev.vars.example`
- Create: `README.md`
- Create: `INSTALL.md`
- Modify: `wrangler.jsonc`
- Modify: `package.json`

- [ ] **Step 1: Add a failing browser acceptance test**

The E2E test starts the local preview with seeded D1 and verifies login, 100 demo groups, default Action view, toggle to Category while preserving filters, open detail, lock category, pause/resume and logout:

```ts
await page.goto("/");
await page.getByLabel("รหัสผ่าน").fill("local-owner-password");
await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
await expect(page.getByText("100 กลุ่ม")).toBeVisible();
await page.getByRole("button", { name: "ตามหมวด" }).click();
await expect(page.getByRole("heading", { name: "ภาพรวมตามหมวด" })).toBeVisible();
```

Run: `npm run test:e2e`  
Expected: FAIL until Playwright web server and the isolated E2E Wrangler config are configured.

- [ ] **Step 2: Configure local E2E without production side effects**

Create `wrangler.e2e.jsonc` with the same Worker/D1/Workflow bindings, database name `line-secretary-cloudflare-e2e`, zero UUID, safe dummy owner/LINE/OpenRouter values in `vars`, and `LINE_PUSH_ENABLED=false`. `playwright.config.ts` sets `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=./wrangler.e2e.jsonc`, runs migrations and seed with that config, starts `vite --host 127.0.0.1`, and uses one Playwright worker. No real `.dev.vars` file is read or modified during E2E.

- [ ] **Step 3: Implement safe Wrangler D1 configuration script**

`scripts/configure-cloudflare.mjs` accepts exactly:

```bash
node scripts/configure-cloudflare.mjs preview line-secretary-cloudflare-preview
node scripts/configure-cloudflare.mjs production line-secretary-cloudflare-production
```

It runs `npx wrangler d1 list --json`, finds the exact database name, validates the returned UUID, parses `wrangler.jsonc` with `jsonc-parser`, updates only the chosen environment D1 `database_id`, and never accepts or prints secrets. Add `jsonc-parser` as a dev dependency. `scripts/configure-worker-url.mjs` accepts `preview|production` plus a deploy log path, extracts the HTTPS `workers.dev` URL, updates only that environment's `DASHBOARD_URL`, and rejects non-HTTPS/non-workers.dev URLs. `scripts/smoke-worker.mjs` accepts the same deploy log path and verifies `/` plus `/api/health` with `fetch`.

- [ ] **Step 4: Add preview and production environments**

Create `env.preview` and `env.production` in `wrangler.jsonc`, each with its own Worker name, D1 binding, Workflow name and vars. Both start with `LINE_PUSH_ENABLED=false`; only production may later be changed to true in a separate reviewed commit after smoke tests.

Add scripts:

```json
{
  "seed:demo:preview": "tsx scripts/seed-demo.ts --remote --env preview",
  "seed:demo:production": "tsx scripts/seed-demo.ts --remote --env production"
}
```

- [ ] **Step 5: Write operator documentation**

`README.md` explains architecture, free-tier boundaries, local commands, silent behavior, A+B views and safety caps. `INSTALL.md` gives exact CLI flow:

```bash
npx wrangler whoami
npx wrangler d1 create line-secretary-cloudflare-preview --location apac
npx wrangler d1 create line-secretary-cloudflare-production --location apac
node scripts/configure-cloudflare.mjs preview line-secretary-cloudflare-preview
node scripts/configure-cloudflare.mjs production line-secretary-cloudflare-production
npx wrangler d1 migrations apply line-secretary-cloudflare-preview --remote --env preview
npm run seed:demo:preview
npx wrangler secret put DASHBOARD_PASSWORD --env preview
npx wrangler secret put SESSION_SECRET --env preview
npm run deploy -- --env preview
```

The written docs must tell the operator to set LINE/OpenRouter secrets without pasting them into logs and to update LINE webhook only after production smoke tests.

- [ ] **Step 6: Run the full local acceptance suite**

Run:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run db:migrate:local
npm run seed:demo:local
npx wrangler deploy --dry-run
npm run test:e2e
git status --short
```

Expected: all tests PASS, dry-run exits 0, exactly 100 demo groups, no untracked build/secrets/state files.

- [ ] **Step 7: Commit the verified local prototype**

```bash
git add playwright.config.ts e2e scripts .dev.vars.example README.md INSTALL.md wrangler.jsonc package.json package-lock.json .gitignore
git commit -m "test: verify Cloudflare prototype end to end"
```

- [ ] **Step 8: Create private GitHub remote when CLI is authenticated**

Run read-only checks first:

```bash
gh auth status
gh repo view gobank01/line-secretary-cloudflare
```

If authenticated and the repo does not exist:

```bash
gh repo create gobank01/line-secretary-cloudflare --private --source . --remote origin --push
```

If it exists, do not overwrite or force-push; report the collision and keep the complete local repo.

- [ ] **Step 9: Provision and smoke-test Cloudflare preview through CLI**

Only when `wrangler whoami` succeeds, create/bind preview and production D1 databases, apply migrations, seed preview, set secrets that are already available to the user, deploy preview, then verify:

```bash
mkdir -p .generated
npx wrangler deploy --env preview | tee .generated/preview-deploy.log
node scripts/configure-worker-url.mjs preview .generated/preview-deploy.log
npx wrangler deploy --env preview | tee .generated/preview-deploy-final.log
node scripts/smoke-worker.mjs .generated/preview-deploy-final.log
npx wrangler d1 execute line-secretary-cloudflare-preview --remote --env preview --command "select data_mode,count(*) n from groups group by data_mode"
```

Expected: API health 200, SPA 200, `demo | 100`, `LINE_PUSH_ENABLED=false`. Do not switch the LINE webhook or enable production push without successful tests and real LINE credentials.

- [ ] **Step 10: Deploy a production-safe demo when required secrets are available**

Set `DASHBOARD_PASSWORD` interactively, pipe a generated 32-byte session secret directly into Wrangler without printing it, migrate and seed production, then deploy twice so the discovered dashboard URL is stored:

```bash
npx wrangler secret put DASHBOARD_PASSWORD --env production
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET --env production
npx wrangler d1 migrations apply line-secretary-cloudflare-production --remote --env production
npm run seed:demo:production
npx wrangler deploy --env production | tee .generated/production-deploy.log
node scripts/configure-worker-url.mjs production .generated/production-deploy.log
npx wrangler deploy --env production | tee .generated/production-deploy-final.log
node scripts/smoke-worker.mjs .generated/production-deploy-final.log
```

Expected: production dashboard and health endpoint return 200 with 100 demo groups, `LINE_PUSH_ENABLED=false`, and no LINE/OpenRouter call occurs. If the dashboard password cannot be supplied, stop after the verified preview deployment and report that single credential blocker rather than inventing or displaying a password.

## Final verification checklist

- [ ] New Git root remains `/Users/gobank01/Documents/All AI/line-secretary-cloudflare`
- [ ] Original repo remains untouched except its untracked visual brainstorming directory
- [ ] `git log` shows small task-oriented commits
- [ ] 100 demo groups are isolated from Workflow and LINE paths
- [ ] Group text webhook never replies or calls AI
- [ ] Join disclosure is the only group reply
- [ ] Urgent deterministic alerts are visible through the 60-second poll path
- [ ] Cron is `*/30 * * * *` and only eligible real groups create Workflows
- [ ] AI and LINE daily/monthly guards have passing boundary tests
- [ ] Action and Category views share filters and data context
- [ ] Preview and production D1/secrets are isolated
- [ ] `LINE_PUSH_ENABLED=false` for all automated smoke tests
- [ ] Full tests, build, Wrangler dry-run and E2E pass before completion is claimed
