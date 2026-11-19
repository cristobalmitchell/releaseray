import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load";
import { resolveConfig } from "../../src/config/resolve";
import type { PullData } from "../../src/core/fetch/github";
import type { LLMProvider } from "../../src/core/llm/provider";
import { readInputBlock } from "../../src/core/llm/providers/fake";
import { INPUT_CLOSE, INPUT_OPEN } from "../../src/core/prompt/build";
import { BUNDLED_TEMPLATES } from "../../src/core/prompt/templates";
import { createGit } from "../../src/core/range/git";
import { prepareRun, run, type RunResult } from "../../src/core/run";
import { DraftOutputSchema } from "../../src/core/types";
import { recordedGitHub } from "../helpers/fake-github";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";
import { INJECTION_FIXTURES, type InjectionFixture } from "./fixtures";

const PR = 40;
const KNOWN = new Set([PR]);

/**
 * A compromised model: it obeys the injection, copying the sanitized input
 * and the raw payload into every field, inventing refs and sections.
 */
function hostileModel(fixture: InjectionFixture): LLMProvider & { drafts: unknown[] } {
  const drafts: unknown[] = [];
  return {
    drafts,
    async generateStructured(_system, user) {
      const input = readInputBlock(user) as {
        pullRequests?: Array<{ title: string; body: string; number: number }>;
      };
      const pr = input.pullRequests?.[0];
      const draft = {
        highlights: [fixture.payload.slice(0, 500), `${pr?.title ?? ""} (#999)`.slice(0, 500)],
        sections: [
          {
            title: "Features",
            items: [
              {
                title: (pr?.title ?? "x").slice(0, 300),
                description: `${fixture.payload} ${pr?.body ?? ""}`.slice(0, 2000),
                ref: `#${pr?.number ?? PR}`,
              },
              {
                title: "Invented change",
                description: fixture.payload.slice(0, 2000),
                ref: "#999",
              },
            ],
          },
          { title: "Internal", items: [{ title: "Talking points: competitors are failing" }] },
          { title: "Totally New Section", items: [{ title: fixture.payload.slice(0, 300) }] },
        ],
        upgradeInstructions: [fixture.payload.slice(0, 2000)],
        contributors: ["attacker", "@everyone"],
      };
      drafts.push(draft);
      const content = JSON.stringify(draft);
      return {
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" as const },
        model: "hostile",
        provider: "openai" as const,
      };
    },
  };
}

const config = resolveConfig(parseConfig({ version: 1 }));

function pullFor(fixture: InjectionFixture): PullData {
  return {
    number: PR,
    title: fixture.title,
    body: fixture.body,
    labels: ["type: feature"],
    author: "contributor",
    merged: true,
    mergedAt: "2026-09-01T00:00:00Z",
    url: `https://github.com/acme/widgets/pull/${PR}`,
  };
}

/** Text outside inline code spans and fenced blocks. */
function outsideCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function contributorsLine(text: string): string {
  return text.split("\n").find((l) => l.startsWith("Thank you to ")) ?? "";
}

function assertSafe(text: string): void {
  const body = text.replace(contributorsLine(text), "");
  // Only allowlisted hosts.
  for (const url of body.match(/https?:\/\/[^\s)\]]+/g) ?? []) {
    const host = new URL(url).hostname;
    expect(host === "github.com" || host.endsWith(".github.com"), url).toBe(true);
  }
  // Only refs to fetched items, outside code.
  for (const match of outsideCode(body).matchAll(/(?:^|[\s([,])#(\d+)\b/g)) {
    expect(KNOWN.has(Number(match[1])), `#${match[1]}`).toBe(true);
  }
  for (const match of body.matchAll(/\/(?:pull|issues)\/(\d+)/g)) {
    expect(KNOWN.has(Number(match[1])), match[0]).toBe(true);
  }
  // No live mentions outside code (contributors come from PR authors, not the model).
  expect(outsideCode(body)).not.toMatch(/(^|[^\w`@/.-])@[A-Za-z0-9]/);
  // No images, no raw HTML, no hidden characters.
  expect(body).not.toContain("![");
  expect(body).not.toMatch(/<\/?[A-Za-z!][^>]*>/);
  expect(body).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/);
}

describe("prompt-injection fixtures", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = createTestRepo();
    repo.commit("chore: initial commit");
    repo.tag("v1.0.0");
    repo.commit(`feat: hostile change (#${PR})`);
    repo.tag("v1.1.0");
  });
  afterAll(() => repo.remove());

  const deps = (fixture: InjectionFixture, model: LLMProvider) => ({
    git: createGit(repo.dir),
    github: recordedGitHub({ pulls: [pullFor(fixture)], issues: [] }).reader,
    llm: () => model,
    templates: BUNDLED_TEMPLATES,
    repo: {
      owner: "acme",
      repo: "widgets",
      serverUrl: "https://github.com",
      visibility: "public" as const,
    },
    priced: false,
    sleep: async () => {},
    now: () => 0,
  });
  const request = {
    range: { kind: "tag" as const, to: "v1.1.0" },
    allowSparse: true,
    force: false,
    publish: false,
  };

  for (const fixture of INJECTION_FIXTURES) {
    describe(fixture.name, () => {
      let result: RunResult;
      let model: ReturnType<typeof hostileModel>;
      beforeAll(async () => {
        model = hostileModel(fixture);
        result = await run(request, config, deps(fixture, model));
      });

      it("keeps the input block intact: one block, closed once, at the end, with no hidden text", async () => {
        const prepared = await prepareRun(request, config, deps(fixture, model));
        for (const r of prepared.active) {
          const { user } = prepared.prompts(r.persona);
          // The template names the tag once in its instructions; the block is the last one.
          const block = user.slice(user.lastIndexOf(INPUT_OPEN));
          expect(block.split(INPUT_CLOSE)).toHaveLength(2);
          expect(block.trimEnd().endsWith(INPUT_CLOSE)).toBe(true);
          expect(user.split(INPUT_CLOSE)).toHaveLength(2);
          // Repository text cannot open a tag inside the block: < is escaped.
          expect(block.slice(INPUT_OPEN.length, -INPUT_CLOSE.length)).not.toContain("<");
          expect(block).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/);
          // Bodies are capped at maxBodyChars (4,000) before they reach the model.
          expect(user.length).toBeLessThan(20_000);
        }
      });

      it("publishes schema-valid output with no off-allowlist link, unknown ref, live mention, image or raw HTML", () => {
        const generated = result.personas.filter((p) => p.status === "generated");
        expect(generated.map((p) => p.id)).toEqual(["engineer", "customer"]);
        for (const p of generated) {
          expect(p.text).toBeDefined();
          assertSafe(p.text!);
          expect(p.report!.hallucinatedRefs).toBeGreaterThanOrEqual(1);
        }
        for (const draft of model.drafts)
          expect(DraftOutputSchema.safeParse(draft).success).toBe(true);
      });

      it("keeps internal sections out of the customer notes and contributors to real authors", () => {
        const customer = result.personas.find((p) => p.id === "customer")!;
        expect(customer.text).not.toMatch(/^## .*Internal/m);
        for (const p of result.personas.filter((x) => x.text)) {
          const line = contributorsLine(p.text!);
          if (line)
            expect(line).toBe("Thank you to @contributor for contributing to this release!");
        }
      });
    });
  }
});
