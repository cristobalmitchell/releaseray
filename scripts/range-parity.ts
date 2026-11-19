/**
 * Local parity check for the range resolver against the monorepo's history
 * (CONVERSION-PLAN §12.2, Phase 2 criterion 5). Not a CI suite: it needs a
 * full clone of releaseray/releaseray with tags.
 *
 * It runs the extractor with the hosted product's subject patterns and
 * compares PR counts and previous-tag choices with the values measured on the
 * hosted dashboard.
 *
 * Usage: tsx scripts/range-parity.ts <path-to-monorepo-clone>
 */
import { pathToFileURL } from "node:url";
import { createGit } from "../src/core/range/git";
import { HOSTED_SUBJECT_PATTERNS } from "../src/core/range/pr-numbers";
import { resolveRange, type RangeOptions } from "../src/core/range/resolve";

const OPTIONS: RangeOptions = {
  tagPattern: "v*",
  includePrereleases: false,
  allowNonAncestor: false,
  maxPullRequests: 5000,
  titlePatterns: HOSTED_SUBJECT_PATTERNS,
};

/** Ranges and the PR counts measured on the hosted dashboard. */
const COUNTS = [
  { from: "v3.6.0", to: "v4.0.0", expected: 24 },
  { from: "v4.1.0", to: "v4.2.0", expected: 25 },
  { from: "v1.3.0", to: "v1.4.0", expected: 27 },
  { from: "v4.6.1", to: "v4.7.0", expected: 4 },
];

/** Tags and the previous tag the resolver must choose. */
const PREVIOUS = [
  { to: "v4.7.0", expected: "v4.6.1" },
  { to: "v2.0.0", expected: "v0.5.0" },
];

/**
 * Runs the checks and prints a Markdown report.
 *
 * @param repo - Path to a full clone of the monorepo
 * @returns 0 when every check matches, 1 otherwise
 */
export function main(repo: string): number {
  const git = createGit(repo);
  let failures = 0;
  const lines = ["| Check | Expected | Actual | |", "| --- | --- | --- | --- |"];
  for (const c of COUNTS) {
    const range = resolveRange(git, { kind: "tag", from: c.from, to: c.to }, OPTIONS);
    const ok = range.prNumbers.length === c.expected;
    if (!ok) failures++;
    lines.push(
      `| PRs in \`${c.from}..${c.to}\` | ${c.expected} | ${range.prNumbers.length} | ${ok ? "✅" : "❌"} |`
    );
  }
  for (const p of PREVIOUS) {
    const range = resolveRange(git, { kind: "tag", to: p.to }, OPTIONS);
    const ok = range.from === p.expected;
    if (!ok) failures++;
    lines.push(
      `| Previous tag of \`${p.to}\` | \`${p.expected}\` | \`${range.from ?? "(root)"}\` | ${ok ? "✅" : "❌"} |`
    );
  }
  console.log(lines.join("\n"));
  return failures === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repo = process.argv[2];
  if (!repo) {
    console.error("Usage: tsx scripts/range-parity.ts <path-to-monorepo-clone>");
    process.exit(2);
  }
  process.exit(main(repo));
}
