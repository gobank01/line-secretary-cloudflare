// Smoke test adapter ทั้งเส้นบน libsql ไฟล์จริง: migrate → health → login ผิด/ถูก → dashboard
import { mkdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";

process.env.TURSO_DATABASE_URL = "file:.generated/smoke.db";
process.env.DASHBOARD_PASSWORD = "smoke-password-12chars";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";

await mkdir(".generated", { recursive: true });
await rm(".generated/smoke.db", { force: true });
execSync("node scripts/migrate-turso.mjs", { stdio: "inherit", env: process.env });

const { createApp } = await import("../worker/app");
const { buildEnv } = await import("../vercel-adapter/env");
const app = createApp();
const env = buildEnv();
const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://smoke.local${path}`, init), env);

const health = await call("/api/health");
if (health.status !== 200) throw new Error(`health ${health.status}`);

const bad = await call("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://smoke.local" },
  body: JSON.stringify({ password: "wrong-password-xx" }),
});
if (bad.status !== 401) throw new Error(`bad login ${bad.status}`);

const good = await call("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://smoke.local" },
  body: JSON.stringify({ password: "smoke-password-12chars" }),
});
if (good.status !== 200) throw new Error(`good login ${good.status}`);
const cookie = (good.headers.get("set-cookie") ?? "").split(";")[0];

const dash = await call("/api/dashboard?mode=demo", { headers: { cookie } });
if (dash.status !== 200) throw new Error(`dashboard ${dash.status}`);
const payload = (await dash.json()) as { kpis: { totalGroups: number } };

console.log(`smoke:vercel ผ่าน — login+dashboard บน libsql (demo groups: ${payload.kpis.totalGroups})`);
