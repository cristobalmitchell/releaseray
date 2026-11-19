/**
 * Writes `schema/releaseray.schema.json` from the Zod config schema, or with
 * `--check` fails when the committed file is stale (CONVERSION-PLAN §4.6).
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

/** Where the schema is committed. */
export const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "releaseray.schema.json"
);

/** The URL in the starter config's `yaml-language-server` comment. */
export const SCHEMA_ID =
  "https://raw.githubusercontent.com/cristobalmitchell/releaseray/v1/schema/releaseray.schema.json";

/**
 * Renders the JSON Schema text.
 *
 * @returns The schema as formatted JSON with a trailing newline
 */
export function renderSchema(): string {
  const schema = z.toJSONSchema(ConfigShapeSchema, { io: "input", target: "draft-2020-12" });
  const ordered = {
    $schema: schema.$schema,
    $id: SCHEMA_ID,
    title: "ReleaseRay configuration",
    description: "Schema for .releaseray/config.yml. See docs/configuration.md.",
    ...schema,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function main(): void {
  const expected = renderSchema();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(SCHEMA_PATH, "utf8");
    } catch {
      // A missing file is stale.
    }
    if (current !== expected) {
      console.error("check-schema: schema/releaseray.schema.json is stale; run pnpm schema");
      process.exit(1);
    }
    console.log("check-schema: schema/releaseray.schema.json is current");
    return;
  }
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  writeFileSync(SCHEMA_PATH, expected);
  console.log(`Wrote ${SCHEMA_PATH}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
