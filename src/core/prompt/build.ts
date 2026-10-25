/**
 * Persona prompt builder and generation-input checks.
 *
 * Lifted from packages/shared/src/prompts/index.ts at 7d1d56f8, with these
 * changes (CONVERSION-PLAN PD-25):
 * - one builder for every persona, which sends only the selected persona's
 *   rules instead of all three;
 * - code, not the template, appends the input, as one delimited JSON block
 *   that the input cannot close;
 * - templates use `{{name}}` placeholders, and an unknown placeholder fails.
 */
import type { ResolvedPersona } from "../types";
import { generatePersonaInstructions } from "./tone";

export const PROMPT_VERSION = "2.0.0";

/**
 * Minimum requirements for meaningful release notes generation.
 * If these thresholds aren't met, generation should warn or abort.
 */
export const GENERATION_THRESHOLDS = {
  /** Minimum PRs needed for confident generation */
  MIN_PRS: 1,
  /** Warn if fewer PRs than this */
  WARN_THRESHOLD_PRS: 2,
  /** Minimum total content length (PR titles + bodies) */
  MIN_CONTENT_LENGTH: 100,
  /** Warn if content is below this threshold */
  WARN_THRESHOLD_CONTENT: 500,
};

/**
 * Check if input data is sufficient for release notes generation
 *
 * @param prs - Pull requests with title and body
 * @param commits - Commits, used when a range has few pull requests
 * @returns Whether generation may proceed, a warning, and the content length
 */
export function validateGenerationInput(
  prs: Array<{ title: string; body?: string | null }>,
  commits: Array<{ message: string }> = []
): {
  valid: boolean;
  warning: string | null;
  contentLength: number;
} {
  const prCount = prs.length;
  const commitCount = commits.length;

  // Calculate total content length
  const prContent = prs.reduce((acc, pr) => {
    return acc + (pr.title?.length || 0) + (pr.body?.length || 0);
  }, 0);
  const commitContent = commits.reduce((acc, c) => acc + (c.message?.length || 0), 0);
  const contentLength = prContent + commitContent;

  // Check thresholds
  if (prCount === 0 && commitCount === 0) {
    return {
      valid: false,
      warning: "No PRs or commits found. Cannot generate release notes without source data.",
      contentLength,
    };
  }

  if (prCount < GENERATION_THRESHOLDS.MIN_PRS && commitCount < 3) {
    return {
      valid: false,
      warning: `Insufficient data: Only ${prCount} PRs and ${commitCount} commits. Need at least ${GENERATION_THRESHOLDS.MIN_PRS} PR or 3 commits.`,
      contentLength,
    };
  }

  if (contentLength < GENERATION_THRESHOLDS.MIN_CONTENT_LENGTH) {
    return {
      valid: false,
      warning: `Insufficient content: Only ${contentLength} characters of PR/commit descriptions. Need at least ${GENERATION_THRESHOLDS.MIN_CONTENT_LENGTH}.`,
      contentLength,
    };
  }

  // Warnings (proceed but flag)
  let warning: string | null = null;

  if (prCount < GENERATION_THRESHOLDS.WARN_THRESHOLD_PRS) {
    warning = `Low PR count (${prCount}). Release notes may be sparse.`;
  } else if (contentLength < GENERATION_THRESHOLDS.WARN_THRESHOLD_CONTENT) {
    warning = `Low content volume (${contentLength} chars). Descriptions may be generic.`;
  }

  return { valid: true, warning, contentLength };
}

/** Placeholders a persona template may use. */
export const PERSONA_TEMPLATE_PLACEHOLDERS = [
  "persona",
  "personaRules",
  "toneInstructions",
  "sectionStructure",
] as const;

export type PersonaTemplateValues = Record<(typeof PERSONA_TEMPLATE_PLACEHOLDERS)[number], string>;

const PLACEHOLDER = /\{\{\s*([^{}\s]*)\s*\}\}/g;

/**
 * Lists the placeholders a template uses that are not in the allowed set.
 *
 * @param template - Template text
 * @param allowed - Placeholder names the caller supplies
 * @returns Unknown placeholder names, in order of first use
 */
