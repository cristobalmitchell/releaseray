/**
 * LLM Provider Abstraction
 *
 * Lightweight provider-agnostic interface for LLM calls.
 * Supports OpenAI (and OpenAI-compatible endpoints), AWS Bedrock and Anthropic.
 *
 * Lifted from packages/shared/src/llm/provider.ts at 7d1d56f8. The caller
 * builds the provider from configuration with `createProvider`; nothing here
 * reads the environment, there is no module cache, and there is no
 * cross-vendor fallback (CONVERSION-PLAN PD-18). Streaming is not lifted.
 *
 * @see https://platform.openai.com/docs/api-reference/chat/create
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 * @see https://platform.claude.com/docs/en/api/messages
 * @see https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html
 */

import { createLogger } from "../logger";

const logger = createLogger("llm-provider");

// ============================================================================
// TYPES
// ============================================================================

/**
 * Supported LLM providers
 */
export type LLMProviderType = "openai" | "bedrock" | "anthropic";

/**
 * Provider configuration, from `.releaseray/config.yml`
 */
export interface ProviderConfig {
  provider: LLMProviderType;
  /** Model ID; defaults per provider */
  model?: string;
  /** OpenAI-compatible endpoint (openai only) */
  baseUrl?: string;
  /** AWS region (bedrock only, required) */
  region?: string;
  /** Model name for the pricing lookup, when `model` is an inference-profile ARN (bedrock) */
  pricingModel?: string;
}

/**
 * Credentials the entry layer reads from the environment and passes in.
 * Bedrock uses the AWS SDK default credential chain, so it needs none here.
 */
export interface ProviderCredentials {
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

/**
 * Token usage from an LLM call
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Estimated cost in USD from an LLM call
 */
export interface TokenCost {
  /** Cost for input/prompt tokens in USD */
  inputCost: number;
  /** Cost for output/completion tokens in USD */
  outputCost: number;
  /** Total cost in USD */
  totalCost: number;
  /** Currency (always USD) */
  currency: "USD";
}

/**
 * Result from a structured LLM call (JSON mode)
 */
export interface ProviderStructuredResult {
  /** Raw JSON string content from the model */
  content: string;
  /** Token usage metrics */
  usage: TokenUsage;
  /** Estimated cost based on provider pricing */
  cost: TokenCost;
  /** Model identifier as reported by the provider */
  model: string;
  /** Which provider served this request */
  provider: LLMProviderType;
}

/**
 * Provider interface — implement this for each LLM backend
 */
export interface LLMProvider {
  /**
   * Generate a structured JSON response
   *
   * @param systemPrompt - System instructions
   * @param userPrompt - User message
   * @param maxTokens - Maximum output tokens
   * @returns Structured result with content, usage, cost, and model info
   */
  generateStructured(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number
  ): Promise<ProviderStructuredResult>;
}

// ============================================================================
// PRICING — per 1M tokens in USD
// ============================================================================

/**
 * Provider pricing per 1M tokens (USD)
 *
 * Prices sourced from official provider pricing pages:
 * @see https://openai.com/api/pricing/
 * @see https://aws.amazon.com/bedrock/pricing/
 * @see https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Updated: 2026-02-10
 */
export const PROVIDER_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // OpenAI models
  "gpt-5-mini": { inputPer1M: 0.3, outputPer1M: 1.25 },
  "gpt-5": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  // Anthropic first-party API (updated 2026-11-23). Claude Haiku 5.5's price
  // is for prompts up to 100K tokens; longer prompts cost $0.50 / $2.50.
  "claude-fable-5-2": { inputPer1M: 8.0, outputPer1M: 40.0 },
  "claude-fable-5-1": { inputPer1M: 10.0, outputPer1M: 50.0 },
  "claude-opus-5-5": { inputPer1M: 4.0, outputPer1M: 20.0 },
  "claude-opus-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-sonnet-5-5": { inputPer1M: 2.0, outputPer1M: 10.0 },
  "claude-sonnet-5": { inputPer1M: 2.0, outputPer1M: 10.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-5-5": { inputPer1M: 0.1, outputPer1M: 0.5 },
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
  // AWS Bedrock — Claude 4.5 models (require cross-region inference profiles)
  // US inference profile IDs (us.anthropic.*) — recommended for US-based deployments
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
  },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  // Global inference profile IDs (global.anthropic.*)
  "global.anthropic.claude-haiku-4-5-20251001-v1:0": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
  },
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  // Foundation model IDs (kept for pricing lookups — cannot be invoked directly)
  "anthropic.claude-haiku-4-5-20251001-v1:0": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
  },
  "anthropic.claude-sonnet-4-5-20250929-v1:0": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  // Legacy models (on-demand, direct invocation still works)
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  "anthropic.claude-3-5-sonnet-20241022-v2:0": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  "anthropic.claude-3-5-haiku-20241022-v1:0": {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
  },
  "amazon.nova-pro-v1:0": { inputPer1M: 0.8, outputPer1M: 3.2 },
  "amazon.nova-lite-v1:0": { inputPer1M: 0.06, outputPer1M: 0.24 },
  "amazon.nova-micro-v1:0": { inputPer1M: 0.035, outputPer1M: 0.14 },
};

