import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderSchema, SCHEMA_PATH } from "../../scripts/generate-schema";
import { loadConfig, mergeLayers, parseConfig } from "../../src/config/load";
import { ReleaseRayError } from "../../src/core/errors";
import { classifyByLabels } from "../../src/core/classify/rules";
import { buildPersonaPrompt } from "../../src/core/prompt/build";
import { BUNDLED_TEMPLATES } from "../../src/core/prompt/templates";
import { GHP } from "../helpers/secret-fixtures";

const workspaces: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "releaseray-config-"));
  workspaces.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The `path: message` lines a raw config fails with, or [] when it passes. */
function problems(raw: unknown): string[] {
  try {
    parseConfig(raw);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseRayError);
    expect((error as ReleaseRayError).exitCode).toBe(2);
    return (error as ReleaseRayError).details;
  }
}

function withYaml(yaml: string) {
  return loadConfig({ workspace: workspace({ ".releaseray/config.yml": yaml }) });
}

describe("loading", () => {
  it("uses defaults when there is no file", () => {
    const loaded = loadConfig({ workspace: workspace() });
    expect(loaded.source).toBe("defaults");
    expect(loaded.personas.map((p) => p.id)).toEqual(["engineer", "internal", "customer"]);
    expect(loaded.config.outputs.githubRelease).toMatchObject({
      enabled: true,
      persona: "engineer",
      mode: "section",
      onHumanEdit: "skip",
    });
    expect(loaded.config.outputs.changelog.enabled).toBe(false);
    expect(loaded.model).toBe("gpt-5-mini");
    expect(loaded.personas[0].tone).toEqual({
      formality: 50,
      technicalDepth: 50,
      enthusiasm: 30,
      detail: 50,
    });
  });

  it("applies nested defaults inside a partly written object", () => {
    const loaded = withYaml("version: 1\nenrichment:\n  linkedIssues: false\n");
    expect(loaded.config.enrichment).toMatchObject({
      linkedIssues: false,
      bodies: true,
      maxBodyChars: 4000,
      maxLinkedIssues: 100,
    });
    expect(loaded.config.classification.exclude.labels).toEqual(["skip-release-notes"]);
  });

  it("fails when a named config path does not exist", () => {
    expect(() => loadConfig({ workspace: workspace(), path: "ci/releaseray.yml" })).toThrow(
      ReleaseRayError
    );
  });

  it("reports YAML syntax errors with a line and column", () => {
    try {
      withYaml("version: 1\npersonas: [\n");
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).details[0]).toMatch(/^\.releaseray\/config\.yml:\d+:\d+: /);
    }
  });

  it("lets inputs override the file", () => {
    const loaded = loadConfig({
      workspace: workspace({ ".releaseray/config.yml": "version: 1\nllm:\n  model: from-file\n" }),
      overrides: { llm: { model: "from-input" } },
    });
    expect(loaded.config.llm.model).toBe("from-input");
    expect(loaded.model).toBe("from-input");
  });

  it("defaults the model per provider", () => {
    const loaded = loadConfig({
      workspace: workspace({
        ".releaseray/config.yml": "version: 1\nllm:\n  provider: anthropic\n",
      }),
    });
    expect(loaded.model).toBe("claude-opus-5-5");
  });

  it("merges objects key by key and replaces arrays", () => {
    expect(mergeLayers({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, d: undefined })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
    });
  });
});

