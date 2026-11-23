import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load";
import { resolveConfig } from "../../src/config/resolve";
import { ReleaseRayError } from "../../src/core/errors";
import { createOctokit, type IssueData, type PullData } from "../../src/core/fetch/github";
import type { LLMProvider } from "../../src/core/llm/provider";
import { createFakeProvider } from "../../src/core/llm/providers/fake";
import { BUNDLED_TEMPLATES } from "../../src/core/prompt/templates";
import { createGit, touchesWorkflows } from "../../src/core/range/git";
import { shiftHeadings } from "../../src/core/render/markdown";
import { findMarkedBlocks } from "../../src/core/state/marker";
import { generate } from "../../src/modes/generate";
import { publish } from "../../src/modes/publish";
import { createReleaseApi } from "../../src/outputs/github-release/sink";
import { GENERATED_BY_TRAILER, pushChangelog } from "../../src/outputs/push";
import { recordedGitHub } from "../helpers/fake-github";
import { fakeReleases } from "../helpers/fake-release";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";

const ROOT = join(__dirname, "..", "..");
const recorded = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/golden/github.json"), "utf8")
) as { pulls: PullData[]; issues: IssueData[] };

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function counting(transform?: (d: Record<string, unknown>) => Record<string, unknown>) {
  let calls = 0;
  const provider: LLMProvider = {
    async generateStructured(...args) {
      calls++;
      return createFakeProvider({ transform }).generateStructured(...args);
    },
  };
  return { provider, calls: () => calls };
}

function config(raw: Record<string, unknown> = {}) {
  return resolveConfig(parseConfig({ version: 1, ...raw }));
}

interface Harness {
  repo: TestRepo;
  releases: ReturnType<typeof fakeReleases>;
  data: { pulls: PullData[]; issues: IssueData[] };
}

async function runGenerate(
  h: Harness,
  cfg = config(),
  opts: { publish?: boolean; llm?: ReturnType<typeof counting> } = {}
) {
  const github = recordedGitHub(h.data);
  const llm = opts.llm ?? counting();
  const readsBefore = h.releases.reads();
  const writesBefore = h.releases.writes.length;
  const out = await generate(
    {
      range: { kind: "tag", to: "v1.2.0" },
      allowSparse: true,
      force: false,
      publish: opts.publish ?? true,
      workspace: h.repo.dir,
    },
    cfg,
    {
      git: createGit(h.repo.dir),
      github: github.reader,
      llm: () => llm.provider,
      templates: BUNDLED_TEMPLATES,
      repo: {
        owner: "acme",
        repo: "widgets",
        serverUrl: "https://github.com",
        visibility: "public",
      },
      priced: false,
      sleep: async () => {},
      now: () => 0,
      release: h.releases.api,
      changelogText: () => {
        const f = join(h.repo.dir, "CHANGELOG.md");
        return existsSync(f) ? readFileSync(f, "utf8") : "";
      },
      persisted: { release: h.releases.api, workspace: h.repo.dir },
    }
  );
  const requests =
    github.requests() +
    (h.releases.reads() - readsBefore) +
    (h.releases.writes.length - writesBefore);
  return { out, llm, requests };
}

function harness(initialBody: string | null = "Intro written by a maintainer.\n"): Harness {
  const repo = createTestRepo();
  repo.commit("chore: initial commit", "2026-01-10");
  repo.tag("v1.1.0");
  repo.commit("feat!: drop Node 18 support (#14)", "2026-05-04");
  repo.commit("perf: parse large files in a stream (#15)", "2026-05-05");
  repo.commit("fix: keep column order when exporting (#17)", "2026-05-07");
  repo.tag("v1.2.0");
  dirs.push(repo.dir);
  return {
    repo,
    releases: fakeReleases(
      initialBody === null
        ? []
        : [{ tag: "v1.2.0", body: initialBody, name: "Custom name", draft: true }]
    ),
    data: structuredClone(recorded),
  };
}

