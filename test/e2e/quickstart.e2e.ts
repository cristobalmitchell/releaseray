/**
 * The README quickstart on a new repository, through the real `openai`
 * adapter against a local OpenAI-compatible stub: Phase 4 criteria 4 and 8.
 * The only things added to what the README says are a dummy
 * OPENAI_API_KEY and one config line pointing `llm.baseUrl` at the stub.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findMarkedBlocks } from "../../src/core/state/marker";
import { cleanup, cloneWorkspace } from "./harness/git-fixture";
import { OpenAIStub } from "./harness/openai-stub";
import { inputsOnRelease, quickstartStep, starterConfig } from "./harness/readme";
import { buildWorld, type World } from "./harness/world";

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
const DUMMY_KEY = "dummy-quickstart-key";

const worlds: World[] = [];
const stub = new OpenAIStub();
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.stop()));
  await stub.stop();
  cleanup();
});

describe("4.4 quickstart and 4.8 starter config", () => {
  it("publishes notes through the openai adapter on a published release", async () => {
    const baseUrl = await stub.start();
    const starter = starterConfig(README);
    expect(starter).toMatch(/^llm:\n/m);
    const config = `${starter.trimEnd()}\n  baseUrl: ${baseUrl}\n`;
    const w = await buildWorld({
      config,
      // The recorded response names #12, so the fixture's pull requests do too.
      pulls: [
        {
          number: 10,
          title: "feat: add CSV export",
          body: "Reports can be exported as CSV for spreadsheets.",
        },
        {
          number: 11,
          title: "fix: keep empty rows on import",
          body: "Empty rows no longer stop an import half way.",
        },
        {
          number: 12,
          title: "perf: faster imports",
          body: "Imports stream rows instead of loading the whole file.",
        },
      ],
    });
    worlds.push(w);

    // 4.8: the README's starter config, unchanged, passes validate-config.
    const validateWorkspace = cloneWorkspace(w.origin);
    writeFileSync(join(validateWorkspace, ".releaseray", "config.yml"), starter);
    const validated = await w.run({
      workspace: validateWorkspace,
      event: "workflow_dispatch",
      payload: { inputs: {} },
      inputs: { mode: "validate-config" },
      fakeModel: false,
    });
    expect(validated.errors).toEqual([]);
    expect(validated.code).toBe(0);

    // 4.4: Flow 1 exactly as the quickstart workflow passes it.
    const step = quickstartStep(README);
    expect(Object.keys(step.env)).toEqual(["OPENAI_API_KEY"]);
    w.gh.addRelease({ tag: "v1.1.0" });
    const run = await w.run({
      workspace: cloneWorkspace(w.origin, { ref: "v1.1.0" }),
      event: "release",
      payload: { action: "published", release: { tag_name: "v1.1.0" } },
      inputs: inputsOnRelease(step, "v1.1.0"),
      fakeModel: false,
      env: { OPENAI_API_KEY: DUMMY_KEY },
    });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.outputs["release-changed"]).toBe("true");

    const calls = Number(run.outputs["llm-calls"]);
    expect(calls).toBeGreaterThan(0);
    expect(stub.requests).toHaveLength(calls);
    for (const r of stub.requests) {
      expect(r.path).toBe("/v1/chat/completions");
      expect(r.authorization).toBe(`Bearer ${DUMMY_KEY}`);
      expect(r.body.model).toBe("gpt-5-mini");
    }
    expect(run.outputs["llm-cost-usd"]).toMatch(/^\d+\.\d{4}$/);

    const [block] = findMarkedBlocks(w.gh.release("v1.1.0")!.body);
    expect(block.fields.persona).toBe("engineer");
    expect(block.inner).toContain("Faster imports");
    // The key is registered for masking and printed nowhere else.
    expect(run.stdout).toContain(`::add-mask::${DUMMY_KEY}`);
    expect(run.stdout.replace(`::add-mask::${DUMMY_KEY}`, "")).not.toContain(DUMMY_KEY);
  });
});
