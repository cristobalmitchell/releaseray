import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BedrockRuntimeClient, type ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDraft } from "../../src/core/llm/draft";
import { hasPricing } from "../../src/core/llm/provider";
import { createAnthropicProvider, FALLBACK_BETA } from "../../src/core/llm/providers/anthropic";
import { createBedrockProvider } from "../../src/core/llm/providers/bedrock";
import { createOpenAIProvider } from "../../src/core/llm/providers/openai";
import { BoundedDraftSchema } from "../../src/core/validate/output";

const FIXTURES = join(__dirname, "..", "fixtures", "providers");
const fixture = (name: string) => {
  const data = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
  delete data._source;
  return data;
};

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Captured) => Response) {
  const calls: Captured[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const call = {
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await request.text()) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("openai contract", () => {
  it("sends JSON mode with max_completion_tokens and maps the documented response", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("openai-chat-completion.json")));
    const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-5-mini", fetch });
    const result = await provider.generateStructured("system text", "user text", 2048);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls[0].body).toMatchObject({
      model: "gpt-5-mini",
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "system text" },
        { role: "user", content: "user text" },
      ],
    });
    expect(calls[0].body).not.toHaveProperty("temperature");
    expect(BoundedDraftSchema.parse(JSON.parse(result.content)).sections[0].title).toBe("Features");
    expect(result).toMatchObject({
      usage: { promptTokens: 1117, completionTokens: 46, totalTokens: 1163 },
      model: "gpt-5-mini-2025-08-07",
      provider: "openai",
    });
  });

  it("targets an OpenAI-compatible endpoint through baseUrl", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("openai-chat-completion.json")));
    const provider = createOpenAIProvider({
      apiKey: "dummy",
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      fetch,
    });
    await provider.generateStructured("s", "u", 256);
    expect(calls[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("fails on an empty message", async () => {
    const empty = fixture("openai-chat-completion.json");
    (empty.choices as Array<{ message: { content: string | null } }>)[0].message.content = null;
    const { fetch } = fakeFetch(() => json(empty));
    const provider = createOpenAIProvider({ apiKey: "k", model: "gpt-5-mini", fetch });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(
      "No content in OpenAI response"
    );
  });

  it("leaves retries to ReleaseRay: one HTTP call per attempt, with the status in the error", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(
        { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } },
        429
      )
    );
    const provider = createOpenAIProvider({ apiKey: "k", model: "gpt-5-mini", fetch });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it("reports cost as n/a for a model without pricing", async () => {
    const unpriced = fixture("openai-chat-completion.json");
    unpriced.model = "acme-local-7b";
    const { fetch } = fakeFetch(() => json(unpriced));
    const provider = createOpenAIProvider({ apiKey: "k", model: "acme-local-7b", fetch });
    expect(hasPricing("acme-local-7b")).toBe(false);
    expect(hasPricing("gpt-5-mini")).toBe(true);
    const { usage } = await generateDraft(provider, "s", "u", {
      retries: 0,
      maxCompletionTokens: 256,
      priced: hasPricing("acme-local-7b"),
    });
    expect(usage.costUsd).toBeNull();
  });
});

