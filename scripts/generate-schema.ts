/**
 * Writes `schema/releaseray.schema.json` and `docs/configuration.md` from
 * the Zod config schema and `config-descriptions.ts`, or with `--check`
 * fails when either committed file is stale (CONVERSION-PLAN §4.6).
 *
 * The JSON Schema covers keys, types, ranges and defaults. Cross-field rules
 * (unknown persona names, internal personas on public outputs, and so on)
 * cannot be expressed there; `mode: validate-config` checks them.
 *
 * Usage: tsx scripts/generate-schema.ts [--check]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { ConfigShapeSchema } from "../src/config/schema";
import { DESCRIPTIONS, SECTIONS } from "./config-descriptions";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the schema is committed. */
export const SCHEMA_PATH = join(ROOT, "schema", "releaseray.schema.json");

/** Where the configuration reference is committed. */
export const DOCS_PATH = join(ROOT, "docs", "configuration.md");

/** The URL in the starter config's `yaml-language-server` comment. */
export const SCHEMA_ID =
  "https://raw.githubusercontent.com/cristobalmitchell/releaseray/v1/schema/releaseray.schema.json";

/** A JSON Schema node, as far as this script reads it. */
interface Node {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Node>;
  items?: Node;
  anyOf?: Node[];
  oneOf?: Node[];
}

/** A documented key. */
export interface Leaf {
  path: string;
  node: Node;
}

/**
 * Every documented path in the schema, in schema order: leaves, arrays of
 * objects and their item fields.
 *
 * @param node - Schema node
 * @param path - Its path
 * @returns Paths with their nodes
 */
export function schemaPaths(node: Node, path = ""): Leaf[] {
  if (node.type === "object" && node.properties) {
    return Object.entries(node.properties).flatMap(([key, child]) =>
      schemaPaths(child, path ? `${path}.${key}` : key)
    );
  }
  if (node.type === "array" && node.items?.type === "object" && node.items.properties) {
    return [{ path, node }, ...schemaPaths({ ...node.items }, `${path}[]`)];
  }
  if (node.type === "array" && node.items?.oneOf) {
    return [{ path, node }, ...variantPaths(node.items.oneOf, `${path}[]`)];
  }
  return [{ path, node }];
}

/**
 * The fields of a discriminated union, such as `outputs.notify[]`, each once
 * in first-seen order. A field that is a constant in every variant (the
 * discriminator) is shown as the list of its values.
 *
 * @param variants - The union's object variants
 * @param path - The union's path
 * @returns Paths with their nodes
 */
function variantPaths(variants: Node[], path: string): Leaf[] {
  const fields = new Map<string, Node[]>();
  for (const variant of variants) {
    for (const [key, child] of Object.entries(variant.properties ?? {})) {
      fields.set(key, [...(fields.get(key) ?? []), child]);
    }
  }
  return [...fields].map(([key, nodes]) => ({
    path: `${path}.${key}`,
    node: nodes.every((n) => n.const !== undefined)
      ? { type: "string", enum: nodes.map((n) => n.const) }
      : nodes[0],
  }));
}

function describe(node: Node, path = ""): void {
  const text = DESCRIPTIONS[path];
  if (text && path) node.description = text;
  if (node.type === "object" && node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      describe(child, path ? `${path}.${key}` : key);
    }
  }
  if (node.type === "array" && node.items?.properties) {
    for (const [key, child] of Object.entries(node.items.properties)) {
      describe(child, `${path}[].${key}`);
    }
  }
  for (const variant of node.type === "array" ? (node.items?.oneOf ?? []) : []) {
    for (const [key, child] of Object.entries(variant.properties ?? {})) {
      describe(child, `${path}[].${key}`);
    }
  }
}

/**
 * The JSON Schema with descriptions.
 *
 * @returns The schema object
 */
