import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/ui/**/*.test.tsx"],
    setupFiles: ["@testing-library/jest-dom/vitest"],
  },
});

