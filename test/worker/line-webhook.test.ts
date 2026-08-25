import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { registerRealGroup } from "../../worker/db/repositories";
import { verifyLineSignature } from "../../worker/line/signature";

const encoder = new TextEncoder();
const now = Date.UTC(2026, 7, 23, 12, 0, 0);

async function signatureFor(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.LINE_CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)));
  return btoa(String.fromCharCode(...digest));
}

function lineEvent(
  event: Record<string, unknown>,
  groupId = "C-new-group",
): Record<string, unknown> {
  return {
    webhookEventId: `evt-${groupId}-${String(event.type)}`,
    timestamp: now,
    source: { type: "group", groupId, userId: "U-member" },
    deliveryContext: { isRedelivery: false },
    ...event,
  };
}

async function postWebhook(
  events: Record<string, unknown>[],
  options: { signed?: boolean } = { signed: true },
): Promise<Response> {
  const raw = JSON.stringify({ destination: "U-bot", events });
  const headers = new Headers({ "content-type": "application/json" });
  if (options.signed !== false) headers.set("x-line-signature", await signatureFor(raw));

  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("http://example.com/api/line", { method: "POST", headers, body: raw }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function scalar(sql: string, ...bindings: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...bindings).first<number>("count")) ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alerts"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM groups"),
  ]);
  vi.restoreAllMocks();
});

