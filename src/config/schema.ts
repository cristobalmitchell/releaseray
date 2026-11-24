/**
 * The `.releaseray/config.yml` schema (CONVERSION-PLAN §4.2), with the
 * cross-field rules that need only the parsed file (§4.6). Rules that need the
 * workspace, such as whether an `instructionsFile` exists, run in `load.ts`.
 *
 * Objects with defaults use `prefault({})`: in Zod 4 a `default({})` returns
 * the empty object as is, without applying the defaults inside it.
 */
import { z } from "zod";
import { compilePattern, isSlashedPattern } from "../core/util/regex";
import { resolveCategories } from "./categories";
import {
  BUILTIN_CATEGORY_DEFINITIONS,
  BUILTIN_PERSONA_IDS,
  STANDARD_SECTION_CATEGORIES,
} from "./defaults";

const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be lowercase letters, digits and hyphens");
const Pct = z.number().int().min(0).max(100);
const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");
/**
 * Variables that hold another credential or the runner's own state. A notify
 * entry sends its variable's value to Slack, Teams or Intercom, so naming one
 * of these would send that value to a third party.
 */
const RESERVED_ENV =
  /^(GITHUB_|GH_|INPUT_|ACTIONS_|RUNNER_|AWS_)|^(OPENAI_API_KEY|ANTHROPIC_API_KEY)$/;
const NotifyEnvName = EnvName.refine(
  (name) => !RESERVED_ENV.test(name),
  "names a variable that holds another credential or runner state; use a dedicated secret"
);
const RegexSource = z.string().min(1);

const CategorySchema = z.strictObject({
  /** A built-in id overrides that category; fields left out keep the built-in values. */
  id: Slug,
  title: z.string().min(1).max(100).optional(),
  /** Exact label names, or `/regex/` entries. */
  labels: z.array(z.string().min(1)).optional(),
  /** Conventional-commit types, such as feat, fix, perf, build or ci. */
  conventionalTypes: z.array(z.string().min(1)).optional(),
  /** Hidden from personas that exclude internal changes. */
  internal: z.boolean().optional(),
});

const SectionSchema = z.strictObject({
  id: Slug,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  /** Empty: the standard section's categories, or the category whose id equals the section id. */
  categories: z.array(Slug).default([]),
  enabled: z.boolean().default(true),
});

const ToneSchema = z
  .strictObject({ formality: Pct, technicalDepth: Pct, enthusiasm: Pct, detail: Pct })
  .partial();

const IncludeSchema = z
  .strictObject({
    identifiers: z.boolean(),
    breakingChanges: z.boolean(),
    migrationGuides: z.boolean(),
    highlights: z.boolean(),
    upgradeInstructions: z.boolean(),
    contributors: z.boolean(),
  })
  .partial();

const PersonaSchema = z.strictObject({
  slug: Slug,
  extends: z.enum(BUILTIN_PERSONA_IDS).optional(),
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  /** Default: internal for the internal persona and personas extending it. */
  visibility: z.enum(["public", "internal"]).optional(),
  /** Each slider 0 to 100; 0 is kept. */
  tone: ToneSchema.optional(),
  instructions: z.string().max(2000).optional(),
  /** Repository-relative path under `.releaseray/`. */
  instructionsFile: z.string().min(1).optional(),
  include: IncludeSchema.optional(),
  sections: z.array(SectionSchema).max(15).optional(),
  excludeCategories: z.array(Slug).optional(),
});

const NotifyWhen = z.enum(["primary-changed", "always"]);
const NotifySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("slack"),
    persona: Slug,
    webhookUrlEnv: NotifyEnvName,
    when: NotifyWhen.default("primary-changed"),
  }),
  z.strictObject({
    type: z.literal("teams"),
    persona: Slug,
    webhookUrlEnv: NotifyEnvName,
    when: NotifyWhen.default("primary-changed"),
  }),
  z.strictObject({
    type: z.literal("intercom"),
    persona: Slug,
    apiKeyEnv: NotifyEnvName,
    collectionId: z.string().min(1),
    state: z.enum(["draft", "published"]).default("draft"),
    titleTemplate: z.string().min(1).default("Release {{key}}"),
    when: NotifyWhen.default("primary-changed"),
  }),
]);

const RangeSchema = z.strictObject({
  /** Glob over tag names. */
  tagPattern: z.string().min(1).default("v*"),
  /** Consider prereleases when choosing the previous tag. */
  includePrereleases: z.boolean().default(false),
  /** Allow an explicit `from` that is not an ancestor of `to`. */
  allowNonAncestor: z.boolean().default(false),
  /** Write commit-only notes when no PR is referenced. */
  fallbackToCommits: z.boolean().default(true),
  /** Past this many PRs the run stops and asks for a narrower range. */
  maxPullRequests: z.number().int().min(1).max(5000).default(250),
});

