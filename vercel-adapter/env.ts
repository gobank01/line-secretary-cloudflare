// ประกอบ AppEnv สำหรับรันบน Vercel: D1 → Turso shim, Workflow → รัน inline
import type { AppEnv, GroupSummarizerParams } from "../worker/env";
import {
  releaseGroupSummaryReservation,
  runGroupSummarizerSteps,
  type WorkflowStepRunner,
} from "../worker/workflows/group-summarizer";
import { releaseAiCallSlot } from "../worker/ai/openrouter";
import { createD1Shim } from "./d1-shim";

const inlineStep: WorkflowStepRunner = {
  async do(name, configOrCallback, maybeCallback) {
    const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
    if (!callback) throw new Error(`workflow step ${name} missing callback`);
    // จำกัด retry ให้แน่นกว่าฝั่ง Workflows (สูงสุด 2 ครั้ง) — ต้องจบใน 300 วิของ Vercel
    const limit = Math.min(typeof configOrCallback === "object" ? (configOrCallback.retries?.limit ?? 0) : 0, 1);
    let lastError: unknown;
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      try {
        return await callback();
      } catch (error) {
        lastError = error;
        if (attempt < limit) await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      }
    }
    throw lastError;
  },
};

let cached: AppEnv | null = null;

export function buildEnv(): AppEnv {
  if (cached) return cached;
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
    // fail fast พร้อมข้อความชัด แทน SQLITE_CANTOPEN ปริศนาบน filesystem อ่านอย่างเดียว
    throw new Error("TURSO_DATABASE_URL is not set — run: npx vercel env add TURSO_DATABASE_URL production");
  }
  const url = process.env.TURSO_DATABASE_URL ?? "file:local.db";
  const db = createD1Shim(url, process.env.TURSO_AUTH_TOKEN) as unknown as AppEnv["DB"];

  const env: AppEnv = {
    DB: db,
    GROUP_SUMMARIZER: {
      // ponytail: Workflow รัน inline ใน cron request — พอสำหรับ ≤10 กลุ่ม/รอบ
      // ถ้าโตกว่านั้นค่อยย้ายไป queue จริง
      create: async ({ params }: { id: string; params: GroupSummarizerParams }) => {
        // กันกลุ่มเดียวพังแล้วลากทั้งรอบล่ม: จับ error รายกลุ่ม คืน lease + โควตา AI แล้วไปกลุ่มถัดไป
        try {
          await runGroupSummarizerSteps(env, params, inlineStep);
        } catch (error) {
          console.error("group_summary_failed", {
            name: error instanceof Error ? error.name : "UnknownError",
          });
          await Promise.allSettled([
            releaseGroupSummaryReservation(env.DB, params.groupId, params.scheduledFor),
            releaseAiCallSlot(env.DB, params.aiReservationId, params.aiReservationDay, Date.now()),
          ]);
        }
      },
    } as unknown as AppEnv["GROUP_SUMMARIZER"],
    APP_ENV: process.env.APP_ENV ?? "vercel",
    APP_TIMEZONE: process.env.APP_TIMEZONE ?? "Asia/Bangkok",
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? "google/gemini-3.7-flash",
    REAL_GROUP_LIMIT: process.env.REAL_GROUP_LIMIT ?? "10",
    AUTOMATED_MONTHLY_PUSH_CAP: process.env.AUTOMATED_MONTHLY_PUSH_CAP ?? "280",
    AI_DAILY_CALL_CAP: process.env.AI_DAILY_CALL_CAP ?? "120",
    AI_DAILY_INPUT_TOKEN_CAP: process.env.AI_DAILY_INPUT_TOKEN_CAP ?? "500000",
    AI_MIN_MESSAGES: process.env.AI_MIN_MESSAGES ?? "5",
    AI_MAX_WAIT_MINUTES: process.env.AI_MAX_WAIT_MINUTES ?? "120",
    LINE_PUSH_ENABLED: process.env.LINE_PUSH_ENABLED ?? "false",
    LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET ?? "",
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    OWNER_USER_ID: process.env.OWNER_USER_ID ?? "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD ?? "",
    SESSION_SECRET: process.env.SESSION_SECRET ?? "",
    DASHBOARD_URL: process.env.DASHBOARD_URL ?? "http://localhost:3000",
  };
  cached = env;
  return env;
}
