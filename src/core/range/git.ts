/**
 * Local git, the source of tags, ancestry and commits (CONVERSION-PLAN §5.1).
 * Every call goes through a {@link Git} so tests can run against a synthetic
 * repository.
 */
import { execFileSync } from "node:child_process";

/** Runs git in one repository. */
export interface Git {
  /**
   * Runs `git <args>` and returns stdout without the trailing newline.
   *
   * @throws Error when git exits non-zero
   */
  run(args: readonly string[]): string;
  /** Runs `git <args>` and reports whether it exited 0. */
  succeeds(args: readonly string[]): boolean;
}

/** A commit in a range, oldest first. */
export interface Commit {
  sha: string;
  /** Subject and body. */
  message: string;
  authorName: string;
  /** ISO 8601 author date. */
  date: string;
}

/**
 * Creates a {@link Git} for a working directory.
 *
 * @param cwd - Repository directory
 * @returns The runner
 */
export function createGit(cwd: string): Git {
  const exec = (args: readonly string[]) =>
    execFileSync("git", ["-c", "core.quotepath=off", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    run: (args) => exec(args).replace(/\n$/, ""),
    succeeds: (args) => {
      try {
        exec(args);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The commit a ref points at, or null when it does not exist.
 *
 * @param git - Runner
 * @param ref - Tag, branch or SHA
 * @returns The full SHA, or null
 */
export function resolveCommit(git: Git, ref: string): string | null {
  if (!git.succeeds(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return null;
  return git.run(["rev-parse", "--verify", `${ref}^{commit}`]);
}

/**
 * Whether a ref names a tag.
 *
 * @param git - Runner
 * @param name - Tag name
 * @returns True when `refs/tags/<name>` exists
 */
export function isTag(git: Git, name: string): boolean {
  return git.succeeds(["rev-parse", "--verify", "--quiet", `refs/tags/${name}`]);
}

/**
 * Whether `ancestor` is an ancestor of, or the same commit as, `descendant`.
 *
 * @param git - Runner
 * @param ancestor - Commit-ish
 * @param descendant - Commit-ish
 * @returns The answer from `git merge-base --is-ancestor`
 */
export function isAncestor(git: Git, ancestor: string, descendant: string): boolean {
  return git.succeeds(["merge-base", "--is-ancestor", ancestor, descendant]);
}

/**
 * Whether the checkout is shallow.
 *
 * @param git - Runner
 * @returns True for a shallow clone
 */
export function isShallow(git: Git): boolean {
  return git.run(["rev-parse", "--is-shallow-repository"]) === "true";
}

/**
 * Tags whose commits are reachable from `to`, with the commit each points at.
 *
 * @param git - Runner
 * @param to - Commit-ish
 * @returns Tag names and commit SHAs
 */
export function mergedTags(git: Git, to: string): Array<{ name: string; sha: string }> {
  const out = git.run([
    "for-each-ref",
    "--merged",
    to,
    "--format=%(refname:strip=2)%00%(*objectname)%00%(objectname)",
    "refs/tags",
  ]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [name, peeled, object] = line.split("\0");
    // Annotated tags peel to their commit; lightweight tags are the commit.
    return { name, sha: peeled || object };
  });
}

/**
 * Every tag in the repository with the commit it points at.
 *
 * @param git - Runner
 * @returns Tag names and commit SHAs, in ref order
 */
export function listTags(git: Git): Array<{ name: string; sha: string }> {
  const out = git.run([
    "for-each-ref",
    "--format=%(refname:strip=2)%00%(*objectname)%00%(objectname)",
    "refs/tags",
  ]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [name, peeled, object] = line.split("\0");
    return { name, sha: peeled || object };
  });
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * Commits selected by `git log` arguments, oldest first, merges included.
 *
 * @param git - Runner
 * @param args - Revision range and filters, such as `["v1.0.0..v1.1.0"]`
 * @returns The commits
 */
export function logCommits(git: Git, args: readonly string[]): Commit[] {
  const out = git.run([
    "log",
    "--reverse",
    `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%B${RECORD}`,
    ...args,
    "--",
  ]);
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.length > 0)
    .map((record) => {
      const [sha, authorName, date, message] = record.split(FIELD);
      return { sha, authorName, date, message: message.replace(/\n+$/, "") };
    });
}

/**
 * A commit's committer date as YYYY-MM-DD, the CHANGELOG entry date, so
 * re-applying an entry reproduces the same bytes.
 *
 * @param git - Runner
 * @param ref - Commit-ish
 * @returns The date
 */
export function commitDate(git: Git, ref: string): string {
  return git.run(["log", "-1", "--format=%cs", ref, "--"]);
}

/**
 * Whether a commit changes files under `.github/workflows/`. `GITHUB_TOKEN`
 * cannot create a release whose target commit does. Merge commits are
 * compared with their first parent; without `-m --first-parent`,
 * `git diff-tree` prints nothing for a merge.
 *
 * @param git - Runner
 * @param ref - Commit-ish
 * @returns True when a workflow file changes
 */
export function touchesWorkflows(git: Git, ref: string): boolean {
  const isRoot = git.run(["rev-list", "--parents", "-n", "1", ref]).split(" ").length === 1;
  const out = git.run([
    "diff-tree",
    "-r",
    "-m",
    "--first-parent",
    "--name-only",
    "--no-commit-id",
    ...(isRoot ? ["--root"] : []),
    ref,
  ]);
  return out.split("\n").some((path) => path.startsWith(".github/workflows/"));
}
