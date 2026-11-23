import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HistoryBuilder } from "../e2e/harness/git-fixture";
import { inputsOnRelease, quickstartStep, starterConfig } from "../e2e/harness/readme";
import { inputVariable } from "../e2e/harness/run-action";
import { parseAnnotations, parseOutputFile } from "../e2e/harness/workflow-commands";
import { COVERED } from "../e2e/spec";

const ROOT = join(__dirname, "..", "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

describe("e2e harness: workflow commands", () => {
  it("reads name=value and heredoc outputs, later values winning", () => {
    const text = [
      "key=v1.2.0",
      "notes<<ghadelimiter_1",
      "line one",
      "line=two",
      "ghadelimiter_1",
      "key=v1.3.0",
      "",
    ].join("\n");
    expect(parseOutputFile(text)).toEqual({ key: "v1.3.0", notes: "line one\nline=two" });
    expect(() => parseOutputFile("x<<EOF\nno end")).toThrow(/Unterminated/);
  });

  it("reads annotations and undoes the command escapes", () => {
    const stdout = [
      "plain log line",
      "::warning::50%25 done%0Asecond line",
      "::error title=Config::bad key",
      "::notice::fine",
      "::add-mask::secret",
    ].join("\n");
    expect(parseAnnotations(stdout)).toEqual({
      warnings: ["50% done\nsecond line"],
      errors: ["bad key"],
      notices: ["fine"],
    });
  });

  it("names inputs as the runner does", () => {
    expect(inputVariable("github-token")).toBe("INPUT_GITHUB-TOKEN");
    expect(inputVariable("preview prompts")).toBe("INPUT_PREVIEW_PROMPTS");
  });
});

describe("e2e harness: fixture history", () => {
  it("writes root commits, merges and refs as a fast-import stream", () => {
    const h = new HistoryBuilder();
    const root = h.commit("chore: start", { files: { "a.md": "é\n" } });
    const merge = h.mergePull(root, { number: 7, title: "feat: add" });
    h.ref("refs/heads/main", merge);
    h.ref("refs/tags/v1.0.0", root);
    const stream = h.stream();
    // The root starts an empty branch; data lengths are in bytes.
    expect(stream).toContain("reset refs/fixture/scratch\ncommit refs/fixture/scratch\nmark :1");
    expect(stream).toContain("M 100644 inline a.md\ndata 3\né\n");
    expect(stream).toContain(`mark :3`);
    expect(stream).toContain(`from :1\nmerge :2`);
    expect(stream).toContain("Merge pull request #7 from acme/topic-7\n\nfeat: add");
    expect(stream).toContain("reset refs/heads/main\nfrom :3");
    expect(stream).toContain("reset refs/tags/v1.0.0\nfrom :1");
  });
});

describe("e2e harness: README quickstart", () => {
  it("finds the starter config and the quickstart step", () => {
    expect(parse(starterConfig(README))).toMatchObject({ version: 1, llm: { provider: "openai" } });
    const step = quickstartStep(README);
    expect(Object.keys(step.with).sort()).toEqual(["publish", "to"]);
    expect(inputsOnRelease(step, "v1.2.0")).toEqual({ to: "v1.2.0", publish: "true" });
  });

  it("fails on an expression it cannot evaluate", () => {
    expect(() =>
      inputsOnRelease({ with: { to: "${{ inputs.something }}" }, env: {} }, "v1.2.0")
    ).toThrow(/Unknown expression/);
  });
});

describe("e2e harness: criteria map", () => {
  it("names a test file that exists for every covered criterion", () => {
    for (const [id, c] of Object.entries(COVERED)) {
      expect(existsSync(join(ROOT, "test", "e2e", c.file)), id).toBe(true);
    }
  });
});