export function findUnknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!allowed.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/**
 * Fills `{{name}}` placeholders. Blank lines left by empty values collapse.
 *
 * @param template - Template text
 * @param values - A value for every allowed placeholder
 * @returns The filled template
 * @throws Error naming any placeholder that has no value
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const unknown = findUnknownPlaceholders(template, Object.keys(values));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown template placeholder(s): ${unknown.map((n) => `{{${n}}}`).join(", ")}`
    );
  }
  return template
    .replace(PLACEHOLDER, (_match, name: string) => values[name])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Opening and closing tags of the input block. */
export const INPUT_OPEN = "<untrusted_input_json>";
export const INPUT_CLOSE = "</untrusted_input_json>";

/**
 * Serializes input as the delimited block appended to every persona prompt.
 *
 * Every `<`, `>` and `&` inside the JSON is written as a `\u` escape, which
 * JSON parsers read back unchanged, so no string in the input can produce the
 * closing tag.
 *
 * @param input - Data for the model (sanitized PRs, issues, classification)
 * @returns The block, including its tags
 */
export function formatUntrustedInput(input: unknown): string {
  const json = JSON.stringify(input, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `${INPUT_OPEN}\n${json}\n${INPUT_CLOSE}`;
}

/**
 * Build a prompt fragment that instructs the LLM to use a specific section structure.
 * Injected into the prompt when a persona has a sectionConfig defined.
 *
 * @param sections - Ordered, enabled sections from persona.sectionConfig
 * @param options - Visibility flags for highlights, upgrade instructions, contributors
 * @returns Prompt fragment string
 */
export function buildSectionConfigPromptFragment(
  sections: Array<{ name: string; description?: string }>,
  options: {
    showHighlights?: boolean;
    showUpgradeInstructions?: boolean;
    showContributors?: boolean;
  } = {}
): string {
  const {
    showHighlights = true,
    showUpgradeInstructions = true,
    showContributors = true,
  } = options;

  const sectionList = sections
    .map((s, i) => {
      const desc = s.description ? ` — ${s.description}` : "";
      return `${i + 1}. "${s.name}"${desc}`;
    })
    .join("\n");

  const parts: string[] = [];

  parts.push(`**Section Structure (REQUIRED — follow exactly):**`);
  parts.push(`Generate ONLY the following sections, in this exact order:\n${sectionList}`);
  parts.push(`Do NOT generate any sections not listed above.`);
  parts.push(`Each section title in your output MUST match the names above exactly.`);

  if (!showHighlights) {
    parts.push(`Do NOT include a "highlights" array — set it to an empty array [].`);
  }
  if (!showUpgradeInstructions) {
    parts.push(`Do NOT include "upgradeInstructions" — omit this field entirely.`);
  }
  if (!showContributors) {
    parts.push(`Do NOT include "contributors" — omit this field entirely.`);
  }

  return parts.join("\n");
}

/**
 * Text of the persona's rules: its settings as JSON, its guidance, and any
 * extra instructions from configuration.
 *
 * @param persona - The selected persona
 * @returns The rules text
 */
export function formatPersonaRules(persona: ResolvedPersona): string {
  const parts = [JSON.stringify(persona.settings, null, 2), persona.guidance];
  if (persona.instructions) parts.push(`Additional instructions:\n${persona.instructions}`);
  return parts.filter((p) => p.trim().length > 0).join("\n\n");
}

/**
 * Builds the user message for one persona: the filled persona template
 * followed by the delimited input block.
 *
 * @param persona - The selected persona; no other persona's rules are sent
 * @param template - The persona template, bundled or overridden
 * @param input - Data for the model
 * @returns The prompt text
 * @throws Error when the template uses an unknown placeholder
 */
export function buildPersonaPrompt(
  persona: ResolvedPersona,
  template: string,
  input: unknown
): string {
  const sections = persona.sections;
  const values: PersonaTemplateValues = {
    persona: persona.id,
    personaRules: formatPersonaRules(persona),
    toneInstructions: persona.tone
      ? generatePersonaInstructions(
          persona.tone.formality,
          persona.tone.technicalDepth,
          persona.tone.enthusiasm,
          persona.tone.detail
        ).trim()
      : "",
    sectionStructure: sections
      ? buildSectionConfigPromptFragment(
          sections.sectionConfig.filter((s) => s.enabled).sort((a, b) => a.order - b.order),
          sections
        )
      : "",
  };
  return `${renderTemplate(template, values)}\n\n${formatUntrustedInput(input)}`;
}
