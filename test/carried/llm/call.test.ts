/**
 * Carried from packages/shared/src/llm/index.test.ts at 7d1d56f8. The
 * callLLMWithSchema cases pass the provider; the streaming cases retired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callLLMWithSchema, parseWithSchema } from "../../../src/core/llm/call";
import { calculateCost, PROVIDER_PRICING } from "../../../src/core/llm/provider";
import { z } from "zod";
import type { LLMProvider } from "../../../src/core/llm/provider";

// Mock the provider resolution
const mockGenerateStructured = vi.fn();

// Edited (issue 6): the provider is passed explicitly; there is no
// resolveProvider to mock and no streaming method.
const mockProvider: LLMProvider = {
  generateStructured: mockGenerateStructured,
};

// Mock logger to suppress test output
vi.mock("../../../src/core/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("callLLMWithSchema", () => {
  const TestSchema = z.object({
    message: z.string(),
    count: z.number(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateStructured.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call provider with correct parameters", async () => {
    mockGenerateStructured.mockResolvedValue({
      content: JSON.stringify({ message: "test", count: 5 }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { inputCost: 0.000003, outputCost: 0.00000625, totalCost: 0.00000925, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    const result = await callLLMWithSchema("System prompt", "User prompt", TestSchema, {
      provider: mockProvider,
      maxTokens: 8192,
    });

    expect(mockGenerateStructured).toHaveBeenCalledWith("System prompt", "User prompt", 8192);
    expect(result).toEqual({ message: "test", count: 5 });
  });

  it("should use default maxTokens when not specified", async () => {
    mockGenerateStructured.mockResolvedValue({
      content: JSON.stringify({ message: "test", count: 5 }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    await callLLMWithSchema("System", "User", TestSchema, { provider: mockProvider });

    expect(mockGenerateStructured).toHaveBeenCalledWith(
      "System",
      "User",
      16384 // Default maxTokens
    );
  });

  it("should return validated output", async () => {
    const mockData = { message: "Hello world", count: 42 };

    mockGenerateStructured.mockResolvedValue({
      content: JSON.stringify(mockData),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    const result = await callLLMWithSchema("System", "User", TestSchema, {
      provider: mockProvider,
    });
    expect(result).toEqual(mockData);
  });

  it("should return metrics with cost when returnMetrics is true", async () => {
    const mockData = { message: "test", count: 5 };

    mockGenerateStructured.mockResolvedValue({
      content: JSON.stringify(mockData),
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      cost: { inputCost: 0.00003, outputCost: 0.0000625, totalCost: 0.0000925, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    const result = await callLLMWithSchema("System", "User", TestSchema, {
      provider: mockProvider,
      returnMetrics: true,
    });

    expect(result).toEqual({
      data: mockData,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
      cost: {
        inputCost: 0.00003,
        outputCost: 0.0000625,
        totalCost: 0.0000925,
        currency: "USD",
      },
      metadata: {
        model: "gpt-5-mini",
        provider: "openai",
        latencyMs: expect.any(Number),
      },
    });
  });

  it("should throw error when provider returns no content", async () => {
    mockGenerateStructured.mockRejectedValue(new Error("No content in OpenAI response"));

    await expect(
      callLLMWithSchema("System", "User", TestSchema, { provider: mockProvider })
    ).rejects.toThrow("LLM processing failed");
  });

  it("should throw error on API failures", async () => {
    mockGenerateStructured.mockRejectedValue(new Error("API error"));

    await expect(
      callLLMWithSchema("System", "User", TestSchema, { provider: mockProvider })
    ).rejects.toThrow("LLM processing failed: API error");
  });

  it("should throw error when response doesn't match schema", async () => {
    mockGenerateStructured.mockResolvedValue({
      content: JSON.stringify({ wrong: "shape" }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    await expect(
      callLLMWithSchema("System", "User", TestSchema, { provider: mockProvider })
    ).rejects.toThrow("LLM processing failed");
  });

  it("should throw error when response is invalid JSON", async () => {
    mockGenerateStructured.mockResolvedValue({
      content: "not valid json",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    await expect(
      callLLMWithSchema("System", "User", TestSchema, { provider: mockProvider })
    ).rejects.toThrow("LLM processing failed");
  });

  it("should handle complex nested schemas", async () => {
    const ComplexSchema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
      items: z.array(z.string()),
    });

    const mockData = {
      user: { name: "John", age: 30 },
      items: ["a", "b", "c"],
    };

    mockGenerateStructured.mockResolvedValue({
      content: JSON.stringify(mockData),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      model: "gpt-5-mini",
      provider: "openai",
    });

    const result = await callLLMWithSchema("System", "User", ComplexSchema, {
      provider: mockProvider,
    });
    expect(result).toEqual(mockData);
  });
});

// ============================================================================
// COST CALCULATION
// ============================================================================

describe("calculateCost", () => {
  it("should calculate OpenAI gpt-5-mini cost correctly", () => {
    const cost = calculateCost("gpt-5-mini", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    expect(cost.inputCost).toBe(0.3); // $0.30 per 1M input
    expect(cost.outputCost).toBe(1.25); // $1.25 per 1M output
    expect(cost.totalCost).toBe(1.55);
    expect(cost.currency).toBe("USD");
  });

  it("should calculate Bedrock Claude 4.5 Haiku cost correctly (inference profile ID)", () => {
    const cost = calculateCost("us.anthropic.claude-haiku-4-5-20251001-v1:0", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    expect(cost.inputCost).toBe(1.0); // $1.00 per 1M input
    expect(cost.outputCost).toBe(5.0); // $5.00 per 1M output
    expect(cost.totalCost).toBe(6.0);
    expect(cost.currency).toBe("USD");
  });

  it("should calculate Bedrock Claude 4.5 Sonnet cost correctly (inference profile ID)", () => {
    const cost = calculateCost("us.anthropic.claude-sonnet-4-5-20250929-v1:0", {
      promptTokens: 500_000,
      completionTokens: 100_000,
      totalTokens: 600_000,
    });

    expect(cost.inputCost).toBe(1.5); // $3.00 per 1M * 0.5M
    expect(cost.outputCost).toBe(1.5); // $15.00 per 1M * 0.1M
    expect(cost.totalCost).toBe(3);
    expect(cost.currency).toBe("USD");
  });

  it("should return zero cost for unknown models", () => {
    const cost = calculateCost("unknown-model-v9", {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });

    expect(cost.inputCost).toBe(0);
    expect(cost.outputCost).toBe(0);
    expect(cost.totalCost).toBe(0);
  });

  it("should handle zero tokens", () => {
    const cost = calculateCost("gpt-5-mini", {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });

    expect(cost.totalCost).toBe(0);
  });

  it("should have pricing data for all documented models", () => {
    const expectedModels = [
      // OpenAI
      "gpt-5-mini",
      "gpt-5",
      // Bedrock — US inference profiles (default)
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      // Bedrock — foundation model IDs (for pricing lookup)
      "anthropic.claude-haiku-4-5-20251001-v1:0",
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "amazon.nova-pro-v1:0",
    ];

    for (const model of expectedModels) {
      const pricing = PROVIDER_PRICING[model];
      expect(pricing).toBeDefined();
      expect(pricing!.inputPer1M).toBeGreaterThan(0);
      expect(pricing!.outputPer1M).toBeGreaterThan(0);
    }
  });
});

describe("parseWithSchema", () => {
  const TestSchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it("should parse valid JSON with schema", () => {
    const jsonString = '{"name": "Alice", "age": 25}';
    const result = parseWithSchema(jsonString, TestSchema);
    expect(result).toEqual({ name: "Alice", age: 25 });
  });

  it("should throw error for invalid JSON", () => {
    const invalidJson = "Not valid JSON";
    expect(() => parseWithSchema(invalidJson, TestSchema)).toThrow("Schema validation failed");
  });

  it("should throw error when JSON doesn't match schema", () => {
    const jsonString = '{"name": "Bob"}'; // Missing 'age'
    expect(() => parseWithSchema(jsonString, TestSchema)).toThrow();
  });

  it("should throw error for wrong types", () => {
    const jsonString = '{"name": "Charlie", "age": "not a number"}';
    expect(() => parseWithSchema(jsonString, TestSchema)).toThrow();
  });

  it("should handle empty objects when schema allows", () => {
    const EmptySchema = z.object({});
    const result = parseWithSchema("{}", EmptySchema);
    expect(result).toEqual({});
  });

  it("should handle arrays", () => {
    const ArraySchema = z.array(z.string());
    const result = parseWithSchema('["a", "b", "c"]', ArraySchema);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("should validate nested structures", () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
    });

    const result = parseWithSchema(
      '{"user": {"name": "Dave", "email": "dave@example.com"}}',
      NestedSchema
    );
    expect(result.user.name).toBe("Dave");
    expect(result.user.email).toBe("dave@example.com");
  });

  it("should throw error for invalid email in nested structure", () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
    });

    expect(() =>
      parseWithSchema('{"user": {"name": "Eve", "email": "not-an-email"}}', NestedSchema)
    ).toThrow();
  });
});
