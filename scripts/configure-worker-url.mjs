import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify } from "jsonc-parser";

const [environment, deployLogPath, ...extra] = process.argv.slice(2);
if (!["preview", "production"].includes(environment) || !deployLogPath || extra.length > 0) {
  console.error("Usage: node scripts/configure-worker-url.mjs <preview|production> <deploy-log-path>");
  process.exit(1);
}

const deployLog = await readFile(deployLogPath, "utf8");
const match = deployLog.match(/https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.workers\.dev(?:\/[^\s]*)?/i);
if (!match) {
  console.error("No HTTPS workers.dev URL found in the deployment log.");
  process.exit(1);
}

const workerUrl = new URL(match[0]);
if (workerUrl.protocol !== "https:" || !workerUrl.hostname.endsWith(".workers.dev")) {
  console.error("Deployment URL must use HTTPS on workers.dev.");
  process.exit(1);
}

const dashboardUrl = workerUrl.origin;
const configPath = "wrangler.jsonc";
const source = await readFile(configPath, "utf8");
const edits = modify(
  source,
  ["env", environment, "vars", "DASHBOARD_URL"],
  dashboardUrl,
  { formattingOptions: { insertSpaces: true, tabSize: 2 } },
);
await writeFile(configPath, applyEdits(source, edits));
console.log(`Configured ${environment} dashboard URL: ${dashboardUrl}`);
