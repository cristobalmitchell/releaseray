import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway git repository for range tests. */
export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  /** Commits an empty change with the message and an author date of `day` (YYYY-MM-DD). */
  commit(message: string, day?: string): string;
  tag(name: string, ref?: string, annotated?: boolean): void;
  remove(): void;
}

let counter = 0;

/**
 * Creates an empty repository with a fixed identity and no global config.
 *
 * @returns The repository
 */
export function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "releaseray-repo-"));
  const env = (day: string) => ({
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: `${day}T12:00:00Z`,
    GIT_COMMITTER_DATE: `${day}T12:00:00Z`,
  });
  const run = (args: string[], day = "2026-01-01") =>
    execFileSync("git", args, { cwd: dir, env: env(day), encoding: "utf8" }).replace(/\n$/, "");
  run(["init", "-q", "-b", "main"]);
  return {
    dir,
    git: (...args) => run(args),
    commit(message, day = "2026-01-01") {
      // One new file per commit, so branches never conflict when merged.
      const file = `change-${counter++}.txt`;
      writeFileSync(join(dir, file), message);
      run(["add", file], day);
      run(["commit", "-q", "-m", message], day);
      return run(["rev-parse", "HEAD"]);
    },
    tag(name, ref = "HEAD", annotated = false) {
      run(annotated ? ["tag", "-a", name, "-m", name, ref] : ["tag", name, ref]);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Builds the topology the range resolver must handle (CONVERSION-PLAN §12.2,
 * Phase 2 criterion 4):
 *
 * ```text
 * main:  c0 ─ m1…m5 ─ c6 (v0.4.0) ─ c7 ─ M ─ c9 ─ c10 (v2.0.0)
 *         \                 \           /
 *          s1 (v0.5.0) ──────┼──────────
 *                             \
 *                              x1 (v1.6.0, never merged)
 * ```
 *
 * `v0.5.0` and `v0.4.0` are both ancestors of `v2.0.0`; `git describe` on
 * `v2.0.0^` names `v0.4.0` (fewer commits away), while the highest-SemVer
 * ancestor is `v0.5.0`. `v1.6.0` is the highest SemVer overall but is not an
 * ancestor.
 *
 * @returns The repository
 */
export function createDivergentRepo(): TestRepo {
  const repo = createTestRepo();
  repo.commit("chore: initial commit");
  repo.git("branch", "side");
  for (let i = 1; i <= 5; i++) repo.commit(`feat: main change ${i} (#${i})`);
  repo.commit("fix: release prep (#6)");
  repo.tag("v0.4.0");
  repo.git("branch", "old-line");
  repo.commit("feat: after 0.4 (#7)");
  repo.git("checkout", "-q", "side");
  repo.commit("feat: side work (#20)");
  repo.tag("v0.5.0", "HEAD", true);
  repo.git("checkout", "-q", "main");
  repo.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge pull request #21 from example/side",
    "side"
  );
  repo.commit("feat: new api (#22)");
  repo.commit("fix: final fix (#23)");
  repo.tag("v2.0.0");
  repo.git("checkout", "-q", "old-line");
  repo.commit("fix: backport (#30)");
  repo.tag("v1.6.0");
  repo.git("checkout", "-q", "main");
  return repo;
}
