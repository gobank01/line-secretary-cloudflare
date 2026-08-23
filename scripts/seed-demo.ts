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
const sqlPath = ".generated/demo-seed.sql";

await mkdir(".generated", { recursive: true });
await writeFile(sqlPath, renderDemoSeedSql(buildDemoDataset(100, 20_260_823)));

const args = ["wrangler", "d1", "execute", "line-secretary-cloudflare", mode, "--file", sqlPath];
if (environment) args.push("--env", environment);
if (configPath) args.push("--config", configPath);

const result = spawnSync("npx", args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
