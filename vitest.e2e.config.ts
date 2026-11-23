import { defineConfig } from "vitest/config";

// The hermetic end-to-end suite (pnpm test:e2e): runs dist/action.js against
// a local fake GitHub and local git. Kept out of pnpm test, which is unit-only.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
