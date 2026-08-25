// Bundle Vercel functions เป็นไฟล์เดียว (esbuild มากับ vite อยู่แล้ว)
// เหตุผล: Vercel Node builder ไม่ bundle relative import ข้ามโฟลเดอร์เมื่อ package เป็น ESM
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("api", { recursive: true });
const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // native/runtime deps ให้ Vercel ติดตั้งเองผ่าน node_modules (nft ตามให้)
  external: ["@libsql/client", "@vercel/functions"],
};
await build({ ...shared, entryPoints: ["vercel-adapter/handlers/catchall.ts"], outfile: "api/index.mjs" });
await build({ ...shared, entryPoints: ["vercel-adapter/handlers/cron.ts"], outfile: "api/cron.mjs" });
console.log("bundled api/index.mjs + api/cron.mjs");
