/**
 * The pipeline (CONVERSION-PLAN §6.4): resolve the range from local git,
 * fetch content once within the budget, classify once, then for each persona
 * with an eligible output build the prompt, call the model, validate and
 * render. Persisted sinks (GitHub Release, CHANGELOG) are planned and
 * applied by the publish layer; this module returns the text for them.
 */
import type { ResolvedConfig } from "../config/resolve";
import { enhancedClassifyChanges } from "./classify/rules";
import { classifyCommits } from "./classify/commits";
import { fetchContent, type CompletenessState, type FetchResult } from "./fetch/content";
import type { GitHubReader } from "./fetch/github";
import type { UsageSnapshot } from "./fetch/policy";
import { generateDraft, type DraftUsage } from "./llm/draft";
import type { LLMProvider } from "./llm/provider";
import { buildPersonaPrompt } from "./prompt/build";
import type { Templates } from "./prompt/templates";
import {
  assertFullHistory,
  assertSinksAllowed,
  resolveRange,
  type RangeRequest,
  type ResolvedRange,
} from "./range/resolve";
import type { Commit, Git } from "./range/git";
import { CANONICAL_RENDER_OPTIONS, renderToMarkdown } from "./render/markdown";
import {
  sanitizeCommentForLLM,
  sanitizeCommitForLLM,
  sanitizeForLLM,
  sanitizeTitleForLLM,
} from "./sanitize/llm";
import { sanitizeForPublishing } from "./sanitize/publish";
import { generationDigest, inputDigest, outputDigest, sha256 } from "./state/digest";
import type { GroupedChanges, ResolvedPersona } from "./types";
import { mapLimit } from "./util/limit";
import { compilePattern } from "./util/regex";
import { checkSufficiency, fitInput, type InputShape } from "./validate/input";
import { validateDraft, type ValidationReport } from "./validate/output";

/** What to run. */
export interface RunRequest {
  range: RangeRequest;
  /** Only these personas; default all enabled. */
  personas?: readonly string[];
  /** The `allow-sparse` input. */
  allowSparse: boolean;
  /** The `force` input: regenerate even when stored text matches. */
  force: boolean;
  /** Whether persisted sinks may write in this run. */
  publish: boolean;
}

/** The repository the run is for. */
export interface RepoContext {
  owner: string;
  repo: string;
  /** Web URL, such as https://github.com or a GHES host. */
  serverUrl: string;
  /** From the event payload's `repository.private`; unknown counts as public. */
  visibility: "public" | "private" | "unknown";
}

/** What the pipeline needs from outside. */
export interface RunDeps {
  git: Git;
  github: GitHubReader;
  /** The LLM provider for a persona. */
  llm: (persona: ResolvedPersona) => LLMProvider;
  templates: Templates;
  repo: RepoContext;
  /** Whether the model's cost is known. */
  priced: boolean;
  sleep: (ms: number) => Promise<void>;
  /** Current time in milliseconds. */
  now: () => number;
}

/** Where one persona's text may go. */
export interface PersonaSinks {
  summary: boolean;
  files: boolean;
  githubRelease: boolean;
  changelog: boolean;
}

/** One persona's outcome. */
export interface PersonaResult {
  id: string;
  name: string;
  visibility: "public" | "internal";
  sinks: PersonaSinks;
  /** Why a sink was withheld, for the summary. */
  withheld: string[];
  status: "generated" | "skipped";
  /** The generation digest. */
  gen: string;
  /** Canonical Markdown (release form), when generated. */
  text?: string;
  /** Digest of `text`. */
  out?: string;
  report?: ValidationReport;
  usage?: DraftUsage;
}

/** Everything the run produced. */
export interface RunResult {
  key: string;
  range: ResolvedRange;
  personas: PersonaResult[];
  completeness: Array<{ number: number } & CompletenessState>;
  inputDigest: string;
  drops: string[];
  warnings: string[];
  notices: string[];
  github: UsageSnapshot;
  /** The preflight estimate, when PRs were fetched. */
  estimate: number | null;
  /** True when the notes come from commit messages only. */
  commitOnly: boolean;
}