describe("GitHub Release sink", () => {
  it("appends exactly one block and keeps the text above it byte for byte", async () => {
    const h = harness();
    const { out } = await runGenerate(h);
    const body = h.releases.releases.get("v1.2.0")!.body;
    expect(
      body.startsWith(
        "Intro written by a maintainer.\n\n<!-- releaseray:begin v=1 key=v1.2.0 persona=engineer"
      )
    ).toBe(true);
    expect(findMarkedBlocks(body)).toHaveLength(1);
    expect(out.outputs["release-changed"]).toBe("true");
    expect(h.releases.writes).toEqual([{ kind: "update", tag: "v1.2.0", fields: ["body"] }]);
  });

  it("is a no-op on re-run: no LLM call, no write, one request fewer", async () => {
    const h = harness();
    const first = await runGenerate(h);
    const writesBefore = h.releases.writes.length;
    const second = await runGenerate(h);
    expect(second.out.outputs["release-changed"]).toBe("false");
    expect(second.llm.calls()).toBe(0);
    expect(h.releases.writes.length).toBe(writesBefore);
    // R - 1: the same fetch and release lookup, without the write.
    expect(second.requests).toBe(first.requests - 1);
    expect(second.out.run.personas.find((p) => p.id === "engineer")!.status).toBe("stored");
  });

  it("keeps a draft a draft and keeps its name on update", async () => {
    const h = harness();
    await runGenerate(h);
    const release = h.releases.releases.get("v1.2.0")!;
    expect(release).toMatchObject({ draft: true, name: "Custom name" });
  });

  it("skips a hand-edited block when the persona's settings change", async () => {
    const h = harness();
    await runGenerate(h);
    const release = h.releases.releases.get("v1.2.0")!;
    release.body = release.body.replace("## ", "## Edited by hand\n\n## ");
    const writes = h.releases.writes.length;
    const { out } = await runGenerate(
      h,
      config({ personas: [{ slug: "engineer", instructions: "Be brief." }] })
    );
    expect(h.releases.writes.length).toBe(writes);
    expect(out.warnings.some((w) => /edited by hand/.test(w))).toBe(true);
  });

  it("updates once after a PR body edit, then is a no-op", async () => {
    const h = harness();
    await runGenerate(h);
    h.data.pulls.find((p) => p.number === 15)!.body = "Now streams files of any size.";
    const writes = h.releases.writes.length;
    const edited = await runGenerate(h);
    expect(edited.out.outputs["release-changed"]).toBe("true");
    expect(h.releases.writes.length).toBe(writes + 1);
    const again = await runGenerate(h);
    expect(again.out.outputs["release-changed"]).toBe("false");
    expect(again.llm.calls()).toBe(0);
  });

  it("creates a missing release only with createIfMissing, named and marked prerelease by SemVer", async () => {
    const h = harness(null);
    const skipped = await runGenerate(h);
    expect(skipped.out.outputs["release-changed"]).toBe("false");
    expect(skipped.out.warnings.concat(skipped.out.run.notices).join("\n")).toMatch(
      /createIfMissing/
    );

    await runGenerate(h, config({ outputs: { githubRelease: { createIfMissing: true } } }));
    expect(h.releases.releases.get("v1.2.0")).toMatchObject({
      name: "Release v1.2.0",
      prerelease: false,
    });
  });

  it("publishes filtered text: mentions as code, off-allowlist links redacted", async () => {
    const h = harness();
    const llm = counting((draft) => ({
      ...draft,
      highlights: ["Thanks @octocat, see https://evil.example/x"],
    }));
    await runGenerate(h, config(), { llm });
    const body = h.releases.releases.get("v1.2.0")!.body;
    expect(body).toContain("Thanks `@octocat`, see [redacted]");
  });

  it("names the token rule when a workflow-changing release cannot be created", async () => {
    const h = harness(null);
    h.releases.api.failCreate = Object.assign(new Error("Not Found"), { status: 404 });
    try {
      await runGenerate(h, config({ outputs: { githubRelease: { createIfMissing: true } } }));
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).exitCode).toBe(3);
    }
  });
});

describe("workflow-file detection", () => {
  it("sees workflow changes in a merge commit's first-parent diff", () => {
    const repo = createTestRepo();
    dirs.push(repo.dir);
    repo.commit("initial");
    repo.git("checkout", "-q", "-b", "ci");
    mkdirSync(join(repo.dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo.dir, ".github/workflows/ci.yml"), "on: push\n");
    repo.git("add", ".github/workflows/ci.yml");
    repo.git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "ci");
    repo.git("checkout", "-q", "main");
    repo.git(
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge pull request #2",
      "ci"
    );
    const git = createGit(repo.dir);
    expect(git.run(["diff-tree", "-r", "--name-only", "--no-commit-id", "HEAD"])).toBe("");
    expect(touchesWorkflows(git, "HEAD")).toBe(true);
    expect(touchesWorkflows(git, "HEAD^")).toBe(false);
  });
});

