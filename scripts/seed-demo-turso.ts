// Seed demo 100 กลุ่มลง Turso/ไฟล์ local: npx tsx scripts/seed-demo-turso.ts
import { createClient } from "@libsql/client";
import { buildDemoDataset, renderDemoSeedSql } from "./demo-data";

const url = process.env.TURSO_DATABASE_URL ?? "file:local.db";
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });
await client.executeMultiple(renderDemoSeedSql(buildDemoDataset(100, 20_260_823)));
console.log(`Seeded 100 demo groups → ${url.startsWith("file:") ? url : "Turso"}`);
