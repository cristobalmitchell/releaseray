/**
 * AWS Bedrock provider implementation
 *
 * Uses the Bedrock Converse API for structured output.
 * Default model: Claude 4.5 Haiku via US cross-region inference profile.
 *
 * IMPORTANT: Claude 4.5 models REQUIRE cross-region inference profile IDs
 * (e.g., us.anthropic.claude-haiku-4-5-20251001-v1:0). Bare foundation
 * model IDs will fail with "on-demand throughput isn't supported".
 *
 * Supports Claude, Llama, Nova, and other Bedrock-hosted models, and
 * inference profile ARNs as the model.
 *
 * Lifted from packages/shared/src/llm/providers/bedrock.ts at 7d1d56f8. The
 * region and model are passed in. Credentials come from the AWS SDK default
 * credential chain, which reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
 * AWS_SESSION_TOKEN, among other sources, inside the SDK.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html
 * @see https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { LLMProvider, ProviderStructuredResult } from "../provider";
import { calculateCost } from "../provider";
import { createLogger } from "../../logger";

const logger = createLogger("bedrock-provider");

export interface BedrockProviderOptions {
  region: string;
  /** Cross-region inference profile ID, foundation model ID, or inference profile ARN */
  model: string;
  /** Model name for the pricing lookup; defaults to `model` */
  pricingModel?: string;
  /** For tests: a pre-built client */
  client?: Pick<BedrockRuntimeClient, "send">;
}

/**
 * Strip JSON from markdown code fences if present
 *
 * Some models (especially Claude) may wrap JSON in ```json ... ``` fences
 * even when instructed not to. This ensures clean JSON parsing.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Match ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Create an AWS Bedrock LLMProvider instance
 *
 * Uses the Converse API which provides a unified interface across
 * all Bedrock-hosted models (Claude, Llama, Mistral, Nova, etc.).
 *
 * JSON structured output is achieved by instructing the model via the system
 * prompt (Bedrock Converse does not have a native JSON mode like OpenAI).
 * A post-processing step strips code fences for models that wrap JSON.
 *
 * @param options - Region, model and optional pricing model
 * @returns LLMProvider backed by AWS Bedrock
 */
export function createBedrockProvider(options: BedrockProviderOptions): LLMProvider {
  const modelId = options.model;
  const bedrock = options.client ?? new BedrockRuntimeClient({ region: options.region });
  logger.info("Using Bedrock model", { modelId, region: options.region });

  return {
    async generateStructured(
      systemPrompt: string,
      userPrompt: string,
      maxTokens: number
    ): Promise<ProviderStructuredResult> {
      // Bedrock Converse API doesn't have a native JSON mode, so we enforce
      // JSON output via the system prompt. The caller's system prompt already
      // asks for JSON output; we add an explicit reminder.
      const jsonSystemPrompt = `${systemPrompt}\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation — just the raw JSON object.`;

      const command = new ConverseCommand({
        modelId,
        system: [{ text: jsonSystemPrompt }],
        messages: [
          {
            role: "user",
            content: [{ text: userPrompt }],
          },
        ],
        inferenceConfig: {
          maxTokens,
        },
      });

      const response = await bedrock.send(command);

      // Extract text content from the response
      const outputMessage = response.output?.message;
      if (!outputMessage?.content?.[0]) {
        throw new Error("No content in Bedrock response");
      }

      const firstBlock = outputMessage.content[0];
      if (!("text" in firstBlock) || !firstBlock.text) {
        throw new Error("Bedrock response did not contain text content");
      }

      // Strip code fences that some models add despite instructions
      const cleanContent = stripCodeFences(firstBlock.text);

      const usage = {
        promptTokens: response.usage?.inputTokens || 0,
        completionTokens: response.usage?.outputTokens || 0,
        totalTokens: (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0),
      };

      return {
        content: cleanContent,
        usage,
        // Inference profile ARNs don't appear in pricing tables
        cost: calculateCost(options.pricingModel ?? modelId, usage),
        model: modelId,
        provider: "bedrock",
      };
    },
  };
}
