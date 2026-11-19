/**
 * One persona's draft from the model: call, parse with length caps, and ask
 * again on invalid output up to `llm.retries` times (CONVERSION-PLAN §6.6
 * step 1). Transient provider errors are retried inside `callLLMWithSchema`.
 */
import { EXIT_CODES, ReleaseRayError } from "../errors";
import { BoundedDraftSchema } from "../validate/output";
import type { DraftOutput } from "../types";
import { callLLMWithSchema, type LLMResponse } from "./call";
import type { LLMProvider } from "./provider";

/** Token use and cost across every attempt for one persona. */
export interface DraftUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** USD, or null when the model has no known pricing. */
  costUsd: number | null;
  latencyMs: number;
  model: string;
  provider: string;
}

/** Settings from `llm.*`. */
export interface DraftOptions {
  retries: number;
  maxCompletionTokens: number;
  /** False when neither the built-in table nor `llm.pricing` covers the model. */
  priced: boolean;
}

function isInvalidOutput(error: unknown): boolean {
  const cause = (error as { cause?: unknown })?.cause;
  return (
    cause instanceof SyntaxError ||
    (typeof cause === "object" &&
      cause !== null &&
      (cause as { name?: string }).name === "ZodError")
  );
}

/**
 * Generates one persona's draft.
 *
 * @param provider - The user's LLM provider
 * @param system - System prompt
 * @param user - Persona prompt with the input block
 * @param options - Retries, token cap and whether cost is known
 * @returns The parsed draft and its usage
 * @throws ReleaseRayError (exit 5) when output is still invalid after retries, or the provider keeps failing
 */
export async function generateDraft(
  provider: LLMProvider,
  system: string,
  user: string,
  options: DraftOptions
): Promise<{ draft: DraftOutput; usage: DraftUsage }> {
  const usage: DraftUsage = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: options.priced ? 0 : null,
    latencyMs: 0,
    model: "",
    provider: "",
  };
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    usage.calls++;
    try {
      const response = (await callLLMWithSchema(system, user, BoundedDraftSchema, {
        provider,
        maxTokens: options.maxCompletionTokens,
        maxRetries: options.retries + 1,
        returnMetrics: true,
      })) as LLMResponse<DraftOutput>;
      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      if (usage.costUsd !== null) usage.costUsd += response.cost.totalCost;
      usage.latencyMs += response.metadata.latencyMs;
      usage.model = response.metadata.model;
      usage.provider = response.metadata.provider;
      return { draft: response.data, usage };
    } catch (error) {
      lastError = error;
      if (!isInvalidOutput(error)) break;
    }
  }
  const invalid = isInvalidOutput(lastError);
  throw new ReleaseRayError(
    invalid
      ? `The model's output was still invalid after ${options.retries + 1} attempts`
      : "The LLM provider call failed",
    EXIT_CODES.modelOutput,
    [lastError instanceof Error ? lastError.message : String(lastError)],
    { cause: lastError }
  );
}
