import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../../worker/auth/session";
import worker from "../../worker/index";

const origin = "http://example.com";
let cookie = "";
let customerCategoryId = 0;
let teamCategoryId = 0;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.method && init.method !== "GET") headers.set("origin", origin);
  if (init.body) headers.set("content-type", "application/json");
  return worker.fetch(
    new Request(`${origin}${path}`, { ...init, headers }),
    env,
    createExecutionContext(),
  );
}

beforeAll(async () => {
  cookie = `owner_session=${await createSession(env.SESSION_SECRET, Date.now())}`;
  customerCategoryId =
    (await env.DB.prepare("SELECT id FROM categories WHERE slug='customer'").first<number>("id")) ?? 0;
  teamCategoryId = (await env.DB.prepare("SELECT id FROM categories WHERE slug='team'").first<number>("id")) ?? 0;
  await env.DB.prepare(
    `INSERT INTO groups(source_id,title,data_mode,active,category_id,category_source,category_locked,created_at,updated_at)
     VALUES('C-control','กลุ่มควบคุม','real',1,?,'ai',0,1,1)`,
  )
    .bind(teamCategoryId)
    .run();
  await env.DB.prepare(
    `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
     VALUES('m-control','C-control','text','ข้อความที่จะลบ',1,1,9999999999999)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO reports(group_id,period_start,period_end,summary,priority_score,model,prompt_version,created_at)
     VALUES('C-control',1,2,'รายงานที่ต้องเก็บ',70,'test','v1',2)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO alerts(group_id,kind,severity,status,excerpt,created_at)
     VALUES('C-control','test','high','open','แจ้งเตือนที่ต้องเก็บ',2)`,
  ).run();
});

describe("owner controls", () => {
  it("assigns and locks a category with an owner audit entry", async () => {
    const response = await api("/api/groups/C-control/category", {
      method: "PATCH",
      body: JSON.stringify({ categoryId: customerCategoryId, locked: true }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      categoryId: customerCategoryId,
      categoryLocked: true,
      categorySource: "manual",
    });

    await env.DB.prepare(
      "UPDATE groups SET category_id=? WHERE source_id='C-control' AND category_locked=0",
    )
      .bind(teamCategoryId)
      .run();
    const stored = await env.DB.prepare("SELECT category_id,category_locked FROM groups WHERE source_id='C-control'")
      .first<{ category_id: number; category_locked: number }>();
    expect(stored).toEqual({ category_id: customerCategoryId, category_locked: 1 });

    const audit = await (
      await api("/api/audit-log?entity_type=group&entity_id=C-control&limit=50")
    ).json<{ entries: Array<{ actor: string; action: string }> }>();
    expect(audit.entries.map((entry) => entry.actor)).toContain("owner");
    expect(audit.entries.map((entry) => entry.action)).toContain("group.category_changed");
  });

  it("pauses a group and deletes only its raw history", async () => {
    const paused = await api("/api/groups/C-control/status", {
      method: "PATCH",
      body: JSON.stringify({ active: false }),
    });
    await expect(paused.json()).resolves.toMatchObject({ active: false });

    const deleted = await api("/api/groups/C-control/raw-history", { method: "DELETE" });
    await expect(deleted.json()).resolves.toEqual({ deletedMessages: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE group_id='C-control'").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM reports WHERE group_id='C-control'").first("count")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM alerts WHERE group_id='C-control'").first("count")).toBe(1);
  });

  it("resolves an alert and records its timestamp", async () => {
    const alertId = await env.DB.prepare("SELECT id FROM alerts WHERE group_id='C-control'").first<number>("id");
    const response = await api(`/api/alerts/${alertId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "resolved" });
    const resolvedAt = await env.DB.prepare("SELECT resolved_at FROM alerts WHERE id=?")
      .bind(alertId)
      .first<number>("resolved_at");
    expect(resolvedAt).toBeTypeOf("number");
  });

  it("creates, renames, and soft-deletes a validated category without changing its slug", async () => {
    const created = await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({ slug: "vip-customer", name: "ลูกค้า VIP", color: "#2563eb" }),
    });
    expect(created.status).toBe(201);
    const category = await created.json<{ id: number; slug: string }>();
    expect(category.slug).toBe("vip-customer");

    const invalidSlug = await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({ slug: "VIP ลูกค้า", name: "ผิด", color: "#000000" }),
    });
    expect(invalidSlug.status).toBe(400);

    const updated = await api(`/api/categories/${category.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "ลูกค้าคนสำคัญ", active: false }),
    });
    await expect(updated.json()).resolves.toMatchObject({
      slug: "vip-customer",
      name: "ลูกค้าคนสำคัญ",
      active: false,
    });
    expect(
      (
        await api(`/api/categories/${category.id}`, {
          method: "PATCH",
          body: JSON.stringify({ slug: "changed-slug" }),
        })
      ).status,
    ).toBe(400);
  });

  it("requires a matching Origin for every mutation", async () => {
    const response = await worker.fetch(
      new Request(`${origin}/api/groups/C-control/status`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify({ active: true }),
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(403);
  });
});
