import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load";
import { resolveConfig } from "../../src/config/resolve";
import type { IssueData, PullData } from "../../src/core/fetch/github";
import { createFakeProvider } from "../../src/core/llm/providers/fake";
import { BUNDLED_TEMPLATES } from "../../src/core/prompt/templates";
import { createGit } from "../../src/core/range/git";
import { run, type RepoContext, type RunRequest } from "../../src/core/run";
import { findMarkedBlocks } from "../../src/core/state/marker";
import { writeNotesFiles } from "../../src/outputs/files";
import { renderSummary } from "../../src/outputs/summary";
import { recordedGitHub } from "../helpers/fake-github";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";

const GOLDEN = join(__dirname, "..", "fixtures", "golden");
const data = JSON.parse(readFileSync(join(GOLDEN, "github.json"), "utf8")) as {
  pulls: PullData[];
  issues: IssueData[];
};

/** Three tags; v1.2.0 holds PRs 14 to 17. */
function goldenRepo(): TestRepo {
  const repo = createTestRepo();
  repo.commit("chore: initial commit", "2026-01-10");
  repo.tag("v1.0.0");
  repo.commit("feat(export): add CSV export (#11)", "2026-03-02");
  repo.commit("fix: handle empty rows in the importer (#12)", "2026-03-03");
  repo.tag("v1.1.0", "HEAD", true);
  repo.commit("feat!: drop Node 18 support (#14)", "2026-05-04");
  repo.commit("perf: parse large files in a stream (#15)", "2026-05-05");
  repo.commit("chore(deps): bump zod to 4.1 (#16)", "2026-05-06");
  repo.commit("fix: keep column order when exporting (#17)", "2026-05-07");
  repo.tag("v1.2.0");
  return repo;
}

const config = resolveConfig(
  parseConfig({ version: 1, classification: { exclude: { authors: ["renovate[bot]"] } } })
);
const request: RunRequest = {
  range: { kind: "tag", to: "v1.2.0" },
  allowSparse: false,
  force: false,
  publish: false,
};

function deps(repo: TestRepo, visibility: RepoContext["visibility"] = "public") {
  const github = recordedGitHub(data);
  return {
    github,
    deps: {
      git: createGit(repo.dir),
      github: github.reader,
      llm: () => createFakeProvider(),
      templates: BUNDLED_TEMPLATES,
      repo: { owner: "acme", repo: "widgets", serverUrl: "https://github.com", visibility },
      priced: false,
      sleep: async () => {},
      now: () => Date.parse("2026-09-14T12:00:00Z"),
    },
  };
}

describe("golden output", () => {
  let repo: TestRepo;
  const workspaces: string[] = [];
  beforeAll(() => {
    repo = goldenRepo();
  });
  afterAll(() => {
    repo.remove();
    for (const w of workspaces) rmSync(w, { recursive: true, force: true });
  });

  async function generate(): Promise<Record<string, string>> {
    const workspace = mkdtempSync(join(tmpdir(), "releaseray-golden-"));
    workspaces.push(workspace);
    const result = await run(request, config, deps(repo).deps);
    const files = writeNotesFiles(result, workspace, ".releaseray/notes");
    return Object.fromEntries(
      files.map((f) => [
        f.replace(".releaseray/notes/", ""),
        readFileSync(join(workspace, f), "utf8"),
      ])
    );
  }

  it("writes byte-identical persona files and notes.json on every run", async () => {
    const first = await generate();
    const second = await generate();
    expect(Object.keys(first).sort()).toEqual([
      "v1.2.0/customer.md",
      "v1.2.0/engineer.md",
      "v1.2.0/notes.json",
    ]);
    expect(second).toEqual(first);

    if (process.env.UPDATE_GOLDEN === "1") {
      for (const [file, text] of Object.entries(first)) {
        mkdirSync(join(GOLDEN, "v1.2.0"), { recursive: true });
        writeFileSync(join(GOLDEN, file), text);
      }
    }
    for (const [file, text] of Object.entries(first)) {
      expect(existsSync(join(GOLDEN, file)), `${file} is committed`).toBe(true);
      expect(text).toBe(readFileSync(join(GOLDEN, file), "utf8"));
    }
  });
});