describe("CHANGELOG sink", () => {
  const withChangelog = config({ outputs: { changelog: { enabled: true } } });

  it("writes a marked entry below Unreleased, and repairs a lost entry from the release block with no LLM call", async () => {
    const h = harness();
    writeFileSync(
      join(h.repo.dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n- Pending\n\n## [v1.1.0] - 2026-01-10\n\n- First\n"
    );
    await runGenerate(h, withChangelog);
    const text = readFileSync(join(h.repo.dir, "CHANGELOG.md"), "utf8");
    expect(text.indexOf("## [Unreleased]")).toBeLessThan(text.indexOf("## [v1.2.0] - 2026-05-07"));
    expect(text.indexOf("## [v1.2.0]")).toBeLessThan(text.indexOf("## [v1.1.0]"));

    // The push failed; the CHANGELOG was never written. A re-run reuses the release block.
    rmSync(join(h.repo.dir, "CHANGELOG.md"));
    const repair = await runGenerate(h, withChangelog);
    expect(repair.llm.calls()).toBe(0);
    expect(repair.out.outputs).toMatchObject({
      "release-changed": "false",
      "changelog-changed": "true",
    });
    const repaired = readFileSync(join(h.repo.dir, "CHANGELOG.md"), "utf8");
    const [releaseBlock] = findMarkedBlocks(h.releases.releases.get("v1.2.0")!.body);
    const [entry] = findMarkedBlocks(repaired);
    expect(entry.inner).toBe(`## [v1.2.0] - 2026-05-07\n\n${shiftHeadings(releaseBlock.inner, 1)}`);
  });
});

describe("push loop", () => {
  function remoteWithClone() {
    const origin = tmp("releaseray-origin-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = createTestRepo();
    dirs.push(seed.dir);
    seed.commit("initial");
    seed.git("push", "-q", origin, "main");
    const clone = tmp("releaseray-clone-");
    execFileSync("git", ["clone", "-q", origin, clone]);
    return { origin, clone };
  }

  const base = (clone: string) => ({
    workspace: clone,
    branch: "main",
    path: "CHANGELOG.md",
    serverUrl: "https://github.com",
    token: "test-token",
    message: "docs(changelog): v1.2.0",
    key: "v1.2.0",
    author: {
      name: "github-actions[bot]",
      email: "41898282+github-actions[bot]@users.noreply.github.com",
    },
    setSecret: () => {},
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });

  it("pushes a fast-forward commit with the trailers without touching the workspace", () => {
    const { origin, clone } = remoteWithClone();
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" });
    const result = pushChangelog({ ...base(clone), apply: (t) => `${t}## [v1.2.0]\n` });
    expect(result).toMatchObject({ pushed: true, attempts: 1 });
    const log = execFileSync("git", ["log", "-1", "--format=%an%n%B", "main"], {
      cwd: origin,
      encoding: "utf8",
    });
    expect(log).toContain("github-actions[bot]");
    expect(log).toContain(GENERATED_BY_TRAILER);
    expect(log).toContain("ReleaseRay-Key: v1.2.0");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" })).toBe(
      headBefore
    );
  });

  it("re-applies on a fresh fetch after a non-fast-forward rejection", () => {
    const { origin, clone } = remoteWithClone();
    const other = tmp("releaseray-other-");
    execFileSync("git", ["clone", "-q", origin, other]);
    const result = pushChangelog({
      ...base(clone),
      apply: (t) => (t.includes("v1.2.0") ? null : `${t}## [v1.2.0]\n`),
      beforePush: (attempt) => {
        if (attempt === 1) {
          writeFileSync(join(other, "CHANGELOG.md"), "## [v1.1.9]\n");
          execFileSync("git", ["add", "CHANGELOG.md"], { cwd: other });
          execFileSync(
            "git",
            ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "other"],
            { cwd: other }
          );
          execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });
        }
      },
    });
    expect(result).toMatchObject({ pushed: true, attempts: 2 });
    const text = execFileSync("git", ["show", "main:CHANGELOG.md"], {
      cwd: origin,
      encoding: "utf8",
    });
    expect(text).toBe("## [v1.1.9]\n## [v1.2.0]\n");
  });

  it("exits 6 with guidance when protection rejects the push", () => {
    const { origin, clone } = remoteWithClone();
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(
      hook,
      '#!/bin/sh\necho "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n'
    );
    chmodSync(hook, 0o755);
    try {
      pushChangelog({ ...base(clone), apply: (t) => `${t}x\n` });
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).exitCode).toBe(6);
      expect((error as ReleaseRayError).details.join("\n")).toMatch(/bypass list|app-token/);
    }
  });

  it("gives up after 3 non-fast-forward rejections", () => {
    const { origin, clone } = remoteWithClone();
    const other = tmp("releaseray-other-");
    execFileSync("git", ["clone", "-q", origin, other]);
    let n = 0;
    try {
      pushChangelog({
        ...base(clone),
        apply: (t) => `${t}entry\n`,
        beforePush: () => {
          writeFileSync(join(other, `f${n++}.txt`), "x");
          execFileSync("git", ["add", "."], { cwd: other });
          execFileSync(
            "git",
            ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "race"],
            { cwd: other }
          );
          execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).exitCode).toBe(6);
      expect((error as ReleaseRayError).message).toMatch(/rejected 3 times/);
    }
  });
});