const ClassificationSchema = z.strictObject({
  /** Merged over the built-in categories by id. */
  categories: z.array(CategorySchema).max(30).default([]),
  conventionalCommits: z.boolean().default(true),
  fallbackCategory: Slug.default("improvements"),
  exclude: z
    .strictObject({
      labels: z.array(z.string().min(1)).default(["skip-release-notes"]),
      authors: z.array(z.string().min(1)).default([]),
      /** Matched against commit subjects and PR titles. */
      titlePatterns: z.array(RegexSource).default([]),
    })
    .prefault({}),
});

const EnrichmentSchema = z.strictObject({
  bodies: z.boolean().default(true),
  linkedIssues: z.boolean().default(true),
  maxLinkedIssues: z.number().int().min(0).max(500).default(100),
  /** PR comments, reviews and issue comments. */
  comments: z.boolean().default(false),
  commentAuthorAssociations: z
    .array(z.enum(["OWNER", "MEMBER", "COLLABORATOR"]))
    .default(["OWNER", "MEMBER", "COLLABORATOR"]),
  maxBodyChars: z.number().int().min(0).max(20000).default(4000),
});

const OutputsSchema = z.strictObject({
  summary: z
    .strictObject({
      enabled: z.boolean().default(true),
      personas: z.union([z.literal("all"), z.array(Slug)]).default("all"),
    })
    .prefault({}),
  files: z
    .strictObject({
      enabled: z.boolean().default(true),
      dir: z.string().min(1).default(".releaseray/notes"),
    })
    .prefault({}),
  githubRelease: z
    .strictObject({
      enabled: z.boolean().default(true),
      persona: Slug.default("engineer"),
      mode: z.enum(["section", "replace"]).default("section"),
      onHumanEdit: z.enum(["skip", "overwrite"]).default("skip"),
      createIfMissing: z.boolean().default(false),
      /** Used only when creating a release. */
      nameTemplate: z.string().min(1).default("Release {{tag}}"),
      /** Used only when creating a release. */
      prerelease: z.union([z.literal("auto"), z.boolean()]).default("auto"),
    })
    .prefault({}),
  changelog: z
    .strictObject({
      enabled: z.boolean().default(false),
      path: z.string().min(1).default("CHANGELOG.md"),
      persona: Slug.default("engineer"),
      onHumanEdit: z.enum(["skip", "overwrite"]).default("skip"),
      push: z.boolean().default(false),
      /** Default: the checked-out branch. */
      branch: z.string().min(1).optional(),
      commitMessage: z.string().min(1).default("docs(changelog): {{key}}"),
      author: z
        .strictObject({
          name: z.string().min(1),
          // Not z.email(): a GitHub App's noreply address has brackets,
          // as in 41898282+github-actions[bot]@users.noreply.github.com.
          email: z.string().regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, "Invalid email address"),
        })
        .optional(),
    })
    .prefault({}),
  /** Slack, Teams and Intercom; posted when the primary target changes, or always. */
  notify: z.array(NotifySchema).max(10).default([]),
  /** Allow internal personas on the GitHub Release or CHANGELOG. */
  allowInternalOutputs: z.boolean().default(false),
  /** Allow internal personas in the summary and files of a public repository. */
  allowInternalOnPublicRepo: z.boolean().default(false),
});

const LlmSchema = z.strictObject({
  provider: z.enum(["openai", "bedrock", "anthropic"]).default("openai"),
  /** Default: gpt-5-mini on openai, Claude Haiku 4.5 on bedrock, Claude Opus 5.5 on anthropic. */
  model: z.string().min(1).optional(),
  /** OpenAI-compatible endpoint; openai only. */
  baseUrl: z.url().optional(),
  /** AWS region; bedrock only, and required there. */
  region: z.string().min(1).optional(),
  maxCompletionTokens: z.number().int().min(256).max(65536).default(16384),
  /** Estimated at 4 characters per token, checked before any call. */
  maxInputTokens: z.number().int().min(1000).default(200000),
  concurrency: z.number().int().min(1).max(10).default(3),
  retries: z.number().int().min(0).max(5).default(3),
  pricing: z
    .strictObject({ inputPer1M: z.number().nonnegative(), outputPer1M: z.number().nonnegative() })
    .optional(),
});

const GithubSchema = z.strictObject({
  /** Default: 90% of the token's core limit from GET /rate_limit. */
  maxRequests: z.number().int().min(1).optional(),
  /** Parallel REST reads; writes are always serial. */
  concurrency: z.number().int().min(1).max(10).default(1),
  onBudgetExceeded: z.enum(["fail", "wait", "degrade"]).default("fail"),
  maxWaitMinutes: z.number().int().min(0).max(300).default(0),
});

