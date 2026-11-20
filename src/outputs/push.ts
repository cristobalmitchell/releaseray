/**
 * The CHANGELOG push loop (CONVERSION-PLAN §7.3): build a commit on the
 * fetched branch head with git plumbing on a temporary index, push it
 * fast-forward only, and on a non-fast-forward rejection fetch and re-apply,
 * up to 3 attempts. A rejection by protection, a ruleset or a signature
 * rule stops at once. The workspace index and HEAD are never touched.
 *
 * Authentication is an explicit `extraheader` with the resolved token, after
 * an empty value that clears any header `actions/checkout` persisted, so a
 * PAT or App token passed as `github-token` is what the push uses.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";

/** Settings for {@link pushChangelog}. */
export interface PushOptions {
  workspace: string;
  remote?: string;
  branch: string;
  /** CHANGELOG path in the repository. */
  path: string;
  serverUrl: string;
  token: string;
  /** Commit subject; the trailers are added here. */
  message: string;
  key: string;
  author: { name: string; email: string };
  /** Applies the entry to the branch's current text; null or unchanged means nothing to push. */
  apply(current: string): string | null;
  /** Registers a value to mask in logs. */
  setSecret(value: string): void;
  /** Base environment for git (the runner's), without secrets added here. */
  env: Readonly<Record<string, string | undefined>>;
  maxAttempts?: number;
  /** Test seam: runs before each push attempt. */
  beforePush?(attempt: number): void;
}

/** The trailer a push-triggered run checks to avoid loops. */
export const GENERATED_BY_TRAILER = "Generated-by: ReleaseRay";

/** The default identity when pushing with `GITHUB_TOKEN`. */
export const GITHUB_ACTIONS_BOT = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

class GitFailure extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

function git(
  options: PushOptions,
  args: string[],
  extra: { input?: string; env?: Record<string, string>; auth?: boolean } = {}
): string {
  const auth = extra.auth
    ? [
        "-c",
        `http.${options.serverUrl}/.extraheader=`,
        "-c",
        `http.${options.serverUrl}/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`,
      ]
    : [];
  try {
    return execFileSync("git", [...auth, ...args], {
      cwd: options.workspace,
      encoding: "utf8",
      input: extra.input,
      env: { ...options.env, GIT_TERMINAL_PROMPT: "0", ...extra.env },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, "");
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    throw new GitFailure(`git ${args[0]} failed`, stderr);
  }
}

/** Guidance for a rejection by a rule, keyed by what the message names. */
function ruleGuidance(stderr: string): string[] | null {
  if (/signature/i.test(stderr)) {
    return [
      "The branch requires signed commits. The push loop's commits are unsigned; use the changelog-pr recipe instead",
    ];
  }
  if (/pull request|GH006|GH013|protected branch|ruleset|rule violation/i.test(stderr)) {
    return [
      "Branch protection or a ruleset rejected the push",
      "Required pull requests: add the token's actor to the bypass list, or use the changelog-pr recipe",
      "Push restrictions: pass a PAT whose user, or a GitHub App you registered, may push (the app-token recipe)",
    ];
  }
  return null;
}

/**
 * Pushes one CHANGELOG entry to a branch.
 *
 * @param options - Branch, path, credentials, identity and the entry to apply
 * @returns Whether a commit was pushed, its SHA, and attempts used
 * @throws ReleaseRayError (exit 6) on a rule rejection or after 3 non-fast-forward rejections
 */
export function pushChangelog(options: PushOptions): {
  pushed: boolean;
  commit?: string;
  attempts: number;
} {
  const remote = options.remote ?? "origin";
  const max = options.maxAttempts ?? 3;
  const header = Buffer.from(`x-access-token:${options.token}`).toString("base64");
  options.setSecret(header);
  const identity = {
    GIT_AUTHOR_NAME: options.author.name,
    GIT_AUTHOR_EMAIL: options.author.email,
    GIT_COMMITTER_NAME: options.author.name,
    GIT_COMMITTER_EMAIL: options.author.email,
  };
  const message = `${options.message}\n\n${GENERATED_BY_TRAILER}\nReleaseRay-Key: ${options.key}\n`;

  for (let attempt = 1; attempt <= max; attempt++) {
    let head: string;
    try {
      git(options, ["fetch", "--no-tags", "--quiet", remote, options.branch], { auth: true });
      head = git(options, ["rev-parse", "FETCH_HEAD^{commit}"]);
    } catch (error) {
      throw new ReleaseRayError(
        `Could not fetch ${options.branch} to push CHANGELOG`,
        EXIT_CODES.push,
        [
          error instanceof GitFailure
            ? (error.stderr.trim().split("\n").pop() ?? "")
            : String(error),
        ]
      );
    }
    let current = "";
    try {
      current = git(options, ["show", `${head}:${options.path}`]) + "\n";
    } catch {
      // A missing file starts empty.
    }
    const next = options.apply(current);
    if (next === null || next === current) return { pushed: false, attempts: attempt };

    const indexDir = mkdtempSync(join(tmpdir(), "releaseray-index-"));
    let commit: string;
    try {
      const env = { GIT_INDEX_FILE: join(indexDir, "index") };
      const blob = git(options, ["hash-object", "-w", "--stdin"], { input: next });
      git(options, ["read-tree", head], { env });
      git(options, ["update-index", "--add", "--cacheinfo", `100644,${blob},${options.path}`], {
        env,
      });
      const tree = git(options, ["write-tree"], { env });
      commit = git(options, ["commit-tree", tree, "-p", head, "-F", "-"], {
        input: message,
        env: identity,
      });
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }

    options.beforePush?.(attempt);
    try {
      git(options, ["push", "--quiet", remote, `${commit}:refs/heads/${options.branch}`], {
        auth: true,
      });
      return { pushed: true, commit, attempts: attempt };
    } catch (error) {
      const stderr = error instanceof GitFailure ? error.stderr : String(error);
      const rule = ruleGuidance(stderr);
      if (rule) {
        throw new ReleaseRayError(
          `The CHANGELOG push to ${options.branch} was rejected`,
          EXIT_CODES.push,
          rule
        );
      }
      if (!/non-fast-forward|fetch first|stale info|cannot lock ref/i.test(stderr)) {
        throw new ReleaseRayError(
          `The CHANGELOG push to ${options.branch} failed`,
          EXIT_CODES.push,
          [stderr.trim().split("\n").pop() ?? ""]
        );
      }
      // Someone pushed first: fetch again and re-apply.
    }
  }
  throw new ReleaseRayError(
    `The CHANGELOG push to ${options.branch} was rejected ${max} times`,
    EXIT_CODES.push,
    ["Other pushes kept moving the branch; re-run the workflow, which reuses the stored text"]
  );
}
