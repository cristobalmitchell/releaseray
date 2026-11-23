/**
 * Anthropic provider implementation
 *
 * Calls the Claude Messages API through the official SDK. The default model
 * is Claude Opus 5.5. The Messages API has no schema-free JSON mode, so JSON
 * is asked for in the system prompt and a surrounding code fence is
 * stripped, as for Bedrock; the caller validates the result against its own
 * schema and re-asks on failure.
 *
 * On models that support it, a refusal is retried server-side on a fallback
 * model that Anthropic picks by refusal category (`fallbacks: "default"`).
 * The reported model and cost are those of the model that answered.
 *
 * @see https://platform.claude.com/docs/en/api/messages
 * @see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, ProviderStructuredResult } from "../provider";
import { calculateCost } from "../provider";
import { stripCodeFences } from "../json-text";

/** Beta that enables server-side refusal fallbacks. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models that accept `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

/**
 * Effort for release-note drafting. Claude Opus 5.5 defaults to `medium`;
 * it is set explicitly so a model change does not silently change it.
 */
const EFFORT = "medium";

/** Models that accept `output_config.effort`. */
const EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet-5|haiku-5)/;

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Replaces the global fetch, for contract tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Create an Anthropic LLMProvider instance
 *
 * @param options - API key and model
 * @returns LLMProvider backed by the Claude Messages API
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): LLMProvider {
  const { model } = options;
  // retryLLMCall owns retries; SDK retries on top would multiply attempts on the user's key.
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const fallback = FALLBACK_MODELS.has(model);

  return {
    async generateStructured(
      systemPrompt: string,
      userPrompt: string,
      maxTokens: number
    ): Promise<ProviderStructuredResult> {
      const response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        system: `${systemPrompt}\n\nRespond with one valid JSON object only: no markdown, no code fences, no text before or after it.`,
        messages: [{ role: "user", content: userPrompt }],
        ...(EFFORT_MODELS.test(model) ? { output_config: { effort: EFFORT } } : {}),
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      });

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unspecified";
        throw new Error(`The model declined the request (refusal: ${category})`);
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(
          `The response reached max_tokens (${maxTokens}) before the JSON was complete; raise llm.maxCompletionTokens`
        );
      }

      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      if (!text.trim()) {
        throw new Error("No text content in Anthropic response");
      }

      const { usage } = response;
      const promptTokens =
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      const tokens = {
        promptTokens,
        completionTokens: usage.output_tokens,
        totalTokens: promptTokens + usage.output_tokens,
      };

      return {
        content: stripCodeFences(text),
        usage: tokens,
        cost: calculateCost(response.model, tokens),
        model: response.model,
        provider: "anthropic",
      };
    },
  };
}
