import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest, type DigestEnv } from "../../worker/scheduler/digest";

function bangkokEpoch(value: string): number {
  const [date, time] = value.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour - 7, minute);
}

const slot = bangkokEpoch("2026-08-24 08:00");

function digestEnv(overrides: Partial<DigestEnv> = {}): DigestEnv {
  return {
    DB: env.DB,
    LINE_PUSH_ENABLED: "true",
    LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
    OWNER_USER_ID: env.OWNER_USER_ID,
    AUTOMATED_MONTHLY_PUSH_CAP: "280",
    DASHBOARD_URL: "https://secretary.example.com",
    APP_TIMEZONE: env.APP_TIMEZONE,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alerts"),
    env.DB.prepare("DELETE FROM reports"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM groups"),
    env.DB.prepare("DELETE FROM digest_deliveries"),
    env.DB.prepare("DELETE FROM usage_daily"),
  ]);
  vi.restoreAllMocks();
});

async function seedDigestContent(): Promise<{ reportId: number; demoReportId: number; alertId: number }> {
  const categoryId = (await env.DB.prepare("SELECT id FROM categories WHERE slug='customer'").first<number>("id")) ?? 0;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO groups(source_id,title,data_mode,active,category_id,priority_score,created_at,updated_at)
       VALUES('C-digest','ลูกค้าสำคัญ','real',1,?,92,?,?)`,
    ).bind(categoryId, slot, slot),
    env.DB.prepare(
      `INSERT INTO groups(source_id,title,data_mode,active,category_id,priority_score,created_at,updated_at)
       VALUES('DEMO-digest','ข้อมูลจำลองลับ','demo',1,?,99,?,?)`,
    ).bind(categoryId, slot, slot),
  ]);
  await env.DB.prepare(
    `INSERT INTO reports(group_id,period_start,period_end,summary,action_items_json,unresolved_json,priority_score,model,prompt_version,created_at)
     VALUES('C-digest',1,2,'ลูกค้ารอคำตอบ','["โทรกลับลูกค้า"]','[]',92,'test','v1',?)`,
  )
    .bind(slot - 1_000)
    .run();
  await env.DB.prepare(
    `INSERT INTO reports(group_id,period_start,period_end,summary,action_items_json,unresolved_json,priority_score,model,prompt_version,created_at)
     VALUES('DEMO-digest',1,2,'ห้ามส่งข้อมูลจำลอง','["demo action"]','[]',99,'test','v1',?)`,
  )
    .bind(slot - 1_000)
    .run();
  await env.DB.prepare(
    `INSERT INTO alerts(group_id,kind,severity,status,excerpt,created_at)
     VALUES('C-digest','keyword','critical','open','ด่วน ลูกค้าจะยกเลิก',?)`,
  )
    .bind(slot - 2_000)
    .run();
  return {
    reportId: (await env.DB.prepare("SELECT id FROM reports WHERE group_id='C-digest'").first<number>("id")) ?? 0,
    demoReportId: (await env.DB.prepare("SELECT id FROM reports WHERE group_id='DEMO-digest'").first<number>("id")) ?? 0,
    alertId: (await env.DB.prepare("SELECT id FROM alerts WHERE group_id='C-digest'").first<number>("id")) ?? 0,
  };
}

describe("guarded LINE digest", () => {
  it("returns disabled before reserving a delivery and skips empty content", async () => {
    await expect(runDigest(digestEnv({ LINE_PUSH_ENABLED: "false" }), slot)).resolves.toEqual({ status: "disabled" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM digest_deliveries").first("count")).toBe(0);
    await expect(runDigest(digestEnv(), slot)).resolves.toEqual({ status: "empty" });
  });

  it("sends only real completed content, keeps one delivery per slot, and marks accepted items", async () => {
    const ids = await seedDigestContent();
    const requests: Array<{ retryKey: string | null; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ retryKey: headers.get("x-line-retry-key"), body: String(init?.body) });
      return Response.json({}, { status: 200, headers: { "x-line-request-id": "line-1" } });
    });

    await expect(runDigest(digestEnv(), slot)).resolves.toMatchObject({ status: "sent" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.retryKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requests[0]?.body).toContain("ด่วน ลูกค้าจะยกเลิก");
    expect(requests[0]?.body).toContain("โทรกลับลูกค้า");
    expect(requests[0]?.body).toContain("https://secretary.example.com");
    expect(requests[0]?.body).not.toContain("ห้ามส่งข้อมูลจำลอง");
    expect(requests[0]?.body.length).toBeLessThan(5_500);

    expect(await env.DB.prepare("SELECT notified_at FROM reports WHERE id=?").bind(ids.reportId).first("notified_at")).not.toBeNull();
    expect(await env.DB.prepare("SELECT notified_at FROM reports WHERE id=?").bind(ids.demoReportId).first("notified_at")).toBeNull();
    expect(await env.DB.prepare("SELECT notified_at FROM alerts WHERE id=?").bind(ids.alertId).first("notified_at")).not.toBeNull();

    await env.DB.prepare("UPDATE reports SET notified_at=NULL WHERE id=?").bind(ids.reportId).run();
    await expect(runDigest(digestEnv(), slot)).resolves.toEqual({ status: "duplicate" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM digest_deliveries").first("count")).toBe(1);
  });

  it("retries retryable statuses with one persisted key", async () => {
    await seedDigestContent();
    const retryKeys: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        retryKeys.push(new Headers(init?.headers).get("x-line-retry-key"));
        return Response.json({}, { status: 500 });
      })
      .mockImplementationOnce(async (_input, init) => {
        retryKeys.push(new Headers(init?.headers).get("x-line-retry-key"));
        return Response.json({}, { status: 200 });
      });

    await expect(runDigest(digestEnv(), slot)).resolves.toMatchObject({ status: "sent" });
    expect(retryKeys).toHaveLength(2);
    expect(new Set(retryKeys).size).toBe(1);
  });

  it("enforces ten daily slots and the configured monthly cap", async () => {
    await seedDigestContent();
    for (let hour = 0; hour < 10; hour += 1) {
      await env.DB.prepare(
        `INSERT INTO digest_deliveries(slot_key,retry_key,period_start,period_end,status,created_at)
         VALUES(?,?,1,2,'sent',?)`,
      )
        .bind(`2026-08-24-${String(hour).padStart(2, "0")}`, crypto.randomUUID(), slot)
        .run();
    }
    await expect(runDigest(digestEnv(), slot)).resolves.toEqual({ status: "daily_cap" });

    await env.DB.prepare("DELETE FROM digest_deliveries").run();
    await env.DB.prepare(
      `INSERT INTO digest_deliveries(slot_key,retry_key,period_start,period_end,status,created_at)
       VALUES('2026-08-03-08',?,1,2,'sent',?)`,
    )
      .bind(crypto.randomUUID(), slot)
      .run();
    await expect(runDigest(digestEnv({ AUTOMATED_MONTHLY_PUSH_CAP: "1" }), slot)).resolves.toEqual({
      status: "monthly_cap",
    });
  });
});
