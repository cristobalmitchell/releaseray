/**
 * OpenAI provider implementation
 *
 * Wraps the OpenAI SDK with the LLMProvider interface. Supports GPT-5-mini
 * (default), other OpenAI models, and OpenAI-compatible endpoints through
 * `baseUrl`.
 *
 * Lifted from packages/shared/src/llm/providers/openai.ts at 7d1d56f8. The
 * key, model and endpoint are passed in instead of read from the
 * environment, and there is no client singleton.
 *
 * @see https://platform.openai.com/docs/api-reference/chat/create
 */

import OpenAI from "openai";
import type { LLMProvider, ProviderStructuredResult } from "../provider";
import { calculateCost } from "../provider";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint; the SDK default when unset */
  baseUrl?: string;
  /** Replaces the global fetch, for contract tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Create an OpenAI LLMProvider instance
 *
 * Uses the OpenAI Chat Completions API with JSON mode for structured output.
 *
 * @param options - API key, model and optional endpoint
 * @returns LLMProvider backed by OpenAI
 */
export function createOpenAIProvider(options: OpenAIProviderOptions): LLMProvider {
  const { model } = options;
  // retryLLMCall owns retries; SDK retries on top would multiply attempts on the user's key.
  const openai = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async generateStructured(
      systemPrompt: string,
      userPrompt: string,
      maxTokens: number
    ): Promise<ProviderStructuredResult> {
      const response = await openai.chat.completions.create({
        model,
        // Note: GPT-5 does not support temperature parameter
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in OpenAI response");
      }

      const usage = {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      };

      return {
        content,
        usage,
        cost: calculateCost(response.model, usage),
        model: response.model,
        provider: "openai",
      };
    },
  };
}
