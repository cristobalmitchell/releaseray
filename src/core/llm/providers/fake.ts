/**
 * A deterministic provider for tests and end-to-end runs. It makes no
 * network call: it reads the prompt's input block and turns the classified
 * changes into a draft, so the same input always yields the same output.
 */
import { INPUT_CLOSE, INPUT_OPEN } from "../../prompt/build";
import type { LLMProvider, ProviderStructuredResult } from "../provider";

/** The model name the fake reports. */
export const FAKE_MODEL = "releaseray-fake";

/** Section names the built-in personas use, by classifier category. */
const SECTION_FOR_CATEGORY: Record<string, string> = {
  "Breaking Changes": "Breaking Changes",
  Features: "Features",
  Improvements: "Improvements",
  Fixes: "Bug Fixes",
  Performance: "Performance",
  Security: "Security",
  Deprecations: "Deprecations",
  Docs: "Documentation",
  Internal: "Internal",
};

interface FakeInput {
  changes?: Array<{
    category: string;
    items: Array<{ title: string; ref?: { pr?: number; issue?: number } }>;
  }>;
}

/**
 * Reads the JSON between the input delimiters of a prompt.
 *
 * @param prompt - A persona prompt built by `buildPersonaPrompt`
 * @returns The parsed input, or an empty object when there is none
 */
export function readInputBlock(prompt: string): FakeInput {
  const start = prompt.lastIndexOf(INPUT_OPEN);
  const end = prompt.lastIndexOf(INPUT_CLOSE);
  if (start === -1 || end <= start) return {};
  return JSON.parse(prompt.slice(start + INPUT_OPEN.length, end)) as FakeInput;
}

/**
 * Creates the fake provider.
 *
 * @param options - `transform` lets a test rewrite the draft (for example to inject hostile text)
 * @returns The provider
 */
export function createFakeProvider(
  options: { transform?: (draft: Record<string, unknown>) => Record<string, unknown> } = {}
): LLMProvider {
  return {
    async generateStructured(systemPrompt, userPrompt): Promise<ProviderStructuredResult> {
      const input = readInputBlock(userPrompt);
      const sections = (input.changes ?? [])
        .filter((group) => group.items.length > 0)
        .map((group) => ({
          title: SECTION_FOR_CATEGORY[group.category] ?? group.category,
          items: group.items.map((item) => {
            const n = item.ref?.pr ?? item.ref?.issue;
            return n ? { title: item.title, ref: `#${n}` } : { title: item.title };
          }),
        }));
      const highlights = sections
        .flatMap((s) => s.items)
        .slice(0, 2)
        .map((i) => i.title);
      const draft = options.transform
        ? options.transform({ highlights, sections })
        : { highlights, sections };
      const content = JSON.stringify(draft);
      const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
      const completionTokens = Math.ceil(content.length / 4);
      return {
        content,
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
        model: FAKE_MODEL,
        provider: "openai",
      };
    },
  };
}
