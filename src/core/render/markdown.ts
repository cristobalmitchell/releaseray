/**
 * Markdown rendering of generated notes.
 *
 * Lifted from packages/shared/src/utils/render-markdown.ts at 7d1d56f8. The
 * compare link uses `serverUrl` instead of a fixed github.com, the canonical
 * options for persisted blocks are fixed in one place, and `shiftHeadings`
 * moves a block's headings down for CHANGELOG entries.
 */
import type { DraftOutput } from "../types";

/**
 * Configuration for rendering a DraftOutput to markdown
 *
 * Consolidates all rendering variants into a single configurable function.
 * Previously duplicated across generate-draft/route.ts, generate-all/route.ts,
 * single-draft.ts, draft.ts, regenerate-drafts.ts, and regenerate-all-releases.ts.
 *
 * @see #496 - Custom section structure configuration
 */
export interface RenderMarkdownOptions {
  /** Version tag or title for the release (e.g., "v1.2.0") */
  title?: string;
  /** Repository full name (e.g., "owner/repo") — included in header when set */
  repoFullName?: string;
  /** Start of the range (e.g., "v1.1.0") */
  fromTag?: string;
  /** End of the range (e.g., "v1.2.0") */
  toTag?: string;
  /** Server URL for the compare link. Default: "https://github.com" */
  serverUrl?: string;

  /** Include the title + metadata header block. Default: true */
  includeHeader?: boolean;
  /** Heading level for the title. Default: 1 */
  titleHeadingLevel?: 1 | 2 | 3;
  /** Heading level for sections. Default: 2 */
  sectionHeadingLevel?: 2 | 3 | 4;

  /** Add emoji prefixes to section headings. Default: true */
  includeEmojis?: boolean;
  /** Show the Highlights section. Default: true */
  showHighlights?: boolean;
  /** Show the Upgrade Instructions section. Default: true */
  showUpgradeInstructions?: boolean;
  /** Show the Contributors section. Default: true */
  showContributors?: boolean;

  /** Append a "Full Changelog" compare link. Default: false */
  includeCompareLink?: boolean;
  /** Append a horizontal rule footer. Default: false */
  includeFooter?: boolean;

  /**
   * Ordered list of section titles to render. When provided:
   * - Only sections whose title matches an entry are rendered
   * - Sections render in the order specified here
   * - Unmatched LLM sections are appended at the end
   *
   * When undefined, all sections render in the LLM's original order.
   */
  sectionOrder?: string[];
}

const SECTION_EMOJI_MAP: Record<string, string> = {
  feature: "🚀",
  "what's new": "🚀",
  enhancement: "✨",
  improvement: "✨",
  bug: "🐛",
  fix: "🐛",
  breaking: "⚠️",
  performance: "⚡",
  security: "🔒",
  deprecat: "📦",
  document: "📚",
  doc: "📚",
  internal: "🔧",
  refactor: "🔧",
  "customer impact": "💡",
  "talking point": "💬",
  competitive: "🏆",
};

/**
 * Resolve an emoji prefix for a section title based on keyword matching
 */
function getSectionEmoji(title: string): string {
  const lower = title.toLowerCase();
  for (const [keyword, emoji] of Object.entries(SECTION_EMOJI_MAP)) {
    if (lower.includes(keyword)) return emoji;
  }
  return "📋";
}

/**
 * Order sections according to a priority list.
 * Matched sections come first (in sectionOrder sequence), unmatched follow.
 */
function orderSections(
  sections: DraftOutput["sections"],
  sectionOrder: string[]
): DraftOutput["sections"] {
  const normalizedOrder = sectionOrder.map((s) => s.toLowerCase());
  const ordered: DraftOutput["sections"] = [];
  const remaining = [...sections];

  for (const name of normalizedOrder) {
    const idx = remaining.findIndex((s) => s.title.toLowerCase() === name);
    if (idx !== -1) {
      const [section] = remaining.splice(idx, 1);
      if (section) ordered.push(section);
    }
  }

  return [...ordered, ...remaining];
}

/**
 * Render a structured DraftOutput to markdown string.
 *
 * Single source of truth for all draft-to-markdown rendering across the codebase.
 * Replaces 5+ duplicated implementations with inconsistent emoji/heading/section choices.
 *
 * @param draft - Structured draft output from LLM generation
 * @param options - Rendering configuration
 * @returns Formatted markdown string
 *
 * @example
 * ```ts
 * // API route / worker usage (standard)
 * const md = renderToMarkdown(draft, {
 *   toTag: "v1.2.0",
 *   fromTag: "v1.1.0",
 *   repoFullName: "acme/widget",
 * });
 *
 * // Changelog mode (h3 sections, no header, compare link)
 * const md = renderToMarkdown(draft, {
 *   includeHeader: false,
 *   sectionHeadingLevel: 3,
 *   includeCompareLink: true,
 *   fromTag: "v1.1.0",
 *   toTag: "v1.2.0",
 *   repoFullName: "acme/widget",
 * });
 * ```
 *
 * @see #496 - Custom section structure configuration for personas
 */
