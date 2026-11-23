/**
 * Flow 1 (release-notes.yml) against the fake GitHub: Phase 3 criteria 1,
 * 2, 5, 6, 7, 8, 12 and 16.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findMarkedBlocks, parseMarkerLine } from "../../src/core/state/marker";
import { cleanup, cloneWorkspace } from "./harness/git-fixture";
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

const lf = (text: string) => text.replace(/\r\n/g, "\n");
const blocks = (body: string, key: string) =>
  findMarkedBlocks(lf(body)).filter((b) => b.fields.key === key);

describe("3.1 append once, 3.2 re-run is a no-op, 3.9 blank dispatch inputs", () => {
  it("appends one block below the text, then a re-run reads and writes nothing more", async () => {
    const w = await world();
    const human = "Hand-written introduction.\n\nIt stays above the generated notes.";
    w.gh.addRelease({ tag: "v1.1.0", body: human });

    const first = await w.releasePublished("v1.1.0");
    expect(first.errors).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.outputs).toMatchObject({ "release-changed": "true", "exit-code": "0" });
    expect(Number(first.outputs["llm-calls"])).toBeGreaterThan(0);
    const body = w.gh.release("v1.1.0")!.body;
    expect(body.startsWith(human)).toBe(true);
    expect(blocks(body, "v1.1.0")).toHaveLength(1);
    // The Action's request count matches what the server saw.
    expect(Number(first.outputs["github-requests"])).toBe(w.gh.counted());
    expect(w.gh.writes()).toHaveLength(1);

    const before = w.gh.counted();
    const second = await w.releasePublished("v1.1.0");
    expect(second.code).toBe(0);
    expect(second.outputs).toMatchObject({ "release-changed": "false", "llm-calls": "0" });
    expect(Number(second.outputs["github-requests"])).toBe(
      Number(first.outputs["github-requests"]) - 1
    );
    expect(w.gh.counted() - before).toBe(Number(second.outputs["github-requests"]));
    expect(w.gh.writes()).toHaveLength(1);
    expect(w.gh.release("v1.1.0")!.body).toBe(body);
  });
});

describe("3.5 human edit", () => {
  it("leaves a hand-edited block alone when the persona instructions change", async () => {
    const w = await world({ config: "version: 1\n" });
    w.gh.addRelease({ tag: "v1.1.0" });
    expect((await w.releasePublished("v1.1.0")).code).toBe(0);
    const release = w.gh.release("v1.1.0")!;
    const [block] = blocks(release.body, "v1.1.0");
    release.body = release.body.replace(block.inner, `Edited by a person.\n\n${block.inner}`);
    const edited = release.body;
    const writes = w.gh.writes().length;

    const workspace = cloneWorkspace(w.origin);
    writeFileSync(
      join(workspace, ".releaseray", "config.yml"),
      "version: 1\npersonas:\n  - slug: engineer\n    instructions: Name the area each change touches.\n"
    );
    const run = await w.run({
      workspace,
      event: "workflow_dispatch",
      payload: { inputs: { to: "v1.1.0", publish: "true" } },
      inputs: { to: "v1.1.0", publish: "true" },
    });
    expect(run.code).toBe(0);
    expect(run.outputs["release-changed"]).toBe("false");
    expect(run.warnings.some((m) => m.includes("edited by hand"))).toBe(true);
    expect(w.gh.writes()).toHaveLength(writes);
    expect(w.gh.release("v1.1.0")!.body).toBe(edited);
  });
});

describe("3.6 PR body edit", () => {
  it("updates the release once after a body edit; the next dispatch is a no-op", async () => {
    const w = await world();
    w.gh.addRelease({ tag: "v1.1.0" });
    expect((await w.dispatch("v1.1.0", { publish: "true" })).outputs["release-changed"]).toBe(
      "true"
    );

    w.gh.pulls.get(3)!.body = "Empty rows are kept now. Edited after publishing.";
    const edited = await w.dispatch("v1.1.0", { publish: "true" });
    expect(edited.code).toBe(0);
    expect(edited.outputs["release-changed"]).toBe("true");

    const again = await w.dispatch("v1.1.0", { publish: "true" });
    expect(again.code).toBe(0);
    expect(again.outputs).toMatchObject({ "release-changed": "false", "llm-calls": "0" });
    expect(w.gh.writes()).toHaveLength(2);
  });
});

describe("3.7 comment only", () => {
  it("ignores a new comment when comments are off", async () => {
    const w = await world();
    w.gh.addRelease({ tag: "v1.1.0" });
    expect((await w.releasePublished("v1.1.0")).code).toBe(0);
    w.gh.comments.push({
      number: 3,
      author: "octo-dev",
      body: "Looks good to me.",
      association: "MEMBER",
      kind: "comment",
    });
    const rerun = await w.releasePublished("v1.1.0");
    expect(rerun.code).toBe(0);
    expect(rerun.outputs).toMatchObject({ "release-changed": "false", "llm-calls": "0" });
    expect(w.gh.log.some((l) => l.route.endsWith("/comments"))).toBe(false);
  });
});

describe("3.8 draft and name", () => {
  it("updates a draft release, which stays a draft and keeps its name", async () => {
    const w = await world();
    w.gh.addRelease({
      tag: "v1.1.0",
      draft: true,
      name: "A name a person chose",
      body: "Draft introduction.",
    });
    const run = await w.dispatch("v1.1.0", { publish: "true" });
    expect(run.errors).toEqual([]);
    expect(run.outputs["release-changed"]).toBe("true");
    const release = w.gh.release("v1.1.0")!;
    expect(release).toMatchObject({ draft: true, name: "A name a person chose" });
    expect(release.body.startsWith("Draft introduction.")).toBe(true);
    expect(blocks(release.body, "v1.1.0")).toHaveLength(1);
  });
});

describe("3.12 marker round-trip", () => {
  it("writes markers that read back unchanged, even with CRLF line endings", async () => {
    const w = await world({ github: { crlfReleaseBodies: true } });
    w.gh.addRelease({ tag: "v1.1.0" });
    expect((await w.releasePublished("v1.1.0")).code).toBe(0);
    const stored = w.gh.release("v1.1.0")!.body;
    const lines = stored.split("\n").filter((l) => l.startsWith("<!-- releaseray:"));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => parseMarkerLine(l)?.type)).toEqual(["begin", "end"]);

    const rerun = await w.releasePublished("v1.1.0");
    expect(rerun.outputs).toMatchObject({ "release-changed": "false", "llm-calls": "0" });
    expect(w.gh.release("v1.1.0")!.body).toBe(stored);
  });
});

describe("3.16 published text is filtered", () => {
  it("publishes a mention as inline code and redacts an off-allowlist link", async () => {
    const w = await world({
      pulls: [
        {
          number: 2,
          title: "feat: greet @octocat and link https://evil.example.com/phish",
          body: "Adds a greeting.",
        },
        { number: 3, title: "fix: keep empty rows on import" },
      ],
    });
    w.gh.addRelease({ tag: "v1.1.0" });
    const run = await w.releasePublished("v1.1.0");
    expect(run.code).toBe(0);
    const body = w.gh.release("v1.1.0")!.body;
    expect(body).toContain("`@octocat`");
    expect(body.replace(/`@octocat`/g, "")).not.toMatch(/@octocat/);
    expect(body).not.toContain("evil.example.com");
  });
});
