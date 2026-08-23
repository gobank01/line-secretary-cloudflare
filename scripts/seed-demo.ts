import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { buildDemoDataset, renderDemoSeedSql } from "./demo-data";

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const mode = process.argv.includes("--remote") ? "--remote" : "--local";
const environment = optionValue("--env");
const configPath = optionValue("--config");
const database = optionValue("--database") ?? "line-secretary-cloudflare";
const sqlPath = ".generated/demo-seed.sql";

await mkdir(".generated", { recursive: true });
await writeFile(sqlPath, renderDemoSeedSql(buildDemoDataset(100, 20_260_823)));

const args = ["wrangler", "d1", "execute", database, mode, "--file", sqlPath];
if (environment) args.push("--env", environment);
if (configPath) args.push("--config", configPath);

const result = spawnSync("npx", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.status !== 0) {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exitCode = result.status ?? 1;
} else {
  console.log(`Seeded 100 demo groups into ${database} (${mode.slice(2)}).`);
}
