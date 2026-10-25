import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules/**", "test/scripts/fixtures/**"],
    testTimeout: 10000,
  },
});
