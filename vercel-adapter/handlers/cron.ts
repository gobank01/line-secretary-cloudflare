// ยิงจาก cron-job.org รายชั่วโมง: GET /api/cron พร้อม Authorization: Bearer <CRON_SECRET>
// ตอบ 202 ทันที (cron-job.org ฟรีตัดที่ 30 วิ) แล้วสรุปต่อเบื้องหลังด้วย waitUntil (เพดาน 300 วิ)
import { waitUntil } from "@vercel/functions";
import { runScheduled } from "../../worker/scheduler/coordinator";
import { buildEnv } from "../env";

const HOUR_MS = 3_600_000;

async function handler(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET ?? "";
  const header = request.headers.get("authorization") ?? "";
  if (secret.length < 16 || header !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Floor ให้ตรงชั่วโมง: job_runs dedup/resume ทำงานเหมือนฝั่ง Cloudflare
  // และ digest slot (minute===0) ไม่พังเพราะ cron ยิงช้าไปหนึ่งนาที
  const scheduledTime = Date.now() - (Date.now() % HOUR_MS);
  waitUntil(
    runScheduled(buildEnv() as never, scheduledTime).catch((error: unknown) => {
      console.error("cron_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    }),
  );
  return Response.json({ accepted: true, scheduledTime }, { status: 202 });
}

// Vercel Node runtime รู้จัก web handler ผ่านรูปแบบ { fetch } เท่านั้น
export default { fetch: handler };
