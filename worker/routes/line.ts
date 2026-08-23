import { Hono } from "hono";
import {
  getAlertWords,
  claimDisclosure,
  insertKeywordAlert,
  insertMessage,
  markDisclosureSent,
  markGroupLeft,
  recordGroupJoin,
  registerRealGroup,
  releaseDisclosureClaim,
  updateGroupLastMessage,
  updateGroupTitle,
} from "../db/repositories";
import type { AppEnv } from "../env";
import { getGroupSummary, replyDisclosure } from "../line/client";
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
    await recordGroupJoin(env.DB, event.groupId, event.timestamp);
    if (group.created) {
      executionContext.waitUntil(
        refreshGroupName(env.DB, event.groupId, env.LINE_CHANNEL_ACCESS_TOKEN, event.timestamp),
      );
    }
    const disclosureClaimedAt = Date.now();
    if (group.disclosureSentAt === null && await claimDisclosure(env.DB, event.groupId, disclosureClaimedAt)) {
      try {
        const reply = await replyDisclosure(event.replyToken, env.LINE_CHANNEL_ACCESS_TOKEN);
        if (reply.ok) await markDisclosureSent(env.DB, event.groupId, Date.now());
        else await releaseDisclosureClaim(env.DB, event.groupId, disclosureClaimedAt);
      } catch (error) {
        await releaseDisclosureClaim(env.DB, event.groupId, disclosureClaimedAt);
        throw error;
      }
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
  const alertWords = await getAlertWords(env.DB);
  if (alertWords.some((word) => event.text.toLocaleLowerCase("th").includes(word.toLocaleLowerCase("th")))) {
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

  for (const event of events) {
    await handleEvent(event, context.env, context.executionCtx);
  }
  return context.json({ ok: true });
});