describe("run", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = goldenRepo();
  });
  afterAll(() => repo.remove());

  it("fetches once, records completeness, and grounds every ref", async () => {
    const { deps: d, github } = deps(repo);
    const result = await run(request, config, d);
    expect(result.range.from).toBe("v1.1.0");
    expect(result.completeness).toEqual([
      { number: 14, state: "fetched" },
      { number: 15, state: "fetched" },
      { number: 16, state: "excluded", rule: "author renovate[bot]" },
      { number: 17, state: "fetched" },
    ]);
    // 4 PRs + 1 linked issue (#31).
    expect(github.requests()).toBe(5);
    const engineer = result.personas.find((p) => p.id === "engineer")!;
    expect(engineer.status).toBe("generated");
    expect(engineer.report?.hallucinatedRefs).toBe(0);
    expect(engineer.text).toContain("(#14)");
    expect(engineer.text).toContain(
      "**Full Changelog**: [v1.1.0...v1.2.0](https://github.com/acme/widgets/compare/v1.1.0...v1.2.0)"
    );
    expect(engineer.text).not.toContain("#16");
  });

  it("withholds the internal persona on a public repository and includes it on a private one", async () => {
    const pub = await run(request, config, deps(repo, "public").deps);
    const internal = pub.personas.find((p) => p.id === "internal")!;
    expect(internal.status).toBe("skipped");
    expect(internal.sinks).toMatchObject({ summary: false, files: false });
    expect(renderSummary(pub)).toContain("Internal (CSM): internal persona withheld");

    const priv = await run(request, config, deps(repo, "private").deps);
    expect(priv.personas.find((p) => p.id === "internal")!.status).toBe("generated");
  });

  it("keeps internal changes out of the customer persona", async () => {
    const result = await run(request, config, deps(repo).deps);
    const customer = result.personas.find((p) => p.id === "customer")!;
    expect(customer.text).not.toMatch(/Internal/);
  });

  it("writes marker blocks whose out digest matches their text", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "releaseray-files-"));
    try {
      const result = await run(request, config, deps(repo).deps);
      writeNotesFiles(result, workspace, ".releaseray/notes");
      const text = readFileSync(join(workspace, ".releaseray/notes/v1.2.0/engineer.md"), "utf8");
      const [block] = findMarkedBlocks(text);
      const engineer = result.personas.find((p) => p.id === "engineer")!;
      expect(block.fields).toEqual({
        key: "v1.2.0",
        persona: "engineer",
        gen: engineer.gen,
        out: engineer.out,
      });
      expect(block.inner).toBe(engineer.text);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to commit messages when no commit names a PR", async () => {
    const plain = createTestRepo();
    try {
      plain.commit("initial");
      plain.tag("v0.1.0");
      plain.commit("feat: add a search box to the header so people can find pages quickly");
      plain.commit("fix: stop the sidebar from collapsing when the window is resized");
      plain.commit("docs: explain how to configure the search index in the README file");
      plain.tag("v0.2.0");
      const result = await run(
        { ...request, range: { kind: "tag", to: "v0.2.0" } },
        config,
        deps(plain).deps
      );
      expect(result.commitOnly).toBe(true);
      expect(result.warnings[0]).toMatch(/Rebase merges/);
      expect(result.personas.find((p) => p.id === "engineer")!.status).toBe("generated");
    } finally {
      plain.remove();
    }
  });

  it("generates only the requested personas", async () => {
    const result = await run({ ...request, personas: ["customer"] }, config, deps(repo).deps);
    expect(result.personas.map((p) => p.id)).toEqual(["customer"]);
  });
});

describe("summary", () => {
  it("truncates at the byte budget with a pointer to the files", async () => {
    const { truncateSummary } = await import("../../src/outputs/summary");
    const long = Array.from({ length: 2000 }, (_, i) => `- line ${i} ✓`).join("\n");
    const cut = truncateSummary(long, 1024, "See notes.json.");
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(1024);
    expect(cut).toMatch(/> \*\*Truncated\.\*\* See notes\.json\.\n$/);
    const synthetic = "x".repeat(1.2 * 1024 * 1024);
    expect(
      Buffer.byteLength(truncateSummary(synthetic, 900 * 1024, "p"), "utf8")
    ).toBeLessThanOrEqual(900 * 1024);
  });
});
