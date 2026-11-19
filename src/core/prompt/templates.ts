/**
 * Bundled prompt templates.
 *
 * The Markdown files in `prompts/` at the repository root are the editable
 * source. GitHub checks out the whole Action repository when a workflow uses
 * it, so the files sit next to the bundle at run time. Users override them
 * with files in `.releaseray/prompts/` (CONVERSION-PLAN §4.4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Names of the templates the Action ships. */
export const TEMPLATE_NAMES = ["system", "persona"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export type Templates = Record<TemplateName, string>;

/** Directory holding the bundled templates. */
export const BUNDLED_PROMPTS_DIR = fileURLToPath(new URL("../../../prompts/", import.meta.url));

/**
 * Reads every template from a directory.
 *
 * @param dir - Directory holding `system.md` and `persona.md`
 * @returns The template texts, with one trailing newline removed
 * @throws Error when a file is missing
 */
export function readTemplates(dir: string = BUNDLED_PROMPTS_DIR): Templates {
  const read = (name: TemplateName) =>
    readFileSync(join(dir, `${name}.md`), "utf8").replace(/\n$/, "");
  return { system: read("system"), persona: read("persona") };
}

/** The bundled templates, read once. */
export const BUNDLED_TEMPLATES: Templates = readTemplates();

/** The bundled system prompt. */
export const SYSTEM_PROMPT = BUNDLED_TEMPLATES.system;
