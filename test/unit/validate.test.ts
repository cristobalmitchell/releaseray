import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/resolve";
import { parseConfig } from "../../src/config/load";
import { ReleaseRayError } from "../../src/core/errors";
import { generateDraft } from "../../src/core/llm/draft";
import type { LLMProvider } from "../../src/core/llm/provider";
import { redactInternalLinks } from "../../src/core/sanitize/redact";
import type { DraftOutput } from "../../src/core/types";
import { checkSufficiency, fitInput } from "../../src/core/validate/input";
import {
  groundInlineRefs,
  quoteMentions,
  refNumber,
  stripIdentifiers,
  validateDraft,
  type ValidateOptions,
} from "../../src/core/validate/output";

const resolved = resolveConfig(parseConfig({ version: 1 }));
const persona = (id: string) => resolved.personas.find((p) => p.id === id)!;

function opts(id = "engineer", extra: Partial<ValidateOptions> = {}): ValidateOptions {
  return {
    persona: persona(id),
    knownRefs: new Set([12, 40]),
    categories: resolved.categories,
    fallbackCategory: "improvements",
    allowedDomains: ["github.com"],
    redactPaths: true,
    pullAuthors: ["alice", "dependabot[bot]", "bob", "alice"],
    ...extra,
  };
}

const hostile: DraftOutput = {
  highlights: ["Faster sign-in for @octocat and @acme/platform (#999)"],
  sections: [
    {
      title: "Features",
      items: [
        {
          title: "New dashboard <script>alert(1)</script><b>bold</b>",
          description:
            "See https://internal.corp.example/wiki and ![x](https://img.example/a.png) <!-- hidden -->",
          ref: "#999",
        },
        { title: "Export to CSV (#12)", ref: "https://github.com/o/r/pull/12" },
      ],
    },
  ],
  contributors: ["mallory"],
};

describe("validateDraft", () => {
  it("removes unknown refs, redacts links, quotes mentions, and strips HTML and images", () => {
    const { draft, report } = validateDraft(hostile, opts());
    expect(report.hallucinatedRefs).toBe(2);
    const [features] = draft.sections;
    expect(features.title).toBe("Features");
    expect(features.items[0]).toEqual({
      title: "New dashboard alert(1)bold",
      description: "See [redacted] and",
    });
    expect(features.items[1]).toEqual({ title: "Export to CSV (#12)", ref: "#12" });
    expect(draft.highlights).toEqual(["Faster sign-in for `@octocat` and `@acme/platform`"]);
    const all = JSON.stringify(draft);
    expect(all).not.toMatch(/<[a-z!]/i);
    expect(all).not.toContain("![");
    expect(all).not.toContain("internal.corp");
  });

  it("takes contributors from PR authors, never from the model", () => {
    expect(validateDraft(hostile, opts()).draft.contributors).toEqual(["alice", "bob"]);
  });

  it("merges unknown sections into the fallback section", () => {
    const { draft, report } = validateDraft(
      { highlights: [], sections: [{ title: "Misc things", items: [{ title: "Tweak" }] }] },
      opts()
    );
    expect(report.mergedSections).toEqual(["Misc things"]);
    expect(draft.sections).toEqual([{ title: "Improvements", items: [{ title: "Tweak" }] }]);
  });

  it("drops internal sections for the customer persona", () => {
    const { draft, report } = validateDraft(
      {
        highlights: [],
        sections: [
          { title: "Internal", items: [{ title: "Refactor the queue" }] },
          { title: "Bug Fixes", items: [{ title: "Fixed login" }] },
        ],
      },
      opts("customer")
    );
    expect(report.droppedSections).toEqual(["Internal"]);
    expect(draft.sections.map((s) => s.title)).toEqual(["Bug Fixes"]);
  });

  it("strips identifiers when the persona hides them", () => {
    const hidden = resolveConfig(
      parseConfig({ version: 1, personas: [{ slug: "customer", include: { identifiers: false } }] })
    ).personas.find((p) => p.id === "customer")!;
    const { draft } = validateDraft(
      {
        highlights: ["Sign-in fixed (#12) in a1b2c3d, see https://github.com/o/r/pull/12"],
        sections: [{ title: "Bug Fixes", items: [{ title: "Fixed login (#12)", ref: "#12" }] }],
      },
      opts("customer", { persona: hidden })
    );
    expect(draft.highlights).toEqual(["Sign-in fixed in , see"]);
    expect(draft.sections[0].items[0]).toEqual({ title: "Fixed login" });
  });
});

