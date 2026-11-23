/**
 * Job summary size: Phase 3 criterion 14. The runner rejects a step
 * summary over 1 MiB (RC §5.3), so the Action must stay under it.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, cloneWorkspace } from "./harness/git-fixture";
import { buildWorld, type World, type WorldPull } from "./harness/world";

const MIB = 1024 * 1024;

const worlds: World[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.stop()));
  cleanup();
});

function pulls(count: number, titleLength: number, type = "feat", first = 2): WorldPull[] {
  return Array.from({ length: count }, (_, i) => {
    const n = first + i;
    const title = `${type}: change number ${n} `.padEnd(titleLength, "x");
    return {
      number: n,
      title,
      body: `Change ${n} adds a small, separate improvement to the import flow.`,
    };
  });
}

describe("3.14 summary size", () => {
  it("keeps the N = 100 summary under 1 MiB", async () => {
    const w = await buildWorld({ pulls: pulls(100, 60) });
    worlds.push(w);
    const run = await w.dispatch("v1.1.0");
    expect(run.code).toBe(0);
    expect(run.summary).toContain("## Engineer");
    expect(run.summary).toContain("100 fetched");
    expect(Buffer.byteLength(run.summary)).toBeLessThan(MIB);
    expect(Number(run.outputs["github-requests"])).toBe(w.gh.counted());
  });

  it("truncates a summary that would pass 1 MiB, and the step succeeds", async () => {
    // 200 features and 200 fixes (the most a section holds) in 20 personas
    // come to about 1.2 MiB of notes.
    const custom = Array.from(
      { length: 17 },
      (_, i) => `  - slug: team-${i + 1}\n    extends: engineer\n    name: Team ${i + 1}\n`
    ).join("");
    const w = await buildWorld({
      pulls: [...pulls(200, 280, "feat"), ...pulls(200, 280, "fix", 202)],
      config: `version: 1\nrange:\n  maxPullRequests: 500\npersonas:\n${custom}`,
    });
    worlds.push(w);
    const workspace = cloneWorkspace(w.origin);
    const run = await w.run({
      workspace,
      event: "workflow_dispatch",
      payload: { inputs: { to: "v1.1.0" }, repository: { private: true } },
      inputs: { to: "v1.1.0", publish: "false" },
    });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    const dir = join(workspace, run.outputs["notes-dir"]);
    const notesBytes = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(notesBytes).toBeGreaterThan(1.1 * MIB);
    expect(Buffer.byteLength(run.summary)).toBeLessThanOrEqual(MIB);
    expect(run.summary).toContain("**Truncated.**");
  });
});