export function renderToMarkdown(draft: DraftOutput, options: RenderMarkdownOptions = {}): string {
  const {
    title,
    repoFullName,
    fromTag,
    toTag,
    serverUrl = "https://github.com",
    includeHeader = true,
    titleHeadingLevel = 1,
    sectionHeadingLevel = 2,
    includeEmojis = true,
    showHighlights = true,
    showUpgradeInstructions = true,
    showContributors = true,
    includeCompareLink = false,
    includeFooter = false,
    sectionOrder,
  } = options;

  const h = (level: number) => "#".repeat(level);
  const parts: string[] = [];

  // --- Header ---
  if (includeHeader) {
    const heading = title || toTag || "Release";
    parts.push(`${h(titleHeadingLevel)} ${heading}\n`);

    if (repoFullName) {
      parts.push(`**Repository:** ${repoFullName}`);
    }
    if (fromTag && toTag) {
      parts.push(`**Range:** ${fromTag} → ${toTag}`);
    }
    parts.push("");
  }

  // --- Highlights ---
  if (showHighlights && draft.highlights && draft.highlights.length > 0) {
    const emoji = includeEmojis ? "🌟 " : "";
    parts.push(`${h(sectionHeadingLevel)} ${emoji}Highlights\n`);
    for (const highlight of draft.highlights) {
      parts.push(`- ${highlight}`);
    }
    parts.push("");
  }

  // --- Sections ---
  const sections = sectionOrder ? orderSections(draft.sections, sectionOrder) : draft.sections;

  for (const section of sections) {
    const emoji = includeEmojis ? `${getSectionEmoji(section.title)} ` : "";
    parts.push(`${h(sectionHeadingLevel)} ${emoji}${section.title}\n`);
    for (const item of section.items) {
      let line = `- **${item.title}**`;
      if (item.ref) {
        line += ` (${item.ref})`;
      }
      if (item.description) {
        line += ` — ${item.description}`;
      }
      parts.push(line);
    }
    parts.push("");
  }

  // --- Upgrade Instructions ---
  if (
    showUpgradeInstructions &&
    draft.upgradeInstructions &&
    draft.upgradeInstructions.length > 0
  ) {
    const emoji = includeEmojis ? "🔧 " : "";
    parts.push(`${h(sectionHeadingLevel)} ${emoji}Upgrade Instructions\n`);
    for (let i = 0; i < draft.upgradeInstructions.length; i++) {
      parts.push(`${i + 1}. ${draft.upgradeInstructions[i]}`);
    }
    parts.push("");
  }

  // --- Contributors ---
  if (showContributors && draft.contributors && draft.contributors.length > 0) {
    const emoji = includeEmojis ? "👏 " : "";
    parts.push(`${h(sectionHeadingLevel)} ${emoji}Contributors\n`);
    const mentions = draft.contributors.map((c) => `@${c.replace(/^@/, "")}`).join(", ");
    parts.push(`Thank you to ${mentions} for contributing to this release!`);
    parts.push("");
  }

  // --- Footer ---
  if (includeFooter) {
    parts.push("---\n");
  }

  if (includeCompareLink && repoFullName && fromTag && toTag) {
    parts.push(
      `**Full Changelog**: [${fromTag}...${toTag}](${serverUrl.replace(/\/+$/, "")}/${repoFullName}/compare/${fromTag}...${toTag})`
    );
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Preset render options for common use cases
 */
export const RENDER_PRESETS = {
  /** Standard API route / worker rendering */
  standard: {
    includeHeader: true,
    titleHeadingLevel: 1 as const,
    sectionHeadingLevel: 2 as const,
    includeEmojis: true,
    includeCompareLink: false,
    includeFooter: false,
  },

  /** Worker rendering with compare link and footer */
  worker: {
    includeHeader: false,
    sectionHeadingLevel: 2 as const,
    includeEmojis: true,
    includeCompareLink: true,
    includeFooter: true,
  },

  /** Changelog rendering with h3 sections */
  changelog: {
    includeHeader: false,
    sectionHeadingLevel: 3 as const,
    includeEmojis: true,
    includeCompareLink: true,
    includeFooter: false,
  },

  /** Minimal rendering without emojis or metadata */
  minimal: {
    includeHeader: false,
    sectionHeadingLevel: 2 as const,
    includeEmojis: false,
    includeCompareLink: false,
    includeFooter: false,
  },
} satisfies Record<string, Partial<RenderMarkdownOptions>>;

/**
 * Options used for every persisted block (GitHub Release and, after
 * `shiftHeadings`, CHANGELOG). Fixed so the same input always renders the
 * same text, which the generation digest relies on.
 */
export const CANONICAL_RENDER_OPTIONS = {
  includeHeader: false,
  sectionHeadingLevel: 2 as const,
  includeEmojis: true,
  includeCompareLink: true,
  includeFooter: false,
} satisfies Partial<RenderMarkdownOptions>;

/**
 * Move every ATX heading by `levels` (positive = deeper), clamped to 1..6.
 * Lines inside fenced code blocks are left alone.
 *
 * @param markdown - Markdown text
 * @param levels - Number of levels to add (negative to remove)
 * @returns The shifted text
 */
export function shiftHeadings(markdown: string, levels: number): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (fence === null) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const heading = /^( {0,3})(#{1,6})(?=\s|$)/.exec(line);
      if (!heading) return line;
      const depth = Math.min(6, Math.max(1, heading[2].length + levels));
      return `${heading[1]}${"#".repeat(depth)}${line.slice(heading[0].length)}`;
    })
    .join("\n");
}