describe("publish mode", () => {
  let h: Harness;
  let notesDir: string;
  let digest: string;
  beforeAll(async () => {
    h = harness();
    const { out } = await runGenerate(h, config(), { publish: false });
    notesDir = out.outputs["notes-dir"];
    digest = out.outputs["notes-digest"];
  });

  it("refuses a notes.json with a different digest and writes nothing", async () => {
    await expect(
      publish({ workspace: h.repo.dir, notesDir, expectedDigest: "0".repeat(64) }, config(), {
        release: h.releases.api,
        workspace: h.repo.dir,
      })
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(h.releases.writes).toEqual([]);
  });

  it("writes from notes.json with no LLM call, then is a no-op", async () => {
    const first = await publish(
      { workspace: h.repo.dir, notesDir, expectedDigest: digest },
      config(),
      {
        release: h.releases.api,
        workspace: h.repo.dir,
      }
    );
    expect(first.outputs).toMatchObject({ "release-changed": "true", "llm-calls": "0" });
    const second = await publish(
      { workspace: h.repo.dir, notesDir, expectedDigest: digest },
      config(),
      {
        release: h.releases.api,
        workspace: h.repo.dir,
      }
    );
    expect(second.outputs["release-changed"]).toBe("false");
    expect(h.releases.writes).toHaveLength(1);
  });
});

describe("release lookup", () => {
  /** An Octokit whose fetch answers from a route table and logs the routes asked. */
  function api(routes: Record<string, { status: number; body: unknown }>) {
    const asked: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const key = `${init?.method ?? "GET"} ${path}`;
      asked.push(key);
      const hit = routes[key] ?? { status: 404, body: { message: "Not Found" } };
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { "content-type": "application/json" },
      });
    };
    const { octokit } = createOctokit({
      token: "t",
      concurrency: 1,
      maxWaitMinutes: 0,
      sleep: async () => {},
      now: () => 0,
      fetch,
    });
    return { releases: createReleaseApi(octokit, { owner: "acme", repo: "widgets" }), asked };
  }

  it("finds a draft for the tag, which get-by-tag does not return", async () => {
    const { releases, asked } = api({
      "GET /repos/acme/widgets/releases": {
        status: 200,
        body: [
          { id: 7, tag_name: "v1.2.0", draft: true, body: "Draft text", html_url: "https://x/7" },
          { id: 6, tag_name: "v1.1.0", draft: false, body: "", html_url: "https://x/6" },
        ],
      },
    });
    expect(await releases.get("v1.2.0")).toEqual({ id: 7, body: "Draft text", url: "https://x/7" });
    expect(await releases.get("v1.1.0")).toBeNull();
    expect(asked).toEqual([
      "GET /repos/acme/widgets/releases/tags/v1.2.0",
      "GET /repos/acme/widgets/releases",
      "GET /repos/acme/widgets/releases/tags/v1.1.0",
      "GET /repos/acme/widgets/releases",
    ]);
  });

  it("uses a published release without listing", async () => {
    const { releases, asked } = api({
      "GET /repos/acme/widgets/releases/tags/v1.2.0": {
        status: 200,
        body: { id: 8, tag_name: "v1.2.0", draft: false, body: "Hi", html_url: "https://x/8" },
      },
    });
    expect(await releases.get("v1.2.0")).toEqual({ id: 8, body: "Hi", url: "https://x/8" });
    expect(asked).toEqual(["GET /repos/acme/widgets/releases/tags/v1.2.0"]);
  });
});
