// รัน migrations ทั้งหมดกับ Turso (หรือไฟล์ local): node scripts/migrate-turso.mjs
// ใช้ env TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (ไม่ตั้ง = file:local.db)
import { createClient } from "@libsql/client";
import { readFile, readdir } from "node:fs/promises";

const url = process.env.TURSO_DATABASE_URL ?? "file:local.db";
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

await client.execute(
  "CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
);
const applied = new Set(
  (await client.execute("SELECT name FROM _migrations")).rows.map((row) => row.name),
);

const files = (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort();
for (const file of files) {
  if (applied.has(file)) {
    console.log(`ข้าม (ทำแล้ว): ${file}`);
    continue;
  }
  const sql = await readFile(`migrations/${file}`, "utf8");
  // ครอบ transaction ต่อไฟล์ — เน็ตหลุดกลางไฟล์แล้ว schema ไม่ค้างครึ่งทาง (Turso รับ BEGIN/COMMIT)
  await client.executeMultiple(`BEGIN;\n${sql}\nCOMMIT;`);
  await client.execute({ sql: "INSERT INTO _migrations(name, applied_at) VALUES(?, ?)", args: [file, Date.now()] });
  console.log(`ผ่าน: ${file}`);
}
console.log(`ครบ ${files.length} ไฟล์ → ${url.startsWith("file:") ? url : "Turso"}`);
