// ทุก /api/* วิ่งเข้า Hono app ตัวเดียวกับฝั่ง Cloudflare — ต่างแค่ env มาจาก Turso shim
// Vercel Node runtime รู้จัก web handler ผ่านรูปแบบ { fetch } เท่านั้น (default function เปล่า = (req,res) listener ค้างจน 504)
import { createApp } from "../../worker/app";
import { buildEnv } from "../env";

const app = createApp();

async function fetchWithDebug(request: Request): Promise<Response> {
  try {
    return await app.fetch(request, buildEnv());
  } catch (error) {
    // DEBUG_ERRORS ใช้ชั่วคราวตอนไล่ปัญหา deploy เท่านั้น — ห้ามเปิดใน production จริง
    if (process.env.DEBUG_ERRORS) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6) : null },
        { status: 500 },
      );
    }
    throw error;
  }
}

export default { fetch: fetchWithDebug };
