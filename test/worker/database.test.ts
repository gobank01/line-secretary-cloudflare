import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { countActiveRealGroups, insertMessage, upsertGroup } from "../../worker/db/repositories";

describe("D1 schema", () => {
  it("starts with the six business categories", async () => {
    const categoryCount = await env.DB.prepare("SELECT count(*) AS count FROM categories").first<number>("count");

    expect(categoryCount).toBe(6);
  });

  it("stores a LINE message only once", async () => {
    const now = Date.UTC(2026, 7, 23, 12, 0, 0);
    await upsertGroup(env.DB, {
      sourceId: "C-real-1",
      title: "กลุ่มจริง 1",
      dataMode: "real",
      active: true,
      now,
    });

    const message = {
      lineMessageId: "m-001",
      groupId: "C-real-1",
      userId: "U-member",
      kind: "text" as const,
      text: "ขอราคาใหม่ครับ",
      sentAt: now,
      ingestedAt: now,
      retentionExpiresAt: now + 30 * 86_400_000,
    };

    const first = await insertMessage(env.DB, message);
    const duplicate = await insertMessage(env.DB, message);
    const stored = await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE line_message_id = ?")
      .bind(message.lineMessageId)
      .first<number>("count");

    expect(first.meta.changes).toBe(1);
    expect(duplicate.meta.changes).toBe(0);
    expect(stored).toBe(1);
    expect(await countActiveRealGroups(env.DB)).toBe(1);
  });
});
