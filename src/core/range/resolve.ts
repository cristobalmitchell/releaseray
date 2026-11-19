/**
 * Range resolution from local git with no REST calls (CONVERSION-PLAN §5.2).
 *
 * The previous tag is the highest-SemVer tag matching `tagPattern` that is an
 * ancestor of `to`. Neither a plain SemVer sort (which can pick a tag on
 * another branch) nor `git describe` (which picks the nearest tag, not the
 * highest) gives that answer on a repository with diverging release lines.
 */
import { EXIT_CODES, ReleaseRayError } from "../errors";
import { compareSemver, parseSemver, type SemverVersion } from "../util/semver";
import {
  isAncestor,
  isShallow,
  isTag,
  logCommits,
  mergedTags,
  resolveCommit,
  type Commit,
  type Git,
} from "./git";
import { extractPRNumbers } from "./pr-numbers";

/** What the run was asked to cover. */
export type RangeRequest =
  /** A release or tag push, or explicit tags from a dispatch. */
  | { kind: "tag"; to: string; from?: string }
  /** Changes since the latest tag, up to HEAD. `today` is YYYY-MM-DD. */
  | { kind: "unreleased"; today: string }
  /** Commits on HEAD between two dates. */
  | { kind: "window"; since: string; until?: string; key: string };

/** Range settings from `range.*` and `classification.exclude.titlePatterns`. */
export interface RangeOptions {
  tagPattern: string;
  includePrereleases: boolean;
  allowNonAncestor: boolean;
  maxPullRequests: number;
  titlePatterns: RegExp[];
}

/** Where a resolved range may be published. */
export interface PersistedSinks {
  githubRelease: boolean;
  changelog: boolean;
}

/** A range ready for fetching. */
export interface ResolvedRange {
  kind: RangeRequest["kind"];
  /** The release key: the tag, `unreleased-<date>`, or the window's key. */
  key: string;
  /** Start ref (tag name or SHA), or null when the range starts at the root commit. */
  from: string | null;
  /** End ref: the tag name, or HEAD. */
  to: string;
  toSha: string;
  /** The `to` tag's version, when it has one. */
  version: SemverVersion | null;
  /** True when no earlier tag exists and the range starts at the root commit. */
  firstRelease: boolean;
  commits: Commit[];
  /** PR numbers to fetch, ascending. */
  prNumbers: number[];
  /** PR numbers whose subject matched an exclusion pattern. */
  excludedPRNumbers: number[];
  persisted: PersistedSinks;
  warnings: string[];
  notices: string[];
}

function invalid(message: string, details: string[] = []): ReleaseRayError {
  return new ReleaseRayError(message, EXIT_CODES.invalid, details);
}

/**
 * Converts a git-style glob (`*`, `?`, `[...]`) to an anchored expression.
 * Like `git tag --list`, `*` also matches `/`.
 *
 * @param glob - The pattern
 * @returns The expression
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) out += "\\[";
      else {
        const body = glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else out += ch.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Stops range modes on a shallow clone, which hides tags and history.
 *
 * @param git - Runner
 * @throws ReleaseRayError (exit 2) naming `fetch-depth: 0`
 */
export function assertFullHistory(git: Git): void {
  if (isShallow(git)) {
    throw invalid("The checkout is shallow, so tags and history are missing", [
      "Set fetch-depth: 0 on actions/checkout so every tag and commit is available",
    ]);
  }
}

/**
 * The highest-SemVer tag matching the pattern that is an ancestor of `to`,
 * below `to`'s version and excluding prereleases unless allowed.
 *
 * @param git - Runner
 * @param to - Commit-ish the range ends at
 * @param options - Tag pattern and prerelease setting
 * @param below - Only tags lower than this version count, when set
 * @param includeTo - Also consider tags on `to` itself (unreleased previews)
 * @returns The tag name, or null when none exists, and tags ignored for lacking a version
 */
export function findPreviousTag(
  git: Git,
  to: string,
  options: Pick<RangeOptions, "tagPattern" | "includePrereleases">,
  below: SemverVersion | null,
  includeTo = false
): { tag: string | null; ignored: string[] } {
  const toSha = resolveCommit(git, to);
  const pattern = globToRegExp(options.tagPattern);
  const ignored: string[] = [];
  let best: { tag: string; version: SemverVersion } | null = null;
  for (const { name, sha } of mergedTags(git, to)) {
    if (!pattern.test(name)) continue;
    const version = parseSemver(name);
    if (!version) {
      ignored.push(name);
      continue;
    }
    // A tag on the same commit as `to` would give an empty range.
    if (sha === toSha && !includeTo) continue;
    if (version.prerelease.length > 0 && !options.includePrereleases) continue;
    if (below && compareSemver(version, below) >= 0) continue;
    if (!best || compareSemver(version, best.version) > 0) best = { tag: name, version };
  }
  return { tag: best?.tag ?? null, ignored };
}

