/**
 * What every mode returns. Modes take plain requests and return plain
 * results; the Action entry layer turns these into a job summary, step
 * outputs, annotations and an exit code.
 */
import type { Git } from "../core/range/git";
import type { TagSelection } from "../core/range/resolve";
import type { ReleaseApi } from "../outputs/github-release/sink";
import type { PersistedDeps } from "../outputs/persisted";

/** A mode's result. */
export interface ModeResult {
  /** Markdown for the job summary. */
  summary: string;
  /** Step outputs by name. */
  outputs: Record<string, string>;
  /** Workspace files written, relative to the workspace. */
  files: string[];
  warnings: string[];
  /** Problems to show as error annotations. A non-empty list means the step fails. */
  errors: string[];
  /** Exit code when `errors` is non-empty. */
  exitCode?: number;
}

/**
 * An empty result to fill in.
 *
 * @param summary - Summary Markdown
 * @returns The result
 */
export function result(summary = ""): ModeResult {
  return { summary, outputs: {}, files: [], warnings: [], errors: [] };
}

/** `adopt` and `sync-changelog` request. */
export interface TagModeRequest extends TagSelection {
  /** Checkout root, where CHANGELOG.md is read and written. */
  workspace: string;
}

/** What `adopt` and `sync-changelog` need from outside. */
export interface TagModeDeps {
  git: Git;
  /** Release reads and writes; null when the run has no release client. */
  release: ReleaseApi | null;
  /** Workspace and push credentials for the CHANGELOG. */
  persisted: PersistedDeps;
  /** Milliseconds since the epoch. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** REST requests made so far, for the `github-requests` output. */
  requests?: () => number;
}

/**
 * Renders the per-tag table shared by `adopt` and `sync-changelog`.
 *
 * @param rows - Status per tag, in run order
 * @param columns - Column titles after "Tag"
 * @returns Markdown table lines
 */
export function tagTable(
  rows: ReadonlyMap<string, readonly string[]>,
  columns: string[]
): string[] {
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  return [
    `| Tag | ${columns.join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
    ...[...rows].map(([tag, cells]) => `| \`${cell(tag)}\` | ${cells.map(cell).join(" | ")} |`),
  ];
}
