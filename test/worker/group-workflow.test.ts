import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadWorkflowInput,
  persistWorkflowResult,
  runGroupSummarizerSteps,
  type WorkflowStepRunner,
} from "../../worker/workflows/group-summarizer";

const now = Date.UTC(2026, 7, 23, 12, 0, 0);
let teamCategoryId = 0;

async function seedLockedGroup(): Promise<void> {
  teamCategoryId = (await env.DB.prepare("SELECT id FROM categories WHERE slug='team'").first<number>("id")) ?? 0;
  await env.DB.prepare(
    `INSERT INTO groups(source_id,title,data_mode,active,category_id,category_source,category_locked,created_at,updated_at)
     VALUES('C-workflow','ทีมโครงการ','real',1,?,'manual',1,?,?)`,
  )
    .bind(teamCategoryId, now, now)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
       VALUES('mw-1','C-workflow','text','ลูกค้ารอราคา',?,?,?)`,
    ).bind(now - 2_000, now, now + 99_999),
    env.DB.prepare(
      `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
       VALUES('mw-2','C-workflow','text','ต้องส่งวันนี้',?,?,?)`,
    ).bind(now - 1_000, now, now + 99_999),
    env.DB.prepare(
      `INSERT INTO job_runs(scheduled_for,status,started_at) VALUES(?,'running',?)`,
    ).bind(now, now),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM alerts"),
    env.DB.prepare("DELETE FROM reports"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM groups"),
    env.DB.prepare("DELETE FROM job_runs"),
    env.DB.prepare("DELETE FROM usage_daily"),
  ]);
  await seedLockedGroup();
  vi.restoreAllMocks();
});

function validOpenRouterResponse(): Response {
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: "ลูกค้ารอราคาและต้องส่งวันนี้",
            actionItems: ["ส่งราคา"],
            unresolvedQuestions: [],
            priorityScore: 88,
            suggestedCategorySlug: "customer",
            categoryConfidence: 0.95,
          }),
        },
      },
    ],
    usage: { prompt_tokens: 80, completion_tokens: 20 },
  });
}

describe("group summarizer Workflow", () => {
  it("uses stable retryable steps and persists one idempotent report while preserving a locked category", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(validOpenRouterResponse());
    const observed: Array<{ name: string; config?: unknown }> = [];
    const step: WorkflowStepRunner = {
      async do<T>(name: string, configOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
        const callback = typeof configOrCallback === "function" ? (configOrCallback as () => Promise<T>) : maybeCallback;
        observed.push({ name, ...(typeof configOrCallback === "object" ? { config: configOrCallback } : {}) });
        if (!callback) throw new Error("missing callback");
        return callback();
      },
    };

    await runGroupSummarizerSteps(
      env,
      { groupId: "C-workflow", scheduledFor: now, jobRunId: 1 },
      step,
      now,
    );
    expect(observed.map((item) => item.name)).toEqual([
      "load bounded group input",
      "summarize with openrouter",
      "persist report and checkpoint",
    ]);
    expect(observed[1]?.config).toMatchObject({ retries: { limit: 3, backoff: "exponential" } });

    const reportInput = await loadWorkflowInput(env.DB, "C-workflow", 200, true);
    expect(reportInput).not.toBeNull();
    const result = {
      output: {
        summary: "replay",
        actionItems: [],
        unresolvedQuestions: [],
        priorityScore: 90,
        suggestedCategorySlug: "customer",
        categoryConfidence: 0.99,
      },
      promptTokens: 1,
      completionTokens: 1,
      model: env.OPENROUTER_MODEL,
    };
    if (reportInput) {
      await persistWorkflowResult(env.DB, reportInput, result, now, 1);
      await persistWorkflowResult(env.DB, reportInput, result, now, 1);
    }

    expect(await env.DB.prepare("SELECT count(*) AS count FROM reports WHERE group_id='C-workflow'").first("count")).toBe(1);
    const group = await env.DB.prepare(
      "SELECT category_id,category_locked,priority_score FROM groups WHERE source_id='C-workflow'",
    ).first<{ category_id: number; category_locked: number; priority_score: number }>();
    expect(group?.category_id).toBe(teamCategoryId);
    expect(group?.category_locked).toBe(1);
    expect(group?.priority_score).toBe(88);
    expect(await env.DB.prepare("SELECT groups_completed FROM job_runs WHERE id=1").first("groups_completed")).toBe(1);
  });

  it("leaves messages unprocessed when structured output is invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { content: '{"summary":"bad","priorityScore":999}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
    const step: WorkflowStepRunner = {
      async do<T>(_name: string, configOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
        const callback = typeof configOrCallback === "function" ? (configOrCallback as () => Promise<T>) : maybeCallback;
        if (!callback) throw new Error("missing callback");
        return callback();
      },
    };

    await expect(
      runGroupSummarizerSteps(env, { groupId: "C-workflow", scheduledFor: now, jobRunId: 1 }, step, now),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE group_id='C-workflow' AND processed_at IS NULL")
        .first("count"),
    ).toBe(2);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM reports WHERE group_id='C-workflow'").first("count")).toBe(0);
  });
});
