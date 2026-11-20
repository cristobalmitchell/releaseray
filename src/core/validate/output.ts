/**
 * Takes model output to publishable content (CONVERSION-PLAN §6.6). Every
 * step is a pure function; `validateDraft` runs them in order.
 *
 * 1. Parse with length caps ({@link BoundedDraftSchema}; parsing and retries
 *    happen in `llm/draft.ts`).
 * 2. Ground references: refs and inline `#n` that name nothing fetched for
 *    this release are removed and counted.
 * 3. Check sections against the persona's enabled sections.
 * 4. Filter what the text can do: no raw HTML, no images, no live mentions,
 *    no off-allowlist links, and no identifiers when the persona hides them.
 * 5. Contributors come from fetched PR authors, never from the model.
 */
import { z } from "zod";
import { sanitizeForPublishing } from "../sanitize/publish";
import type { DraftOutput, ResolvedPersona } from "../types";

/** {@link DraftOutputSchema} with length caps, so a runaway model cannot flood a release. */
export const BoundedDraftSchema = z.object({
  highlights: z.array(z.string().max(500)).max(10),
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(100),
        items: z
          .array(
            z.object({
              title: z.string().min(1).max(300),
              description: z.string().max(2000).optional(),
              ref: z.string().max(200).optional(),
            })
          )
          .max(200),
      })
    )
    .max(20),
  upgradeInstructions: z.array(z.string().max(2000)).max(20).optional(),
  contributors: z.array(z.string().max(100)).max(200).optional(),
});

/** What validation changed, for the summary and `notes.json`. */
export interface ValidationReport {
  /** Refs and inline `#n` that named nothing fetched for this release. */
  hallucinatedRefs: number;
  /** Sections the persona does not have, merged into the fallback section. */
  mergedSections: string[];
  /** Sections dropped: excluded or internal categories, or no fallback to merge into. */
  droppedSections: string[];
}

/** Inputs to {@link validateDraft}. */
export interface ValidateOptions {
  persona: ResolvedPersona;
  /** PR and linked-issue numbers fetched for this release. */
  knownRefs: ReadonlySet<number>;
  /** Resolved categories, to place unknown sections and find internal ones. */
  categories: ReadonlyArray<{ id: string; title: string; internal: boolean }>;
  /** `classification.fallbackCategory`. */
  fallbackCategory: string;
  allowedDomains: string[];
  redactPaths: boolean;
  /** Fetched PR authors, in PR order. */
  pullAuthors: ReadonlyArray<string | null>;
}

