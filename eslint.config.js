import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "coverage/", "test/scripts/fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      // Carried tests use partial mocks of third-party clients.
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
