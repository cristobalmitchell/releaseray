/**
 * Checks on the model's input before any call: enough content to write about
 * (CONVERSION-PLAN §6.6 step 6) and a prompt that fits `llm.maxInputTokens`
 * (§5.8 item 1).
 */
import { EXIT_CODES, ReleaseRayError } from "../errors";
import { validateGenerationInput } from "../prompt/build";

/** Characters per token for the size estimate (a billing-grade approximation). */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimated tokens for a prompt.
 *
 * @param chars - Prompt length in characters
 * @returns The estimate
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Stops when the input is too thin for useful notes, unless `allow-sparse`.
 *
 * @param pulls - Kept PRs with title and body
 * @param commits - Commits, used when there are no PRs
 * @param allowSparse - The `allow-sparse` input
 * @returns A warning to show, or null
 * @throws ReleaseRayError (exit 5) when the input is below the thresholds
 */
export function checkSufficiency(
  pulls: ReadonlyArray<{ title: string; body?: string | null }>,
  commits: ReadonlyArray<{ message: string }>,
  allowSparse: boolean
): string | null {
  const result = validateGenerationInput([...pulls], [...commits]);
  if (result.valid) return result.warning;
  if (allowSparse) return result.warning;
  throw new ReleaseRayError("Not enough input to write release notes", EXIT_CODES.modelOutput, [
    result.warning ?? "The range has too little content",
    "Set allow-sparse: true to generate anyway",
  ]);
}

/** Input settings the size check may lower. */
export interface InputShape {
  maxBodyChars: number;
  /** Whether linked-issue bodies are sent. */
  linkedIssueBodies: boolean;
}

/**
 * Finds an input shape whose largest persona prompt fits `maxInputTokens`.
 * Under `degrade` it halves `maxBodyChars` down to 500, then sends no bodies,
 * then drops linked-issue bodies, recording each step.
 *
 * @param measure - Longest persona prompt, in characters, for a shape
 * @param start - The configured shape
 * @param maxInputTokens - `llm.maxInputTokens`
 * @param policy - `github.onBudgetExceeded`, which also governs prompt size
 * @returns The shape to use and the drops made
 * @throws ReleaseRayError (exit 3) when no shape fits, or the first does not under `fail` or `wait`
 */
export function fitInput(
  measure: (shape: InputShape) => number,
  start: InputShape,
  maxInputTokens: number,
  policy: "fail" | "wait" | "degrade"
): { shape: InputShape; drops: string[]; tokens: number } {
  const drops: string[] = [];
  let shape = { ...start };
  let tokens = estimateTokens(measure(shape));
  if (tokens <= maxInputTokens) return { shape, drops, tokens };

  if (policy === "degrade") {
    const steps: InputShape[] = [];
    for (
      let chars = Math.floor(start.maxBodyChars / 2);
      chars >= 500;
      chars = Math.floor(chars / 2)
    ) {
      steps.push({ ...start, maxBodyChars: chars });
    }
    steps.push({ ...start, maxBodyChars: 0 });
    steps.push({ maxBodyChars: 0, linkedIssueBodies: false });
    for (const step of steps) {
      if (step.maxBodyChars !== shape.maxBodyChars) {
        drops.push(`maxBodyChars lowered to ${step.maxBodyChars}`);
      }
      if (shape.linkedIssueBodies && !step.linkedIssueBodies) drops.push("linked-issue bodies");
      shape = step;
      tokens = estimateTokens(measure(shape));
      if (tokens <= maxInputTokens) return { shape, drops, tokens };
    }
  }

  throw new ReleaseRayError(
    `The prompt is about ${tokens} tokens, over llm.maxInputTokens (${maxInputTokens})`,
    EXIT_CODES.budget,
    [
      "Lower enrichment.maxBodyChars, turn off enrichment.comments or linkedIssues, narrow the range, raise llm.maxInputTokens for a larger model, or set github.onBudgetExceeded: degrade",
    ]
  );
}
