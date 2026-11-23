import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // test/e2e runs the built bundle end to end: pnpm test:e2e (vitest.e2e.config.ts).
    exclude: ["node_modules/**", "test/scripts/fixtures/**", "test/e2e/**"],
    testTimeout: 10000,
  },
});