const SanitizeSchema = z.strictObject({
  allowedDomains: z.array(z.string().min(1)).default(["github.com", "gitlab.com"]),
  redactPaths: z.boolean().default(true),
});

const RenderSchema = z.strictObject({
  emoji: z.boolean().default(true),
  compareLink: z.boolean().default(true),
});

/** Every key of the file, before cross-field rules. */
const BaseConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  range: RangeSchema.prefault({}),
  classification: ClassificationSchema.prefault({}),
  enrichment: EnrichmentSchema.prefault({}),
  /** Merged over the three built-ins by slug. */
  personas: z.array(PersonaSchema).max(20).optional(),
  outputs: OutputsSchema.prefault({}),
  llm: LlmSchema.prefault({}),
  github: GithubSchema.prefault({}),
  sanitize: SanitizeSchema.prefault({}),
  render: RenderSchema.prefault({}),
});

export type ConfigInput = z.input<typeof BaseConfigSchema>;
export type Config = z.output<typeof BaseConfigSchema>;
export type PersonaConfig = z.output<typeof PersonaSchema>;
export type CategoryConfig = z.output<typeof CategorySchema>;
export type SectionConfigEntry = z.output<typeof SectionSchema>;

/** A persona as the rules see it after built-ins and configuration merge. */
interface PersonaView {
  slug: string;
  enabled: boolean;
  visibility: "public" | "internal";
}

/**
 * The personas a config yields, built-ins first, with their visibility.
 *
 * @param config - A parsed config
 * @returns One entry per persona slug, disabled ones included
 */
export function personaViews(config: Config): PersonaView[] {
  const configured = new Map((config.personas ?? []).map((p) => [p.slug, p]));
  const views: PersonaView[] = BUILTIN_PERSONA_IDS.map((slug) => {
    const p = configured.get(slug);
    return {
      slug,
      enabled: p?.enabled ?? true,
      visibility: p?.visibility ?? (slug === "internal" ? "internal" : "public"),
    };
  });
  for (const p of config.personas ?? []) {
    if ((BUILTIN_PERSONA_IDS as readonly string[]).includes(p.slug)) continue;
    views.push({
      slug: p.slug,
      enabled: p.enabled,
      visibility: p.visibility ?? (p.extends === "internal" ? "internal" : "public"),
    });
  }
  return views;
}

/**
 * Category ids a config yields: the built-ins plus configured ones.
 *
 * @param config - A parsed config
 * @returns The ids, built-ins first
 */
export function categoryIds(config: Config): string[] {
  const ids = BUILTIN_CATEGORY_DEFINITIONS.map((c) => c.id);
  for (const c of config.classification.categories) if (!ids.includes(c.id)) ids.push(c.id);
  return ids;
}

type Issue = { path: (string | number)[]; message: string };