/**
 * Whether the pricing table covers a model. Reports show "n/a" for cost when
 * it does not, because `calculateCost` then returns zero.
 *
 * @param model - Model identifier
 * @param pricing - Extra prices from configuration (`llm.pricing`)
 * @returns True when a price is known
 */
export function hasPricing(
  model: string,
  pricing: Record<string, { inputPer1M: number; outputPer1M: number }> = {}
): boolean {
  return model in pricing || model in PROVIDER_PRICING;
}

/**
 * Calculate estimated cost for a set of token counts and a model
 *
 * @param model - Model identifier
 * @param usage - Token usage counts
 * @returns Estimated cost in USD, or zero if model pricing is unknown
 */
export function calculateCost(model: string, usage: TokenUsage): TokenCost {
  const pricing = PROVIDER_PRICING[model];

  if (!pricing) {
    // Unknown model — log a warning but don't fail
    logger.warn("No pricing data for model, cost will be zero", { model });
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
  }

  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPer1M;

  return {
    inputCost: Math.round(inputCost * 1_000_000) / 1_000_000, // 6 decimal places
    outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
    totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    currency: "USD",
  };
}

/** Default models per provider */
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Build the provider named in configuration.
 *
 * @param config - Provider, model and endpoint settings
 * @param credentials - Secrets the entry layer read from the environment
 * @returns An LLMProvider
 * @throws {Error} If the provider is unknown or a required setting is missing
 */
export async function createProvider(
  config: ProviderConfig,
  credentials: ProviderCredentials = {}
): Promise<LLMProvider> {
  switch (config.provider) {
    case "openai": {
      if (!credentials.openaiApiKey) {
        throw new Error("The openai provider needs an API key (OPENAI_API_KEY)");
      }
      const { createOpenAIProvider } = await import("./providers/openai");
      return createOpenAIProvider({
        apiKey: credentials.openaiApiKey,
        model: config.model ?? DEFAULT_OPENAI_MODEL,
        baseUrl: config.baseUrl,
      });
    }
    case "bedrock": {
      if (!config.region) {
        throw new Error("The bedrock provider needs llm.region");
      }
      const { createBedrockProvider } = await import("./providers/bedrock");
      return createBedrockProvider({
        region: config.region,
        model: config.model ?? DEFAULT_BEDROCK_MODEL,
        pricingModel: config.pricingModel,
      });
    }
    case "anthropic": {
      if (!credentials.anthropicApiKey) {
        throw new Error("The anthropic provider needs an API key (ANTHROPIC_API_KEY)");
      }
      const { createAnthropicProvider } = await import("./providers/anthropic");
      return createAnthropicProvider({
        apiKey: credentials.anthropicApiKey,
        model: config.model ?? DEFAULT_ANTHROPIC_MODEL,
      });
    }
    default:
      throw new Error(`Unsupported LLM provider: ${String(config.provider)}`);
  }
}