const REF_NUMBER = /(?:^|[#/])(\d+)\s*$/;
const INLINE_REF = /(^|[\s([,])#(\d+)\b/g;

/**
 * The number a ref names: `#12`, `12`, `PR #12` or a pull or issue URL.
 *
 * @param ref - The model's ref text
 * @returns The number, or null when the ref names none
 */
export function refNumber(ref: string): number | null {
  const url = /\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/.exec(ref.trim());
  if (url) return Number(url[1]);
  const plain = REF_NUMBER.exec(ref.trim());
  return plain ? Number(plain[1]) : null;
}

/** Applies `fn` to text outside inline code spans and fenced blocks. */
function outsideCode(text: string, fn: (plain: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

/**
 * Removes inline `#n` references that name nothing fetched.
 *
 * @param text - Model text
 * @param known - Fetched numbers
 * @returns The text and how many references were removed
 */
export function groundInlineRefs(
  text: string,
  known: ReadonlySet<number>
): { text: string; removed: number } {
  let removed = 0;
  const out = outsideCode(text, (plain) =>
    plain
      // A pull or issue URL is a reference too, even on an allowed host.
      .replace(/https?:\/\/[^\s)\]]+\/(?:pull|issues)\/(\d+)[^\s)\]]*/g, (url, n: string) => {
        if (known.has(Number(n))) return url;
        removed++;
        return "";
      })
      .replace(INLINE_REF, (match, lead: string, n: string) => {
        if (known.has(Number(n))) return match;
        removed++;
        return lead;
      })
      // A reference removed from "(#12)" leaves "()".
      .replace(/\s*\(\s*(?:,\s*)*\)/g, "")
  );
  return { text: out, removed };
}

/**
 * Makes `@login` and `@org/team` mentions inline code, so notes never notify anyone.
 *
 * @param text - Model text
 * @returns The text with mentions quoted
 */
export function quoteMentions(text: string): string {
  return outsideCode(text, (plain) =>
    plain.replace(
      /(^|[^\w`@/.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?(?:\/[A-Za-z0-9_.-]+)?)/g,
      "$1`@$2`"
    )
  );
}

/**
 * Removes raw HTML (tags and comments) and image syntax.
 *
 * @param text - Model text
 * @returns The text without HTML or images
 */
export function stripHtmlAndImages(text: string): string {
  return outsideCode(text, (plain) =>
    plain
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
      .replace(/<\/?[A-Za-z][^<>]*>/g, "")
  );
}

/**
 * Removes `#n`, commit SHAs and pull or issue URLs, for personas with
 * `include.identifiers: false`.
 *
 * @param text - Model text
 * @returns The text without identifiers
 */
export function stripIdentifiers(text: string): string {
  return outsideCode(text, (plain) =>
    plain
      .replace(/https?:\/\/[^\s)]+\/(?:pull|issues|commit)\/[0-9a-f]+[^\s)]*/gi, "")
      .replace(/(^|[\s([,])#\d+\b/g, "$1")
      .replace(/\b[0-9a-f]{7,40}\b/g, (sha) => (/[a-f]/.test(sha) && /\d/.test(sha) ? "" : sha))
      .replace(/\s*\(\s*(?:,\s*)*\)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

/** Whether the persona shows PR and issue numbers. */
function showsIdentifiers(persona: ResolvedPersona): boolean {
  if (persona.settings.include_pr_numbers === false) return false;
  // The built-in customer persona lists "PR/issue numbers" under exclude.
  const exclude = persona.settings.exclude;
  return !(Array.isArray(exclude) && exclude.some((e) => /PR\/issue numbers/i.test(String(e))));
}

/**
 * Filters one piece of model text: HTML and images, mentions, links,
 * secrets and paths, and identifiers when hidden.
 *
 * @param text - Model text
 * @param options - Persona and sanitize settings
 * @returns Publishable text
 */
export function filterText(
  text: string,
  options: Pick<ValidateOptions, "persona" | "allowedDomains" | "redactPaths">
): string {
  // Quote mentions first, so path redaction cannot split "@org/team".
  let out = quoteMentions(stripHtmlAndImages(text));
  // Paths are redacted outside code; links and secrets everywhere.
  out = outsideCode(out, (plain) =>
    sanitizeForPublishing(plain, {
      allowedDomains: options.allowedDomains,
      redactPaths: options.redactPaths,
    })
  );
  out = sanitizeForPublishing(out, { allowedDomains: options.allowedDomains, redactPaths: false });
  if (!showsIdentifiers(options.persona)) out = stripIdentifiers(out);
  return out.trim();
}

/**
 * Contributors from fetched PR authors: unique, in PR order, without bots.
 *
 * @param authors - PR authors
 * @returns Logins
 */
export function contributorsFrom(authors: ReadonlyArray<string | null>): string[] {
  const seen = new Set<string>();
  for (const author of authors) {
    if (!author || /\[bot\]$/i.test(author)) continue;
    seen.add(author);
  }
  return [...seen];
}

function normalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Validates and filters a parsed draft for one persona.
 *
 * @param draft - Output that passed {@link BoundedDraftSchema}
 * @param options - Persona, fetched refs, categories and sanitize settings
 * @returns The publishable draft and what changed
 */
export function validateDraft(
  draft: DraftOutput,
  options: ValidateOptions
): { draft: DraftOutput; report: ValidationReport } {
  const { persona } = options;
  const report: ValidationReport = { hallucinatedRefs: 0, mergedSections: [], droppedSections: [] };
  const text = (value: string) => {
    const grounded = groundInlineRefs(value, options.knownRefs);
    report.hallucinatedRefs += grounded.removed;
    return filterText(grounded.text, options);
  };

  // Which categories this persona never shows.
  const excluded = new Set(persona.excludeCategories ?? []);
  const hidden = (categoryIds: readonly string[]) =>
    categoryIds.length > 0 && categoryIds.every((id) => excluded.has(id));

  const enabled = (persona.sections?.sectionConfig ?? [])
    .filter((s) => s.enabled)
    .sort((a, b) => a.order - b.order)
    .filter((s) => !hidden(persona.sectionCategories?.[s.id] ?? []));
  const byName = new Map(enabled.map((s) => [normalize(s.name), s]));
  const fallback = enabled.find((s) =>
    (persona.sectionCategories?.[s.id] ?? []).includes(options.fallbackCategory)
  );

  const merged = new Map<string, DraftOutput["sections"][number]["items"]>();
  for (const section of draft.sections) {
    const known = byName.get(normalize(section.title));
    let target = known?.name;
    if (!target) {
      const category = options.categories.find(
        (c) => normalize(c.title) === normalize(section.title) || c.id === normalize(section.title)
      );
      if (category && excluded.has(category.id)) {
        report.droppedSections.push(section.title);
        continue;
      }
      if (!fallback) {
        report.droppedSections.push(section.title);
        continue;
      }
      target = fallback.name;
      report.mergedSections.push(section.title);
    }
    const items = section.items.map((item) => {
      const out: { title: string; description?: string; ref?: string } = {
        title: text(item.title),
      };
      if (item.description) out.description = text(item.description);
      if (item.ref !== undefined) {
        const n = refNumber(item.ref);
        if (n === null || !options.knownRefs.has(n)) report.hallucinatedRefs++;
        else if (showsIdentifiers(persona)) out.ref = `#${n}`;
      }
      return out;
    });
    merged.set(target, [...(merged.get(target) ?? []), ...items.filter((i) => i.title)]);
  }

  const sections = enabled
    .filter((s) => (merged.get(s.name) ?? []).length > 0)
    .map((s) => ({ title: s.name, items: merged.get(s.name)! }));

  const out: DraftOutput = {
    highlights: draft.highlights.map(text).filter((h) => h.length > 0),
    sections,
  };
  if (draft.upgradeInstructions) {
    out.upgradeInstructions = draft.upgradeInstructions.map(text).filter((u) => u.length > 0);
  }
  const contributors = contributorsFrom(options.pullAuthors);
  if (contributors.length > 0) out.contributors = contributors;
  return { draft: out, report };
}
