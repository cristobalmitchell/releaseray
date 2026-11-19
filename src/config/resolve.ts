/**
 * Turns a parsed config into what the pipeline runs with: personas merged
 * over the built-ins, categories, label rules and the model name.
 */
import type { LabelRule } from "../core/classify/rules";
import type { ResolvedPersona, SectionConfig, ToneSliders } from "../core/types";
import { buildLabelRules, resolveCategories } from "./categories";
import {
  BUILTIN_PERSONA_IDS,
  BUILTIN_PERSONAS,
  DEFAULT_MODELS,
  DEFAULT_TONE,
  PERSONA_SECTION_DEFAULTS,
  STANDARD_SECTION_CATEGORIES,
  type BuiltinPersonaId,
  type CategoryDefinition,
} from "./defaults";
import { personaViews, type Config, type PersonaConfig } from "./schema";

/** A config ready to run. */
export interface ResolvedConfig {
  config: Config;
  /** Enabled personas, built-ins first, then configured ones in file order. */
  personas: ResolvedPersona[];
  categories: CategoryDefinition[];
  labelRules: LabelRule[];
  /** Title of `classification.fallbackCategory`. */
  fallbackCategory: string;
  /** `llm.model`, or the provider's default. */
  model: string;
}

function isBuiltin(slug: string): slug is BuiltinPersonaId {
  return (BUILTIN_PERSONA_IDS as readonly string[]).includes(slug);
}

function mergeTone(...layers: Array<Partial<ToneSliders> | undefined>): ToneSliders {
  const tone = { ...DEFAULT_TONE };
  for (const layer of layers) {
    if (!layer) continue;
    // `??` keeps a slider value of 0 (CONVERSION-PLAN PD-25).
    tone.formality = layer.formality ?? tone.formality;
    tone.technicalDepth = layer.technicalDepth ?? tone.technicalDepth;
    tone.enthusiasm = layer.enthusiasm ?? tone.enthusiasm;
    tone.detail = layer.detail ?? tone.detail;
  }
  return tone;
}

function sectionCategoriesFor(
  sections: ReadonlyArray<{ id: string; categories?: string[] }>,
  categoryIds: readonly string[]
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const s of sections) {
    if (s.categories && s.categories.length > 0) map[s.id] = [...s.categories];
    else if (s.id in STANDARD_SECTION_CATEGORIES)
      map[s.id] = [...STANDARD_SECTION_CATEGORIES[s.id]];
    else map[s.id] = categoryIds.includes(s.id) ? [s.id] : [];
  }
  return map;
}

function resolvePersona(
  slug: string,
  configured: PersonaConfig | undefined,
  visibility: "public" | "internal",
  categoryIds: readonly string[],
  instructionsFiles: Readonly<Record<string, string>>
): ResolvedPersona {
  const baseId: BuiltinPersonaId | undefined = isBuiltin(slug) ? slug : configured?.extends;
  const base = baseId ? BUILTIN_PERSONAS[baseId] : undefined;
  const baseSections = base?.sections ?? PERSONA_SECTION_DEFAULTS.engineer;
  const include = configured?.include ?? {};

  const settings: Record<string, unknown> = { ...(base?.settings ?? {}) };
  if (configured?.description) settings.description = configured.description;
  if (include.identifiers !== undefined) {
    settings.include_pr_numbers = include.identifiers;
    settings.include_issue_numbers = include.identifiers;
  }
  if (include.breakingChanges !== undefined) {
    settings.include_breaking_changes = include.breakingChanges;
  }
  if (include.migrationGuides !== undefined) {
    settings.include_migration_guides = include.migrationGuides;
  }

  const sectionConfig: SectionConfig[] = configured?.sections
    ? configured.sections.map((s, order) => ({
        id: s.id,
        name: s.name,
        ...(s.description !== undefined ? { description: s.description } : {}),
        enabled: s.enabled,
        order,
        isCustom: !(s.id in STANDARD_SECTION_CATEGORIES),
      }))
    : baseSections.sectionConfig.map((s) => ({ ...s }));

  const instructions =
    configured?.instructions ??
    (configured?.instructionsFile ? instructionsFiles[configured.instructionsFile] : undefined);

  return {
    id: slug,
    name: configured?.name ?? base?.name ?? slug,
    visibility,
    settings,
    guidance: base?.guidance ?? "",
    tone: mergeTone(base?.tone, configured?.tone),
    sections: {
      sectionConfig,
      showHighlights: include.highlights ?? baseSections.showHighlights,
      showUpgradeInstructions: include.upgradeInstructions ?? baseSections.showUpgradeInstructions,
      showContributors: include.contributors ?? baseSections.showContributors,
    },
    ...(instructions !== undefined ? { instructions } : {}),
    sectionCategories: sectionCategoriesFor(configured?.sections ?? sectionConfig, categoryIds),
    ...(configured?.excludeCategories
      ? { excludeCategories: [...configured.excludeCategories] }
      : {}),
  };
}

/**
 * Resolves a parsed config.
 *
 * @param config - A config that passed {@link ConfigSchema}
 * @param instructionsFiles - Contents of each `instructionsFile`, by its configured path
 * @returns The config ready to run
 */
export function resolveConfig(
  config: Config,
  instructionsFiles: Readonly<Record<string, string>> = {}
): ResolvedConfig {
  const categories = resolveCategories(config.classification.categories);
  const categoryIds = categories.map((c) => c.id);
  const configured = new Map((config.personas ?? []).map((p) => [p.slug, p]));
  const personas = personaViews(config)
    .filter((v) => v.enabled)
    .map((v) =>
      resolvePersona(v.slug, configured.get(v.slug), v.visibility, categoryIds, instructionsFiles)
    );
  const fallback = categories.find((c) => c.id === config.classification.fallbackCategory);
  const provider = config.llm.provider === "bedrock" ? "bedrock" : "openai";
  return {
    config,
    personas,
    categories,
    labelRules: buildLabelRules(categories),
    fallbackCategory: fallback?.title ?? "Improvements",
    model: config.llm.model ?? DEFAULT_MODELS[provider],
  };
}
