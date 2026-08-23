import { readFile } from "node:fs/promises";

const [environment, ...extra] = process.argv.slice(2);
if (!["preview", "production"].includes(environment) || extra.length > 0) {
  console.error("Usage: node scripts/assert-deploy-config.mjs <preview|production>");
  process.exit(1);
}

const config = JSON.parse(await readFile("dist/line_secretary_cloudflare/wrangler.json", "utf8"));
const expectedName = `line-secretary-cloudflare-${environment}`;
const actual = {
  targetEnvironment: config.targetEnvironment,
  name: config.name,
  appEnvironment: config.vars?.APP_ENV,
  databaseName: config.d1_databases?.[0]?.database_name,
  workflowName: config.workflows?.[0]?.name,
};
const expected = {
  targetEnvironment: environment,
  name: expectedName,
  appEnvironment: environment,
  databaseName: expectedName,
  workflowName: `line-secretary-group-summarizer-${environment}`,
};

for (const [key, value] of Object.entries(expected)) {
  if (actual[key] !== value) {
    throw new Error(`Unsafe deploy config: expected ${key}=${value}, received ${String(actual[key])}.`);
  }
}

if (!["true", "false"].includes(config.vars?.LINE_PUSH_ENABLED)) {
  throw new Error("Unsafe deploy config: LINE_PUSH_ENABLED must be an explicit string boolean.");
}

console.log(`Verified flattened ${environment} deploy configuration.`);
