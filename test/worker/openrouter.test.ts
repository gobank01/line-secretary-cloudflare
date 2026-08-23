import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reserveAiBudget, summarizeGroup } from "../../worker/ai/openrouter";

const day = "2026-08-23";
const input = {
  groupId: "C-ai",
  title: "กลุ่มลูกค้า",
  categorySlugs: ["customer", "team"],
  messages: [
    { id: 1, text: "ลูกค้าขอใบเสนอราคา", sentAt: 1 },
    { id: 2, text: "ทีมจะส่งให้วันนี้", sentAt: 2 },
  ],
};

const aiEnv = () => ({
  DB: env.DB,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: env.OPENROUTER_MODEL,
  DASHBOARD_URL: env.DASHBOARD_URL,
  APP_TIMEZONE: env.APP_TIMEZONE,
  AI_DAILY_CALL_CAP: env.AI_DAILY_CALL_CAP,
  AI_DAILY_INPUT_TOKEN_CAP: env.AI_DAILY_INPUT_TOKEN_CAP,
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM usage_daily").run();
  vi.restoreAllMocks();
});

describe("OpenRouter budget and structured output", () => {
  it("atomically refuses a second reservation once the daily call cap is reached", async () => {
    await expect(reserveAiBudget(env.DB, day, 10, 1, 100, 1)).resolves.toBe(true);
    await expect(reserveAiBudget(env.DB, day, 10, 1, 100, 2)).resolves.toBe(false);
    await expect(reserveAiBudget(env.DB, "2026-08-24", 101, 10, 100, 2)).resolves.toBe(false);
  });

  it("validates JSON output and reconciles actual token usage", async () => {
    let sentBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "ลูกค้ารอใบเสนอราคา",
                actionItems: ["ส่งใบเสนอราคาวันนี้"],
                unresolvedQuestions: [],
                priorityScore: 72,
                suggestedCategorySlug: "customer",
                categoryConfidence: 0.94,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 123, completion_tokens: 18 },
      });
    });

    const result = await summarizeGroup(aiEnv(), input, Date.UTC(2026, 7, 23, 12));
    expect(result.output).toMatchObject({ priorityScore: 72, suggestedCategorySlug: "customer" });
    expect(sentBody).toMatchObject({
      model: env.OPENROUTER_MODEL,
      response_format: { type: "json_schema" },
    });

    const usage = await env.DB.prepare(
      "SELECT ai_calls,ai_input_tokens,ai_output_tokens FROM usage_daily WHERE day=?",
    )
      .bind(day)
      .first<{ ai_calls: number; ai_input_tokens: number; ai_output_tokens: number }>();
    expect(usage).toEqual({ ai_calls: 1, ai_input_tokens: 123, ai_output_tokens: 18 });
  });

  it("rejects malformed or out-of-bound model output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { content: '{"summary":"x","priorityScore":999}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );

    await expect(summarizeGroup(aiEnv(), input, Date.UTC(2026, 7, 23, 12))).rejects.toThrow();
  });
});
