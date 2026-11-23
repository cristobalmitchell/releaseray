/**
 * Local git for the e2e harness: fixture history written with
 * `git fast-import` into a bare repository that plays `origin`, clones of
 * it as workspaces, a pre-receive hook that rejects pushes the way branch
 * protection does, and a `git` shim that lands a real concurrent push just
 * before the Action's push.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTITY = { name: "Octo Dev", email: "octo-dev@example.com" };

/**
 * Runs git and returns trimmed stdout.
 *
 * @param args - Arguments
 * @param options - Working directory, stdin and extra environment
 * @returns stdout
 */
export function git(
  args: string[],
  options: { cwd?: string; input?: string; env?: Record<string, string> } = {}
): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** A commit handle: a fast-import mark. */
export type Mark = number;

interface CommitSpec {
  message: string;
  files?: Record<string, string>;
  parents: Mark[];
}

/**
 * Builds history as a fast-import stream. Commits get increasing
 * timestamps one minute apart, so the history is the same on every run.
 */
export class HistoryBuilder {
  private readonly commits: Array<CommitSpec & { mark: Mark }> = [];
  private readonly refs: Array<{ ref: string; mark: Mark }> = [];
  private clock = 1_790_000_000;

  /**
   * Adds a commit.
   *
   * @param message - Commit message
   * @param options - Parents (first is the mainline) and files to write
   * @returns Its mark
   */
  commit(
    message: string,
    options: { parents?: Mark[]; files?: Record<string, string> } = {}
  ): Mark {
    const mark = this.commits.length + 1;
    this.commits.push({ mark, message, parents: options.parents ?? [], files: options.files });
    return mark;
  }

  /**
   * Adds a pull request merged with a merge commit: one commit on a topic
   * branch from `base`, merged into `base` as GitHub's merge button does.
   *
   * @returns The merge commit's mark
   */
  mergePull(base: Mark, pull: { number: number; title: string; branch?: string }): Mark {
    const branch = pull.branch ?? `topic-${pull.number}`;
    const topic = this.commit(pull.title, {
      parents: [base],
      files: { [`changes/${pull.number}.md`]: `${pull.title}\n` },
    });
    return this.commit(`Merge pull request #${pull.number} from acme/${branch}\n\n${pull.title}`, {
      parents: [base, topic],
    });
  }

  /** Points a branch or tag (`refs/heads/x`, `refs/tags/y`) at a commit. */
  ref(ref: string, mark: Mark): void {
    this.refs.push({ ref, mark });
  }

  /**
   * The fast-import stream.
   *
   * @returns Stream text
   */
  stream(): string {
    const out: string[] = [];
    const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}`;
    for (const c of this.commits) {
      const when = `${this.clock + c.mark * 60} +0000`;
      // A root commit starts an empty branch; others name their parents.
      if (c.parents.length === 0) out.push("reset refs/fixture/scratch");
      out.push(
        "commit refs/fixture/scratch",
        `mark :${c.mark}`,
        `author ${IDENTITY.name} <${IDENTITY.email}> ${when}`,
        `committer ${IDENTITY.name} <${IDENTITY.email}> ${when}`,
        data(`${c.message}\n`)
      );
      if (c.parents.length > 0) {
        out.push(`from :${c.parents[0]}`);
        for (const p of c.parents.slice(1)) out.push(`merge :${p}`);
      }
      for (const [path, text] of Object.entries(c.files ?? {})) {
        out.push(`M 100644 inline ${path}`, data(text));
      }
      out.push("");
    }
    for (const r of this.refs) out.push(`reset ${r.ref}`, `from :${r.mark}`, "");
    return `${out.join("\n")}\n`;
  }
}

/** A bare origin repository and the commits the fixture made. */
export interface Origin {
  dir: string;
  /** Commit SHA for each mark. */
  sha(mark: Mark): string;
}

/**
 * Creates a temporary directory removed by {@link cleanup}.
 *
 * @param prefix - Name prefix
 * @returns Its path
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `releaseray-e2e-${prefix}-`));
  created.push(dir);
  return dir;
}

const created: string[] = [];

/** Removes every directory {@link tempDir} made. */
export function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes the history into a new bare repository whose HEAD is main.
 *
 * @param history - The fixture
 * @returns The origin
 */
export function createOrigin(history: HistoryBuilder): Origin {
  const dir = join(tempDir("origin"), "origin.git");
  git(["init", "-q", "--bare", dir]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir });
  const marks = join(dir, "fixture-marks");
  git(["fast-import", "--quiet", `--export-marks=${marks}`], { cwd: dir, input: history.stream() });
  git(["update-ref", "-d", "refs/fixture/scratch"], { cwd: dir });
  const shas = new Map<number, string>();
  for (const line of readFileSync(marks, "utf8").split("\n")) {
    const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
    if (m) shas.set(Number(m[1]), m[2]);
  }
  return {
    dir,
    sha(mark) {
      const sha = shas.get(mark);
      if (!sha) throw new Error(`no commit for mark ${mark}`);
      return sha;
    },
  };
}

/**
 * Clones origin into a new workspace, as actions/checkout does.
 *
 * @param origin - The origin
 * @param options - `ref` to check out (branch, tag or SHA); `depth` 1 for checkout's default
 * @returns The workspace path
 */
export function cloneWorkspace(
  origin: Origin,
  options: { ref?: string; depth?: number } = {}
): string {
  const dir = join(tempDir("workspace"), "repo");
  const depth = options.depth ? ["--depth", String(options.depth), "--no-single-branch"] : [];
  git(["clone", "-q", ...depth, `file://${origin.dir}`, dir]);
  if (options.ref) git(["checkout", "-q", options.ref], { cwd: dir });
  return dir;
}

