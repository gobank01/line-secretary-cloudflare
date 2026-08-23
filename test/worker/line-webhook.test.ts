import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
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

  it("sends the lifecycle disclosure only once, then marks leave inactive", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = new Request(input);
      calls.push(new URL(request.url).pathname);
      if (request.method === "GET") return Response.json({ groupName: "ลูกค้าทดสอบ" });
      return Response.json({ sentMessages: [{ id: "sent-1", quoteToken: "quote-1" }] });
    });

    const join = lineEvent({ type: "join", replyToken: "reply-join" }, "C-lifecycle");
    expect((await postWebhook([join])).status).toBe(200);
    expect(calls.filter((path) => path.endsWith("/reply"))).toHaveLength(1);

    calls.length = 0;
    expect((await postWebhook([join])).status).toBe(200);
    expect(calls).toHaveLength(0);

    const disclosureSentAt = await env.DB.prepare(
      "SELECT disclosure_sent_at FROM groups WHERE source_id = ?",
    )
      .bind("C-lifecycle")
      .first<number>("disclosure_sent_at");
    expect(disclosureSentAt).toBeTypeOf("number");

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
});
