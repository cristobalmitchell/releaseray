/**
 * Core types and schemas.
 *
 * Lifted from packages/shared/src/types/index.ts at 7d1d56f8. Database,
 * webhook, analytics and consent types stayed behind. The category set is
 * data: built-in categories are merged with the user's configuration, and the
 * grouped-changes schema is built from the resolved list (CONVERSION-PLAN PD-14).
 */
import { z } from "zod";

// Normalized item for LLM processing
export const NormalizedItemSchema = z.object({
  type: z.enum(["pr", "issue", "commit"]),
  id: z.number(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  links: z.object({
    issues: z.array(z.number()),
    prs: z.array(z.number()),
  }),
});

export type NormalizedItem = z.infer<typeof NormalizedItemSchema>;

// Classified item
export const ClassifiedItemSchema = z.object({
  title: z.string().max(140),
  description: z.string().max(200),
  ref: z.object({
    pr: z.number().optional(),
    issue: z.number().optional(),
  }),
  labels: z.array(z.string()),
  flags: z.object({
    breaking: z.boolean().optional(),
    security: z.boolean().optional(),
    deprecation: z.boolean().optional(),
  }),

  // Enhanced classification metadata (privacy-friendly)
  confidence: z.number().min(0).max(1).optional(), // 0.0-1.0 confidence score
  signals: z.array(z.string()).optional(), // Classification signals (e.g., ["pattern:breaking", "checkbox:migration"])
});

export type ClassifiedItem = z.infer<typeof ClassifiedItemSchema>;

/**
 * Categories the rules classifier emits. `Internal` is a real category: the
 * hosted schema omitted it, so internal changes could not validate.
 */
export const BUILTIN_CATEGORIES = [
  "Features",
  "Improvements",
  "Fixes",
  "Performance",
  "Security",
  "Docs",
  "Breaking Changes",
  "Deprecations",
  "Internal",
] as const;

export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];

/**
 * Builds the grouped-changes schema for a resolved category list.
 *
 * @param categories - Category titles from the resolved configuration
 * @returns A Zod schema that accepts only those categories
 * @throws Error when the list is empty
 */
export function createGroupedChangesSchema(categories: readonly string[]) {
  if (categories.length === 0) throw new Error("At least one category is required");
  const [first, ...rest] = categories;
  return z.object({
    grouped: z.array(
      z.object({
        category: z.enum([first, ...rest] as [string, ...string[]]),
        items: z.array(ClassifiedItemSchema),
      })
    ),
  });
}

// Grouped changes by category, with the built-in categories
export const GroupedChangesSchema = createGroupedChangesSchema(BUILTIN_CATEGORIES);

export interface GroupedChanges {
  grouped: Array<{ category: string; items: ClassifiedItem[] }>;
}

// Draft generation output
export const DraftOutputSchema = z.object({
  highlights: z.array(z.string()),
  sections: z.array(
    z.object({
      title: z.string(),
      items: z.array(
        z.object({
          title: z.string(),
          description: z.string().optional(),
          ref: z.string().optional(),
        })
      ),
    })
  ),
  upgradeInstructions: z.array(z.string()).optional(),
  contributors: z.array(z.string()).optional(),
});

export type DraftOutput = z.infer<typeof DraftOutputSchema>;

/**
 * Section configuration for persona-level section customization
 */
export const SectionConfigSchema = z.object({
  id: z.string(), // Stable identifier: "breaking-changes", "features", "custom-1"
  name: z.string().min(1).max(100), // Display name / section title in output
  description: z.string().max(500).optional(), // LLM guidance on what content belongs here
  enabled: z.boolean(), // Toggle visibility
  order: z.number().int().min(0), // Sort position
  isCustom: z.boolean(), // false = standard section, true = user-defined
});

export type SectionConfig = z.infer<typeof SectionConfigSchema>;

export const SectionConfigArraySchema = z.array(SectionConfigSchema).max(15);

export interface PersonaSectionDefaults {
  sectionConfig: SectionConfig[];
  showHighlights: boolean;
  showUpgradeInstructions: boolean;
  showContributors: boolean;
}

/** Who may see a persona's output (CONVERSION-PLAN PD-12). */
export type PersonaVisibility = "public" | "internal";

/** Tone sliders, each 0 to 100. A value of 0 is valid and kept. */
export interface ToneSliders {
  formality: number;
  technicalDepth: number;
  enthusiasm: number;
  detail: number;
}

/**
 * A persona after defaults and configuration are merged. The prompt builder
 * receives exactly one of these and sends only its rules.
 */
export interface ResolvedPersona {
  id: string;
  name: string;
  visibility: PersonaVisibility;
  /** Structured settings sent to the model as JSON. */
  settings: Record<string, unknown>;
  /** Free-text style and rewrite guidance, sent after the settings. */
  guidance: string;
  tone?: ToneSliders;
  sections?: PersonaSectionDefaults;
  /** Extra instructions from the user's configuration. */
  instructions?: string;
  /** Category ids each section collects, by section id. */
  sectionCategories?: Record<string, string[]>;
  /** Category ids this persona never shows. */
  excludeCategories?: string[];
}