function checkPattern(issues: Issue[], path: (string | number)[], pattern: string): void {
  try {
    compilePattern(pattern);
  } catch (error) {
    issues.push({ path, message: `invalid regular expression: ${(error as Error).message}` });
  }
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

/**
 * Cross-field rules that need only the parsed file (CONVERSION-PLAN §4.6).
 *
 * @param config - A config that passed the base schema
 * @returns Problems, each with the path it belongs to
 */
export function crossFieldIssues(config: Config): Issue[] {
  const issues: Issue[] = [];
  const personas = config.personas ?? [];
  const builtinSlugs = BUILTIN_PERSONA_IDS as readonly string[];

  for (const slug of duplicates(personas.map((p) => p.slug))) {
    issues.push({ path: ["personas"], message: `persona slug "${slug}" appears more than once` });
  }
  for (const id of duplicates(config.classification.categories.map((c) => c.id))) {
    issues.push({
      path: ["classification", "categories"],
      message: `category id "${id}" appears more than once`,
    });
  }

  for (const title of duplicates(
    resolveCategories(config.classification.categories).map((c) => c.title.toLowerCase())
  )) {
    issues.push({
      path: ["classification", "categories"],
      message: `two categories share the title "${title}"`,
    });
  }

  const views = new Map(personaViews(config).map((v) => [v.slug, v]));
  const categories = categoryIds(config);

  personas.forEach((p, i) => {
    const at = ["personas", i];
    if (p.extends && builtinSlugs.includes(p.slug)) {
      issues.push({
        path: [...at, "extends"],
        message: "a built-in persona cannot extend another",
      });
    }
    if (p.instructions !== undefined && p.instructionsFile !== undefined) {
      issues.push({ path: at, message: "set instructions or instructionsFile, not both" });
    }
    if (p.instructionsFile !== undefined) {
      const file = p.instructionsFile.replace(/\\/g, "/");
      if (
        file.startsWith("/") ||
        /^[A-Za-z]:/.test(file) ||
        file.split("/").includes("..") ||
        !file.startsWith(".releaseray/")
      ) {
        issues.push({
          path: [...at, "instructionsFile"],
          message: "must be a repository-relative path under .releaseray/ with no ..",
        });
      }
    }
    (p.sections ?? []).forEach((s, j) => {
      const sectionPath = [...at, "sections", j, "categories"];
      if (s.categories.length === 0) {
        if (!(s.id in STANDARD_SECTION_CATEGORIES) && !categories.includes(s.id)) {
          issues.push({
            path: sectionPath,
            message: `section "${s.id}" is not a standard section or a category id; name its categories`,
          });
        }
      }
      for (const c of s.categories) {
        if (!categories.includes(c)) {
          issues.push({ path: sectionPath, message: `unknown category "${c}"` });
        }
      }
    });
    for (const c of p.excludeCategories ?? []) {
      if (!categories.includes(c)) {
        issues.push({ path: [...at, "excludeCategories"], message: `unknown category "${c}"` });
      }
    }
    for (const id of duplicates((p.sections ?? []).map((s) => s.id))) {
      issues.push({
        path: [...at, "sections"],
        message: `section id "${id}" appears more than once`,
      });
    }
  });

  if (!categories.includes(config.classification.fallbackCategory)) {
    issues.push({
      path: ["classification", "fallbackCategory"],
      message: `unknown category "${config.classification.fallbackCategory}"`,
    });
  }
  config.classification.categories.forEach((c, i) => {
    (c.labels ?? []).forEach((label, j) => {
      if (isSlashedPattern(label)) {
        checkPattern(issues, ["classification", "categories", i, "labels", j], label);
      }
    });
  });
  config.classification.exclude.labels.forEach((label, j) => {
    if (isSlashedPattern(label)) {
      checkPattern(issues, ["classification", "exclude", "labels", j], label);
    }
  });
  config.classification.exclude.titlePatterns.forEach((pattern, j) => {
    checkPattern(issues, ["classification", "exclude", "titlePatterns", j], pattern);
  });

  const requireEnabled = (path: (string | number)[], slug: string): PersonaView | undefined => {
    const view = views.get(slug);
    if (!view) issues.push({ path, message: `unknown persona "${slug}"` });
    else if (!view.enabled) issues.push({ path, message: `persona "${slug}" is disabled` });
    return view?.enabled ? view : undefined;
  };

  const { outputs } = config;
  if (Array.isArray(outputs.summary.personas)) {
    outputs.summary.personas.forEach((slug, i) =>
      requireEnabled(["outputs", "summary", "personas", i], slug)
    );
  }
  for (const sink of ["githubRelease", "changelog"] as const) {
    if (!outputs[sink].enabled) continue;
    const view = requireEnabled(["outputs", sink, "persona"], outputs[sink].persona);
    if (view?.visibility === "internal" && !outputs.allowInternalOutputs) {
      issues.push({
        path: ["outputs", sink, "persona"],
        message: `persona "${view.slug}" is internal; set outputs.allowInternalOutputs: true to publish it here`,
      });
    }
  }
  outputs.notify.forEach((n, i) => {
    requireEnabled(["outputs", "notify", i, "persona"], n.persona);
    if (n.type === "intercom") {
      const unknown = [...n.titleTemplate.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)]
        .map((m) => m[1])
        .filter((name) => name !== "key");
      if (unknown.length > 0) {
        issues.push({
          path: ["outputs", "notify", i, "titleTemplate"],
          message: `unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(", ")}; only {{key}} is replaced`,
        });
      }
    }
  });

  const { llm } = config;
  if (llm.provider === "bedrock" && !llm.region) {
    issues.push({ path: ["llm", "region"], message: "required when llm.provider is bedrock" });
  }
  if (llm.provider !== "bedrock" && llm.region) {
    issues.push({ path: ["llm", "region"], message: "applies only to llm.provider bedrock" });
  }
  if (llm.provider !== "openai" && llm.baseUrl) {
    issues.push({ path: ["llm", "baseUrl"], message: "applies only to llm.provider openai" });
  }

  return issues;
}

/** The full schema: every key, defaults, and the cross-field rules. */
export const ConfigSchema = BaseConfigSchema.superRefine((config, ctx) => {
  for (const issue of crossFieldIssues(config)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});

/** The schema without cross-field rules, for JSON Schema generation. */
export const ConfigShapeSchema = BaseConfigSchema;
