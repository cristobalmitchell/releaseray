/**
 * The migrate job of the tools workflow (releaseray-tools.yml): `adopt` and
 * `sync-changelog` with no model key, then the release-notes flows over what
 * they wrote. Phase 5 criteria 3 and 4.
 */
import { afterAll, describe, expect, it } from "vitest";
import { findMarkedBlocks } from "../../src/core/state/marker";
import { changelogInner } from "../../src/outputs/changelog-sink";
import { GENERATED_BY_TRAILER } from "../../src/outputs/push";
import { cleanup, cloneWorkspace, git, originFile } from "./harness/git-fixture";
import { buildWorld, type World } from "./harness/world";

/** A release body the way the hosted App wrote it: no markers. */
const HOSTED_BODY = [
  "## What's Changed",
  "",
  "### ✨ New Features",
  "",
  "- **Add CSV export** (#2)",
  "",
  "### 🐛 Bug Fixes",
  "",
  "- **Keep empty rows on import** (#3)",
  "",
  "### ⚡ Performance",
  "",
  "- **Cache tag lookups** (#4)",
  "",
  "**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0",
].join("\n");

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

/**
 * The migrate job: a dispatch on a checkout of the default branch, with the
 * step inputs the workflow passes and no model key or fake model.
 */
function migrate(
  w: World,
  dispatch: { mode: "adopt" | "sync-changelog"; to?: string; all_tags?: boolean; push?: boolean }
) {
  return w.run({
    workspace: cloneWorkspace(w.origin, { ref: "main" }),
    event: "workflow_dispatch",
    payload: { inputs: dispatch },
    inputs: {
      mode: dispatch.mode,
      to: dispatch.to ?? "",
      "all-tags": String(dispatch.all_tags ?? false),
      push: String(dispatch.push ?? false),
    },
    fakeModel: false,
  });
}

const head = (w: World) => git(["rev-parse", "refs/heads/main"], { cwd: w.origin.dir });

describe("5.3 adopt", () => {
  it("marks a hosted-App release body, and the next Flow 1 run makes no LLM call and no write", async () => {
    const w = await world();
    w.gh.addRelease({ tag: "v1.1.0", body: HOSTED_BODY });

    const adopted = await migrate(w, { mode: "adopt", to: "v1.1.0" });
    expect(adopted.errors).toEqual([]);
    expect(adopted.code).toBe(0);
    expect(adopted.outputs).toMatchObject({
      key: "v1.1.0",
      "release-changed": "true",
      "llm-calls": "0",
    });
    expect(w.gh.writes().map((l) => l.route)).toEqual([
      "PATCH /repos/{owner}/{repo}/releases/{release_id}",
    ]);
    const body = w.gh.release("v1.1.0")!.body;
    const [block] = findMarkedBlocks(body);
    expect(block.fields).toMatchObject({ key: "v1.1.0", persona: "engineer", gen: "adopted" });
    expect(block.inner).toBe(HOSTED_BODY);
    expect(Number(adopted.outputs["github-requests"])).toBe(w.gh.counted());

    const writes = w.gh.writes().length;
    const flow1 = await w.releasePublished("v1.1.0");
    expect(flow1.errors).toEqual([]);
    expect(flow1.code).toBe(0);
    expect(flow1.outputs).toMatchObject({
      "llm-calls": "0",
      "release-changed": "false",
      "changelog-changed": "false",
    });
    expect(flow1.warnings.join("\n")).not.toMatch(/without ReleaseRay markers/);
    expect(w.gh.writes()).toHaveLength(writes);
    expect(w.gh.release("v1.1.0")!.body).toBe(body);
  });

  it("also marks and pushes an unmarked CHANGELOG entry, and a Flow 2 run then pushes nothing", async () => {
    const changelog = [
      "# Changelog",
      "",
      "## [v1.1.0] - 2026-11-01",
      "",
      "### Features",
      "",
      "- Add CSV export (#2)",
      "",
    ].join("\n");
    const w = await world({
      config: "version: 1\noutputs:\n  changelog:\n    enabled: true\n",
      files: { "CHANGELOG.md": changelog },
    });
    w.gh.addRelease({ tag: "v1.1.0", body: HOSTED_BODY });
    const before = head(w);

    const adopted = await migrate(w, { mode: "adopt", all_tags: true, push: true });
    expect(adopted.errors).toEqual([]);
    expect(adopted.code).toBe(0);
    expect(adopted.outputs).toMatchObject({
      "release-changed": "true",
      "changelog-changed": "true",
      "llm-calls": "0",
    });
    expect(adopted.summary).toContain("| `v1.0.0` | no release | no entry |");
    expect(adopted.summary).toContain("| `v1.1.0` | adopted | adopted |");
    const pushed = originFile(w.origin, "main", "CHANGELOG.md")!;
    const [entry] = findMarkedBlocks(pushed);
    expect(entry.fields).toMatchObject({ key: "v1.1.0", gen: "adopted" });
    expect(entry.inner).toBe("## [v1.1.0] - 2026-11-01\n\n### Features\n\n- Add CSV export (#2)");
    const commit = git(["log", "-1", "--format=%B", "refs/heads/main"], { cwd: w.origin.dir });
    expect(commit).toContain(GENERATED_BY_TRAILER);
    expect(git(["rev-parse", "refs/heads/main^"], { cwd: w.origin.dir })).toBe(before);

    const after = head(w);
    const writes = w.gh.writes().length;
    const flow2 = await w.tagPushed("v1.1.0");
    expect(flow2.errors).toEqual([]);
    expect(flow2.code).toBe(0);
    expect(flow2.outputs).toMatchObject({
      "llm-calls": "0",
      "release-changed": "false",
      "changelog-changed": "false",
    });
    expect(w.gh.writes()).toHaveLength(writes);
    expect(head(w)).toBe(after);
  });
});

