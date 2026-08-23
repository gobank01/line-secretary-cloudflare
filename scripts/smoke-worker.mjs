import { readFile } from "node:fs/promises";

const [deployLogPath, ...extra] = process.argv.slice(2);
if (!deployLogPath || extra.length > 0) {
  console.error("Usage: node scripts/smoke-worker.mjs <deploy-log-path>");
  process.exit(1);
}

const deployLog = await readFile(deployLogPath, "utf8");
const match = deployLog.match(/https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.workers\.dev(?:\/[^\s]*)?/i);
if (!match) {
  console.error("No HTTPS workers.dev URL found in the deployment log.");
  process.exit(1);
}

const baseUrl = new URL(match[0]).origin;
const [rootResponse, healthResponse] = await Promise.all([
  fetch(`${baseUrl}/`, { redirect: "follow" }),
  fetch(`${baseUrl}/api/health`, { redirect: "error" }),
]);

if (!rootResponse.ok || !(rootResponse.headers.get("content-type") ?? "").includes("text/html")) {
  throw new Error(`Dashboard smoke test failed with HTTP ${rootResponse.status}.`);
}
if (!healthResponse.ok) throw new Error(`Health smoke test failed with HTTP ${healthResponse.status}.`);
const health = await healthResponse.json();
if (health?.ok !== true || health?.service !== "line-secretary-cloudflare") {
  throw new Error("Health response does not identify the expected service.");
}

console.log(`Smoke test passed for ${baseUrl}.`);
