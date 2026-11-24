/**
 * `mode: sync-changelog` (CONVERSION-PLAN §9.5): release blocks mirrored into
 * CHANGELOG.md with headings shifted, keeping each block's `gen`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load";
import { createGit } from "../../src/core/range/git";
import { outputDigest } from "../../src/core/state/digest";
import { findMarkedBlocks, writeMarkedBlock } from "../../src/core/state/marker";
import { findStoredText, planSink } from "../../src/core/state/planner";
import { syncChangelog } from "../../src/modes/sync-changelog";
import { changelogInner, syncChangelogEntry } from "../../src/outputs/changelog-sink";
import { fakeReleases } from "../helpers/fake-release";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";

const repos: TestRepo[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const r of repos) r.remove();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Release text for a tag, in release form (headings at level 2). */
const notes = (tag: string) =>
  `## ✨ Features\n\n- **Export to CSV** in ${tag} (#2)\n\n## 🐛 Bug Fixes\n\n- Keep empty rows (#3)`;

const gen = (tag: string) => `${tag.replace(/\W/g, "")}0000000000000000`.slice(0, 16);

const block = (tag: string, text = notes(tag), persona = "engineer") =>
  writeMarkedBlock({ key: tag, persona, gen: gen(tag), out: outputDigest(text) }, text);

/** Tags v1.0.0, v1.1.0 and v1.2.0 on commits dated 2026-01-10, 02-01 and 03-01. */
function repoWithReleases(): TestRepo {
  const repo = createTestRepo();
  repos.push(repo);
  for (const [tag, day] of [
    ["v1.0.0", "2026-01-10"],
    ["v1.1.0", "2026-02-01"],
    ["v1.2.0", "2026-03-01"],
    ["v1.3.0", "2026-04-01"],
    ["v1.4.0", "2026-05-01"],
  ]) {
    repo.commit(`chore: release ${tag}`, day);
    repo.tag(tag);
  }
  return repo;
}

function config(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "releaseray-sync-config-"));
  dirs.push(dir);
  return loadConfig({ workspace: dir, overrides });
}

function deps(repo: TestRepo, releases: ReturnType<typeof fakeReleases>) {
  return {
    git: createGit(repo.dir),
    release: releases.api,
    persisted: { release: releases.api, workspace: repo.dir },
  };
}

const DATES: Record<string, string> = {
  "v1.0.0": "2026-01-10",
  "v1.1.0": "2026-02-01",
  "v1.2.0": "2026-03-01",
};

