/**
 * Prompt templates.
 *
 * The Markdown files in `prompts/` at the repository root are the editable
 * source; `scripts/generate-prompts.ts` turns them into `bundled.ts`, so the
 * single-file bundle carries them as strings. Users override them with files
 * in `.releaseray/prompts/` (CONVERSION-PLAN §4.4).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_PERSONA, BUNDLED_SYSTEM } from "./bundled";

/** Names of the templates the Action ships. */
export const TEMPLATE_NAMES = ["system", "persona"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export type Templates = Record<TemplateName, string>;

/**
 * Reads every template from a directory.
 *
 * @param dir - Directory holding `system.md` and `persona.md`
 * @returns The template texts, with one trailing newline removed
 * @throws Error when a file is missing
 */
export function readTemplates(dir: string): Templates {
  const read = (name: TemplateName) =>
    readFileSync(join(dir, `${name}.md`), "utf8").replace(/\n$/, "");
  return { system: read("system"), persona: read("persona") };
}

/** The bundled templates. */
export const BUNDLED_TEMPLATES: Templates = { system: BUNDLED_SYSTEM, persona: BUNDLED_PERSONA };

/**
 * The bundled templates with any user overrides from a directory such as
 * `.releaseray/prompts/`. Each file present replaces its template whole.
 *
 * @param dir - Override directory
 * @returns The templates in effect and which were overridden
 */
export function templatesWithOverrides(dir: string): {
  templates: Templates;
  overridden: TemplateName[];
} {
  const templates = { ...BUNDLED_TEMPLATES };
  const overridden: TemplateName[] = [];
  for (const name of TEMPLATE_NAMES) {
    const file = join(dir, `${name}.md`);
    if (existsSync(file)) {
      templates[name] = readFileSync(file, "utf8").replace(/\n$/, "");
      overridden.push(name);
    }
  }
  return { templates, overridden };
}

/** The bundled system prompt. */
export const SYSTEM_PROMPT = BUNDLED_TEMPLATES.system;
