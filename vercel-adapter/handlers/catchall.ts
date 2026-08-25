// ทุก /api/* วิ่งเข้า Hono app ตัวเดียวกับฝั่ง Cloudflare — ต่างแค่ env มาจาก Turso shim
// Vercel Node runtime รู้จัก web handler ผ่านรูปแบบ { fetch } เท่านั้น (default function เปล่า = (req,res) listener ค้างจน 504)
import { createApp } from "../../worker/app";
import { buildEnv } from "../env";

const app = createApp();

export default { fetch: (request: Request) => app.fetch(request, buildEnv()) };