describe("text helpers", () => {
  it("reads ref numbers in every form the model uses", () => {
    expect(refNumber("#12")).toBe(12);
    expect(refNumber("12")).toBe(12);
    expect(refNumber("PR #12")).toBe(12);
    expect(refNumber("https://github.com/o/r/issues/40")).toBe(40);
    expect(refNumber("none")).toBeNull();
  });

  it("leaves code spans and emails alone", () => {
    expect(quoteMentions("Ask `@ops` or mail ops@example.com, ping @ops")).toBe(
      "Ask `@ops` or mail ops@example.com, ping `@ops`"
    );
    expect(quoteMentions("Bumped by @dependabot[bot]")).toBe("Bumped by `@dependabot[bot]`");
    expect(groundInlineRefs("Fixed (#12, #77) and `#77`", new Set([12]))).toEqual({
      text: "Fixed (#12, ) and `#77`",
      removed: 1,
    });
  });

  it("keeps hex words that are not SHAs", () => {
    expect(stripIdentifiers("Added a cafebabe decade feature")).toBe(
      "Added a cafebabe decade feature"
    );
  });
});

describe("link allowlist", () => {
  it("accepts an allowed host and its subdomains but not look-alikes", () => {
    expect(redactInternalLinks("https://github.com/o/r", [])).toBe("https://github.com/o/r");
    expect(redactInternalLinks("https://docs.github.com/x", [])).toBe("https://docs.github.com/x");
    expect(redactInternalLinks("https://evilgithub.com/x", [])).toBe("[redacted]");
    expect(redactInternalLinks("https://github.com.evil.io/x", [])).toBe("[redacted]");
  });
});

describe("input checks", () => {
  it("stops sparse input with exit 5 unless allowed", () => {
    expect(() => checkSufficiency([], [], false)).toThrow(ReleaseRayError);
    try {
      checkSufficiency([{ title: "x", body: "" }], [], false);
    } catch (error) {
      expect((error as ReleaseRayError).exitCode).toBe(5);
      expect((error as ReleaseRayError).details[1]).toBe(
        "Set allow-sparse: true to generate anyway"
      );
    }
    expect(() => checkSufficiency([{ title: "x", body: "" }], [], true)).not.toThrow();
  });

  const measure = (shape: { maxBodyChars: number; linkedIssueBodies: boolean }) =>
    100 * shape.maxBodyChars + (shape.linkedIssueBodies ? 50 * 4000 : 0) + 4000;

  it("fails an over-size prompt under fail", () => {
    try {
      fitInput(measure, { maxBodyChars: 4000, linkedIssueBodies: true }, 100_000, "fail");
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).exitCode).toBe(3);
      expect((error as ReleaseRayError).message).toBe(
        "The prompt is about 151000 tokens, over llm.maxInputTokens (100000)"
      );
    }
  });

  it("lowers maxBodyChars, then drops linked-issue bodies, under degrade", () => {
    const fitted = fitInput(
      measure,
      { maxBodyChars: 4000, linkedIssueBodies: true },
      80_000,
      "degrade"
    );
    expect(fitted.shape).toEqual({ maxBodyChars: 1000, linkedIssueBodies: true });
    expect(fitted.drops).toEqual(["maxBodyChars lowered to 2000", "maxBodyChars lowered to 1000"]);

    const tight = fitInput(
      measure,
      { maxBodyChars: 4000, linkedIssueBodies: true },
      2000,
      "degrade"
    );
    expect(tight.shape).toEqual({ maxBodyChars: 0, linkedIssueBodies: false });
    expect(tight.drops.at(-1)).toBe("linked-issue bodies");
  });
});

describe("generateDraft", () => {
  function provider(outputs: string[]): LLMProvider & { calls: number } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async generateStructured() {
        const content = outputs[Math.min(calls, outputs.length - 1)];
        calls++;
        return {
          content,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: { inputCost: 0.001, outputCost: 0.002, totalCost: 0.003, currency: "USD" as const },
          model: "fake",
          provider: "openai" as const,
        };
      },
    } as LLMProvider & { calls: number };
  }

  it("asks again after invalid output and reports usage", async () => {
    const p = provider(["not json", '```json\n{"highlights":[],"sections":[]}\n```']);
    const { draft, usage } = await generateDraft(p, "s", "u", {
      retries: 3,
      maxCompletionTokens: 1000,
      priced: true,
    });
    expect(draft).toEqual({ highlights: [], sections: [] });
    expect(usage.calls).toBe(2);
    expect(usage.costUsd).toBeCloseTo(0.003);
  });

  it("exits 5 when output still fails the schema after retries", async () => {
    const p = provider(['{"highlights":"nope"}']);
    try {
      await generateDraft(p, "s", "u", { retries: 2, maxCompletionTokens: 1000, priced: false });
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).exitCode).toBe(5);
      expect((error as ReleaseRayError).message).toBe(
        "The model's output was still invalid after 3 attempts"
      );
    }
    expect(p.calls).toBe(3);
  });

  it("rejects output past the length caps", async () => {
    const huge = JSON.stringify({ highlights: Array(11).fill("x"), sections: [] });
    await expect(
      generateDraft(provider([huge]), "s", "u", {
        retries: 0,
        maxCompletionTokens: 1000,
        priced: false,
      })
    ).rejects.toBeInstanceOf(ReleaseRayError);
  });
});