describe("errors", () => {
  it("prints path: message lines", () => {
    const lines = problems({
      version: 1,
      personas: [{ slug: "engineer", tone: { formality: 150 } }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^personas\[0\]\.tone\.formality: /);
  });

  it("rejects a misspelled key", () => {
    expect(problems({ version: 1, outputs: { githubRelese: { enabled: false } } })).toEqual([
      "outputs.githubRelese: unknown key",
    ]);
  });

  it("requires version 1", () => {
    expect(problems({})[0]).toMatch(/^version: /);
  });
});

describe("tone", () => {
  it("keeps a slider value of 0 and emits the lowest formality band", () => {
    const loaded = withYaml(
      "version: 1\npersonas:\n  - slug: customer\n    tone: { formality: 0 }\n"
    );
    const customer = loaded.personas.find((p) => p.id === "customer");
    expect(customer?.tone?.formality).toBe(0);
    expect(customer?.tone?.technicalDepth).toBe(50);
    const prompt = buildPersonaPrompt(customer!, BUNDLED_TEMPLATES.persona, {});
    expect(prompt).toContain("**Formality (0/100):**");
    expect(prompt).toContain("Use casual, friendly language");
  });
});

describe("personas", () => {
  it("drops a disabled built-in and adds a custom persona extending internal", () => {
    const loaded = withYaml(
      [
        "version: 1",
        "personas:",
        "  - slug: customer",
        "    enabled: false",
        "  - slug: sales",
        "    extends: internal",
        "    name: Sales enablement",
        "    instructions: Lead with the customer problem.",
      ].join("\n")
    );
    expect(loaded.personas.map((p) => p.id)).toEqual(["engineer", "internal", "sales"]);
    const sales = loaded.personas[2];
    expect(sales.visibility).toBe("internal");
    expect(sales.name).toBe("Sales enablement");
    expect(sales.guidance).toContain("customer-focused");
    expect(sales.instructions).toBe("Lead with the customer problem.");
  });

  it("maps configured sections to categories and include flags to section options", () => {
    const loaded = withYaml(
      [
        "version: 1",
        "personas:",
        "  - slug: engineer",
        "    include: { contributors: false, identifiers: false }",
        "    sections:",
        "      - { id: breaking-changes, name: Breaking Changes }",
        "      - { id: shipped, name: Shipped, categories: [features, improvements] }",
      ].join("\n")
    );
    const engineer = loaded.personas[0];
    expect(engineer.sections?.sectionConfig.map((s) => [s.id, s.order, s.isCustom])).toEqual([
      ["breaking-changes", 0, false],
      ["shipped", 1, true],
    ]);
    expect(engineer.sectionCategories).toEqual({
      "breaking-changes": ["breaking"],
      shipped: ["features", "improvements"],
    });
    expect(engineer.sections?.showContributors).toBe(false);
    expect(engineer.settings.include_pr_numbers).toBe(false);
  });

  it("reads instructionsFile from .releaseray/", () => {
    const loaded = loadConfig({
      workspace: workspace({
        ".releaseray/config.yml":
          "version: 1\npersonas:\n  - slug: customer\n    instructionsFile: .releaseray/prompts/customer.md\n",
        ".releaseray/prompts/customer.md": "Keep it short.",
      }),
    });
    expect(loaded.personas.find((p) => p.id === "customer")?.instructions).toBe("Keep it short.");
  });
});

describe("categories", () => {
  it("adds a configured category with a label and a regex label", () => {
    const loaded = withYaml(
      [
        "version: 1",
        "classification:",
        "  categories:",
        '    - { id: infrastructure, title: Infrastructure, labels: ["area: infra", "/^terraform/"], internal: true }',
      ].join("\n")
    );
    expect(loaded.categories.at(-1)).toMatchObject({ id: "infrastructure", internal: true });
    expect(classifyByLabels(["Area: Infra"], loaded.labelRules)).toBe("Infrastructure");
    expect(classifyByLabels(["terraform-aws"], loaded.labelRules)).toBe("Infrastructure");
  });

  it("renames a built-in category and keeps the hosted label map pointing at it", () => {
    const loaded = withYaml(
      "version: 1\nclassification:\n  categories:\n    - { id: fixes, title: Bug fixes }\n"
    );
    expect(loaded.categories.find((c) => c.id === "fixes")?.conventionalTypes).toEqual(["fix"]);
    expect(classifyByLabels(["type: bug"], loaded.labelRules)).toBe("Bug fixes");
  });

  it("resolves the fallback category title", () => {
    expect(
      withYaml("version: 1\nclassification: { fallbackCategory: fixes }\n").fallbackCategory
    ).toBe("Fixes");
  });
});

describe("cross-field rules", () => {
  const base = { version: 1 };

  it("persona slugs are unique", () => {
    expect(problems({ ...base, personas: [{ slug: "sales" }, { slug: "ops" }] })).toEqual([]);
    expect(problems({ ...base, personas: [{ slug: "sales" }, { slug: "sales" }] })).toEqual([
      'personas: persona slug "sales" appears more than once',
    ]);
  });

  it("output personas name enabled personas", () => {
    expect(
      problems({ ...base, outputs: { changelog: { enabled: true, persona: "customer" } } })
    ).toEqual([]);
    expect(problems({ ...base, outputs: { githubRelease: { persona: "nobody" } } })).toEqual([
      'outputs.githubRelease.persona: unknown persona "nobody"',
    ]);
    expect(problems({ ...base, personas: [{ slug: "engineer", enabled: false }] })).toEqual([
      'outputs.githubRelease.persona: persona "engineer" is disabled',
    ]);
    expect(problems({ ...base, outputs: { summary: { personas: ["ghost"] } } })).toEqual([
      'outputs.summary.personas[0]: unknown persona "ghost"',
    ]);
  });

  it("a disabled sink does not need its persona", () => {
    expect(
      problems({
        ...base,
        personas: [{ slug: "engineer", enabled: false }],
        outputs: { githubRelease: { enabled: false } },
      })
    ).toEqual([]);
  });

  it("section categories are known ids", () => {
    const sections = (s: unknown) => ({ ...base, personas: [{ slug: "engineer", sections: [s] }] });
    expect(problems(sections({ id: "fixes", name: "Fixes" }))).toEqual([]);
    expect(problems(sections({ id: "misc", name: "Misc", categories: ["nope"] }))).toEqual([
      'personas[0].sections[0].categories: unknown category "nope"',
    ]);
    expect(problems(sections({ id: "misc", name: "Misc" }))[0]).toMatch(/name its categories$/);
  });

  it("the fallback category exists", () => {
    expect(problems({ ...base, classification: { fallbackCategory: "nope" } })).toEqual([
      'classification.fallbackCategory: unknown category "nope"',
    ]);
  });

  it("category titles are unique", () => {
    expect(
      problems({ ...base, classification: { categories: [{ id: "bugs", title: "fixes" }] } })
    ).toEqual(['classification.categories: two categories share the title "fixes"']);
  });

  it("regular expressions compile", () => {
    expect(
      problems({
        ...base,
        classification: { exclude: { titlePatterns: ["^chore\\(release\\):", "/^promote/i"] } },
      })
    ).toEqual([]);
    expect(
      problems({ ...base, classification: { exclude: { titlePatterns: ["(unclosed"] } } })[0]
    ).toMatch(/^classification\.exclude\.titlePatterns\[0\]: invalid regular expression/);
    expect(
      problems({
        ...base,
        classification: { categories: [{ id: "infra", labels: ["/[a-/"] }] },
      })[0]
    ).toMatch(/^classification\.categories\[0\]\.labels\[0\]: invalid regular expression/);
  });

  it("instructions and instructionsFile are exclusive and the file stays in .releaseray/", () => {
    const persona = (p: object) => ({ ...base, personas: [{ slug: "customer", ...p }] });
    expect(problems(persona({ instructions: "a", instructionsFile: ".releaseray/a.md" }))).toEqual([
      "personas[0]: set instructions or instructionsFile, not both",
    ]);
    for (const file of ["../secrets.md", ".releaseray/../x.md", "/etc/passwd", "docs/a.md"]) {
      expect(problems(persona({ instructionsFile: file }))).toEqual([
        "personas[0].instructionsFile: must be a repository-relative path under .releaseray/ with no ..",
      ]);
    }
  });

  it("the instructions file exists, stays inside .releaseray/ and fits", () => {
    const config =
      "version: 1\npersonas:\n  - slug: customer\n    instructionsFile: .releaseray/c.md\n";
    expect(() =>
      loadConfig({ workspace: workspace({ ".releaseray/config.yml": config }) })
    ).toThrow(ReleaseRayError);

    const outside = workspace({ ".releaseray/config.yml": config, "secret.md": "x" });
    symlinkSync(join(outside, "secret.md"), join(outside, ".releaseray/c.md"));
    try {
      loadConfig({ workspace: outside });
      expect.unreachable();
    } catch (error) {
      expect((error as ReleaseRayError).details).toEqual([
        "personas[0].instructionsFile: .releaseray/c.md resolves outside .releaseray/",
      ]);
    }

    expect(() =>
      loadConfig({
        workspace: workspace({
          ".releaseray/config.yml": config,
          ".releaseray/c.md": "x".repeat(2001),
        }),
      })
    ).toThrow(/Invalid configuration/);
  });

  it("an internal persona on a published output needs allowInternalOutputs", () => {
    const internalRelease = {
      ...base,
      personas: [{ slug: "sales", extends: "internal" }],
      outputs: { githubRelease: { persona: "sales" } },
    };
    expect(problems(internalRelease)).toEqual([
      'outputs.githubRelease.persona: persona "sales" is internal; set outputs.allowInternalOutputs: true to publish it here',
    ]);
    expect(
      problems({
        ...internalRelease,
        outputs: { ...internalRelease.outputs, allowInternalOutputs: true },
      })
    ).toEqual([]);
  });

  it("provider settings match the provider", () => {
    expect(problems({ ...base, llm: { provider: "bedrock", region: "us-east-1" } })).toEqual([]);
    expect(problems({ ...base, llm: { provider: "bedrock" } })).toEqual([
      "llm.region: required when llm.provider is bedrock",
    ]);
    expect(problems({ ...base, llm: { region: "us-east-1" } })).toEqual([
      "llm.region: applies only to llm.provider bedrock",
    ]);
    expect(
      problems({
        ...base,
        llm: { provider: "bedrock", region: "us-east-1", baseUrl: "https://x.test" },
      })
    ).toEqual(["llm.baseUrl: applies only to llm.provider openai"]);
    expect(problems({ ...base, llm: { provider: "anthropic" } })).toEqual([]);
    expect(
      problems({ ...base, llm: { provider: "anthropic", baseUrl: "https://x.test" } })
    ).toEqual(["llm.baseUrl: applies only to llm.provider openai"]);
  });

  it("notifications wait for v1.1", () => {
    expect(
      problems({
        ...base,
        outputs: { notify: [{ type: "slack", persona: "engineer", webhookUrlEnv: "SLACK_URL" }] },
      })
    ).toEqual(["outputs.notify: notifications arrive in v1.1"]);
  });

  it("credentials and secret-shaped values are rejected anywhere", () => {
    expect(problems({ ...base, llm: { apiKey: "x" } })).toContain(
      "llm.apiKey: credentials do not belong in the config; name an environment variable (for example webhookUrlEnv or apiKeyEnv)"
    );
    const token = `${GHP}${"a".repeat(36)}`;
    expect(problems({ ...base, personas: [{ slug: "customer", instructions: token }] })).toEqual([
      "personas[0].instructions: looks like a secret; store it in an Actions secret instead",
    ]);
    expect(
      problems({
        ...base,
        personas: [{ slug: "customer", instructions: "Explain Bearer tokens plainly." }],
      })
    ).toEqual([]);
  });
});

describe("warnings", () => {
  it("asks for a longer job timeout when waiting on the rate limit", () => {
    const loaded = withYaml("version: 1\ngithub: { onBudgetExceeded: wait, maxWaitMinutes: 30 }\n");
    expect(loaded.warnings).toEqual([
      "github.onBudgetExceeded is wait: set the job's timeout-minutes above 30 plus the run time",
    ]);
  });
});

describe("JSON Schema", () => {
  it("is current", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(renderSchema());
  });

  it("rejects unknown keys and carries defaults", () => {
    const schema = JSON.parse(renderSchema()) as {
      additionalProperties: boolean;
      properties: { range: { properties: { maxPullRequests: { default: number } } } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.range.properties.maxPullRequests.default).toBe(250);
  });
});