describe("anthropic contract", () => {
  const message = () => fixture("anthropic-message.json");

  it("sends a Messages request with effort and fallbacks, and maps the documented response", async () => {
    const { fetch, calls } = fakeFetch(() => json(message()));
    const provider = createAnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-opus-5-5",
      fetch,
    });
    const result = await provider.generateStructured("system text", "user text", 2048);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/);
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-ant-test");
    expect(calls[0].headers.get("anthropic-version")).toBeTruthy();
    expect(calls[0].headers.get("anthropic-beta")).toBe(FALLBACK_BETA);
    expect(calls[0].body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 2048,
      output_config: { effort: "medium" },
      fallbacks: "default",
      messages: [{ role: "user", content: "user text" }],
    });
    expect(String(calls[0].body.system)).toMatch(
      /^system text\n\nRespond with one valid JSON object only/
    );
    expect(calls[0].body).not.toHaveProperty("thinking");
    expect(calls[0].body).not.toHaveProperty("temperature");
    expect(BoundedDraftSchema.parse(JSON.parse(result.content)).sections[0].title).toBe("Features");
    expect(result).toMatchObject({
      usage: { promptTokens: 1117, completionTokens: 61, totalTokens: 1178 },
      cost: { inputCost: 0.004468, outputCost: 0.00122, totalCost: 0.005688 },
      model: "claude-opus-5-5",
      provider: "anthropic",
    });
  });

  it("sends no fallbacks or effort to a model that does not take them", async () => {
    const reply = message();
    reply.model = "claude-haiku-4-5";
    const { fetch, calls } = fakeFetch(() => json(reply));
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-haiku-4-5", fetch });
    await provider.generateStructured("s", "u", 256);
    expect(calls[0].headers.get("anthropic-beta")).toBeNull();
    expect(calls[0].body).not.toHaveProperty("fallbacks");
    expect(calls[0].body).not.toHaveProperty("output_config");
  });

  it("fails on a refusal, naming its category", async () => {
    const refused = message();
    refused.content = [];
    refused.stop_reason = "refusal";
    refused.stop_details = { type: "refusal", category: "cyber", explanation: null };
    const { fetch } = fakeFetch(() => json(refused));
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(
      "The model declined the request (refusal: cyber)"
    );
  });

  it("fails on max_tokens, naming the setting to raise", async () => {
    const cut = message();
    cut.stop_reason = "max_tokens";
    const { fetch } = fakeFetch(() => json(cut));
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(
      /max_tokens \(256\).*llm\.maxCompletionTokens/
    );
  });

  it("fails on a response without text", async () => {
    const empty = message();
    empty.content = [{ type: "thinking", thinking: "", signature: "x" }];
    const { fetch } = fakeFetch(() => json(empty));
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(
      "No text content in Anthropic response"
    );
  });

  it("leaves retries to ReleaseRay: one HTTP call per attempt, with the status in the error", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529)
    );
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(/529/);
    expect(calls).toHaveLength(1);
  });

  it("prices the model that answered, and reports n/a for one without pricing", async () => {
    expect(hasPricing("claude-opus-5-5")).toBe(true);
    const unpriced = message();
    unpriced.model = "claude-future-9";
    const { fetch } = fakeFetch(() => json(unpriced));
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-future-9", fetch });
    const { usage } = await generateDraft(provider, "s", "u", {
      retries: 0,
      maxCompletionTokens: 256,
      priced: hasPricing("claude-future-9"),
    });
    expect(usage.costUsd).toBeNull();
  });
});

describe("bedrock contract", () => {
  function fakeClient(response: unknown) {
    const sent: ConverseCommand[] = [];
    return {
      sent,
      client: {
        send: vi.fn(async (command: ConverseCommand) => {
          sent.push(command);
          return response;
        }),
      } as unknown as Pick<BedrockRuntimeClient, "send">,
    };
  }

  it("sends a Converse request and maps the documented response, stripping code fences", async () => {
    const { client, sent } = fakeClient(fixture("bedrock-converse.json"));
    const provider = createBedrockProvider({
      region: "us-east-1",
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      client,
    });
    const result = await provider.generateStructured("system text", "user text", 4096);
    const input = sent[0].input;
    expect(input.modelId).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(input.inferenceConfig).toEqual({ maxTokens: 4096 });
    expect(input.system?.[0]).toMatchObject({ text: expect.stringContaining("valid JSON only") });
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "user text" }] }]);
    expect(BoundedDraftSchema.parse(JSON.parse(result.content)).sections[0].title).toBe(
      "Bug Fixes"
    );
    expect(result).toMatchObject({
      usage: { promptTokens: 980, completionTokens: 52, totalTokens: 1032 },
      provider: "bedrock",
    });
    expect(result.cost.totalCost).toBeGreaterThan(0);
  });

  it("prices an inference-profile ARN through pricingModel, and reports none without it", async () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
    const priced = createBedrockProvider({
      region: "us-east-1",
      model: arn,
      pricingModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      client: fakeClient(fixture("bedrock-converse.json")).client,
    });
    expect((await priced.generateStructured("s", "u", 256)).cost.totalCost).toBeGreaterThan(0);
    expect(hasPricing(arn)).toBe(false);
  });

  it("fails on a response without text", async () => {
    const provider = createBedrockProvider({
      region: "us-east-1",
      model: "m",
      client: fakeClient({ output: { message: { role: "assistant", content: [] } } }).client,
    });
    await expect(provider.generateStructured("s", "u", 256)).rejects.toThrow(
      "No content in Bedrock response"
    );
  });
});

describe("bedrock credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the three AWS variables from the environment without a network call", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLEEXAMPLE00");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "example-secret-access-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "example-session-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new BedrockRuntimeClient({ region: "us-east-1" });
    const credentials = await client.config.credentials();
    expect(credentials).toMatchObject({
      accessKeyId: "AKIAEXAMPLEEXAMPLE00",
      secretAccessKey: "example-secret-access-key",
      sessionToken: "example-session-token",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    client.destroy();
  });
});
