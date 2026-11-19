import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig, parseConfig } from "../../src/config/load";
import { resolveConfig } from "../../src/config/resolve";
import { ReleaseRayError } from "../../src/core/errors";
import type { IssueData, PullData } from "../../src/core/fetch/github";
import type { LLMProvider } from "../../src/core/llm/provider";
import { createFakeProvider } from "../../src/core/llm/providers/fake";
import { BUNDLED_TEMPLATES } from "../../src/core/prompt/templates";
import { createGit } from "../../src/core/range/git";
import { doctor } from "../../src/modes/doctor";
import { generate } from "../../src/modes/generate";
import { migratePersonas } from "../../src/modes/migrate-personas";
import { preview } from "../../src/modes/preview";
import { validateConfig } from "../../src/modes/validate-config";
import { recordedGitHub } from "../helpers/fake-github";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";
import { jsonSchemaErrors } from "../helpers/json-schema";

const FIXTURES = join(__dirname, "..", "fixtures");
const data = JSON.parse(readFileSync(join(FIXTURES, "golden", "github.json"), "utf8")) as {
  pulls: PullData[];
  issues: IssueData[];
};

const cleanup: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "releaseray-modes-"));
  cleanup.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function repoWithTags(): TestRepo {
  const repo = createTestRepo();
  repo.commit("chore: initial commit", "2026-01-10");
  repo.tag("v1.1.0");
  repo.commit("feat!: drop Node 18 support (#14)", "2026-05-04");
  repo.commit("perf: parse large files in a stream (#15)", "2026-05-05");
  repo.commit("fix: keep column order when exporting (#17)", "2026-05-07");
  repo.tag("v1.2.0");
  return repo;
}

/** A provider that counts calls and fails the test if called. */
function countingProvider() {
  let calls = 0;
  const provider: LLMProvider = {
    async generateStructured(...args) {
      calls++;
      return createFakeProvider().generateStructured(...args);
    },
  };
  return { provider, calls: () => calls };
}

const config = resolveConfig(parseConfig({ version: 1 }));
const repoCtx = (visibility: "public" | "private" = "public") => ({
  owner: "acme",
  repo: "widgets",
  serverUrl: "https://github.com",
  visibility,
});

describe("generate", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = repoWithTags();
  });
  afterAll(() => repo.remove());

  it("writes files and the summary and sets outputs", async () => {
    const ws = workspace();
    const github = recordedGitHub(data);
    const counting = countingProvider();
    const out = await generate(
      {
        range: { kind: "tag", to: "v1.2.0" },
        allowSparse: false,
        force: false,
        publish: false,
        workspace: ws,
      },
      config,
      {
        git: createGit(repo.dir),
        github: github.reader,
        llm: () => counting.provider,
        templates: BUNDLED_TEMPLATES,
        repo: repoCtx(),
        priced: false,
        sleep: async () => {},
        now: () => 0,
      }
    );
    expect(out.files).toEqual([
      ".releaseray/notes/v1.2.0/engineer.md",
      ".releaseray/notes/v1.2.0/customer.md",
      ".releaseray/notes/v1.2.0/notes.json",
    ]);
    expect(counting.calls()).toBe(2);
    expect(out.outputs).toMatchObject({
      key: "v1.2.0",
      from: "v1.1.0",
      to: "v1.2.0",
      "notes-dir": ".releaseray/notes/v1.2.0",
      "github-requests": "4",
      "llm-calls": "2",
      "llm-cost-usd": "n/a",
    });
    expect(out.outputs["notes-digest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(out.summary).toContain("## Engineer");
  });
});

