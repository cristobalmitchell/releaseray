/**
 * `mode: preview`: never calls the LLM and never writes to GitHub
 * (CONVERSION-PLAN §8.1). Without `previewPrompts` it reads only local git
 * and `GET /rate_limit`, which is not counted against the primary limit, and
 * classifies from commit subjects, so the classification is approximate.
 * With `previewPrompts` it fetches content as `generate` does and writes
 * each persona's exact prompts as workspace files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedConfig } from "../config/resolve";
import { classifyCommits } from "../core/classify/commits";
import { estimateRequests } from "../core/fetch/budget";
import { defaultCap } from "../core/fetch/budget";
import { assertFullHistory, resolveRange } from "../core/range/resolve";
import { prepareRun, type RunDeps, type RunRequest } from "../core/run";
import { sanitizeTitleForLLM } from "../core/sanitize/llm";
import { compilePattern } from "../core/util/regex";
import { keyDir } from "../outputs/files";
import { result, type ModeResult } from "./types";

/** `preview` request. */
export interface PreviewRequest extends Omit<RunRequest, "publish" | "force"> {
  previewPrompts: boolean;
  workspace: string;
}

/**
 * Runs `preview`.
 *
 * @param request - Range, personas and whether to write prompts
 * @param config - Resolved configuration
 * @param deps - Git, GitHub reads, templates and repository; no LLM
 * @returns Summary, outputs and any prompt files
 * @throws ReleaseRayError for range errors, or budget errors with `previewPrompts`
 */
export async function preview(
  request: PreviewRequest,
  config: ResolvedConfig,
  deps: Omit<RunDeps, "llm" | "priced">
): Promise<ModeResult> {
  const c = config.config;
  const mode = result();

  if (request.previewPrompts) {
    const prepared = await prepareRun({ ...request, publish: false, force: false }, config, deps, {
      releaseRequests: 0,
    });
    const dir = join(c.outputs.files.dir, keyDir(prepared.range.key), "prompts");
    mkdirSync(resolve(request.workspace, dir), { recursive: true });
    const lines = [
      `# ReleaseRay preview: ${prepared.range.key}`,
      "",
      "Prompts written; no LLM call was made.",
      "",
    ];
    for (const r of prepared.routed) {
      // Prompts follow the files sink's visibility rule.
      if (!r.sinks.files) {
        lines.push(`- ${r.persona.name}: withheld (${r.withheld[0] ?? "files output is off"})`);
        continue;
      }
      const prompts = prepared.prompts(r.persona);
      for (const [part, text] of [
        ["system", prompts.system],
        ["user", prompts.user],
      ] as const) {
        const file = join(dir, `${r.persona.id}.${part}.md`);
        writeFileSync(resolve(request.workspace, file), `${text}\n`);
        mode.files.push(file);
      }
      lines.push(`- ${r.persona.name}: \`${join(dir, `${r.persona.id}.user.md`)}\``);
    }
    lines.push(
      "",
      `Estimated input: about ${prepared.inputTokens} tokens for the largest persona.`
    );
    mode.summary = lines.join("\n");
    mode.warnings = prepared.warnings;
    mode.outputs = {
      key: prepared.range.key,
      from: prepared.range.from ?? "",
      to: prepared.range.to,
    };
    return mode;
  }

  assertFullHistory(deps.git);
  const titlePatterns = c.classification.exclude.titlePatterns.map(compilePattern);
  const range = resolveRange(deps.git, request.range, {
    tagPattern: c.range.tagPattern,
    includePrereleases: c.range.includePrereleases,
    allowNonAncestor: c.range.allowNonAncestor,
    maxPullRequests: c.range.maxPullRequests,
    titlePatterns,
  });
  const grouped = await classifyCommits(
    range.commits.map((cm) => {
      const subject = sanitizeTitleForLLM(cm.message.split("\n")[0]);
      return { sha: cm.sha, message: subject, subject, author: cm.authorName };
    }),
    {
      labelRules: config.labelRules,
      categories: config.categories.map((cat) => cat.title),
      fallbackCategory: config.fallbackCategory,
    }
  );
  const rate = await deps.github.rateLimit();
  const publishing = c.outputs.githubRelease.enabled && range.persisted.githubRelease;
  const estimate = estimateRequests(
    { pulls: range.prNumbers.length, releaseRequests: publishing ? 2 : 0 },
    c.enrichment
  );
  const cap = c.github.maxRequests ?? defaultCap(rate.limit);
  const available = Math.min(cap, rate.remaining);

  const span = range.from ? `${range.from} → ${range.to}` : `${range.to} (from the first commit)`;
  const lines = [
    `# ReleaseRay preview: ${range.key}`,
    "",
    `Range: ${span}, ${range.commits.length} commits, ${range.prNumbers.length} pull requests${range.excludedPRNumbers.length ? ` (${range.excludedPRNumbers.length} excluded by subject)` : ""}.`,
    "",
    "## Approximate classification",
    "",
    "_From commit subjects only; `generate` also reads labels and bodies._",
    "",
    "| Category | Changes |",
    "| --- | ---: |",
    ...grouped.grouped
      .filter((g) => g.items.length > 0)
      .map((g) => `| ${g.category} | ${g.items.length} |`),
    "",
    "## Budget",
    "",
    `A \`generate\` run would make about ${estimate} REST requests; ${available} are available (remaining ${rate.remaining} of ${rate.limit}, cap ${cap}).`,
    "",
  ];
  for (const w of range.warnings) lines.push(`> [!WARNING]\n> ${w}`, "");
  mode.summary = lines.join("\n");
  mode.warnings = [...range.warnings];
  if (estimate > available) {
    mode.warnings.push(
      `A generate run would need about ${estimate} requests, more than the ${available} available`
    );
  }
  mode.outputs = {
    key: range.key,
    from: range.from ?? "",
    to: range.to,
    "github-requests": "0",
    "llm-calls": "0",
    "llm-cost-usd": "0.0000",
  };
  return mode;
}
