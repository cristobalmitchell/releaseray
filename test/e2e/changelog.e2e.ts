/**
 * Flow 2 (release-notes-on-tag.yml) and the CHANGELOG push loop against a
 * local origin: Phase 3 criteria 3 and 4, plus the non-fast-forward retry.
 */
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { findMarkedBlocks } from "../../src/core/state/marker";
import { changelogInner } from "../../src/outputs/changelog-sink";
import { GENERATED_BY_TRAILER } from "../../src/outputs/push";
import {
  cleanup,
  cloneWorkspace,
  originFile,
  protectBranch,
  raceOncePath,
} from "./harness/git-fixture";
import { buildWorld, type World } from "./harness/world";

const CHANGELOG_CONFIG = "version: 1\noutputs:\n  changelog:\n    enabled: true\n";

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

const keys = (text: string) =>
  findMarkedBlocks(text.replace(/\r\n/g, "\n")).map((b) => b.fields.key);

describe("3.3 lost-CHANGELOG repair", () => {
  it("exits 6 when protection rejects the push, then a re-run pushes the release's text", async () => {
    const w = await world({ config: CHANGELOG_CONFIG });
    protectBranch(w.origin, "main");
    const blocked = await w.tagPushed("v1.1.0");
    expect(blocked.code).toBe(6);
    expect(blocked.outputs["exit-code"]).toBe("6");
    expect(blocked.errors.join("\n")).toMatch(/CHANGELOG push to main was rejected/);
    // The release was written before the push failed.
    const release = w.gh.release("v1.1.0");
    expect(release && keys(release.body)).toEqual(["v1.1.0"]);
    expect(originFile(w.origin, "main", "CHANGELOG.md")).toBeNull();

    protectBranch(w.origin, null);
    const rerun = await w.tagPushed("v1.1.0");
    expect(rerun.code).toBe(0);
    expect(rerun.outputs).toMatchObject({
      "changelog-changed": "true",
      "release-changed": "false",
      "llm-calls": "0",
    });
    const changelog = originFile(w.origin, "main", "CHANGELOG.md")!;
    const [entry] = findMarkedBlocks(changelog).filter((b) => b.fields.key === "v1.1.0");
    const [block] = findMarkedBlocks(w.gh.release("v1.1.0")!.body);
    const date = /^## \[v1\.1\.0\] - (\d{4}-\d{2}-\d{2})/.exec(entry.inner)?.[1];
    expect(date).toBeDefined();
    expect(entry.inner).toBe(changelogInner({ key: "v1.1.0", date: date!, text: block.inner }));
  });
});

describe("3.4 parallel tags", () => {
  it("writes both entries in SemVer order when two tags run at once", async () => {
    const w = await world({
      config: CHANGELOG_CONFIG,
      tags: (m) => ({ "v1.0.0": m.root, "v1.1.0": m.merges[1], "v1.2.0": m.merges[2] }),
    });
    // Two checkouts, as two jobs would have, pushing to the same origin.
    const [a, b] = [
      cloneWorkspace(w.origin, { ref: "main" }),
      cloneWorkspace(w.origin, { ref: "main" }),
    ];
    const runs = await Promise.all([
      w.tagPushed("v1.1.0", { workspace: a }),
      w.tagPushed("v1.2.0", { workspace: b }),
    ]);
    for (const r of runs) {
      expect(r.errors).toEqual([]);
      expect(r.code).toBe(0);
      expect(r.outputs["changelog-changed"]).toBe("true");
    }
    expect(keys(originFile(w.origin, "main", "CHANGELOG.md")!)).toEqual(["v1.2.0", "v1.1.0"]);
  });

  it("fetches and re-applies after a non-fast-forward rejection", async () => {
    const w = await world({ config: CHANGELOG_CONFIG });
    const race = raceOncePath(w.origin, "main");
    const run = await w.tagPushed("v1.1.0", { pathPrefix: [race.bin] });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.outputs["changelog-changed"]).toBe("true");
    // The Action's commit sits on top of the concurrent one; neither was lost.
    const log = execFileSync("git", ["log", "-2", "--format=%s%n%b%x00", "main"], {
      cwd: w.origin.dir,
      encoding: "utf8",
    })
      .split("\0")
      .map((s) => s.trim());
    expect(log[0]).toContain(GENERATED_BY_TRAILER);
    expect(log[1]).toBe("docs: a concurrent push");
    expect(originFile(w.origin, "main", "concurrent.md")).toBe("concurrent\n");
    expect(keys(originFile(w.origin, "main", "CHANGELOG.md")!)).toEqual(["v1.1.0"]);
  });
});