/** Applies `sanitizeForLLM` and a character cap. */
function body(text: string, maxChars: number): string {
  const clean = sanitizeForLLM(text);
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

function eligibleSinks(
  persona: ResolvedPersona,
  config: ResolvedConfig["config"],
  repo: RepoContext,
  persisted: { githubRelease: boolean; changelog: boolean }
): { sinks: PersonaSinks; withheld: string[] } {
  const { outputs } = config;
  const withheld: string[] = [];
  const internalAllowed =
    persona.visibility === "public" ||
    repo.visibility === "private" ||
    outputs.allowInternalOnPublicRepo;
  const listed =
    outputs.summary.personas === "all" || outputs.summary.personas.includes(persona.id);
  const summary = outputs.summary.enabled && listed && internalAllowed;
  const files = outputs.files.enabled && internalAllowed;
  if (!internalAllowed && (outputs.summary.enabled || outputs.files.enabled)) {
    withheld.push(
      "internal persona withheld from the summary and files on a public repository (set outputs.allowInternalOnPublicRepo: true to include it)"
    );
  }
  return {
    sinks: {
      summary,
      files,
      githubRelease:
        persisted.githubRelease &&
        outputs.githubRelease.enabled &&
        outputs.githubRelease.persona === persona.id,
      changelog:
        persisted.changelog &&
        outputs.changelog.enabled &&
        outputs.changelog.persona === persona.id,
    },
    withheld,
  };
}

function excludedTitles(persona: ResolvedPersona, config: ResolvedConfig): Set<string> {
  const ids = new Set(persona.excludeCategories ?? []);
  return new Set(config.categories.filter((c) => ids.has(c.id)).map((c) => c.title));
}

/** A persona with where it may go. */
export interface RoutedPersona {
  persona: ResolvedPersona;
  sinks: PersonaSinks;
  withheld: string[];
}

/** Everything before the first LLM call. */
export interface PreparedRun {
  range: ResolvedRange;
  routed: RoutedPersona[];
  /** Personas with at least one eligible output. */
  active: RoutedPersona[];
  fetched: FetchResult | null;
  commitOnly: boolean;
  /** The exact system and user prompts for a persona, at the fitted input size. */
  prompts(persona: ResolvedPersona): { system: string; user: string };
  /** Estimated input tokens of the largest prompt. */
  inputTokens: number;
  input: string;
  /** Generation digest per persona id. */
  gen: Map<string, string>;
  knownRefs: Set<number>;
  allowedDomains: string[];
  renderOptions: Omit<typeof CANONICAL_RENDER_OPTIONS, "includeEmojis" | "includeCompareLink"> & {
    includeEmojis: boolean;
    includeCompareLink: boolean;
  };
  drops: string[];
  warnings: string[];
  notices: string[];
}

/**
 * Runs the pipeline up to the first LLM call: range, routing, fetch,
 * classification, input sizing and digests. Previews stop here.
 *
 * @param request - Range, persona filter and flags
 * @param config - Resolved configuration
 * @param deps - Git, GitHub, templates, repository and clock
 * @param options - `fetch: false` skips GitHub and classifies from commit subjects
 * @returns The prepared run
 * @throws ReleaseRayError with the exit code of the first failing stage
 */
export async function prepareRun(
  request: RunRequest,
  config: ResolvedConfig,
  deps: Omit<RunDeps, "llm" | "priced">,
  options: { releaseRequests?: number } = {}
): Promise<PreparedRun> {
  const c = config.config;
  const warnings: string[] = [];
  const notices: string[] = [];

  // 1. Range from local git.
  assertFullHistory(deps.git);
  const titlePatterns = c.classification.exclude.titlePatterns.map(compilePattern);
  const range = resolveRange(deps.git, request.range, {
    tagPattern: c.range.tagPattern,
    includePrereleases: c.range.includePrereleases,
    allowNonAncestor: c.range.allowNonAncestor,
    maxPullRequests: c.range.maxPullRequests,
    titlePatterns,
  });
  warnings.push(...range.warnings);
  notices.push(...range.notices);
  if (request.publish) {
    assertSinksAllowed(range, {
      githubRelease: c.outputs.githubRelease.enabled,
      changelog: c.outputs.changelog.enabled,
    });
  }

  // 2. Personas and where each may go.
  const wanted = request.personas ? new Set(request.personas) : null;
  const personas = config.personas.filter((p) => !wanted || wanted.has(p.id));
  const persisted = {
    githubRelease: request.publish && range.persisted.githubRelease,
    changelog: request.publish && range.persisted.changelog,
  };
  const routed = personas.map((persona) => ({
    persona,
    ...eligibleSinks(persona, c, deps.repo, persisted),
  }));
  const releaseRequests =
    options.releaseRequests ?? (routed.some((r) => r.sinks.githubRelease) ? 2 : 0);

  // 3. Fetch once.
  let fetched: FetchResult | null = null;
  if (range.prNumbers.length > 0) {
    fetched = await fetchContent(deps.github, range.prNumbers, {
      enrichment: c.enrichment,
      exclude: {
        labels: c.classification.exclude.labels,
        authors: c.classification.exclude.authors,
        titlePatterns,
      },
      github: c.github,
      releaseRequests,
      sleep: deps.sleep,
      now: deps.now,
    });
    notices.push(...fetched.notes);
  }
  const pulls = fetched?.pulls ?? [];
  const issues = fetched?.issues ?? [];
  const commitOnly = pulls.length === 0 && c.range.fallbackToCommits;
  const commits: Commit[] = commitOnly ? range.commits : [];

  // 4. Enough to write about?
  const sparse = checkSufficiency(pulls, commits, request.allowSparse);
  if (sparse) warnings.push(sparse);

  // 5. Classify once, shared by every persona.
  const classifier = {
    labelRules: config.labelRules,
    categories: config.categories.map((cat) => cat.title),
    fallbackCategory: config.fallbackCategory,
  };
  let grouped: GroupedChanges = { grouped: [] };
  if (pulls.length > 0) {
    grouped = await enhancedClassifyChanges(
      pulls.map((p) => ({
        number: p.number,
        title: sanitizeTitleForLLM(p.title),
        body: sanitizeForLLM(p.body),
        labels: p.labels,
        linkedIssueIds: p.linkedIssues,
        author: p.author ?? "unknown",
        comments: p.comments.map((cm) => ({
          body: sanitizeCommentForLLM(cm.body),
          author: cm.author ?? "unknown",
          commentType: cm.kind === "review" ? "review_body" : "issue_comment",
        })),
      })),
      issues.map((i) => ({
        number: i.number,
        title: sanitizeTitleForLLM(i.title),
        body: sanitizeForLLM(i.body),
        labels: i.labels,
      })),
      classifier
    );
  } else if (commits.length > 0) {
    grouped = await classifyCommits(
      commits.map((cm) => ({
        sha: cm.sha,
        message: sanitizeCommitForLLM(cm.message),
        subject: sanitizeTitleForLLM(cm.message.split("\n")[0]),
        author: cm.authorName,
      })),
      classifier
    );
  }

  // 6. The model's input, per persona, sized to fit.
  const buildInput = (persona: ResolvedPersona, shape: InputShape) => {
    const hide = excludedTitles(persona, config);
    return {
      release: {
        repository: `${deps.repo.owner}/${deps.repo.repo}`,
        key: range.key,
        from: range.from,
        to: range.to,
      },
      changes: grouped.grouped
        .filter((g) => !hide.has(g.category))
        .map((g) => ({
          category: g.category,
          items: g.items.map((item) => ({
            title: item.title,
            description: item.description,
            ref: item.ref,
            labels: item.labels,
            flags: item.flags,
          })),
        })),
      pullRequests: pulls.map((p) => ({
        number: p.number,
        title: sanitizeTitleForLLM(p.title),
        body: body(p.body, shape.maxBodyChars),
        labels: p.labels,
        author: p.author,
        linkedIssues: p.linkedIssues,
        comments: p.comments.map((cm) => ({
          author: cm.author,
          body: sanitizeCommentForLLM(cm.body),
        })),
      })),
      linkedIssues: issues.map((i) => ({
        number: i.number,
        title: sanitizeTitleForLLM(i.title),
        body: shape.linkedIssueBodies ? body(i.body, shape.maxBodyChars) : "",
        labels: i.labels,
      })),
      commits: commits.map((cm) => sanitizeCommitForLLM(cm.message)),
    };
  };
  const promptFor = (persona: ResolvedPersona, shape: InputShape) =>
    buildPersonaPrompt(persona, deps.templates.persona, buildInput(persona, shape));
  const active = routed.filter(
    (r) => r.sinks.summary || r.sinks.files || r.sinks.githubRelease || r.sinks.changelog
  );
  const fitted = fitInput(
    (shape) =>
      Math.max(
        0,
        ...active.map((r) => deps.templates.system.length + promptFor(r.persona, shape).length)
      ),
    { maxBodyChars: c.enrichment.maxBodyChars, linkedIssueBodies: true },
    c.llm.maxInputTokens,
    c.github.onBudgetExceeded
  );
  const drops = [...(fetched?.drops ?? []), ...fitted.drops];

  // 7. Digests.
  const input = inputDigest({
    range: { from: range.from, to: range.to, commits: range.commits },
    pulls,
    issues,
    comments: fetched?.plan.comments ?? false,
  });
  const templates = {
    system: sha256(deps.templates.system).slice(0, 16),
    persona: sha256(deps.templates.persona).slice(0, 16),
  };
  const knownRefs = new Set([...pulls.map((p) => p.number), ...issues.map((i) => i.number)]);
  const renderOptions = {
    ...CANONICAL_RENDER_OPTIONS,
    includeEmojis: c.render.emoji,
    includeCompareLink: c.render.compareLink,
  };
  const serverHost = new URL(deps.repo.serverUrl).hostname;
  const allowedDomains = [...new Set([...c.sanitize.allowedDomains, serverHost])];

  const gen = new Map(
    routed.map((r) => [
      r.persona.id,
      generationDigest({
        input,
        persona: r.persona,
        templates,
        provider: c.llm.provider,
        model: config.model,
        maxCompletionTokens: c.llm.maxCompletionTokens,
        render: renderOptions,
      }),
    ])
  );

  return {
    range,
    routed,
    active,
    fetched,
    commitOnly,
    prompts: (persona) => ({
      system: deps.templates.system,
      user: promptFor(persona, fitted.shape),
    }),
    inputTokens: fitted.tokens,
    input,
    gen,
    knownRefs,
    allowedDomains,
    renderOptions,
    drops,
    warnings,
    notices,
  };
}

/**
 * Runs the pipeline up to rendered text per persona.
 *
 * @param request - Range, persona filter and flags
 * @param config - Resolved configuration
 * @param deps - Git, GitHub, LLM, templates, repository and clock
 * @returns The range, per-persona results, completeness and usage
 * @throws ReleaseRayError with the exit code of the first failing stage
 */
export async function run(
  request: RunRequest,
  config: ResolvedConfig,
  deps: RunDeps
): Promise<RunResult> {
  const c = config.config;
  const prepared = await prepareRun(request, config, deps);
  const { range, routed, active, fetched, knownRefs, allowedDomains, renderOptions } = prepared;
  const { warnings, notices, drops, commitOnly } = prepared;
  const pulls = fetched?.pulls ?? [];

  // 8. Generate each persona that has somewhere to go.
  const results = await mapLimit(routed, c.llm.concurrency, async (r): Promise<PersonaResult> => {
    const gen = prepared.gen.get(r.persona.id)!;
    const prompts = prepared.prompts(r.persona);
    const base = {
      id: r.persona.id,
      name: r.persona.name,
      visibility: r.persona.visibility,
      sinks: r.sinks,
      withheld: r.withheld,
      gen,
    };
    if (!active.includes(r)) return { ...base, status: "skipped" };

    const { draft, usage } = await generateDraft(
      deps.llm(r.persona),
      prompts.system,
      prompts.user,
      {
        retries: c.llm.retries,
        maxCompletionTokens: c.llm.maxCompletionTokens,
        priced: deps.priced,
      }
    );
    const validated = validateDraft(draft, {
      persona: r.persona,
      knownRefs,
      categories: config.categories,
      fallbackCategory: c.classification.fallbackCategory,
      allowedDomains,
      redactPaths: c.sanitize.redactPaths,
      pullAuthors: pulls.map((p) => p.author),
    });
    const sections = r.persona.sections;
    const markdown = renderToMarkdown(validated.draft, {
      ...renderOptions,
      includeCompareLink: renderOptions.includeCompareLink && range.from !== null,
      repoFullName: `${deps.repo.owner}/${deps.repo.repo}`,
      fromTag: range.from ?? undefined,
      toTag: range.to,
      serverUrl: deps.repo.serverUrl,
      showHighlights: sections?.showHighlights ?? true,
      showUpgradeInstructions: sections?.showUpgradeInstructions ?? true,
      showContributors: sections?.showContributors ?? true,
      sectionOrder: (sections?.sectionConfig ?? [])
        .filter((s) => s.enabled)
        .sort((a, b) => a.order - b.order)
        .map((s) => s.name),
    });
    const text = sanitizeForPublishing(markdown, { allowedDomains, redactPaths: false }).trim();
    if (validated.report.hallucinatedRefs > 0) {
      warnings.push(
        `${r.persona.id}: removed ${validated.report.hallucinatedRefs} references to PRs or issues not in this release`
      );
    }
    return {
      ...base,
      status: "generated",
      text,
      out: outputDigest(text),
      report: validated.report,
      usage,
    };
  });

  for (const r of results) {
    if (r.status === "skipped")
      notices.push(`${r.id}: no eligible output in this run; not generated`);
  }

  const completeness = [...(fetched?.states.entries() ?? [])]
    .sort(([a], [b]) => a - b)
    .map(([number, state]) => ({ number, ...state }));

  return {
    key: range.key,
    range,
    personas: results,
    completeness,
    inputDigest: prepared.input,
    drops,
    warnings,
    notices,
    github: deps.github.usage(),
    estimate: fetched?.estimate ?? null,
    commitOnly,
  };
}
