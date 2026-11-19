/**
 * Schema-validated LLM calls.
 *
 * Lifted from packages/shared/src/llm/index.ts at 7d1d56f8. The provider is
 * a required argument: there is no environment-based resolution and no
 * fallback to another vendor. The unused `model` option and the streaming
 * functions were not lifted.
 */
import { type ZodSchema } from "zod";
import { retryLLMCall } from "../util/retry";
import { createLogger } from "../logger";
import type { LLMProvider, LLMProviderType, TokenCost } from "./provider";

const logger = createLogger("llm");

/**
 * Strip markdown code fences from LLM output that wraps JSON.
 *
 * Some models (especially Claude via Bedrock) may wrap JSON in
 * ``` ```json ... ``` ``` fences despite being told not to.
 * Handles variable backtick counts (3+) and optional language tags.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^`{3,}\w*\s*\n?([\s\S]+?)\n?\s*`{3,}\s*$/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

// Re-export provider types for consumers
export type { LLMProvider, LLMProviderType, ProviderConfig, TokenCost } from "./provider";
export { calculateCost, createProvider, hasPricing, PROVIDER_PRICING } from "./provider";

/** Options for {@link callLLMWithSchema}. */
export interface CallLLMOptions {
  /** The provider to call, built with `createProvider` */
  provider: LLMProvider;
  /** Max completion tokens (default: 16384) */
  maxTokens?: number;
  /** Max attempts for transient failures (default: 5) */
  maxRetries?: number;
}

/**
 * LLM response with usage metrics and cost estimation
 */
export interface LLMResponse<T> {
  data: T;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Estimated cost in USD based on provider pricing */
  cost: TokenCost;
  metadata: {
    model: string;
    /** Which provider actually served this request */
    provider: LLMProviderType;
    latencyMs: number;
  };
}

/**
 * Call LLM with strict JSON mode and schema validation
 *
 * Uses a provider-agnostic abstraction supporting OpenAI and AWS Bedrock.
 * The caller passes the provider.
 *
 * Includes automatic retry logic with exponential backoff for transient failures.
 *
 * @param systemPrompt - System instructions
 * @param userPrompt - User message with task details
 * @param schema - Zod schema for output validation
 * @param options - Additional options
 * @param options.provider - The provider to call (required)
 * @param options.maxTokens - Max completion tokens (default: 16384)
 * @param options.maxRetries - Max retry attempts for transient failures (default: 5)
 * @param options.returnMetrics - Whether to return usage metrics (default: false for backward compatibility)
 *
 * @throws {Error} If no provider is passed, or the output fails validation after retries
 * @see https://platform.openai.com/docs/api-reference/chat/create
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */
// Overload: Without returnMetrics, returns T
export async function callLLMWithSchema<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: ZodSchema<T>,
  options: CallLLMOptions & { returnMetrics?: false }
): Promise<T>;

// Overload: With returnMetrics: true, returns LLMResponse<T>
export async function callLLMWithSchema<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: ZodSchema<T>,
  options: CallLLMOptions & { returnMetrics: true }
): Promise<LLMResponse<T>>;

// Implementation
export async function callLLMWithSchema<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: ZodSchema<T>,
  options: CallLLMOptions & { returnMetrics?: boolean }
): Promise<T | LLMResponse<T>> {
  // Checked at run time too: callers outside TypeScript get a clear error
  // instead of a silent fallback to an environment-configured provider.
  const provider = options?.provider;
  if (!provider) {
    throw new Error("callLLMWithSchema requires a provider; build one with createProvider");
  }
  const { maxTokens = 16384, maxRetries = 5, returnMetrics = false } = options;

  // Wrap the entire LLM call in retry logic
  return retryLLMCall<T | LLMResponse<T>>(
    async () => {
      try {
        const startTime = Date.now();

        // Call the provider for structured (JSON) output
        const result = await provider.generateStructured(systemPrompt, userPrompt, maxTokens);

        const latencyMs = Date.now() - startTime;

        // Strip markdown code fences if the model wrapped JSON output.
        // Bedrock providers already strip fences, but this is a safety net
        // for edge cases or alternate providers.
        const cleanContent = stripCodeFences(result.content);

        const parsed = JSON.parse(cleanContent);
        const validated = schema.parse(parsed);

        // Return with metrics if requested
        if (returnMetrics) {
          return {
            data: validated,
            usage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens,
            },
            cost: result.cost,
            metadata: {
              model: result.model,
              provider: result.provider,
              latencyMs,
            },
          } as LLMResponse<T>;
        }

        return validated;
      } catch (error) {
        if (error instanceof Error) {
          logger.error("LLM call failed", { error: error.message });
          throw new Error(`LLM processing failed: ${error.message}`);
        }
        throw error;
      }
    },
    {
      maxAttempts: maxRetries,
      onRetry: (error, attempt) => {
        logger.warn("LLM call failed, retrying", {
          attempt,
          maxRetries,
          error: error.message,
        });
      },
    }
  );
}

/**
 * Parse JSON string with Zod schema validation
 * Use this for retry/repair scenarios
 */
export function parseWithSchema<T>(jsonString: string, schema: ZodSchema<T>): T {
  try {
    const parsed = JSON.parse(stripCodeFences(jsonString));
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Schema validation failed: ${error.message}`);
    }
    throw error;
  }
}
