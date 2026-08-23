import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";

const [environment, databaseName, ...extra] = process.argv.slice(2);
const allowedEnvironments = new Set(["preview", "production"]);
const expectedDatabaseName = environment ? `line-secretary-cloudflare-${environment}` : "";

if (!allowedEnvironments.has(environment) || databaseName !== expectedDatabaseName || extra.length > 0) {
  console.error(
    "Usage: node scripts/configure-cloudflare.mjs <preview|production> line-secretary-cloudflare-<environment>",
  );
  process.exit(1);
}

const result = spawnSync("npx", ["wrangler", "d1", "list", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.status !== 0) {
  console.error("Unable to list Cloudflare D1 databases. Run `npx wrangler whoami` first.");
  process.exit(result.status ?? 1);
}

let databases;
try {
  databases = JSON.parse(result.stdout);
} catch {
  console.error("Cloudflare returned an unreadable D1 database list.");
  process.exit(1);
}

const database = Array.isArray(databases)
  ? databases.find((candidate) => candidate && candidate.name === databaseName)
  : undefined;
const databaseId = database?.uuid ?? database?.id;
if (typeof databaseId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
  console.error(`D1 database not found or invalid: ${databaseName}`);
  process.exit(1);
}

const configPath = "wrangler.jsonc";
const source = await readFile(configPath, "utf8");
const parsed = parse(source);
const currentName = parsed?.env?.[environment]?.d1_databases?.[0]?.database_name;
if (currentName !== databaseName) {
  console.error(`wrangler.jsonc does not target the expected ${environment} database name.`);
  process.exit(1);
}

const edits = modify(
  source,
  ["env", environment, "d1_databases", 0, "database_id"],
  databaseId,
  { formattingOptions: { insertSpaces: true, tabSize: 2 } },
);
await writeFile(configPath, applyEdits(source, edits));
console.log(`Configured ${environment} D1 binding for ${databaseName}.`);
