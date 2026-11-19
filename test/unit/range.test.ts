import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReleaseRayError } from "../../src/core/errors";
import { createGit, logCommits, mergedTags } from "../../src/core/range/git";
import {
  assertFullHistory,
  assertSinksAllowed,
  globToRegExp,
  resolveRange,
  type RangeOptions,
} from "../../src/core/range/resolve";
import { createDivergentRepo, createTestRepo, type TestRepo } from "../helpers/git-repo";

const options: RangeOptions = {
  tagPattern: "v*",
  includePrereleases: false,
  allowNonAncestor: false,
  maxPullRequests: 250,
  titlePatterns: [],
};

function failure(fn: () => unknown): ReleaseRayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseRayError);
    expect((error as ReleaseRayError).exitCode).toBe(2);
    return error as ReleaseRayError;
  }
  throw new Error("expected a ReleaseRayError");
}

describe("divergent release lines", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = createDivergentRepo();
  });
  afterAll(() => repo.remove());

  it("has the topology the resolver must handle", () => {
    expect(repo.git("describe", "--tags", "--abbrev=0", "v2.0.0^")).toBe("v0.4.0");
    const git = createGit(repo.dir);
    expect(git.succeeds(["merge-base", "--is-ancestor", "v1.6.0", "v2.0.0"])).toBe(false);
    expect(
      mergedTags(git, "v2.0.0")
        .map((t) => t.name)
        .sort()
    ).toEqual(["v0.4.0", "v0.5.0", "v2.0.0"]);
  });

  it("picks the highest-SemVer ancestor, not the nearest or the highest overall", () => {
    const range = resolveRange(createGit(repo.dir), { kind: "tag", to: "v2.0.0" }, options);
    expect(range.from).toBe("v0.5.0");
    expect(range.key).toBe("v2.0.0");
    expect(range.firstRelease).toBe(false);
    expect(range.prNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 21, 22, 23]);
    expect(range.persisted).toEqual({ githubRelease: true, changelog: true });
  });

  it("rejects an explicit non-ancestor from unless allowed", () => {
    const git = createGit(repo.dir);
    const error = failure(() =>
      resolveRange(git, { kind: "tag", from: "v1.6.0", to: "v2.0.0" }, options)
    );
    expect(error.message).toBe("v1.6.0 is not an ancestor of v2.0.0");
    const allowed = resolveRange(
      git,
      { kind: "tag", from: "v1.6.0", to: "v2.0.0" },
      { ...options, allowNonAncestor: true }
    );
    expect(allowed.from).toBe("v1.6.0");
    expect(allowed.prNumbers).toContain(22);
    expect(allowed.prNumbers).not.toContain(30);
  });

  it("starts a first release at the root commit", () => {
    const range = resolveRange(createGit(repo.dir), { kind: "tag", to: "v0.4.0" }, options);
    expect(range.from).toBeNull();
    expect(range.firstRelease).toBe(true);
    expect(range.commits[0].message).toBe("chore: initial commit");
    expect(range.prNumbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("stops a range over range.maxPullRequests and names the fix", () => {
    const git = createGit(repo.dir);
    const tagged = failure(() =>
      resolveRange(git, { kind: "tag", to: "v2.0.0" }, { ...options, maxPullRequests: 3 })
    );
    expect(tagged.message).toBe(
      "The range references 10 pull requests, over range.maxPullRequests (3)"
    );
    expect(tagged.details[0]).toMatch(/explicit from closer to the release/);

    const first = failure(() =>
      resolveRange(git, { kind: "tag", to: "v0.4.0" }, { ...options, maxPullRequests: 3 })
    );
    expect(first.details[0]).toMatch(/explicit from: there is no earlier tag/);
  });

  it("drops PR numbers whose subject matches an exclusion pattern", () => {
    const range = resolveRange(
      createGit(repo.dir),
      { kind: "tag", to: "v2.0.0" },
      { ...options, titlePatterns: [/^fix:/] }
    );
    expect(range.excludedPRNumbers).toEqual([6, 23]);
    expect(range.prNumbers).not.toContain(23);
  });

  it("previews unreleased changes from the latest ancestor tag", () => {
    const range = resolveRange(
      createGit(repo.dir),
      { kind: "unreleased", today: "2026-09-14" },
      options
    );
    expect(range.key).toBe("unreleased-2026-09-14");
    expect(range.from).toBe("v2.0.0");
    expect(range.commits).toEqual([]);
    expect(range.persisted).toEqual({ githubRelease: false, changelog: false });
  });
});

describe("tag guards", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = createTestRepo();
    repo.commit("feat: one (#1)");
    repo.tag("v1.0.0");
    repo.commit("feat: two (#2)");
    repo.tag("v1.1.0-rc.1");
    repo.commit("feat: three (#3)");
    repo.tag("release-2026-09");
    repo.tag("v1.1.0");
    repo.tag("vnext");
  });
  afterAll(() => repo.remove());

  it("skips prereleases unless includePrereleases", () => {
    const git = createGit(repo.dir);
    expect(resolveRange(git, { kind: "tag", to: "v1.1.0" }, options).from).toBe("v1.0.0");
    expect(
      resolveRange(git, { kind: "tag", to: "v1.1.0" }, { ...options, includePrereleases: true })
        .from
    ).toBe("v1.1.0-rc.1");
  });

  it("notes tags that match the pattern but hold no version", () => {
    const range = resolveRange(createGit(repo.dir), { kind: "tag", to: "v1.1.0" }, options);
    expect(range.notices).toEqual([
      "Ignored tags that match the pattern but hold no SemVer version: vnext",
    ]);
  });

  it("requires an explicit from for a to outside the convention", () => {
    const git = createGit(repo.dir);
    const error = failure(() => resolveRange(git, { kind: "tag", to: "release-2026-09" }, options));
    expect(error.details[0]).toMatch(/^Explicit from required: release-2026-09 holds no SemVer/);
    const explicit = resolveRange(
      git,
      { kind: "tag", from: "v1.0.0", to: "release-2026-09" },
      options
    );
    expect(explicit.prNumbers).toEqual([2, 3]);
  });

  it("fails on unknown or blank tags", () => {
    const git = createGit(repo.dir);
    expect(failure(() => resolveRange(git, { kind: "tag", to: "v9.9.9" }, options)).message).toBe(
      "Tag v9.9.9 does not exist"
    );
    expect(
      failure(() => resolveRange(git, { kind: "tag", from: "v0.0.1", to: "v1.1.0" }, options))
        .message
    ).toBe("Ref v0.0.1 does not exist");
    expect(failure(() => resolveRange(git, { kind: "tag", to: " " }, options)).details[0]).toMatch(
      /workflow_dispatch/
    );
  });
});

