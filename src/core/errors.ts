/**
 * Errors that end a run with a documented exit code. The Action entry layer
 * maps `exitCode` to the process exit status; the core never exits itself.
 */

/** Exit codes, one per failure class. */
export const EXIT_CODES = {
  /** Invalid configuration, inputs or range. */
  invalid: 2,
  /** GitHub access error, or the GitHub request budget or prompt size does not fit. */
  budget: 3,
  /** GitHub data could not be fetched completely. */
  incomplete: 4,
  /** Model output failed validation after retries. */
  modelOutput: 5,
  /** The CHANGELOG push was rejected 3 times, or by branch protection. */
  push: 6,
  /** A sink failed after another succeeded. */
  partial: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** A failure the user can act on, with the exit code the run ends with. */
export class ReleaseRayError extends Error {
  readonly exitCode: ExitCode;
  /** One line per problem, for example `path: message`. */
  readonly details: string[];

  /**
   * @param message - Summary of the failure
   * @param exitCode - Exit code from {@link EXIT_CODES}
   * @param details - One line per problem
   * @param options - Standard error options, such as `cause`
   */
  constructor(
    message: string,
    exitCode: ExitCode,
    details: string[] = [],
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ReleaseRayError";
    this.exitCode = exitCode;
    this.details = details;
  }
}
