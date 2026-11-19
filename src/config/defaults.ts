/**
 * Built-in defaults: sections, section layouts per persona, and the three
 * built-in personas.
 *
 * Lifted from packages/shared/src/types/index.ts (sections) and
 * packages/shared/src/prompts/index.ts (persona settings and guidance) at
 * 7d1d56f8. The persona guidance used to sit in one template that sent all
 * three personas' rules to every call; each persona now carries its own, and
 * the prompt builder sends only the selected one.
 */
import type {
  PersonaSectionDefaults,
  ResolvedPersona,
  SectionConfig,
  ToneSliders,
} from "../core/types";

/**
 * Standard section palette — the default sections available for all personas.
 * Maps to classification categories plus persona-specific sections.
 */
export const STANDARD_SECTIONS: SectionConfig[] = [
  {
    id: "breaking-changes",
    name: "Breaking Changes",
    description: "Changes that require user action or may break existing behavior",
    enabled: true,
    order: 0,
    isCustom: false,
  },
  {
    id: "features",
    name: "Features",
    description: "New capabilities and functionality",
    enabled: true,
    order: 1,
    isCustom: false,
  },
  {
    id: "improvements",
    name: "Improvements",
    description: "Enhancements to existing features",
    enabled: true,
    order: 2,
    isCustom: false,
  },
  {
    id: "bug-fixes",
    name: "Bug Fixes",
    description: "Resolved issues and corrected behavior",
    enabled: true,
    order: 3,
    isCustom: false,
  },
  {
    id: "performance",
    name: "Performance",
    description: "Speed, efficiency, and resource usage improvements",
    enabled: true,
    order: 4,
    isCustom: false,
  },
  {
    id: "security",
    name: "Security",
    description: "Security patches, vulnerability fixes, and hardening",
    enabled: true,
    order: 5,
    isCustom: false,
  },
  {
    id: "deprecations",
    name: "Deprecations",
    description: "Features scheduled for removal in future versions",
    enabled: true,
    order: 6,
    isCustom: false,
  },
  {
    id: "removed",
    name: "Removed",
    description: "Features that have been deleted or are no longer available",
    enabled: false,
    order: 7,
    isCustom: false,
  },
  {
    id: "docs",
    name: "Documentation",
    description: "Documentation additions and updates",
    enabled: false,
    order: 8,
    isCustom: false,
  },
  {
    id: "internal",
    name: "Internal",
    description: "Internal changes, refactoring, and tooling updates",
    enabled: false,
    order: 9,
    isCustom: false,
  },
];

function makeSections(
  overrides: Partial<Record<string, boolean>>,
  orderIds?: string[]
): SectionConfig[] {
  const base = structuredClone(STANDARD_SECTIONS);
  for (const s of base) {
    if (overrides[s.id] !== undefined) {
      s.enabled = overrides[s.id]!;
    }
  }
  if (orderIds) {
    const ordered: SectionConfig[] = [];
    for (const [i, id] of orderIds.entries()) {
      const s = base.find((b) => b.id === id);
      if (s) ordered.push({ ...s, order: i });
    }
    for (const s of base) {
      if (!orderIds.includes(s.id)) {
        ordered.push({ ...s, order: ordered.length });
      }
    }
    return ordered;
  }
  return base.map((s, i) => ({ ...s, order: i }));
}

/**
 * Persona-specific default section configurations.
 * Each default persona gets a tailored set of sections, visibility flags,
 * and ordering that matches its audience's needs.
 */
export const PERSONA_SECTION_DEFAULTS: Record<string, PersonaSectionDefaults> = {
  engineer: {
    sectionConfig: makeSections(
      {
        "breaking-changes": true,
        features: true,
        improvements: true,
        "bug-fixes": true,
        performance: true,
        security: true,
        deprecations: true,
        removed: true,
        docs: true,
        internal: true,
      },
      [
        "breaking-changes",
        "features",
        "improvements",
        "bug-fixes",
        "performance",
        "security",
        "deprecations",
        "removed",
        "docs",
        "internal",
      ]
    ),
    showHighlights: true,
    showUpgradeInstructions: true,
    showContributors: true,
  },
  internal: {
    sectionConfig: makeSections(
      {
        "breaking-changes": true,
        features: true,
        improvements: true,
        "bug-fixes": true,
        performance: false,
        security: true,
        deprecations: true,
        removed: false,
        docs: false,
        internal: false,
      },
      [
        "breaking-changes",
        "features",
        "improvements",
        "bug-fixes",
        "security",
        "deprecations",
        "performance",
        "removed",
        "docs",
        "internal",
      ]
    ),
    showHighlights: true,
    showUpgradeInstructions: false,
    showContributors: false,
  },
  customer: {
    sectionConfig: makeSections(
      {
        "breaking-changes": true,
        features: true,
        improvements: true,
        "bug-fixes": true,
        performance: false,
        security: false,
        deprecations: false,
        removed: false,
        docs: false,
        internal: false,
      },
      [
        "breaking-changes",
        "features",
        "improvements",
        "bug-fixes",
        "performance",
        "security",
        "deprecations",
        "removed",
        "docs",
        "internal",
      ]
    ),
    showHighlights: true,
    showUpgradeInstructions: false,
    showContributors: false,
  },
};

