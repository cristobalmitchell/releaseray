/**
 * Flow 1H (release-notes-hardened.yml): generate with no write access, then
 * publish from a depth-1 checkout with the digest check. Phase 3 criterion 11.
 */
import { cpSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findMarkedBlocks } from "../../src/core/state/marker";
import { cleanup, cloneWorkspace } from "./harness/git-fixture";
import { buildWorld, type World } from "./harness/world";

const worlds: World[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.stop()));
  cleanup();
});

const release = { action: "published", release: { tag_name: "v1.1.0" } };

describe("3.11 hardened split", () => {
  it("refuses a wrong digest with no writes, regenerates the same digest, and publishes", async () => {
    const w = await buildWorld();
    worlds.push(w);
    w.gh.addRelease({ tag: "v1.1.0", body: "Intro." });

    const generate = async () => {
      const workspace = cloneWorkspace(w.origin, { ref: "v1.1.0" });
      const run = await w.run({
        workspace,
        event: "release",
        payload: release,
        inputs: { mode: "generate", publish: "false", to: "v1.1.0" },
      });
      expect(run.code).toBe(0);
      return { run, dir: join(workspace, run.outputs["notes-dir"]) };
    };
    const publish = async (notes: string, digest: string) => {
      // The publish job's checkout keeps actions/checkout's default depth of 1.
      const workspace = cloneWorkspace(w.origin, { ref: "main", depth: 1 });
      cpSync(notes, join(workspace, "releaseray-notes"), { recursive: true });
      return w.run({
        workspace,
        event: "release",
        payload: release,
        inputs: { mode: "publish", "notes-dir": "releaseray-notes", "expected-digest": digest },
        fakeModel: false,
      });
    };

    const first = await generate();
    expect(w.gh.writes()).toEqual([]);
    const wrong = await publish(first.dir, "0".repeat(64));
    expect(wrong.code).not.toBe(0);
    expect(wrong.outputs["exit-code"]).toBe(String(wrong.code));
    expect(w.gh.writes()).toEqual([]);
    expect(w.gh.release("v1.1.0")!.body).toBe("Intro.");

    // Re-running the generate job on the same content yields the same artifact.
    const again = await generate();
    expect(again.run.outputs["notes-digest"]).toBe(first.run.outputs["notes-digest"]);

    const ok = await publish(again.dir, again.run.outputs["notes-digest"]);
    expect(ok.errors).toEqual([]);
    expect(ok.code).toBe(0);
    expect(ok.outputs).toMatchObject({ "release-changed": "true", "llm-calls": "0" });
    expect(w.gh.writes()).toHaveLength(1);
    const body = w.gh.release("v1.1.0")!.body;
    expect(body.startsWith("Intro.")).toBe(true);
    expect(findMarkedBlocks(body).map((b) => b.fields.key)).toEqual(["v1.1.0"]);
  });
});
