/**
 * What every mode returns. Modes take plain requests and return plain
 * results; the Action entry layer turns these into a job summary, step
 * outputs, annotations and an exit code.
 */

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
