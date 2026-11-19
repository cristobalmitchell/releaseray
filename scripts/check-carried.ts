/**
 * Compares the carried-test manifest with the tests Vitest collects
 * (CONVERSION-PLAN §6.5, §12.3 issues 1 and 10).
 *
 * The manifest was generated once in the hosted monorepo at 7d1d56f8. Every
 * `carry` or `edit` entry must still be collected under its target file, and
 * no test may appear in a carried file without a manifest entry.
 *
 * Usage:
 *   tsx scripts/check-carried.ts                 # runs `vitest list --json`
 *   tsx scripts/check-carried.ts list.json       # uses a saved listing
 *   tsx scripts/check-carried.ts --summary FILE  # also writes Markdown totals
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type CarriedStatus = "carry" | "edit" | "retire";

export interface ManifestTest {
  /** Monorepo path of the test file at the source commit. */
  sourceFile: string;
  /** Vitest full name: describe blocks and test title joined by " > ". */
  fullName: string;
  status: CarriedStatus;
  reason: string;
  /** Title in this repository when an `edit` renamed it; defaults to `fullName`. */
  targetName?: string;
}

export interface CarriedManifest {
  sourceCommit: string;
  /** Monorepo test file to its path in this repository. */
  files: Record<string, string>;
  tests: ManifestTest[];
}

export interface ListedTest {
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  fullName: string;
}

export interface FileTotals {
  sourceFile: string;
  targetFile: string;
  carry: number;
  edit: number;
  retire: number;
  collected: number;
}

export interface CarriedReport {
  missing: ManifestTest[];
  unlisted: ListedTest[];
  totals: FileTotals[];
}

const key = (file: string, name: string) => `${file}\u0000${name}`;
const nameIn = (t: ManifestTest) => t.targetName ?? t.fullName;

/**
 * Checks a Vitest listing against the manifest.
 *
 * @param manifest - The carried-test manifest
 * @param listed - Tests collected by Vitest, with root-relative paths
 * @returns Missing manifest tests, unlisted collected tests, and per-file totals
 */
export function compareCarried(manifest: CarriedManifest, listed: ListedTest[]): CarriedReport {
  const targets = new Set(Object.values(manifest.files));
  const inCarriedFiles = listed.filter((t) => targets.has(t.file));
  const collected = new Set(inCarriedFiles.map((t) => key(t.file, t.fullName)));
  const kept = manifest.tests.filter((t) => t.status !== "retire");
  const expected = new Set(kept.map((t) => key(manifest.files[t.sourceFile] ?? "", nameIn(t))));

  const missing = kept.filter(
    (t) => !collected.has(key(manifest.files[t.sourceFile] ?? "", nameIn(t)))
  );
  const unlisted = inCarriedFiles.filter((t) => !expected.has(key(t.file, t.fullName)));

  const totals = Object.entries(manifest.files).map(([sourceFile, targetFile]) => {
    const of = manifest.tests.filter((t) => t.sourceFile === sourceFile);
    return {
      sourceFile,
      targetFile,
      carry: of.filter((t) => t.status === "carry").length,
      edit: of.filter((t) => t.status === "edit").length,
      retire: of.filter((t) => t.status === "retire").length,
      collected: inCarriedFiles.filter((t) => t.file === targetFile).length,
    };
  });
  return { missing, unlisted, totals };
}

/**
 * Renders per-file totals as a Markdown table for the job summary.
 *
 * @param report - Output of {@link compareCarried}
 * @returns Markdown text
 */
export function renderSummary(report: CarriedReport): string {
  const sum = (field: "carry" | "edit" | "retire" | "collected") =>
    report.totals.reduce((n, t) => n + t[field], 0);
  const carried = sum("carry") + sum("edit");
  const rows = report.totals.map(
    (t) =>
      `| \`${t.targetFile}\` | ${t.carry + t.edit} | ${t.edit} | ${t.retire} | ${t.collected} |`
  );
  return [
    "## Carried tests",
    "",
    `${carried} carried, ${sum("edit")} of them edited, and ${sum("retire")} retired. ` +
      `${report.missing.length} missing, ${report.unlisted.length} unlisted.`,
    "",
    "| File | Carried | Edited | Retired | Collected |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
    `| **Total** | **${carried}** | **${sum("edit")}** | **${sum("retire")}** | **${sum("collected")}** |`,
    "",
  ].join("\n");
}

/**
 * Normalizes `vitest list --json` output to root-relative paths.
 *
 * @param raw - Parsed JSON from `vitest list --json`
 * @param root - Repository root
 * @returns Listed tests
 */
export function normalizeListing(raw: unknown, root: string): ListedTest[] {
  if (!Array.isArray(raw)) throw new Error("vitest list output is not an array");
  return raw.map((entry: { name: string; file: string }) => ({
    file: relative(root, resolve(root, entry.file)).split(sep).join("/"),
    fullName: entry.name,
  }));
}

function listWithVitest(root: string, files: string[]): unknown {
  const out = join(mkdtempSync(join(tmpdir(), "carried-")), "list.json");
  execFileSync("pnpm", ["exec", "vitest", "list", `--json=${out}`, ...files], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

/**
 * CLI entry.
 *
 * @param argv - Arguments after the script name
 * @param root - Repository root
 * @returns 0 when the manifest matches, 1 otherwise
 */
export function main(argv: string[], root = process.cwd()): number {
  const summaryIndex = argv.indexOf("--summary");
  const summaryFile =
    summaryIndex >= 0 ? argv[summaryIndex + 1] : process.env.GITHUB_STEP_SUMMARY || undefined;
  const positional = argv.filter((_, i) => i !== summaryIndex && i !== summaryIndex + 1);
  const manifestPath = join(root, "test/carried/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CarriedManifest;

  const raw = positional[0]
    ? JSON.parse(readFileSync(positional[0], "utf8"))
    : listWithVitest(root, [...new Set(Object.values(manifest.files))]);
  const report = compareCarried(manifest, normalizeListing(raw, root));

  for (const t of report.totals) {
    console.log(
      `${t.targetFile}: ${t.carry + t.edit} carried (${t.edit} edited), ${t.retire} retired, ${t.collected} collected`
    );
  }
  for (const t of report.missing) {
    console.error(`missing ${t.status}: ${manifest.files[t.sourceFile]} > ${nameIn(t)}`);
  }
  for (const t of report.unlisted) {
    console.error(`unlisted: ${t.file} > ${t.fullName}`);
  }
  if (summaryFile) appendFileSync(summaryFile, renderSummary(report));
  return report.missing.length === 0 && report.unlisted.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
