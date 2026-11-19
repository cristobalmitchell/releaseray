/**
 * `mode: migrate-personas`: converts the hosted product's persona YAML into
 * `.releaseray/config.yml` (CONVERSION-PLAN §4.7). Two shapes are read: the
 * settings page's export (`includeIdentifiers`, `customInstructions`) and
 * the older file that used `includeCodeExamples`. It writes only to the
 * workspace, never over an existing file, and makes no GitHub write.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { DEFAULT_CONFIG_PATH, parseConfig } from "../config/load";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import { result, type ModeResult } from "./types";

/** The comment that lets editors validate the file against the published schema. */
export const SCHEMA_COMMENT =
  "# yaml-language-server: $schema=https://raw.githubusercontent.com/cristobalmitchell/releaseray/v1/schema/releaseray.schema.json";

type Hosted = Record<string, unknown>;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const SLIDERS = [
  ["formalityLevel", "formality"],
  ["technicalDepth", "technicalDepth"],
  ["enthusiasmLevel", "enthusiasm"],
  ["detailLevel", "detail"],
] as const;

/**
 * Converts hosted persona entries to config persona entries.
 *
 * @param personas - Entries from the hosted YAML
 * @returns Config personas and notices about what was dropped or changed
 */
export function convertPersonas(personas: Hosted[]): {
  personas: Record<string, unknown>[];
  notices: string[];
} {
  const notices: string[] = [];
  const out = personas.map((p, i) => {
    const raw = String(p.slug ?? p.name ?? `persona-${i + 1}`);
    const slug = slugify(raw) || `persona-${i + 1}`;
    if (slug !== raw) notices.push(`Persona "${raw}": slug changed to "${slug}"`);
    const entry: Record<string, unknown> = { slug };
    if (typeof p.name === "string") entry.name = p.name.slice(0, 60);
    if (typeof p.description === "string") entry.description = p.description.slice(0, 500);
    if (p.isDisabled === true) entry.enabled = false;

    const tone: Record<string, number> = {};
    for (const [from, to] of SLIDERS) {
      if (typeof p[from] === "number") tone[to] = p[from] as number;
    }
    if (Object.keys(tone).length > 0) entry.tone = tone;

    const include: Record<string, boolean> = {};
    if (typeof p.includeIdentifiers === "boolean") include.identifiers = p.includeIdentifiers;
    if (typeof p.includeMigrationGuides === "boolean") {
      include.migrationGuides = p.includeMigrationGuides;
    }
    if (typeof p.includeBreakingChanges === "boolean") {
      include.breakingChanges = p.includeBreakingChanges;
    }
    if (Object.keys(include).length > 0) entry.include = include;

    if (typeof p.customInstructions === "string" && p.customInstructions.trim()) {
      const text = p.customInstructions.trim();
      entry.instructions = text.slice(0, 2000);
      if (text.length > 2000) {
        notices.push(`Persona "${slug}": instructions cut to 2,000 characters`);
      }
    }

    const dropped = ["tone", "audienceLevel", "includeCodeExamples"].filter((k) => k in p);
    if (dropped.length > 0) {
      notices.push(
        `Persona "${slug}": ${dropped.join(", ")} dropped; the hosted product never sent ${dropped.length === 1 ? "it" : "them"} to the model. Use tone sliders or instructions instead`
      );
    }
    return entry;
  });
  return { personas: out, notices };
}

/** `migrate-personas` request. */
export interface MigrateRequest {
  workspace: string;
  /** The `personas-file` input. */
  personasFile: string;
  /** The `config` input: where to write. */
  configPath?: string;
}

/**
 * Runs `migrate-personas`.
 *
 * @param request - Workspace, source file and target path
 * @returns The written config in the summary and `files`
 * @throws ReleaseRayError (exit 2) when the source is missing or unreadable,
 *   the target exists, or the result does not validate
 */
export function migratePersonas(request: MigrateRequest): ModeResult {
  const source = resolve(request.workspace, request.personasFile);
  const target = request.configPath ?? DEFAULT_CONFIG_PATH;
  const targetAbs = resolve(request.workspace, target);
  if (!existsSync(source)) {
    throw new ReleaseRayError(`${request.personasFile} does not exist`, EXIT_CODES.invalid, [
      "Set personas-file to the YAML downloaded from the hosted personas page",
    ]);
  }
  if (existsSync(targetAbs)) {
    throw new ReleaseRayError(`${target} already exists; nothing was written`, EXIT_CODES.invalid, [
      "Set the config input to a new path, or move the existing file first",
    ]);
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new ReleaseRayError(`${request.personasFile} is not valid YAML`, EXIT_CODES.invalid, [
      (error as Error).message.split("\n")[0],
    ]);
  }
  const list = (parsed as { personas?: unknown })?.personas;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ReleaseRayError(
      `${request.personasFile} has no personas list`,
      EXIT_CODES.invalid,
      []
    );
  }

  const { personas, notices } = convertPersonas(list as Hosted[]);
  const config = { version: 1, personas };
  parseConfig(config);

  const yaml = `${SCHEMA_COMMENT}\n# Converted from ${request.personasFile} by ReleaseRay migrate-personas.\n${stringify(config, { lineWidth: 0 })}`;
  mkdirSync(dirname(targetAbs), { recursive: true });
  writeFileSync(targetAbs, yaml);

  const mode = result(
    [
      "# ReleaseRay: personas migrated",
      "",
      `Wrote \`${target}\` in the runner's workspace. Copy it into your repository and commit it.`,
      "",
      "```yaml",
      yaml.trimEnd(),
      "```",
      "",
      ...(notices.length > 0 ? ["## Notices", "", ...notices.map((n) => `- ${n}`), ""] : []),
    ].join("\n")
  );
  mode.files = [target];
  mode.warnings = notices;
  return mode;
}
