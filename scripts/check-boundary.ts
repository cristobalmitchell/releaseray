/**
 * Import-boundary and purity check (CONVERSION-PLAN PD-1, §3.2).
 *
 * Only `src/action/` may import `@actions/core` or `@actions/github`, or read
 * `process.env`. Everything else takes plain inputs and returns plain results,
 * which keeps the core testable and usable by a later CLI wrapper.
 *
 * Usage: tsx scripts/check-boundary.ts [root]   (root defaults to the cwd)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type ViolationKind = "actions-import" | "process-env";

export interface Violation {
  /** Path relative to the root, with forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  kind: ViolationKind;
}

const ACTIONS_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@actions\/(?:core|github)(?:\/[^"']*)?["']/;
const PROCESS_ENV = /\bprocess\s*(?:\.\s*env\b|\[\s*["']env["']\s*\])/;

/** Directories under `src/` where `process.env` is forbidden (the purity check). */
export const PURE_DIRS = ["src/core/", "src/outputs/", "src/config/"];

/**
 * Blanks out comments so that documentation mentioning `process.env` or
 * `@actions/core` does not count. Line breaks are kept so line numbers hold.
 *
 * @param source - TypeScript source text
 * @returns The source with comment text replaced by spaces
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_match, lead: string) => lead);
}

/**
 * Finds boundary violations in one file's source.
 *
 * @param file - Path relative to the root
 * @param source - The file's text
 * @returns Violations found; empty when the file may use these APIs
 */
export function scanSource(file: string, source: string): Violation[] {
  const normalized = file.split(sep).join("/");
  if (!normalized.startsWith("src/") || normalized.startsWith("src/action/")) return [];
  const violations: Violation[] = [];
  stripComments(source)
    .split("\n")
    .forEach((text, index) => {
      if (ACTIONS_IMPORT.test(text)) {
        violations.push({ file: normalized, line: index + 1, kind: "actions-import" });
      }
      if (PROCESS_ENV.test(text)) {
        violations.push({ file: normalized, line: index + 1, kind: "process-env" });
      }
    });
  return violations;
}

function listSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(?:[cm]?ts|[cm]?js)$/.test(entry) ? [path] : [];
  });
}

/**
 * Scans every source file under `<root>/src`.
 *
 * @param root - Repository root
 * @returns All violations, ordered by file and line
 */
export function scanTree(root: string): Violation[] {
  return listSourceFiles(join(root, "src")).flatMap((path) =>
    scanSource(relative(root, path), readFileSync(path, "utf8"))
  );
}

/**
 * Keeps only `process.env` reads in the pure directories (core, outputs, config).
 *
 * @param violations - Output of {@link scanTree}
 * @returns The purity violations
 */
export function purityViolations(violations: Violation[]): Violation[] {
  return violations.filter(
    (v) => v.kind === "process-env" && PURE_DIRS.some((dir) => v.file.startsWith(dir))
  );
}

/**
 * CLI entry.
 *
 * @param root - Repository root
 * @returns 0 when clean, 1 on any violation
 */
export function main(root = process.cwd()): number {
  const violations = scanTree(root);
  if (violations.length === 0) {
    console.log("check-boundary: no @actions/* import or process.env read outside src/action/");
    return 0;
  }
  const purity = new Set(purityViolations(violations));
  for (const v of violations) {
    const what =
      v.kind === "actions-import"
        ? "imports @actions/core or @actions/github"
        : `reads process.env${purity.has(v) ? " (purity: core, outputs and config read no environment)" : ""}`;
    console.error(`${v.file}:${v.line}: ${what}; only src/action/ may do this`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv[2]));
}
