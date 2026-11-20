import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DESCRIPTIONS } from "../../scripts/config-descriptions";
import { buildSchema, schemaPaths } from "../../scripts/generate-schema";
import { parseConfig } from "../../src/config/load";
import { jsonSchemaErrors } from "../helpers/json-schema";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The fenced block of a language that follows a heading. */
function blockAfter(markdown: string, heading: string, lang: string): string {
  const at = markdown.indexOf(heading);
  expect(at, heading).toBeGreaterThan(-1);
  const start = markdown.indexOf("```" + lang + "\n", at);
  const end = markdown.indexOf("\n```", start + 1);
  return markdown.slice(start + lang.length + 4, end);
}

describe("README", () => {
  const readme = read("README.md");

  it("has a starter config that passes the JSON Schema and validate-config, with the $schema comment", () => {
    const yaml = blockAfter(readme, "## Starter config", "yaml");
    expect(yaml.split("\n")[0]).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/cristobalmitchell\/releaseray\/v1\/schema\/releaseray\.schema\.json$/
    );
    const config = parse(yaml) as unknown;
    expect(jsonSchemaErrors(config)).toEqual([]);
    expect(() => parseConfig(config)).not.toThrow();
  });

  it("has a quickstart workflow that passes only declared inputs", () => {
    const inputs = Object.keys(
      (parse(read("action.yml")) as { inputs: Record<string, unknown> }).inputs
    );
    const workflow = parse(blockAfter(readme, "## Quickstart", "yaml")) as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
    };
    const step = Object.values(workflow.jobs)
      .flatMap((j) => j.steps)
      .find((s) => s.uses?.startsWith("cristobalmitchell/releaseray@"));
    expect(step).toBeDefined();
    for (const key of Object.keys(step!.with ?? {})) expect(inputs).toContain(key);
  });

  it("documents every input and output of action.yml", () => {
    const meta = parse(read("action.yml")) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
    };
    for (const name of [...Object.keys(meta.inputs), ...Object.keys(meta.outputs)]) {
      expect(readme, name).toContain(`\`${name}\``);
    }
  });
});

describe("configuration reference", () => {
  const paths = schemaPaths(buildSchema()).map((l) => l.path);

  it("describes every key in the schema", () => {
    expect(paths.filter((p) => !DESCRIPTIONS[p])).toEqual([]);
  });

  it("describes no key the schema lacks", () => {
    expect(Object.keys(DESCRIPTIONS).filter((p) => !paths.includes(p))).toEqual([]);
  });
});

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) out.add(slug(m[1]));
  }
  return out;
}

describe("documentation links", () => {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ...readdirSync(join(ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/${f}`),
  ];

  for (const file of files) {
    it(`${file}: every relative link and anchor resolves`, () => {
      const text = read(file).replace(/```[\s\S]*?```/g, "");
      const broken: string[] = [];
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split("#");
        const resolved = path ? resolve(dirname(join(ROOT, file)), path) : join(ROOT, file);
        if (!existsSync(resolved)) {
          broken.push(target);
          continue;
        }
        if (
          anchor &&
          resolved.endsWith(".md") &&
          !anchors(readFileSync(resolved, "utf8")).has(anchor)
        ) {
          broken.push(target);
        }
      }
      expect(broken).toEqual([]);
    });
  }
});