describe("LINE signature verification", () => {
  it("accepts only the HMAC of the exact raw body", async () => {
    const raw = '{"events":[]}';
    const signature = await signatureFor(raw);

    await expect(verifyLineSignature(raw, signature, env.LINE_CHANNEL_SECRET)).resolves.toBe(true);
    await expect(verifyLineSignature(`${raw} `, signature, env.LINE_CHANNEL_SECRET)).resolves.toBe(false);
    await expect(verifyLineSignature(raw, "not-base64", env.LINE_CHANNEL_SECRET)).resolves.toBe(false);
  });

  it("rejects an unsigned request before parsing JSON", async () => {
    const response = await worker.fetch(
      new Request("http://example.com/api/line", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
  });
});

describe("silent LINE ingestion", () => {
  it("deduplicates text events, raises keyword alerts, and never replies", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    const event = lineEvent({
      type: "message",
      replyToken: "reply-text",
      message: { id: "m-urgent", type: "text", text: "ด่วน ขอคืนเงินครับ" },
    });

    expect((await postWebhook([event])).status).toBe(200);
    expect((await postWebhook([event])).status).toBe(200);

    expect(await scalar("SELECT count(*) AS count FROM messages WHERE line_message_id = ?", "m-urgent")).toBe(1);
    expect(
      await scalar(
        `SELECT count(*) AS count
         FROM alerts a JOIN messages m ON m.id = a.message_id
         WHERE a.kind = 'keyword' AND m.line_message_id = ?`,
        "m-urgent",
      ),
    ).toBe(1);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("stays fully silent on join, then marks leave inactive", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      calls.push(new URL(request.url).pathname);
      if (request.method === "GET") return Response.json({ groupName: "ลูกค้าทดสอบ" });
      return Response.json({ sentMessages: [{ id: "sent-1", quoteToken: "quote-1" }] });
    });

    const join = lineEvent({ type: "join", replyToken: "reply-join" }, "C-lifecycle");
    expect((await postWebhook([join])).status).toBe(200);
    expect(calls.filter((path) => path.endsWith("/reply"))).toHaveLength(0);

    calls.length = 0;
    expect((await postWebhook([join])).status).toBe(200);
    expect(calls.filter((path) => path.endsWith("/reply"))).toHaveLength(0);

    expect((await postWebhook([lineEvent({ type: "leave" }, "C-lifecycle")])).status).toBe(200);
    const active = await env.DB.prepare("SELECT active FROM groups WHERE source_id = ?")
      .bind("C-lifecycle")
      .first<number>("active");
    expect(active).toBe(0);
  });

  it("keeps an eleventh real group inactive and does not retain its text", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at)
         VALUES(?,?,'real',1,?,?)`,
      ).bind(`C-active-${index}`, `กลุ่ม ${index}`, now, now),
    );
    await env.DB.batch(rows);

    const event = lineEvent(
      {
        type: "message",
        replyToken: "reply-over-limit",
        message: { id: "m-over-limit", type: "text", text: "ข้อความที่ต้องไม่เก็บ" },
      },
      "C-eleventh",
    );
    expect((await postWebhook([event])).status).toBe(200);

    const group = await env.DB.prepare("SELECT active FROM groups WHERE source_id = ?")
      .bind("C-eleventh")
      .first<{ active: number }>();
    expect(group?.active).toBe(0);
    expect(await scalar("SELECT count(*) AS count FROM messages WHERE group_id = ?", "C-eleventh")).toBe(0);
    expect(
      await scalar(
        "SELECT count(*) AS count FROM alerts WHERE group_id = ? AND kind = 'real_group_limit'",
        "C-eleventh",
      ),
    ).toBe(1);
  });

  it("atomically activates no more than ten concurrently registered real groups", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => registerRealGroup(env.DB, `C-race-${index}`, now + index, 10)),
    );

    expect(await scalar("SELECT count(*) AS count FROM groups WHERE data_mode='real' AND active=1")).toBe(10);
  });

  it("discloses collection on join even when the real-group limit pauses the group", async () => {
    await env.DB.batch(
      Array.from({ length: 10 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at)
           VALUES(?,?,'real',1,?,?)`,
        ).bind(`C-full-${index}`, `กลุ่มเต็ม ${index}`, now, now),
      ),
    );
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      calls.push(new URL(request.url).pathname);
      if (request.method === "GET") return Response.json({ groupName: "กลุ่มรอเปิด" });
      return Response.json({ sentMessages: [{ id: "sent-limit", quoteToken: "quote-limit" }] });
    });

    expect((await postWebhook([lineEvent({ type: "join", replyToken: "reply-limit" }, "C-paused-join")])).status)
      .toBe(200);

    expect(calls.filter((path) => path.endsWith("/reply"))).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT active FROM groups WHERE source_id='C-paused-join'")
        .first<{ active: number }>(),
    ).toMatchObject({ active: 0 });
  });

  it("reactivates a kicked group on re-invite and keeps ingesting", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json({ groupName: "กลุ่มกลับมา" });
      return Response.json({});
    });
    const groupId = "C-rejoin";
    expect((await postWebhook([lineEvent({ type: "join", replyToken: "r1" }, groupId)])).status).toBe(200);
    expect((await postWebhook([lineEvent({ type: "leave" }, groupId)])).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT active FROM groups WHERE source_id=?").bind(groupId).first<number>("active"),
    ).toBe(0);

    expect((await postWebhook([lineEvent({ type: "join", replyToken: "r2" }, groupId)])).status).toBe(200);
    const row = await env.DB.prepare("SELECT active,left_at FROM groups WHERE source_id=?")
      .bind(groupId)
      .first<{ active: number; left_at: number | null }>();
    expect(row).toMatchObject({ active: 1, left_at: null });

    expect(
      (
        await postWebhook([
          lineEvent({ type: "message", message: { type: "text", id: "m-rejoin", text: "กลับมาแล้ว" } }, groupId),
        ])
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE group_id=?").bind(groupId).first("count"),
    ).toBe(1);
  });

  it("never replies even for concurrent join deliveries", async () => {
    let replyCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json({ groupName: "กลุ่มพร้อมกัน" });
      replyCalls += 1;
      await Promise.resolve();
      return Response.json({ sentMessages: [{ id: "sent-once", quoteToken: "quote-once" }] });
    });

    await Promise.all([
      postWebhook([lineEvent({ type: "join", replyToken: "reply-race-a" }, "C-disclosure-race")]),
      postWebhook([lineEvent({ type: "join", replyToken: "reply-race-b" }, "C-disclosure-race")]),
    ]);

    expect(replyCalls).toBe(0);
  });

  it("hashes group identifiers in lifecycle failure logs", async () => {
    const groupId = "C-private-group-id-must-not-be-logged";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") throw new Error("LINE unavailable");
      return Response.json({ sentMessages: [{ id: "sent-private", quoteToken: "quote-private" }] });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await postWebhook([lineEvent({ type: "join", replyToken: "reply-private" }, groupId)])).status).toBe(200);

    expect(warning).toHaveBeenCalledWith(
      "line_group_name_lookup_failed",
      expect.objectContaining({ groupHash: expect.stringMatching(/^[0-9a-f]{12}$/u) }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(groupId);
  });
});