describe("no-cost modes", () => {
  let repo: TestRepo;
  beforeAll(() => {
    repo = repoWithTags();
  });
  afterAll(() => repo.remove());

  it("preview makes no LLM call and no counted request, and labels its classification approximate", async () => {
    const github = recordedGitHub(data);
    const out = await preview(
      {
        range: { kind: "tag", to: "v1.2.0" },
        allowSparse: false,
        previewPrompts: false,
        workspace: workspace(),
      },
      config,
      {
        git: createGit(repo.dir),
        github: github.reader,
        templates: BUNDLED_TEMPLATES,
        repo: repoCtx(),
        sleep: async () => {},
        now: () => 0,
      }
    );
    expect(github.requests()).toBe(0);
    expect(out.summary).toContain("Approximate classification");
    expect(out.summary).toMatch(/about \d+ REST requests/);
    expect(out.outputs["llm-calls"]).toBe("0");
  });

  it("preview with preview-prompts fetches, writes prompts and makes no LLM call", async () => {
    const ws = workspace();
    const github = recordedGitHub(data);
    const out = await preview(
      {
        range: { kind: "tag", to: "v1.2.0" },
        allowSparse: false,
        previewPrompts: true,
        workspace: ws,
      },
      config,
      {
        git: createGit(repo.dir),
        github: github.reader,
        templates: BUNDLED_TEMPLATES,
        repo: repoCtx(),
        sleep: async () => {},
        now: () => 0,
      }
    );
    // Fetch only: 3 PRs and 1 linked issue, no release lookup.
    expect(github.requests()).toBe(4);
    expect(out.files).toEqual([
      ".releaseray/notes/v1.2.0/prompts/engineer.system.md",
      ".releaseray/notes/v1.2.0/prompts/engineer.user.md",
      ".releaseray/notes/v1.2.0/prompts/customer.system.md",
      ".releaseray/notes/v1.2.0/prompts/customer.user.md",
    ]);
    expect(out.summary).toMatch(/Internal \(CSM\): withheld/);
    const user = readFileSync(join(ws, out.files[1]), "utf8");
    expect(user).toContain("<untrusted_input_json>");
  });

  it("doctor makes no LLM call or write and reports each check", async () => {
    const ws = workspace();
    const github = recordedGitHub(data);
    const out = await doctor(
      {
        workspace: ws,
        credentials: { openai: false, aws: false },
        visibility: "public",
        nodeVersion: "24.22.1",
      },
      { git: createGit(repo.dir), github: github.reader }
    );
    expect(github.requests()).toBe(0);
    expect(out.checks.map((c) => [c.name, c.status])).toEqual([
      ["Configuration", "ok"],
      ["Node.js", "ok"],
      ["Checkout", "ok"],
      ["Tags", "ok"],
      ["GitHub token", "ok"],
      ["LLM credentials", "warn"],
      ["Model", "ok"],
      ["Repository visibility", "ok"],
    ]);
    expect(out.errors).toEqual([]);
    expect(out.summary).toContain("latest `v1.2.0`");
    expect(out.summary).toContain("internal withheld from the summary and files");
  });
});

describe("validate-config", () => {
  it("passes a valid file and lists every problem in an invalid one", () => {
    const ws = workspace();
    expect(validateConfig({ workspace: ws }).errors).toEqual([]);
    mkdirSync(join(ws, ".releaseray"));
    writeFileSync(
      join(ws, ".releaseray/config.yml"),
      "version: 1\noutputs:\n  githubRelese: {}\nllm:\n  provider: bedrock\n"
    );
    const out = validateConfig({ workspace: ws });
    expect(out.exitCode).toBe(2);
    expect(out.errors).toEqual([
      "outputs.githubRelese: unknown key",
      "llm.region: required when llm.provider is bedrock",
    ]);
    expect(out.summary).toContain("has 2 problems");
  });
});

describe("migrate-personas", () => {
  for (const fixture of ["legacy.yml", "hosted-export.yml"]) {
    it(`converts ${fixture} into a config that passes validate-config and the JSON Schema`, () => {
      const ws = workspace();
      mkdirSync(join(ws, ".releaseray"));
      copyFileSync(join(FIXTURES, "personas", fixture), join(ws, ".releaseray/personas.yml"));
      const out = migratePersonas({ workspace: ws, personasFile: ".releaseray/personas.yml" });
      expect(out.files).toEqual([".releaseray/config.yml"]);
      const text = readFileSync(join(ws, ".releaseray/config.yml"), "utf8");
      expect(text.split("\n")[0]).toMatch(/^# yaml-language-server: \$schema=/);
      expect(validateConfig({ workspace: ws }).errors).toEqual([]);
      expect(jsonSchemaErrors(parse(text))).toEqual([]);
      expect(out.warnings.some((w) => /audienceLevel/.test(w))).toBe(true);
    });
  }

  it("keeps instructions and include flags and fixes slugs", () => {
    const ws = workspace();
    mkdirSync(join(ws, ".releaseray"));
    copyFileSync(
      join(FIXTURES, "personas", "hosted-export.yml"),
      join(ws, ".releaseray/personas.yml")
    );
    const out = migratePersonas({ workspace: ws, personasFile: ".releaseray/personas.yml" });
    const loaded = loadConfig({ workspace: ws });
    const sales = loaded.personas.find((p) => p.id === "sales-enablement")!;
    expect(sales.instructions).toBe(
      "Lead with the customer problem each change solves.\nOne sentence per item."
    );
    expect(loaded.personas.find((p) => p.id === "customer")!.settings.include_pr_numbers).toBe(
      false
    );
    expect(out.warnings).toContain(
      'Persona "Sales Enablement": slug changed to "sales-enablement"'
    );
  });

  it("never overwrites an existing config", () => {
    const ws = workspace();
    mkdirSync(join(ws, ".releaseray"));
    copyFileSync(join(FIXTURES, "personas", "legacy.yml"), join(ws, ".releaseray/personas.yml"));
    writeFileSync(join(ws, ".releaseray/config.yml"), "version: 1\n");
    expect(() =>
      migratePersonas({ workspace: ws, personasFile: ".releaseray/personas.yml" })
    ).toThrow(ReleaseRayError);
    expect(readFileSync(join(ws, ".releaseray/config.yml"), "utf8")).toBe("version: 1\n");
  });

  it("fails clearly when the source is missing", () => {
    const ws = workspace();
    expect(existsSync(join(ws, ".releaseray/personas.yml"))).toBe(false);
    expect(() =>
      migratePersonas({ workspace: ws, personasFile: ".releaseray/personas.yml" })
    ).toThrow(/does not exist/);
  });
});
