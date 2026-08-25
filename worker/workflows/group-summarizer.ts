import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { releaseAiCallSlot, summarizeGroup } from "../ai/openrouter";
import type { SummaryOutputValue } from "../ai/schema";
import type { AppEnv, GroupSummarizerParams } from "../env";

export interface WorkflowInput {
  groupId: string;
  title: string;
  categorySlugs: string[];
  previousSummary: string | null;
  messages: Array<{ id: number; text: string; sentAt: number }>;
  periodStart: number;
  periodEnd: number;
}

export interface WorkflowResult {
  output: SummaryOutputValue;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface WorkflowStepRunner {
  do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | (() => Promise<T>),
    maybeCallback?: () => Promise<T>,
  ): Promise<T>;
}

const WORKFLOW_INPUT_BYTE_LIMIT = 240 * 1_024;
const textEncoder = new TextEncoder();

export async function loadWorkflowInput(
  db: D1Database,
  groupId: string,
  limit: number,
  includeProcessed = false,
  cutoff = Number.MAX_SAFE_INTEGER,
): Promise<WorkflowInput | null> {
  const group = await db
    .prepare("SELECT title FROM groups WHERE source_id=? AND data_mode='real' AND active=1")
    .bind(groupId)
    .first<{ title: string }>();
  if (!group) return null;

  const [categories, messages, previousReport] = await Promise.all([
    db.prepare("SELECT slug FROM categories WHERE active=1 ORDER BY sort_order,id").all<{ slug: string }>(),
    db
      .prepare(
        `SELECT id,text,sent_at FROM messages WHERE group_id=? AND text IS NOT NULL
         ${includeProcessed ? "" : "AND processed_at IS NULL"}
         AND sent_at<=?
         ORDER BY sent_at,id LIMIT ?`,
      )
      .bind(groupId, cutoff, limit)
      .all<{ id: number; text: string; sent_at: number }>(),
    db
      .prepare("SELECT summary FROM reports WHERE group_id=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .bind(groupId, cutoff)
      .first<{ summary: string }>(),
  ]);
  const categorySlugs = categories.results.map((category) => category.slug);
  const previousSummary = previousReport?.summary ?? null;
  const boundedMessages: WorkflowInput["messages"] = [];
  // Accumulate serialized bytes incrementally instead of re-stringifying the whole
  // candidate per message (O(n) vs O(n^2), which risked the Workers CPU limit).
  // The envelope is sized with MAX_SAFE_INTEGER periods and each message adds one
  // separator byte, so for LINE's positive integer-ms timestamps the estimate only
  // overshoots the real payload; either way ~800KB headroom remains to the 1 MiB step limit.
  let payloadBytes = textEncoder.encode(
    JSON.stringify({
      groupId,
      title: group.title,
      categorySlugs,
      previousSummary,
      messages: [],
      periodStart: Number.MAX_SAFE_INTEGER,
      periodEnd: Number.MAX_SAFE_INTEGER,
    }),
  ).byteLength;
  for (const message of messages.results) {
    const mapped = { id: message.id, text: message.text, sentAt: message.sent_at };
    const messageBytes = textEncoder.encode(JSON.stringify(mapped)).byteLength + 1;
    if (payloadBytes + messageBytes > WORKFLOW_INPUT_BYTE_LIMIT) break;
    payloadBytes += messageBytes;
    boundedMessages.push(mapped);
  }
  if (boundedMessages.length === 0) return null;
  return {
    groupId,
    title: group.title,
    categorySlugs,
    previousSummary,
    messages: boundedMessages,
    periodStart: boundedMessages[0]?.sentAt ?? 0,
    periodEnd: boundedMessages.at(-1)?.sentAt ?? 0,
  };
}

export async function releaseGroupSummaryReservation(
  db: D1Database,
  groupId: string,
  scheduledFor: number,
): Promise<void> {
  await db.prepare(
    `UPDATE groups SET summary_inflight_for=NULL,summary_inflight_until=NULL
     WHERE source_id=? AND summary_inflight_for=?`,
  )
    .bind(groupId, scheduledFor)
    .run();
}

export async function persistWorkflowResult(
  db: D1Database,
  input: WorkflowInput,
  result: WorkflowResult,
  now: number,
  jobRunId?: number,
  scheduledFor = now,
): Promise<{ created: boolean }> {
  const existing = await db
    .prepare("SELECT id FROM reports WHERE group_id=? AND period_start=? AND period_end=?")
    .bind(input.groupId, input.periodStart, input.periodEnd)
    .first<number>("id");
  if (existing !== null) {
    await releaseGroupSummaryReservation(db, input.groupId, scheduledFor);
    return { created: false };
  }

  const placeholders = input.messages.map(() => "?").join(",");
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO reports(group_id,period_start,period_end,summary,action_items_json,unresolved_json,
         priority_score,model,prompt_version,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,period_start,period_end) DO NOTHING`,
      )
      .bind(
        input.groupId,
        input.periodStart,
        input.periodEnd,
        result.output.summary,
        JSON.stringify(result.output.actionItems),
        JSON.stringify(result.output.unresolvedQuestions),
        result.output.priorityScore,
        result.model,
        "summary-v1",
        now,
      ),
    db
      .prepare(
        `UPDATE groups SET priority_score=?,last_summary_at=?,
         category_id=CASE WHEN category_locked=0 THEN COALESCE(
           (SELECT id FROM categories WHERE slug=? AND active=1),category_id
         ) ELSE category_id END,
         category_source=CASE WHEN category_locked=0 AND EXISTS(
           SELECT 1 FROM categories WHERE slug=? AND active=1
         ) THEN 'ai' ELSE category_source END,
         category_confidence=CASE WHEN category_locked=0 THEN ? ELSE category_confidence END,
         needs_category_review=CASE WHEN category_locked=0 THEN ? ELSE needs_category_review END,
         summary_inflight_for=CASE WHEN summary_inflight_for=? THEN NULL ELSE summary_inflight_for END,
         summary_inflight_until=CASE WHEN summary_inflight_for=? THEN NULL ELSE summary_inflight_until END,
         updated_at=? WHERE source_id=?`,
      )
      .bind(
        result.output.priorityScore,
        now,
        result.output.suggestedCategorySlug,
        result.output.suggestedCategorySlug,
        result.output.categoryConfidence,
        result.output.categoryConfidence < 0.75 ? 1 : 0,
        scheduledFor,
        scheduledFor,
        now,
        input.groupId,
      ),
    db
      .prepare(`UPDATE messages SET processed_at=? WHERE group_id=? AND id IN (${placeholders})`)
      .bind(now, input.groupId, ...input.messages.map((message) => message.id)),
    db
      .prepare(
        `INSERT INTO audit_log(actor,action,entity_type,entity_id,before_json,after_json,created_at)
         VALUES('ai','group.summary_created','group',?,NULL,?,?)`,
      )
      .bind(
        input.groupId,
        JSON.stringify({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          priorityScore: result.output.priorityScore,
          suggestedCategorySlug: result.output.suggestedCategorySlug,
          categoryConfidence: result.output.categoryConfidence,
        }),
        now,
      ),
  ];
  if (jobRunId !== undefined) {
    statements.push(
      db.prepare("UPDATE job_runs SET groups_completed=groups_completed+1 WHERE id=?").bind(jobRunId),
    );
  }
  await db.batch(statements);
  return { created: true };
}

export async function runGroupSummarizerSteps(
  env: AppEnv,
  payload: GroupSummarizerParams,
  step: WorkflowStepRunner,
  now = Date.now(),
): Promise<{ status: "complete" | "empty" }> {
  const input = await step.do("load bounded group input", async () =>
    loadWorkflowInput(env.DB, payload.groupId, 200, false, payload.scheduledFor),
  );
  if (!input) {
    await step.do("release unused AI reservation", async () =>
      releaseAiCallSlot(env.DB, payload.aiReservationId, payload.aiReservationDay, now),
    );
    return { status: "empty" };
  }

  const result = await step.do(
    "summarize with openrouter",
    { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
    async () => summarizeGroup(env, input, now, {
      id: payload.aiReservationId,
      day: payload.aiReservationDay,
    }),
  );
  await step.do(
    "persist report and checkpoint",
    { retries: { limit: 3, delay: "5 seconds", backoff: "linear" } },
    async () => persistWorkflowResult(env.DB, input, result, now, payload.jobRunId, payload.scheduledFor),
  );
  return { status: "complete" };
}

export class GroupSummarizer extends WorkflowEntrypoint<AppEnv, GroupSummarizerParams> {
  async run(event: Readonly<WorkflowEvent<GroupSummarizerParams>>, step: WorkflowStep): Promise<unknown> {
    return runGroupSummarizerSteps(this.env, event.payload, step as unknown as WorkflowStepRunner);
  }
}
