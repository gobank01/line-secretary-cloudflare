import { isAiEligible } from "../ai/policy";
import { updateGroupTitle } from "../db/repositories";
import { getGroupSummary } from "../line/client";
import type { GroupSummarizerParams } from "../env";
import { localDateTimeParts, runDigest, type DigestEnv } from "./digest";
import { releaseGroupSummaryReservation } from "../workflows/group-summarizer";
import { releaseAiCallSlot, reserveAiCallSlot } from "../ai/openrouter";

interface WorkflowCreator {
  create(options: { id: string; params: GroupSummarizerParams }): Promise<unknown>;
}

export interface CoordinatorEnv extends DigestEnv {
  GROUP_SUMMARIZER: WorkflowCreator;
  AI_DAILY_CALL_CAP: string;
  AI_DAILY_INPUT_TOKEN_CAP: string;
  AI_MIN_MESSAGES: string;
  AI_MAX_WAIT_MINUTES: string;
}

export interface EligibleGroup {
  groupId: string;
  dataMode: "real";
  newMessages: number;
  oldestAgeMinutes: number;
  hasUrgentAlert: boolean;
}

export function isDigestSlot(epochMs: number): boolean {
  const local = localDateTimeParts(epochMs, "Asia/Bangkok");
  return (
    local.minute === 0 &&
    local.hour >= 8 &&
    local.hour <= 17 &&
    local.weekday !== "Sat" &&
    local.weekday !== "Sun"
  );
}

export async function selectEligibleGroups(
  db: D1Database,
  now: number,
  limit: number,
  budgetAvailable: boolean,
  thresholds: { minimumMessages: number; maximumWaitMinutes: number } = {
    minimumMessages: 5,
    maximumWaitMinutes: 120,
  },
  leaseNow = now,
): Promise<EligibleGroup[]> {
  const result = await db
    .prepare(
      `SELECT g.source_id,g.data_mode,count(m.id) AS new_messages,min(m.sent_at) AS oldest_message,
       EXISTS(SELECT 1 FROM alerts a WHERE a.group_id=g.source_id AND a.status!='resolved'
         AND a.severity IN ('high','critical')) AS has_urgent
       FROM groups g JOIN messages m ON m.group_id=g.source_id AND m.processed_at IS NULL
       WHERE g.data_mode='real' AND g.active=1 AND m.sent_at<=?
       AND (g.summary_inflight_until IS NULL OR g.summary_inflight_until<=?)
       GROUP BY g.source_id,g.data_mode
       ORDER BY has_urgent DESC,oldest_message,g.source_id LIMIT 100`,
    )
    .bind(now, leaseNow)
    .all<{
      source_id: string;
      data_mode: "real";
      new_messages: number;
      oldest_message: number;
      has_urgent: number;
    }>();
  return result.results
    .map((row) => ({
      groupId: row.source_id,
      dataMode: row.data_mode,
      newMessages: row.new_messages,
      oldestAgeMinutes: Math.max(0, Math.floor((now - row.oldest_message) / 60_000)),
      hasUrgentAlert: row.has_urgent === 1,
    }))
    .filter((group) => isAiEligible({ ...group, budgetAvailable }, thresholds))
    .slice(0, limit);
}

export async function reserveGroupSummary(
  db: D1Database,
  groupId: string,
  scheduledFor: number,
  acquiredAt: number,
  leaseUntil: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE groups SET summary_inflight_for=?,summary_inflight_until=?
     WHERE source_id=? AND data_mode='real' AND active=1
       AND (summary_inflight_until IS NULL OR summary_inflight_until<=?)
       AND EXISTS(SELECT 1 FROM messages WHERE group_id=? AND processed_at IS NULL AND sent_at<=?)`,
  )
    .bind(scheduledFor, leaseUntil, groupId, acquiredAt, groupId, scheduledFor)
    .run();
  return result.meta.changes === 1;
}

async function runMaintenanceOnce(db: D1Database, scheduledTime: number, timeZone: string): Promise<void> {
  const local = localDateTimeParts(scheduledTime, timeZone);
  const lastDay = await db.prepare("SELECT value_json FROM settings WHERE key='maintenance_last_day'")
    .first<string>("value_json");
  if (lastDay === JSON.stringify(local.day)) return;

  await db.batch([
    db.prepare("DELETE FROM messages WHERE retention_expires_at<?").bind(scheduledTime),
    db.prepare("DELETE FROM reports WHERE created_at<?").bind(scheduledTime - 180 * 86_400_000),
    db
      .prepare("DELETE FROM auth_attempts WHERE window_start<? AND (blocked_until IS NULL OR blocked_until<?)")
      .bind(scheduledTime - 15 * 60_000, scheduledTime),
    db
      .prepare(
        `INSERT INTO settings(key,value_json,updated_at) VALUES('maintenance_last_day',?,?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      )
      .bind(JSON.stringify(local.day), scheduledTime),
  ]);
}