describe("5.4 sync-changelog", () => {
  it("writes three release blocks as CHANGELOG entries with headings shifted, and a second run makes no commit", async () => {
    const w = await world({
      tags: (m) => ({ "v1.0.0": m.merges[0], "v1.1.0": m.merges[1], "v1.2.0": m.merges[2] }),
    });
    const tags = ["v1.0.0", "v1.1.0", "v1.2.0"];
    for (const tag of tags) {
      w.gh.addRelease({ tag });
      const published = await w.releasePublished(tag);
      expect(published.code, tag).toBe(0);
    }
    const before = head(w);
    const writes = w.gh.writes().length;

    const synced = await migrate(w, { mode: "sync-changelog", all_tags: true, push: true });
    expect(synced.errors).toEqual([]);
    expect(synced.code).toBe(0);
    expect(synced.outputs).toMatchObject({ "changelog-changed": "true", "llm-calls": "0" });
    expect(w.gh.writes()).toHaveLength(writes);
    expect(git(["rev-parse", "refs/heads/main^"], { cwd: w.origin.dir })).toBe(before);
    const text = originFile(w.origin, "main", "CHANGELOG.md")!;
    const entries = findMarkedBlocks(text);
    expect(entries.map((e) => e.fields.key)).toEqual(["v1.2.0", "v1.1.0", "v1.0.0"]);
    for (const entry of entries) {
      const tag = entry.fields.key;
      const [block] = findMarkedBlocks(w.gh.release(tag)!.body);
      const date = git(["log", "-1", "--format=%cs", tag], { cwd: w.origin.dir });
      expect(entry.inner).toBe(changelogInner({ key: tag, date, text: block.inner }));
      expect(entry.fields.gen).toBe(block.fields.gen);
    }

    const after = head(w);
    const again = await migrate(w, { mode: "sync-changelog", all_tags: true, push: true });
    expect(again.errors).toEqual([]);
    expect(again.code).toBe(0);
    expect(again.outputs["changelog-changed"]).toBe("false");
    expect(head(w)).toBe(after);
  });

  it("exits 2 on a shallow checkout and when neither to nor all-tags is given", async () => {
    const w = await world();
    const shallow = await w.run({
      workspace: cloneWorkspace(w.origin, { depth: 1 }),
      event: "workflow_dispatch",
      inputs: { mode: "sync-changelog", "all-tags": "true" },
      fakeModel: false,
    });
    expect(shallow.code).toBe(2);
    expect(shallow.errors.join("\n")).toContain("fetch-depth: 0");
    const none = await migrate(w, { mode: "adopt" });
    expect(none.code).toBe(2);
    expect(none.errors.join("\n")).toMatch(/No tag to act on/);
    expect(w.gh.log).toEqual([]);
  });
});
