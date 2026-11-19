import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index";
import { stripComments } from "../../scripts/check-boundary";

describe("src/core/index.ts", () => {
  it("lists its exports one by one", () => {
    const source = stripComments(
      readFileSync(join(__dirname, "..", "..", "src", "core", "index.ts"), "utf8")
    );
    expect(source).not.toMatch(/export \*/);
  });

  it("loads without any hosting dependency and exposes the lifted entry points", () => {
    for (const name of [
      "buildPersonaPrompt",
      "callLLMWithSchema",
      "createProvider",
      "enhancedClassifyChanges",
      "extractPRNumbers",
      "sanitizeForLLM",
      "sanitizeForPublishing",
      "renderToMarkdown",
      "writeMarkedBlock",
      "configureLogger",
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
