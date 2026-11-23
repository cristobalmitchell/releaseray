/**
 * The tools workflow (releaseray-tools.yml): read-only modes with no model
 * key and no fake model. Phase 3 criterion 18.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, cloneWorkspace } from "./harness/git-fixture";
import { buildWorld, type World } from "./harness/world";

const HOSTED_PERSONAS = readFileSync(
  fileURLToPath(new URL("../fixtures/personas/hosted-export.yml", import.meta.url)),
  "utf8"
);

const worlds: World[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.stop()));
  cleanup();
});

async function tools(w: World, inputs: Record<string, string>) {
  const workspace = cloneWorkspace(w.origin);
  const mode = inputs.mode;
  const run = await w.run({
    workspace,
    event: "workflow_dispatch",
    payload: { inputs },
    // releaseray-tools.yml: to defaults to HEAD; migrate-personas writes a new config path.
    inputs: {
      to: "HEAD",
      ...inputs,
      ...(mode === "migrate-personas" ? { config: ".releaseray/config.migrated.yml" } : {}),
    },
    fakeModel: false,
  });
  return { run, workspace };
}

describe("3.18 tools workflow", () => {
  it("runs preview, doctor, validate-config and migrate-personas with no model and no writes", async () => {
    const w = await buildWorld({
      config: "version: 1\n",
      // Leave HEAD untagged so the preview has unreleased changes.
      tags: (m) => ({ "v1.0.0": m.root }),
      files: {
        ".releaseray/personas.yml": HOSTED_PERSONAS,
        ".releaseray/invalid.yml": "version: 2\noutputs:\n  githubRelease:\n    persona: nobody\n",
      },
    });
    worlds.push(w);

    for (const mode of ["preview", "doctor", "validate-config", "migrate-personas"]) {
      const { run, workspace } = await tools(w, { mode });
      expect(run.errors, mode).toEqual([]);
      expect(run.code, mode).toBe(0);
      expect(run.outputs["llm-calls"] ?? "0", mode).toBe("0");
      if (mode === "doctor") expect(w.gh.log.some((l) => l.route === "GET /rate_limit")).toBe(true);
      if (mode === "migrate-personas") {
        expect(existsSync(join(workspace, ".releaseray", "config.migrated.yml"))).toBe(true);
      }
    }

    const { run: prompts, workspace } = await tools(w, {
      mode: "preview",
      "preview-prompts": "true",
    });
    expect(prompts.code).toBe(0);
    const promptDir = join(workspace, ".releaseray", "notes");
    const files = readdirSync(promptDir, { recursive: true }).map(String);
    expect(files.some((f) => /prompts\/[^/]+\.user\.md$/.test(f))).toBe(true);

    const { run: invalid } = await tools(w, {
      mode: "validate-config",
      config: ".releaseray/invalid.yml",
    });
    expect(invalid.code).toBe(2);
    expect(invalid.errors.length).toBeGreaterThan(0);

    expect(w.gh.writes()).toEqual([]);
  });
});
