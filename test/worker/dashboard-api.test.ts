import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDemoDataset, renderDemoSeedSql } from "../../scripts/demo-data";
import { createSession } from "../../worker/auth/session";
import worker from "../../worker/index";

let cookie = "";

async function get(path: string): Promise<Response> {
  return worker.fetch(
    new Request(`http://example.com${path}`, { headers: { cookie } }),
    env,
    createExecutionContext(),
  );
}

beforeAll(async () => {
  const statements = renderDemoSeedSql(buildDemoDataset(100, 20_260_823))
    .split(";\n")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.length > 0 &&
        statement !== "PRAGMA foreign_keys = ON" &&
        statement !== "BEGIN TRANSACTION" &&
        statement !== "COMMIT",
    );
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  cookie = `owner_session=${await createSession(env.SESSION_SECRET, Date.now())}`;
});

describe("dashboard read API", () => {
  it("returns demo KPIs, categories, and a priority-sorted action queue", async () => {
    const response = await get("/api/dashboard");
    expect(response.status).toBe(200);
    const dashboard = await response.json<{
      kpis: { totalGroups: number };
      groups: Array<{ dataMode: string }>;
      categories: Array<{ slug: string; groupCount: number }>;
      actionQueue: Array<{ priorityScore: number }>;
    }>();

    expect(dashboard.kpis.totalGroups).toBe(100);
    expect(dashboard.groups).toHaveLength(100);
    expect(dashboard.groups.every((group) => group.dataMode === "demo")).toBe(true);
    expect(dashboard.categories).toHaveLength(6);
    expect(dashboard.categories.reduce((total, category) => total + category.groupCount, 0)).toBe(100);
    expect(dashboard.actionQueue[0]?.priorityScore).toBeGreaterThanOrEqual(
      dashboard.actionQueue[1]?.priorityScore ?? -1,
    );
  });

  it("supports bounded group filters and rejects invalid ones", async () => {
    const real = await (await get("/api/groups?mode=real")).json<{ groups: unknown[] }>();
    const limited = await (await get("/api/groups?limit=25")).json<{ groups: unknown[]; nextOffset: number | null }>();

    expect(real.groups).toHaveLength(0);
    expect(limited.groups).toHaveLength(25);
    expect(limited.nextOffset).toBe(25);
    expect((await get("/api/groups?mode=invalid")).status).toBe(400);
    expect((await get("/api/groups?limit=999")).status).toBe(400);
  });

  it("returns bounded detail without exposing retained raw message text", async () => {
    await env.DB.prepare(
      `INSERT INTO messages(line_message_id,group_id,user_id,kind,text,sent_at,ingested_at,retention_expires_at)
       VALUES('secret-message','DEMO-001','U-secret','text','TOP SECRET RAW TEXT',1,1,9999999999999)`,
    ).run();

    const response = await get("/api/groups/DEMO-001");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("TOP SECRET RAW TEXT");
    const detail = JSON.parse(text) as { reports: unknown[]; alerts: unknown[]; messageCount: number };
    expect(detail.reports.length).toBeLessThanOrEqual(30);
    expect(detail.alerts.length).toBeLessThanOrEqual(50);
    expect(detail.messageCount).toBe(1);
    expect((await get("/api/groups/UNKNOWN")).status).toBe(404);
  });

  it("polls alerts by timestamp and reports bounded system health", async () => {
    const all = await (await get("/api/alerts?updated_after=0&limit=10")).json<{ alerts: Array<{ createdAt: number }> }>();
    expect(all.alerts.length).toBeLessThanOrEqual(10);
    const newest = Math.max(...all.alerts.map((alert) => alert.createdAt));
    const after = await (await get(`/api/alerts?updated_after=${newest}`)).json<{
      alerts: Array<{ createdAt: number }>;
    }>();
    expect(after.alerts.every((alert) => alert.createdAt > newest)).toBe(true);
    const complete = await (await get("/api/alerts?updated_after=0&limit=100")).json<{
      alerts: Array<{ createdAt: number }>;
    }>();
    const globalNewest = Math.max(...complete.alerts.map((alert) => alert.createdAt));
    expect(
      (await (await get(`/api/alerts?updated_after=${globalNewest}`)).json<{ alerts: unknown[] }>()).alerts,
    ).toHaveLength(0);
    expect((await get("/api/alerts?updated_after=bad")).status).toBe(400);

    const health = await (await get("/api/system/health")).json<{
      backlogGroups: number;
      aiCallsToday: number;
      aiInputTokensToday: number;
      linePushesMonth: number;
      lastSuccessfulCron: number | null;
      warnings: string[];
    }>();
    expect(health).toEqual({
      backlogGroups: 0,
      aiCallsToday: 0,
      aiInputTokensToday: 0,
      linePushesMonth: 0,
      lastSuccessfulCron: null,
      warnings: [],
    });
  });
});
