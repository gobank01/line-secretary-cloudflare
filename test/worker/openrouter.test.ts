import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reserveAiBudget, reserveAiCallSlot, summarizeGroup } from "../../worker/ai/openrouter";
import { estimateInputTokens } from "../../worker/ai/policy";

const day = "2026-08-23";
const input = {
  groupId: "C-ai",
  title: "กลุ่มลูกค้า",
  categorySlugs: ["customer", "team"],
  previousSummary: "รอบก่อนลูกค้าขอข้อมูลเพิ่มเติม",
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
  await env.DB.prepare("DELETE FROM ai_call_reservations").run();
  await env.DB.prepare("DELETE FROM usage_daily").run();
  vi.restoreAllMocks();
});

describe("OpenRouter budget and structured output", () => {
  it("atomically refuses a second reservation once the daily call cap is reached", async () => {
    await expect(reserveAiBudget(env.DB, day, 10, 1, 100, 1)).resolves.toBe(true);
    await expect(reserveAiBudget(env.DB, day, 10, 1, 100, 2)).resolves.toBe(false);
    await expect(reserveAiBudget(env.DB, "2026-08-24", 101, 10, 100, 2)).resolves.toBe(false);
  });

  it("reserves the full request conservatively and records actual overage without hiding it", async () => {
    expect(estimateInputTokens("ภาษาไทย")).toBeGreaterThan("ภาษาไทย".length / 4);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{
          message: { content: JSON.stringify({
            summary: "สรุป",
            actionItems: [],
            unresolvedQuestions: [],
            priorityScore: 10,
            suggestedCategorySlug: "customer",
            categoryConfidence: 0.9,
          }) },
        }],
        usage: { prompt_tokens: 12_000, completion_tokens: 1 },
      }),
    );

    const cappedEnv = { ...aiEnv(), AI_DAILY_INPUT_TOKEN_CAP: "10000" };
    await summarizeGroup(cappedEnv, input, Date.UTC(2026, 7, 23, 12));

    expect(await env.DB.prepare("SELECT ai_input_tokens FROM usage_daily WHERE day=?").bind(day).first("ai_input_tokens"))
      .toBe(12_000);
    await expect(summarizeGroup(cappedEnv, input, Date.UTC(2026, 7, 23, 12))).rejects.toThrow("budget");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("validates JSON output and reconciles actual token usage", async () => {
    let sentBody: Record<string, unknown> = {};
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
    const messages = sentBody.messages as Array<{ role: string; content: string }>;
    expect(JSON.parse(messages[1]?.content ?? "{}")).toMatchObject({ previousSummary: input.previousSummary });

    const usage = await env.DB.prepare(
      "SELECT ai_calls,ai_input_tokens,ai_output_tokens FROM usage_daily WHERE day=?",
    )
      .bind(day)
      .first<{ ai_calls: number; ai_input_tokens: number; ai_output_tokens: number }>();
    expect(usage).toEqual({ ai_calls: 1, ai_input_tokens: 123, ai_output_tokens: 18 });
  });

  it("releases only its named call slot when the input-token reservation is refused", async () => {
    await reserveAiCallSlot(env.DB, "ai-over-budget", "workflow-over-budget", day, 120, 1);
    const outbound = vi.spyOn(globalThis, "fetch");

    await expect(
      summarizeGroup(
        { ...aiEnv(), AI_DAILY_INPUT_TOKEN_CAP: "1" },
        input,
        Date.UTC(2026, 7, 24, 1),
        { id: "ai-over-budget", day },
      ),
    ).rejects.toThrow("budget");

    expect(await env.DB.prepare("SELECT status FROM ai_call_reservations WHERE id='ai-over-budget'").first("status"))
      .toBe("released");
    expect(await env.DB.prepare("SELECT ai_calls FROM usage_daily WHERE day=?").bind(day).first("ai_calls"))
      .toBe(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("charges each provider retry after malformed structured output as a separate capped attempt", async () => {
    await reserveAiCallSlot(env.DB, "ai-retry", "workflow-retry", day, 120, 1);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: '{"summary":"bad","priorityScore":999}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: JSON.stringify({
          summary: "สรุปหลัง retry",
          actionItems: [],
          unresolvedQuestions: [],
          priorityScore: 20,
          suggestedCategorySlug: "customer",
          categoryConfidence: 0.9,
        }) } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }));
    const reservation = { id: "ai-retry", day };

    await expect(summarizeGroup(aiEnv(), input, 2, reservation)).rejects.toThrow();
    await expect(summarizeGroup(aiEnv(), input, 3, reservation)).resolves.toMatchObject({ promptTokens: 7 });

    expect(await env.DB.prepare(
      "SELECT ai_calls,ai_input_tokens,ai_output_tokens FROM usage_daily WHERE day=?",
    ).bind(day).first()).toEqual({ ai_calls: 2, ai_input_tokens: 12, ai_output_tokens: 5 });
    expect(await env.DB.prepare("SELECT attempt_count FROM ai_call_reservations WHERE id='ai-retry'")
      .first("attempt_count")).toBe(2);
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