/** Ids of the built-in personas. */
export const BUILTIN_PERSONA_IDS = ["engineer", "internal", "customer"] as const;

export type BuiltinPersonaId = (typeof BUILTIN_PERSONA_IDS)[number];

/**
 * The built-in personas. `settings` is what the hosted prompt sent as
 * "Persona Rules"; `guidance` is that persona's block from the hosted
 * template's "Persona Configurations" list.
 */
export const BUILTIN_PERSONAS: Record<BuiltinPersonaId, ResolvedPersona> = {
  engineer: {
    id: "engineer",
    name: "Engineer",
    visibility: "public",
    settings: {
      tone: "matter-of-fact, technical",
      include: [
        "Breaking Changes (always first if present)",
        "Features",
        "Enhancements",
        "Bug Fixes",
        "Performance",
        "Deprecations",
        "Security",
        "Internal",
        "Upgrade Instructions",
      ],
      detail_level: "high",
      include_pr_numbers: true,
      include_issue_numbers: true,
      include_file_paths: false,
      include_commit_references: true,
      code_examples_in_migration_guides: true,
    },
    guidance: [
      "tone: matter-of-fact, technical",
      "include: [Breaking Changes (ALWAYS FIRST if present), Features, Enhancements, Bug Fixes, Performance, Deprecations, Security, Internal, Upgrade Instructions]",
      "detail_level: high",
      "include_pr_numbers: true",
      "include_issue_numbers: true",
      "style:",
      "  - Use technical terminology when appropriate",
      '  - Write COMPLETE SENTENCES, not abbreviated "type(scope): description" format',
      '  - Example: ✅ "Added comprehensive logging to the authentication service to improve debugging capabilities"',
      '  - Example: ❌ "feat(auth): add logging"',
      "  - Include implementation context from PR bodies",
      "  - List all changes comprehensively",
      "  - Group by category with descriptive headers",
      "  - Reference PR/issue numbers in parentheses at the end of descriptions",
      "  - Include performance metrics when mentioned in PRs",
      "  - Document API changes with full context (old behavior → new behavior)",
      "  - DO NOT quote arbitrary file paths from implementation code",
      "  - Upgrade Instructions MUST include code examples when API signatures, env vars, or config formats change",
    ].join("\n"),
    sections: PERSONA_SECTION_DEFAULTS.engineer,
  },
  internal: {
    id: "internal",
    name: "Internal (CSM)",
    visibility: "internal",
    settings: {
      tone: "professional, customer-focused",
      include: [
        "Breaking Changes (always first — with CSM talking points)",
        "Highlights",
        "Features",
        "Enhancements",
        "Bug Fixes",
        "Customer Impact",
        "Talking Points",
        "Competitive Advantages",
      ],
      detail_level: "medium",
      rewrite_focus: "customer impact, ROI, and actionable talking points for CSMs",
      breaking_changes_focus:
        "explain what customers need to do, by when, and provide conversation talking points",
      include_elevator_pitch: true,
      include_objection_handling: true,
    },
    guidance: [
      "tone: professional, customer-focused",
      "include: [Breaking Changes (ALWAYS FIRST — include CSM talking points for each), Highlights, Features, Enhancements, Bug Fixes, Customer Impact]",
      "detail_level: medium",
      "rewrite_rules:",
      "  - Write COMPLETE, DESCRIPTIVE SENTENCES about business impact",
      '  - Example: ✅ "Enhanced dashboard performance, reducing load times by 40% for better user experience"',
      '  - Example: ❌ "perf(dashboard): improve load time"',
      "  - For breaking changes: explain what customers will need to do, by when, and provide talking points for the conversation",
      "  - Focus on customer impact and business value",
      '  - Explain "why this matters" for customer success teams',
      "  - Provide talking points for CSMs",
      "  - Highlight competitive advantages",
      "  - Start each item with customer benefit",
      "  - Lead with most impactful changes first",
      "  - Group by customer segment if applicable (Enterprise vs SMB)",
      "style:",
      "  - Business language with complete explanations",
      "  - Emphasize benefits and ROI",
      "  - Include use cases when mentioned in PRs",
      "  - Avoid technical jargon",
      "  - Use metrics and data points when available",
      '  - Separate "What customers will notice" from "Behind the scenes"',
    ].join("\n"),
    sections: PERSONA_SECTION_DEFAULTS.internal,
  },
  customer: {
    id: "customer",
    name: "Customer",
    visibility: "public",
    settings: {
      tone: "friendly, approachable",
      include: [
        "Breaking Changes (always first — plain language, action required or not)",
        "What's New",
        "Improvements",
        "Bug Fixes",
      ],
      detail_level: "low",
      exclude: ["Internal", "Technical implementation details", "PR/issue numbers", "File paths"],
      rewrite_focus: "plain language, user benefits, and outcome-driven descriptions",
      breaking_changes_rule:
        "Lead with what the user needs to do (or reassure them no action is needed). Never use technical terms.",
      benefits_first: true,
    },
    guidance: [
      "tone: friendly, approachable",
      "include: [Breaking Changes (ALWAYS FIRST if present — plain language, what action is required), What's New, Improvements, Bug Fixes]",
      "detail_level: low",
      "exclude: [Internal, Technical implementation details, PR numbers, File paths]",
      "breaking_changes_rule: CRITICAL — if any breaking changes exist, they MUST appear first with clear plain-language description of what changed and exactly what the user needs to do (or that no action is required). Never omit breaking changes from customer-facing notes.",
      "rewrite_rules:",
      "  - Write CLEAR, BENEFIT-FOCUSED SENTENCES in plain language",
      '  - Example: ✅ "You can now sign in securely with your GitHub account, making it easier to get started"',
      '  - Example: ❌ "feat(auth): GitHub OAuth support (#123)"',
      "  - For breaking changes: lead with what the user needs to do, not what the developer changed",
      '  - Example (breaking): ✅ "Action required: After upgrading, you\'ll need to reconnect your Slack integration in Settings."',
      '  - Example (no action): ✅ "We updated how you sign in. Nothing changes for you — just log in as normal."',
      '  - Use "you" and "your" liberally',
      "  - Explain in terms of user experience",
      "  - Start each item with the benefit, not the feature",
      '  - Explain "why this matters" not just "what changed"',
      "  - Connect features to user goals and outcomes",
      "  - Keep each item to 2-3 sentences maximum",
      "  - Explain when users will see the change (immediate, next login, etc.)",
      "style:",
      "  - Conversational and warm with complete sentences",
      "  - Benefit-driven, user-centric",
      "  - Short sentences (10-15 words ideal)",
      "  - No jargon or technical terms",
      '  - Use active voice ("You can now..." not "Users can now...")',
    ].join("\n"),
    sections: PERSONA_SECTION_DEFAULTS.customer,
  },
};