export function buildSchema(): Record<string, unknown> & Node {
  const schema = z.toJSONSchema(ConfigShapeSchema, {
    io: "input",
    target: "draft-2020-12",
  }) as Record<string, unknown> & Node;
  describe(schema);
  return {
    $schema: schema.$schema as string,
    $id: SCHEMA_ID,
    title: "ReleaseRay configuration",
    description: "Schema for .releaseray/config.yml. See docs/configuration.md.",
    ...schema,
  };
}

/**
 * Renders the schema text.
 *
 * @returns Formatted JSON with a trailing newline
 */
export function renderSchema(): string {
  return `${JSON.stringify(buildSchema(), null, 2)}\n`;
}

function typeOf(node: Node): string {
  if (node.enum) return node.enum.map((v) => `\`${String(v)}\``).join(" \\| ");
  if (node.const !== undefined) return `\`${String(node.const)}\``;
  if (node.anyOf) return node.anyOf.map(typeOf).join(" \\| ");
  if (node.oneOf) return "object";
  if (node.type === "array") return `list of ${node.items ? typeOf(node.items) : "values"}`;
  if (node.type === "integer" || node.type === "number") {
    const range =
      node.minimum !== undefined && node.maximum !== undefined
        ? ` ${node.minimum}–${node.maximum}`
        : node.minimum !== undefined
          ? ` ≥ ${node.minimum}`
          : "";
    return `${node.type}${range}`;
  }
  return node.type ?? "value";
}

function defaultOf(node: Node): string {
  if (node.default === undefined) return "";
  if (typeof node.default === "object") {
    const json = JSON.stringify(node.default);
    return json === "{}" ? "" : `\`${json}\``;
  }
  return `\`${String(node.default)}\``;
}

/**
 * Renders docs/configuration.md.
 *
 * @returns Markdown
 */
export function renderDocs(): string {
  const leaves = schemaPaths(buildSchema()).filter((l) => l.path !== "$schema");
  const lines = [
    "# Configuration reference",
    "",
    "<!-- Generated by scripts/generate-schema.ts from the Zod schema and scripts/config-descriptions.ts. Do not edit. -->",
    "",
    "ReleaseRay reads one optional file, `.releaseray/config.yml` (the `config` input changes the path). Every key is optional except `version`. Values merge in this order, later winning: built-in defaults, the file, Action inputs.",
    "",
    "Add this first line so editors check the file as you type:",
    "",
    "```yaml",
    `# yaml-language-server: $schema=${SCHEMA_ID}`,
    "```",
    "",
    "Rules that span keys (persona names in outputs, internal personas on published outputs, provider settings) are checked by `mode: validate-config` and at the start of every run. Credentials never go in this file: name them by environment variable.",
    "",
  ];
  for (const [key, section] of Object.entries(SECTIONS)) {
    const rows = leaves.filter(
      (l) => l.path === key || l.path.startsWith(`${key}.`) || l.path.startsWith(`${key}[]`)
    );
    if (rows.length === 0) continue;
    lines.push(
      `## ${section.title}`,
      "",
      section.intro,
      "",
      "| Key | Type | Default | Description |",
      "| --- | --- | --- | --- |"
    );
    for (const { path, node } of rows) {
      const description = (DESCRIPTIONS[path] ?? "").replace(/\|/g, "\\|");
      lines.push(`| \`${path}\` | ${typeOf(node)} | ${defaultOf(node)} | ${description} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const files = [
    { path: SCHEMA_PATH, text: renderSchema() },
    { path: DOCS_PATH, text: renderDocs() },
  ];
  if (process.argv.includes("--check")) {
    const stale = files.filter((f) => {
      try {
        return readFileSync(f.path, "utf8") !== f.text;
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      for (const f of stale) {
        console.error(`check-schema: ${f.path.replace(`${ROOT}/`, "")} is stale; run pnpm schema`);
      }
      process.exit(1);
    }
    console.log(
      "check-schema: schema/releaseray.schema.json and docs/configuration.md are current"
    );
    return;
  }
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.text);
    console.log(`Wrote ${f.path.replace(`${ROOT}/`, "")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
