import { Hono } from "hono";
import {
  getAlertWords,
  insertKeywordAlert,
  insertMessage,
  markGroupLeft,
  recordGroupJoin,
  registerRealGroup,
  updateGroupLastMessage,
  updateGroupTitle,
} from "../db/repositories";
import type { AppEnv } from "../env";
import { getGroupSummary } from "../line/client";
import { InvalidLinePayloadError, parseLineEvents, type LineGroupEvent } from "../line/events";
import { verifyLineSignature } from "../line/signature";

const RETENTION_MS = 30 * 86_400_000;
const encoder = new TextEncoder();

async function shortGroupHash(groupId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(groupId)));
  return [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function refreshGroupName(db: D1Database, groupId: string, token: string, now: number): Promise<void> {
  try {
    const summary = await getGroupSummary(groupId, token);
    await updateGroupTitle(db, groupId, summary.groupName, now);
  } catch (error) {
    console.warn("line_group_name_lookup_failed", {
      groupHash: await shortGroupHash(groupId),
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function handleEvent(
  event: LineGroupEvent,
  env: AppEnv,
  executionContext: { waitUntil(promise: Promise<unknown>): void },
  loweredAlertWords: string[],
): Promise<void> {
  if (event.type === "leave") {
    await markGroupLeft(env.DB, event.groupId, event.timestamp);
    return;
  }

  const group = await registerRealGroup(
    env.DB,
    event.groupId,
    event.timestamp,
    Number.parseInt(env.REAL_GROUP_LIMIT, 10) || 10,
  );

  if (event.type === "join") {
    // The bot is fully silent — it never speaks in groups, not even on join.
    // The owner sees everything on the dashboard instead.
    await recordGroupJoin(env.DB, event.groupId, event.timestamp);
    if (group.created) {
      executionContext.waitUntil(
        refreshGroupName(env.DB, event.groupId, env.LINE_CHANNEL_ACCESS_TOKEN, event.timestamp),
      );
    }
    return;
  }

  if (!group.active) return;

  const insertion = await insertMessage(env.DB, {
    lineMessageId: event.messageId,
    groupId: event.groupId,
    userId: event.userId,
    kind: "text",
    text: event.text,
    sentAt: event.timestamp,
    ingestedAt: Date.now(),
    retentionExpiresAt: event.timestamp + RETENTION_MS,
  });
  if (insertion.meta.changes !== 1) return;

  await updateGroupLastMessage(env.DB, event.groupId, event.timestamp);
  const loweredText = event.text.toLocaleLowerCase("th");
  if (loweredAlertWords.some((word) => loweredText.includes(word))) {
    await insertKeywordAlert(env.DB, event.messageId, event.groupId, event.text.slice(0, 240), Date.now());
  }
}

export const lineRoutes = new Hono<{ Bindings: AppEnv }>();

lineRoutes.post("/", async (context) => {
  const raw = await context.req.text();
  const signature = context.req.header("x-line-signature") ?? "";
  if (!(await verifyLineSignature(raw, signature, context.env.LINE_CHANNEL_SECRET))) {
    return context.json({ error: "invalid_signature" }, 401);
  }

  let events: LineGroupEvent[];
  try {
    events = parseLineEvents(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidLinePayloadError) {
      return context.json({ error: "invalid_payload" }, 400);
    }
    throw error;
  }

  // Alert words change rarely; load them once per webhook batch instead of per message.
  const loweredAlertWords = events.some((event) => event.type === "text")
    ? (await getAlertWords(context.env.DB)).map((word) => word.toLocaleLowerCase("th"))
    : [];
  for (const event of events) {
    await handleEvent(event, context.env, context.executionCtx, loweredAlertWords);
  }
  return context.json({ ok: true });
});