describe("date windows", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = createTestRepo();
    repo.commit("feat: january (#1)", "2026-01-15");
    repo.commit("feat: february (#2)", "2026-02-15");
    repo.commit("feat: march (#3)", "2026-03-15");
  });
  afterAll(() => repo.remove());

  it("selects commits between the dates and allows only CHANGELOG", () => {
    const range = resolveRange(
      createGit(repo.dir),
      { kind: "window", since: "2026-02-01", until: "2026-03-01", key: "2026-02" },
      options
    );
    expect(range.prNumbers).toEqual([2]);
    expect(range.key).toBe("2026-02");
    expect(range.persisted).toEqual({ githubRelease: false, changelog: true });
    expect(() =>
      assertSinksAllowed(range, { githubRelease: false, changelog: true })
    ).not.toThrow();
    expect(
      failure(() => assertSinksAllowed(range, { githubRelease: true, changelog: false })).message
    ).toBe("A date window has no tag, so it cannot publish a GitHub Release");
  });

  it("needs a key", () => {
    expect(
      failure(() =>
        resolveRange(createGit(repo.dir), { kind: "window", since: "2026-01-01", key: "" }, options)
      ).message
    ).toBe("A date window needs a key");
  });
});

describe("merge strategy", () => {
  it("warns when a non-empty range names no pull request", () => {
    const repo = createTestRepo();
    try {
      repo.commit("initial");
      repo.tag("v1.0.0");
      repo.commit("add a thing");
      repo.tag("v1.1.0");
      const range = resolveRange(createGit(repo.dir), { kind: "tag", to: "v1.1.0" }, options);
      expect(range.commits).toHaveLength(1);
      expect(range.warnings[0]).toMatch(/Rebase merges are the likely cause/);
    } finally {
      repo.remove();
    }
  });
});

describe("shallow clone guard", () => {
  it("stops a range mode on a depth-1 checkout and names fetch-depth: 0", () => {
    const repo = createDivergentRepo();
    const clone = mkdtempSync(join(tmpdir(), "releaseray-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo.dir}`, clone]);
      const error = failure(() => assertFullHistory(createGit(clone)));
      expect(error.details[0]).toMatch(/fetch-depth: 0/);
      expect(() => assertFullHistory(createGit(repo.dir))).not.toThrow();
    } finally {
      repo.remove();
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("matches tag globs like git", () => {
    expect(globToRegExp("v*").test("v1.2.3")).toBe(true);
    expect(globToRegExp("v*").test("release-1")).toBe(false);
    expect(globToRegExp("pkg/v[0-9]*").test("pkg/v1.0.0")).toBe(true);
    expect(globToRegExp("v?.*").test("v1.0")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("reads multi-line messages with their bodies", () => {
    const repo = createTestRepo();
    try {
      repo.commit("feat: subject (#4)\n\nBody line.\nCloses #9");
      const [commit] = logCommits(createGit(repo.dir), ["HEAD"]);
      expect(commit.message).toBe("feat: subject (#4)\n\nBody line.\nCloses #9");
      expect(commit.authorName).toBe("Test");
    } finally {
      repo.remove();
    }
  });
});
