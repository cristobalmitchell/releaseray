/**
 * Event, input and clone guards, and visibility: Phase 3 criteria 9 and 10.
 * The real `release: published` trigger part of criterion 9 is out of scope
 * (see spec.ts); the synthetic release event runs in flow1.e2e.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, cloneWorkspace, tempDir } from "./harness/git-fixture";
import { buildWorld, type World } from "./harness/world";

const worlds: World[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.stop()));
  cleanup();
});

async function world(...args: Parameters<typeof buildWorld>): Promise<World> {
  const w = await buildWorld(...args);
  worlds.push(w);
  return w;
}

describe("3.9 event, input and clone guards", () => {
  it("stops pull_request_target in its first step, before any checkout or request", async () => {
    const w = await world();
    const run = await w.run({
      workspace: tempDir("empty"),
      event: "pull_request_target",
      payload: { pull_request: { number: 9, head: { repo: { fork: true } } } },
    });
    expect(run.code).toBe(2);
    expect(run.outputs).toEqual({ "exit-code": "2" });
    expect(run.errors[0]).toBe("pull_request_target is not supported");
    expect(w.gh.log).toEqual([]);
  });

  it("runs pull_request as a preview: exit 0, no model, no writes", async () => {
    const w = await world();
    const run = await w.run({
      workspace: cloneWorkspace(w.origin, { ref: "main" }),
      event: "pull_request",
      payload: { pull_request: { number: 9 } },
      inputs: { mode: "generate" },
      // No fake model and no key: a model call would fail the step.
      fakeModel: false,
    });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.outputs["llm-calls"]).toBe("0");
    expect(run.notices.some((n) => n.includes("preview only"))).toBe(true);
    expect(w.gh.writes()).toEqual([]);
  });

  it("refuses mode: generate on a depth-1 checkout and names fetch-depth: 0", async () => {
    const w = await world();
    const run = await w.run({
      workspace: cloneWorkspace(w.origin, { ref: "main", depth: 1 }),
      event: "workflow_dispatch",
      payload: { inputs: { to: "v1.1.0" } },
      inputs: { to: "v1.1.0" },
    });
    expect(run.code).toBe(2);
    expect(run.errors.join("\n")).toMatch(/fetch-depth: 0/);
    expect(w.gh.log).toEqual([]);
  });
});

describe("3.10 visibility", () => {
  for (const visibility of ["public", "private"] as const) {
    it(`${visibility === "public" ? "withholds" : "shows"} the internal persona on a ${visibility} repository`, async () => {
      const w = await world();
      const workspace = cloneWorkspace(w.origin);
      const run = await w.run({
        workspace,
        event: "workflow_dispatch",
        payload: { inputs: { to: "v1.1.0" }, repository: { private: visibility === "private" } },
        inputs: { to: "v1.1.0", publish: "false" },
      });
      expect(run.code).toBe(0);
      const dir = join(workspace, run.outputs["notes-dir"]);
      expect(existsSync(join(dir, "engineer.md"))).toBe(true);
      expect(existsSync(join(dir, "internal.md"))).toBe(visibility === "private");
      expect(run.summary).toContain("## Engineer");
      expect(run.summary.includes("## Internal (CSM)")).toBe(visibility === "private");
    });
  }
});