describe("sync-changelog", () => {
  it("writes each release block as an entry with headings shifted, then a second run changes nothing", async () => {
    const repo = repoWithReleases();
    const releases = fakeReleases([
      { tag: "v1.0.0", body: block("v1.0.0") },
      { tag: "v1.1.0", body: `Intro by hand.\r\n\r\n${block("v1.1.0").replace(/\n/g, "\r\n")}` },
      { tag: "v1.2.0", body: block("v1.2.0") },
      { tag: "v1.3.0", body: block("v1.3.0"), draft: true },
      { tag: "v1.4.0", body: "Hosted text, no markers." },
    ]);
    writeFileSync(join(repo.dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- Pending\n");
    const request = { workspace: repo.dir, to: "", allTags: true };

    const first = await syncChangelog(request, config(), deps(repo, releases));
    expect(first.warnings).toEqual([]);
    expect(first.outputs).toMatchObject({
      "changelog-changed": "true",
      "release-changed": "false",
      "llm-calls": "0",
    });
    expect(releases.reads()).toBe(5);
    expect(releases.writes).toEqual([]);
    const text = readFileSync(join(repo.dir, "CHANGELOG.md"), "utf8");
    expect(text.startsWith("# Changelog\n\n## [Unreleased]\n\n- Pending\n\n")).toBe(true);
    const entries = findMarkedBlocks(text);
    expect(entries.map((e) => e.fields.key)).toEqual(["v1.2.0", "v1.1.0", "v1.0.0"]);
    for (const entry of entries) {
      const tag = entry.fields.key;
      expect(entry.fields.gen).toBe(gen(tag));
      expect(entry.inner).toBe(changelogInner({ key: tag, date: DATES[tag], text: notes(tag) }));
      expect(entry.inner).toContain("### ✨ Features");
    }
    for (const [tag, state] of [
      ["v1.2.0", "created"],
      ["v1.3.0", "draft, skipped"],
      ["v1.4.0", "no engineer block"],
    ]) {
      expect(first.summary).toContain(`| \`${tag}\` | ${state} |`);
    }

    // The next generate run sees both targets as current and reuses the text.
    const target = {
      sink: "changelog" as const,
      exists: true,
      text,
      mode: "section" as const,
      onHumanEdit: "skip" as const,
      createIfMissing: true,
    };
    const plan = { key: "v1.1.0", persona: "engineer", gen: gen("v1.1.0"), force: false };
    expect(planSink(target, plan).action).toBe("noop");
    expect(findStoredText([target], plan)?.text).toBe(notes("v1.1.0"));

    const second = await syncChangelog(request, config(), deps(repo, releases));
    expect(second.outputs["changelog-changed"]).toBe("false");
    expect(second.files).toEqual([]);
    expect(readFileSync(join(repo.dir, "CHANGELOG.md"), "utf8")).toBe(text);
  });

  it("mirrors a hand-edited release block, but leaves hand-written CHANGELOG entries unless onHumanEdit is overwrite", async () => {
    const repo = repoWithReleases();
    const edited = `${notes("v1.1.0")}\n\nEdited on the release page.`;
    const releases = fakeReleases([
      // The release block was edited by hand: its text no longer hashes to out.
      { tag: "v1.1.0", body: block("v1.1.0").replace(notes("v1.1.0"), edited) },
      { tag: "v1.2.0", body: block("v1.2.0") },
    ]);
    const file = join(repo.dir, "CHANGELOG.md");
    const synced = syncChangelogEntry("", {
      key: "v1.1.0",
      persona: "engineer",
      gen: gen("v1.1.0"),
      text: notes("v1.1.0"),
      date: DATES["v1.1.0"],
      onHumanEdit: "skip",
    }).content;
    // A hand-written v1.2.0 entry above the v1.1.0 entry ReleaseRay wrote.
    writeFileSync(
      file,
      synced.replace(
        /^(<!-- releaseray:begin)/m,
        "## [v1.2.0] - 2026-03-01\n\n- Written by a person\n\n$1"
      )
    );
    const request = { workspace: repo.dir, to: "", allTags: true };

    const skip = await syncChangelog(request, config(), deps(repo, releases));
    let text = readFileSync(file, "utf8");
    expect(findMarkedBlocks(text).find((b) => b.fields.key === "v1.1.0")!.inner).toBe(
      changelogInner({ key: "v1.1.0", date: DATES["v1.1.0"], text: edited })
    );
    expect(text).toContain("- Written by a person");
    expect(skip.summary).toContain("| `v1.1.0` | updated |");
    expect(skip.summary).toContain("| `v1.2.0` | skipped (hand-written or edited) |");
    expect(skip.warnings.join("\n")).toMatch(/v1\.2\.0/);

    const overwrite = await syncChangelog(
      request,
      config({ outputs: { changelog: { onHumanEdit: "overwrite" } } }),
      deps(repo, releases)
    );
    text = readFileSync(file, "utf8");
    expect(text).not.toContain("- Written by a person");
    expect(findMarkedBlocks(text).map((b) => b.fields.key)).toEqual(["v1.2.0", "v1.1.0"]);
    expect(overwrite.warnings).toEqual([]);
  });

  it("leaves a CHANGELOG entry edited by hand unless onHumanEdit is overwrite", () => {
    const write = {
      key: "v1.0.0",
      persona: "engineer",
      gen: gen("v1.0.0"),
      text: notes("v1.0.0"),
      date: DATES["v1.0.0"],
      onHumanEdit: "skip" as const,
    };
    const written = syncChangelogEntry("", write).content;
    const edited = written.replace("- Keep empty rows", "- Keep empty rows, by hand");
    const newer = { ...write, gen: "ffffffffffffffff", text: `${notes("v1.0.0")}\n\n- More` };
    expect(syncChangelogEntry(edited, newer)).toMatchObject({
      action: "skipped-human",
      content: edited,
    });
    expect(syncChangelogEntry(edited, { ...newer, onHumanEdit: "overwrite" }).action).toBe(
      "updated"
    );
    expect(syncChangelogEntry(written, write).action).toBe("unchanged");
    // Another persona's entry for the same version is not replaced.
    expect(syncChangelogEntry(written, { ...write, persona: "customer" }).action).toBe(
      "skipped-human"
    );
  });
});