async function refreshFallbackGroupNames(db: D1Database, token: string, now: number): Promise<void> {
  const groups = await db
    .prepare("SELECT source_id FROM groups WHERE data_mode='real' AND title LIKE 'กลุ่ม LINE • %' LIMIT 10")
    .all<{ source_id: string }>();
  for (const group of groups.results) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const summary = await getGroupSummary(group.source_id, token);
        await updateGroupTitle(db, group.source_id, summary.groupName, now);
        break;
      } catch {
        // A later Cron run will retry unresolved fallback titles.
      }
    }
  }
}

async function budgetAvailable(env: CoordinatorEnv, scheduledTime: number): Promise<boolean> {
  const local = localDateTimeParts(scheduledTime, env.APP_TIMEZONE);
  const usage = await env.DB.prepare("SELECT ai_calls,ai_input_tokens FROM usage_daily WHERE day=?")
    .bind(local.day)
    .first<{ ai_calls: number; ai_input_tokens: number }>();
  return (
    (usage?.ai_calls ?? 0) < (Number.parseInt(env.AI_DAILY_CALL_CAP, 10) || 0) &&
    (usage?.ai_input_tokens ?? 0) < (Number.parseInt(env.AI_DAILY_INPUT_TOKEN_CAP, 10) || 0)
  );
}

export async function runScheduled(env: CoordinatorEnv, scheduledTime: number) {
  const reservation = await env.DB.prepare(
    `INSERT INTO job_runs(scheduled_for,status,started_at) VALUES(?,'running',?)
     ON CONFLICT(scheduled_for) DO UPDATE SET status='running',started_at=excluded.started_at,
       completed_at=NULL,error=NULL
     WHERE job_runs.status='failed'`,
  )
    .bind(scheduledTime, Date.now())
    .run();
  if (reservation.meta.changes !== 1) return { status: "duplicate" as const };
  const jobRunId =
    (await env.DB.prepare("SELECT id FROM job_runs WHERE scheduled_for=?").bind(scheduledTime).first<number>("id")) ?? 0;

  try {
    await runMaintenanceOnce(env.DB, scheduledTime, env.APP_TIMEZONE);
    await refreshFallbackGroupNames(env.DB, env.LINE_CHANNEL_ACCESS_TOKEN, scheduledTime);
    const selected = await selectEligibleGroups(
      env.DB,
      scheduledTime,
      10,
      await budgetAvailable(env, scheduledTime),
      {
        minimumMessages: Number.parseInt(env.AI_MIN_MESSAGES, 10) || 5,
        maximumWaitMinutes: Number.parseInt(env.AI_MAX_WAIT_MINUTES, 10) || 120,
      },
      Date.now(),
    );
    const aiDay = localDateTimeParts(scheduledTime, env.APP_TIMEZONE).day;
    const aiCallCap = Number.parseInt(env.AI_DAILY_CALL_CAP, 10) || 0;
    let dispatchedGroups = 0;
    for (const group of selected) {
      const acquiredAt = Date.now();
      const workflowId = `${group.groupId}:${scheduledTime}`;
      const aiReservationId = crypto.randomUUID();
      const reserved = await reserveGroupSummary(
        env.DB,
        group.groupId,
        scheduledTime,
        acquiredAt,
        acquiredAt + 45 * 60_000,
      );
      if (!reserved) continue;
      const callReserved = await reserveAiCallSlot(
        env.DB,
        aiReservationId,
        workflowId,
        aiDay,
        aiCallCap,
        acquiredAt,
      );
      if (!callReserved) {
        await releaseGroupSummaryReservation(env.DB, group.groupId, scheduledTime);
        break;
      }
      try {
        await env.GROUP_SUMMARIZER.create({
          id: workflowId,
          params: {
            groupId: group.groupId,
            scheduledFor: scheduledTime,
            jobRunId,
            aiReservationId,
            aiReservationDay: aiDay,
          },
        });
        dispatchedGroups += 1;
      } catch (error) {
        await Promise.all([
          releaseGroupSummaryReservation(env.DB, group.groupId, scheduledTime),
          releaseAiCallSlot(env.DB, aiReservationId, aiDay, Date.now()),
        ]);
        throw error;
      }
    }

    let digestStatus: string | undefined;
    if (isDigestSlot(scheduledTime)) digestStatus = (await runDigest(env, scheduledTime)).status;
    await env.DB.prepare(
      "UPDATE job_runs SET status='dispatched',groups_selected=?,completed_at=? WHERE id=?",
    )
      .bind(dispatchedGroups, Date.now(), jobRunId)
      .run();
    return {
      status: "dispatched" as const,
      groups: dispatchedGroups,
      ...(digestStatus ? { digestStatus } : {}),
    };
  } catch (error) {
    await env.DB.prepare("UPDATE job_runs SET status='failed',error=?,completed_at=? WHERE id=?")
      .bind(error instanceof Error ? error.name : "UnknownError", Date.now(), jobRunId)
      .run();
    throw error;
  }
}