/** A category as configuration sees it: a slug id and the title the classifier emits. */
export interface CategoryDefinition {
  id: string;
  title: string;
  /** Exact label names, or `/regex/` entries. */
  labels: string[];
  /** Conventional-commit types that map to this category. */
  conventionalTypes: string[];
  /** Hidden from personas that exclude internal changes. */
  internal: boolean;
}

/**
 * The built-in categories by id. Titles are the classifier's category names
 * (`BUILTIN_CATEGORIES` in core/types), so the hosted label map keeps working.
 */
export const BUILTIN_CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    id: "breaking",
    title: "Breaking Changes",
    labels: [],
    conventionalTypes: [],
    internal: false,
  },
  { id: "security", title: "Security", labels: [], conventionalTypes: [], internal: false },
  { id: "features", title: "Features", labels: [], conventionalTypes: ["feat"], internal: false },
  { id: "improvements", title: "Improvements", labels: [], conventionalTypes: [], internal: false },
  { id: "fixes", title: "Fixes", labels: [], conventionalTypes: ["fix"], internal: false },
  {
    id: "performance",
    title: "Performance",
    labels: [],
    conventionalTypes: ["perf"],
    internal: false,
  },
  { id: "deprecations", title: "Deprecations", labels: [], conventionalTypes: [], internal: false },
  { id: "docs", title: "Docs", labels: [], conventionalTypes: ["docs"], internal: false },
  {
    id: "internal",
    title: "Internal",
    labels: [],
    conventionalTypes: ["build", "chore", "ci", "refactor", "style", "test"],
    internal: true,
  },
];

/**
 * Categories each standard section collects when a configured section names
 * none. `removed` has no category of its own; the model places items there.
 */
export const STANDARD_SECTION_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  "breaking-changes": ["breaking"],
  features: ["features"],
  improvements: ["improvements"],
  "bug-fixes": ["fixes"],
  performance: ["performance"],
  security: ["security"],
  deprecations: ["deprecations"],
  removed: [],
  docs: ["docs"],
  internal: ["internal"],
};

/** Tone sliders for a persona that sets none (the hosted schema's column defaults). */
export const DEFAULT_TONE: ToneSliders = {
  formality: 50,
  technicalDepth: 50,
  enthusiasm: 30,
  detail: 50,
};

/** Default model per provider. */
export const DEFAULT_MODELS = {
  openai: "gpt-5-mini",
  bedrock: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
} as const;
