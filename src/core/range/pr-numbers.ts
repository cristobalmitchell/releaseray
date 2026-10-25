/**
 * PR numbers from commit messages, with configurable exclusions.
 *
 * Lifted from `extractPRNumbersFromCommits` in
 * apps/app/src/app/api/ranges/route.ts:47-96 at 7d1d56f8. The hosted code
 * dropped PR numbers whose subject mentioned "promote" or "release v", and
 * filtered fetched PRs by similar title rules (:201-209). Both lists are now
 * `classification.exclude.titlePatterns`, empty by default, so a PR titled
 * "Release validation fix (#12)" is kept unless the user configures a
 * pattern that matches it (CONVERSION-PLAN PD-6).
 */

export interface PRNumberExtraction {
  /** PR numbers to fetch, ascending */
  prNumbers: number[];
  /** PR numbers removed because their subject matched a title pattern, ascending */
  excludedPRNumbers: number[];
}

/**
 * The subject rules the hosted extractor applied, for users who want the
 * same behavior: `promote` or `release v` anywhere (any case), or a
 * `feat|fix|docs(release):` prefix.
 */
export const HOSTED_SUBJECT_PATTERNS: RegExp[] = [
  /promote/i,
  /release v/i,
  /^(feat|fix|docs)\(release\):/,
];

/** The PR-title rules the hosted range route applied after fetching. */
export const HOSTED_PR_TITLE_PATTERNS: RegExp[] = [
  /promote/i,
  /^(feat|fix|docs|chore)\(release\):/,
  /staging to/i,
  /to production/i,
];

/**
 * Extract PR numbers from commit messages
 * Handles traditional merges, squash merges, and multiple PR references.
 * A subject matching a title pattern excludes only the PR number in its
 * trailing `(#n)`.
 *
 * @param commits - Commits, newest or oldest first
 * @param options - `titlePatterns`: subjects to exclude (default none)
 * @returns PR numbers to fetch and PR numbers excluded
 */
export function extractPRNumbers(
  commits: Array<{ message: string }>,
  options: { titlePatterns?: RegExp[] } = {}
): PRNumberExtraction {
  const patterns = options.titlePatterns ?? [];
  const prNumbers = new Set<number>();
  const excluded = new Set<number>();

  for (const { message } of commits) {
    const firstLine = message.split("\n")[0];

    // Match "Merge pull request #123" (traditional merge)
    const mergePRMatch = message.match(/Merge pull request #(\d+)/i);
    if (mergePRMatch?.[1]) {
      prNumbers.add(parseInt(mergePRMatch[1], 10));
    }

    // Match ALL (#123) patterns in the first line (squash merges often have multiple)
    if (firstLine) {
      for (const match of firstLine.matchAll(/\(#(\d+)(?:\s+#\d+)*\)/g)) {
        for (const numMatch of match[0].matchAll(/#(\d+)/g)) {
          if (numMatch[1]) prNumbers.add(parseInt(numMatch[1], 10));
        }
      }

      if (patterns.some((pattern) => pattern.test(firstLine))) {
        const lastMatch = firstLine.match(/\(#(\d+)\)\s*$/);
        if (lastMatch?.[1]) excluded.add(parseInt(lastMatch[1], 10));
      }
    }
  }

  for (const num of excluded) prNumbers.delete(num);

  const ascending = (a: number, b: number) => a - b;
  return {
    prNumbers: [...prNumbers].sort(ascending),
    excludedPRNumbers: [...excluded].sort(ascending),
  };
}

/**
 * Splits fetched PRs into kept and excluded by title.
 *
 * @param prs - Fetched pull requests
 * @param titlePatterns - Title patterns to exclude (default none)
 * @returns PRs to keep and PRs excluded, each with the matching pattern
 */
export function partitionByTitle<T extends { title: string }>(
  prs: T[],
  titlePatterns: RegExp[] = []
): { kept: T[]; excluded: Array<{ pr: T; pattern: string }> } {
  const kept: T[] = [];
  const excluded: Array<{ pr: T; pattern: string }> = [];
  for (const pr of prs) {
    const match = titlePatterns.find((pattern) => pattern.test(pr.title));
    if (match) excluded.push({ pr, pattern: match.source });
    else kept.push(pr);
  }
  return { kept, excluded };
}
