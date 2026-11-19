import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callLLMWithSchema } from "../../src/core/llm/call";
import {
  calculateCost,
  createProvider,
  DEFAULT_OPENAI_MODEL,
  hasPricing,
  type LLMProvider,
} from "../../src/core/llm/provider";
import { createBedrockProvider } from "../../src/core/llm/providers/bedrock";

const openAICalls = vi.hoisted(() => ({ ctor: [] as unknown[], create: [] as unknown[] }));

vi.mock("openai", () => ({
  default: class OpenAI {
    constructor(options: unknown) {
      openAICalls.ctor.push(options);
    }
    chat = {
      completions: {
        create: async (body: unknown) => {
          openAICalls.create.push(body);
          return {
            model: "gpt-5-mini",
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          };
        },
      },
    };
  },
}));

describe("callLLMWithSchema", () => {
  it("throws without a provider", async () => {
    await expect(
      // @ts-expect-error -- the provider is required; JavaScript callers get a run-time error
      callLLMWithSchema("system", "user", z.object({}))
    ).rejects.toThrow("callLLMWithSchema requires a provider");
    await expect(
      // @ts-expect-error -- same, with an options object that lacks it
      callLLMWithSchema("system", "user", z.object({}), { maxTokens: 10 })
    ).rejects.toThrow("callLLMWithSchema requires a provider");
  });

  it("calls the injected provider", async () => {
    const provider: LLMProvider = {
      generateStructured: vi.fn().mockResolvedValue({
        content: '```json\n{"n":1}\n```',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
        model: "m",
        provider: "openai",
      }),
    };
    await expect(
      callLLMWithSchema("s", "u", z.object({ n: z.number() }), { provider })
    ).resolves.toEqual({ n: 1 });
  });
});

describe("createProvider", () => {
  it("builds the OpenAI provider from config and an injected key, with baseUrl", async () => {
    const provider = await createProvider(
      { provider: "openai", baseUrl: "http://localhost:8080/v1" },
      { openaiApiKey: "test-key" }
    );
    const result = await provider.generateStructured("s", "u", 100);
    expect(openAICalls.ctor.at(-1)).toEqual({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
      maxRetries: 0,
    });
    expect(openAICalls.create.at(-1)).toMatchObject({
      model: DEFAULT_OPENAI_MODEL,
      max_completion_tokens: 100,
      response_format: { type: "json_object" },
    });
    expect(result).toMatchObject({ content: '{"ok":true}', provider: "openai" });
  });

  it("fails clearly without an OpenAI key", async () => {
    await expect(createProvider({ provider: "openai" })).rejects.toThrow("needs an API key");
  });

  it("fails clearly without a Bedrock region", async () => {
    await expect(createProvider({ provider: "bedrock" })).rejects.toThrow("needs llm.region");
  });

  it("rejects an unknown provider", async () => {
    await expect(
      createProvider({ provider: "other" as "openai" }, { openaiApiKey: "k" })
    ).rejects.toThrow("Unsupported LLM provider: other");
  });
});

describe("Bedrock provider", () => {
  it("prices by pricingModel when the model is an inference-profile ARN", async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: '```json\n{"a":1}\n```' }] } },
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    const provider = createBedrockProvider({
      region: "us-east-1",
      model: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom",
      pricingModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      client: { send } as never,
    });
    const result = await provider.generateStructured("s", "u", 50);
    expect(result.content).toBe('{"a":1}');
    expect(result.cost.totalCost).toBe(1);
    expect(send.mock.calls[0][0].input).toMatchObject({ inferenceConfig: { maxTokens: 50 } });
  });
});

describe("pricing", () => {
  it("hasPricing tells known models from unknown ones", () => {
    expect(hasPricing("gpt-5-mini")).toBe(true);
    expect(hasPricing("my-local-model")).toBe(false);
    expect(
      hasPricing("my-local-model", { "my-local-model": { inputPer1M: 1, outputPer1M: 1 } })
    ).toBe(true);
    // calculateCost still reports 0 for an unknown model; reports show "n/a" via hasPricing.
    expect(
      calculateCost("my-local-model", { promptTokens: 5, completionTokens: 5, totalTokens: 10 })
        .totalCost
    ).toBe(0);
  });
});

describe("purity", () => {
  it("nothing under src/core/llm reads process.env", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    for (const file of files(join(__dirname, "..", "..", "src", "core", "llm"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env/);
    }
  });
});
