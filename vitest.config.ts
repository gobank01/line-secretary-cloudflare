import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          APP_ENV: "local",
          DASHBOARD_PASSWORD: "local-owner-password",
          SESSION_SECRET: "local-test-session-secret-at-least-32-characters",
          LINE_CHANNEL_SECRET: "line-test-secret",
          LINE_CHANNEL_ACCESS_TOKEN: "line-test-token",
          OWNER_USER_ID: "U-test-owner",
          OPENROUTER_API_KEY: "openrouter-test-key",
          DASHBOARD_URL: "http://localhost:5173",
        },
      },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
