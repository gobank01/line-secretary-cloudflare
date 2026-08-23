import { estimateInputTokens } from "./policy";
import { buildSummarySystemPrompt, SummaryOutput, type SummaryOutputValue } from "./schema";

export interface WorkflowMessageInput {
  id: number;
  text: string;
  sentAt: number;
}

export interface GroupSummaryInput {
  groupId: string;
  title: string;
  categorySlugs: string[];
  previousSummary: string | null;
  messages: WorkflowMessageInput[];
}

interface SummarizeEnv {
  DB: D1Database;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  DASHBOARD_URL: string;
  APP_TIMEZONE: string;
  AI_DAILY_CALL_CAP: string;
  AI_DAILY_INPUT_TOKEN_CAP: string;
}

interface OpenRouterPayload {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export class AiBudgetExceededError extends Error {
  constructor() {
    super("Daily AI budget is exhausted");
    this.name = "AiBudgetExceededError";
  }
}

export interface AiCallReservation {
  id: string;
  day: string;
}

function localDay(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export async function reserveAiBudget(
  db: D1Database,
  day: string,
  estimatedInputTokens: number,
  callCap: number,
  inputTokenCap: number,
  now: number,
): Promise<boolean> {
  if (callCap < 1 || estimatedInputTokens < 1 || estimatedInputTokens > inputTokenCap) return false;
  const result = await db
    .prepare(
      `INSERT INTO usage_daily(day,ai_calls,ai_input_tokens,ai_output_tokens,line_pushes,updated_at)
       VALUES(?,1,?,0,0,?)
       ON CONFLICT(day) DO UPDATE SET
         ai_calls=usage_daily.ai_calls+1,
         ai_input_tokens=usage_daily.ai_input_tokens+excluded.ai_input_tokens,
         updated_at=excluded.updated_at
       WHERE usage_daily.ai_calls<? AND usage_daily.ai_input_tokens+excluded.ai_input_tokens<=?`,
    )
    .bind(day, estimatedInputTokens, now, callCap, inputTokenCap)
    .run();
  return result.meta.changes > 0;
}

export async function reserveAiCallSlot(
  db: D1Database,
  reservationId: string,
  workflowId: string,
  day: string,
  callCap: number,
  now: number,
): Promise<boolean> {
  if (callCap < 1) return false;
  const result = await db.prepare(
    `INSERT INTO ai_call_reservations(id,workflow_id,day,status,created_at)
     SELECT ?,?,?,'reserved',?
     WHERE COALESCE((SELECT ai_calls FROM usage_daily WHERE day=?),0)<?
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(reservationId, workflowId, day, now, day, callCap)
    .run();
  return result.meta.changes > 0;
}

export async function releaseAiCallSlot(
  db: D1Database,
  reservationId: string,
  day: string,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE ai_call_reservations SET status='released',released_at=?
     WHERE id=? AND day=? AND status='reserved'`,
  )
    .bind(now, reservationId, day)
    .run();
}

async function beginAiCallAttempt(
  db: D1Database,
  reservation: AiCallReservation,
  estimatedInputTokens: number,
  callCap: number,
  inputTokenCap: number,
  now: number,
): Promise<boolean> {
  if (callCap < 1 || estimatedInputTokens < 1 || estimatedInputTokens > inputTokenCap) return false;
  const result = await db.prepare(
    `UPDATE ai_call_reservations
     SET status='consumed',estimated_input_tokens=?,attempt_count=attempt_count+1,consumed_at=?
     WHERE id=? AND day=? AND status IN ('reserved','consumed')
       AND COALESCE((SELECT ai_input_tokens FROM usage_daily WHERE day=?),0)+?<=?
       AND (attempt_count=0 OR COALESCE((SELECT ai_calls FROM usage_daily WHERE day=?),0)<?)`,
  )
    .bind(
      estimatedInputTokens,
      now,
      reservation.id,
      reservation.day,
      reservation.day,
      estimatedInputTokens,
      inputTokenCap,
      reservation.day,
      callCap,
    )
    .run();
  return result.meta.changes > 0;
}

async function reconcileAiUsage(
  db: D1Database,
  day: string,
  reservedInputTokens: number,
  promptTokens: number,
  completionTokens: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE usage_daily SET
       ai_input_tokens=max(0,ai_input_tokens-?+?),
       ai_output_tokens=ai_output_tokens+?,updated_at=? WHERE day=?`,
    )
    .bind(reservedInputTokens, promptTokens, completionTokens, now, day)
    .run();
}

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "actionItems",
    "unresolvedQuestions",
    "priorityScore",
    "suggestedCategorySlug",
    "categoryConfidence",
  ],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 3000 },
    actionItems: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
    unresolvedQuestions: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    priorityScore: { type: "integer", minimum: 0, maximum: 100 },
    suggestedCategorySlug: { type: "string", minLength: 1, maxLength: 40 },
    categoryConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export async function summarizeGroup(
  env: SummarizeEnv,
  input: GroupSummaryInput,
  now = Date.now(),
  callReservation?: AiCallReservation,
): Promise<{ output: SummaryOutputValue; promptTokens: number; completionTokens: number; model: string }> {
  const systemPrompt = buildSummarySystemPrompt(input.categorySlugs);
  const userPayload = JSON.stringify({
    group: { id: input.groupId, title: input.title },
    previousSummary: input.previousSummary,
    messages: input.messages.map((message) => ({ sentAt: message.sentAt, text: message.text })),
  });
  const requestBody = {
    model: env.OPENROUTER_MODEL,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPayload },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "group_summary", strict: true, schema: OUTPUT_JSON_SCHEMA },
    },
  };
  const serializedRequest = JSON.stringify(requestBody);
  const estimatedInputTokens = estimateInputTokens(serializedRequest) + 512;
  const day = callReservation?.day ?? localDay(now, env.APP_TIMEZONE);
  const inputTokenCap = Number.parseInt(env.AI_DAILY_INPUT_TOKEN_CAP, 10) || 0;
  const callCap = Number.parseInt(env.AI_DAILY_CALL_CAP, 10) || 0;
  const reserved = callReservation
    ? await beginAiCallAttempt(env.DB, callReservation, estimatedInputTokens, callCap, inputTokenCap, now)
    : await reserveAiBudget(
      env.DB,
      day,
      estimatedInputTokens,
      callCap,
      inputTokenCap,
      now,
    );
  if (!reserved) {
    if (callReservation) await releaseAiCallSlot(env.DB, callReservation.id, callReservation.day, now);
    throw new AiBudgetExceededError();
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": env.DASHBOARD_URL,
      "x-title": "LINE Secretary Cloudflare",
    },
    body: serializedRequest,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`OpenRouter request failed with ${response.status}`);

  const payload = (await response.json()) as OpenRouterPayload;
  const promptTokens =
    typeof payload.usage?.prompt_tokens === "number" ? Math.max(0, Math.floor(payload.usage.prompt_tokens)) : estimatedInputTokens;
  const completionTokens =
    typeof payload.usage?.completion_tokens === "number" ? Math.max(0, Math.floor(payload.usage.completion_tokens)) : 0;
  await reconcileAiUsage(env.DB, day, estimatedInputTokens, promptTokens, completionTokens, now);

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter response did not include JSON content");
  const output = SummaryOutput.parse(JSON.parse(content));
  if (!input.categorySlugs.includes(output.suggestedCategorySlug)) {
    throw new Error("OpenRouter returned an unsupported category");
  }
  return { output, promptTokens, completionTokens, model: env.OPENROUTER_MODEL };
}