/**
 * A file's text on an origin branch, or null.
 *
 * @param origin - The origin
 * @param branch - Branch name
 * @param path - File path
 * @returns The text
 */
export function originFile(origin: Origin, branch: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `refs/heads/${branch}:${path}`], {
      cwd: origin.dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/**
 * Makes origin reject pushes to a branch the way GitHub's branch protection
 * does (GH006), or removes that hook.
 *
 * @param origin - The origin
 * @param branch - Branch to protect, or null to remove the hook
 */
export function protectBranch(origin: Origin, branch: string | null): void {
  const hook = join(origin.dir, "hooks", "pre-receive");
  if (branch === null) {
    rmSync(hook, { force: true });
    return;
  }
  writeFileSync(
    hook,
    `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/${branch}" ]; then
    echo "error: GH006: Protected branch update failed for refs/heads/${branch}." >&2
    echo "error: Changes must be made through a pull request." >&2
    exit 1
  fi
done
exit 0
`
  );
  chmodSync(hook, 0o755);
}

/**
 * A `git` wrapper to put first on the Action's PATH. The first time the
 * Action runs `git push`, it first pushes a commit to `branch` from a
 * second clone, so the Action's push is a real non-fast-forward.
 *
 * @param origin - The origin
 * @param branch - Branch the concurrent push updates
 * @returns The directory to prepend to PATH, and the second clone
 */
export function raceOncePath(origin: Origin, branch: string): { bin: string; clone: string } {
  const bin = tempDir("bin");
  const clone = cloneWorkspace(origin, { ref: branch });
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const flag = join(bin, "race-pending");
  writeFileSync(flag, "");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ] && [ -f "${flag}" ]; then
    rm -f "${flag}"
    (
      unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE
      cd "${clone}" &&
      "${realGit}" fetch -q origin ${branch} &&
      "${realGit}" reset -q --hard FETCH_HEAD &&
      echo "concurrent" > concurrent.md &&
      "${realGit}" add concurrent.md &&
      GIT_AUTHOR_NAME="Someone Else" GIT_AUTHOR_EMAIL=else@example.com \\
      GIT_COMMITTER_NAME="Someone Else" GIT_COMMITTER_EMAIL=else@example.com \\
      "${realGit}" commit -q -m "docs: a concurrent push" &&
      "${realGit}" push -q origin HEAD:refs/heads/${branch}
    ) >&2 || exit 99
    break
  fi
done
exec "${realGit}" "$@"
`
  );
  chmodSync(join(bin, "git"), 0o755);
  return { bin, clone };
}