function finish(
  git: Git,
  base: Omit<
    ResolvedRange,
    "commits" | "prNumbers" | "excludedPRNumbers" | "warnings" | "notices" | "toSha"
  >,
  logArgs: string[],
  options: RangeOptions,
  notices: string[]
): ResolvedRange {
  const toSha = resolveCommit(git, base.to);
  if (!toSha) throw invalid(`Ref ${base.to} does not exist`);
  const commits = logCommits(git, logArgs);
  const { prNumbers, excludedPRNumbers } = extractPRNumbers(commits, {
    titlePatterns: options.titlePatterns,
  });
  if (prNumbers.length > options.maxPullRequests) {
    const fix =
      base.kind === "window"
        ? "narrow the date window"
        : base.firstRelease
          ? "pass an explicit from: there is no earlier tag, so the range starts at the root commit"
          : "pass an explicit from closer to the release";
    throw invalid(
      `The range references ${prNumbers.length} pull requests, over range.maxPullRequests (${options.maxPullRequests})`,
      [`To fix it, ${fix}, or raise range.maxPullRequests`]
    );
  }
  const warnings: string[] = [];
  if (commits.length > 0 && prNumbers.length === 0 && excludedPRNumbers.length === 0) {
    warnings.push(
      `No commit in the range names a pull request ("Merge pull request #n" or a trailing "(#n)"). Rebase merges are the likely cause; the notes fall back to commit messages.`
    );
  }
  return {
    ...base,
    toSha,
    commits,
    prNumbers,
    excludedPRNumbers,
    warnings,
    notices,
  };
}

function ignoredNotice(ignored: string[]): string[] {
  if (ignored.length === 0) return [];
  const shown = ignored.slice(0, 5).join(", ");
  const more = ignored.length > 5 ? ` and ${ignored.length - 5} more` : "";
  return [`Ignored tags that match the pattern but hold no SemVer version: ${shown}${more}`];
}

/**
 * Resolves a range request against the local repository.
 *
 * @param git - Runner over a full-history checkout
 * @param request - Tag, unreleased or date-window request
 * @param options - Range settings
 * @returns The resolved range with commits and PR numbers
 * @throws ReleaseRayError (exit 2) for unknown refs, a non-ancestor `from`,
 *   a `to` outside the tag convention without `from`, or a range over the cap
 */
export function resolveRange(
  git: Git,
  request: RangeRequest,
  options: RangeOptions
): ResolvedRange {
  if (request.kind === "window") {
    if (!request.key.trim()) throw invalid("A date window needs a key");
    const args = [`--since=${request.since}`];
    if (request.until) args.push(`--until=${request.until}`);
    return finish(
      git,
      {
        kind: "window",
        key: request.key,
        from: null,
        to: "HEAD",
        version: null,
        firstRelease: false,
        persisted: { githubRelease: false, changelog: true },
      },
      [...args, "HEAD"],
      options,
      []
    );
  }

  if (request.kind === "unreleased") {
    const { tag, ignored } = findPreviousTag(git, "HEAD", options, null, true);
    return finish(
      git,
      {
        kind: "unreleased",
        key: `unreleased-${request.today}`,
        from: tag,
        to: "HEAD",
        version: null,
        firstRelease: tag === null,
        persisted: { githubRelease: false, changelog: false },
      },
      [tag ? `${tag}..HEAD` : "HEAD"],
      options,
      ignoredNotice(ignored)
    );
  }

  const to = request.to.trim();
  if (!to) {
    throw invalid("No release tag", [
      "Set the to input; a workflow_dispatch run carries no event tag",
    ]);
  }
  if (!isTag(git, to)) throw invalid(`Tag ${to} does not exist`);
  const version = parseSemver(to);
  const persisted = { githubRelease: true, changelog: true };

  if (request.from !== undefined && request.from.trim() !== "") {
    const from = request.from.trim();
    if (!resolveCommit(git, from)) throw invalid(`Ref ${from} does not exist`);
    if (!options.allowNonAncestor && !isAncestor(git, from, to)) {
      throw invalid(`${from} is not an ancestor of ${to}`, [
        "Pick a from on the same line of history, or set allow-non-ancestor: true to compare them anyway",
      ]);
    }
    return finish(
      git,
      { kind: "tag", key: to, from, to, version, firstRelease: false, persisted },
      [`${from}..${to}`],
      options,
      []
    );
  }

  if (!version || !globToRegExp(options.tagPattern).test(to)) {
    throw invalid(`${to} is outside the tag convention, so no previous tag is defined`, [
      `Explicit from required: ${to} ${version ? `does not match range.tagPattern (${options.tagPattern})` : "holds no SemVer version"}`,
    ]);
  }
  const { tag, ignored } = findPreviousTag(git, to, options, version);
  return finish(
    git,
    { kind: "tag", key: to, from: tag, to, version, firstRelease: tag === null, persisted },
    [tag ? `${tag}..${to}` : to],
    options,
    ignoredNotice(ignored)
  );
}

/**
 * Checks that the enabled outputs may receive this range.
 *
 * @param range - The resolved range
 * @param outputs - Whether the GitHub Release and CHANGELOG sinks are enabled
 * @throws ReleaseRayError (exit 2) when a date window would publish a release
 */
export function assertSinksAllowed(
  range: Pick<ResolvedRange, "kind" | "persisted">,
  outputs: { githubRelease: boolean; changelog: boolean }
): void {
  if (outputs.githubRelease && !range.persisted.githubRelease && range.kind === "window") {
    throw invalid("A date window has no tag, so it cannot publish a GitHub Release", [
      "Set outputs.githubRelease.enabled: false for date-window runs",
    ]);
  }
}
