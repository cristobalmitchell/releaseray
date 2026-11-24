/**
 * `mode: generate`: run the pipeline, write the workspace files and the job
 * summary. Persisted sinks are applied by the publish layer when `publish`
 * resolves to true.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/resolve";
import { EXIT_CODES } from "../core/errors";
import { run, type RunDeps, type RunRequest, type RunResult } from "../core/run";
import { sha256 } from "../core/state/digest";
import { keyDir, writeNotesFiles } from "../outputs/files";
import { generateCompareUrl } from "../outputs/github-release/api";
import {
  applyNotify,
  assertNotifyCredentials,
  notifyReport,
  type NotifySecrets,
} from "../outputs/notify/sink";
import { applyPersisted, type PersistedDeps, type PersistedPersona } from "../outputs/persisted";
import { renderSummary } from "../outputs/summary";
import { result, type ModeResult } from "./types";

/** `generate` request. */
export interface GenerateRequest extends RunRequest {
  /** Checkout root, where workspace files are written. */
  workspace: string;
}

/**
 * Step outputs shared by `generate` and `publish`.
 *
 * @param run - The run result
 * @param notesDir - Directory holding notes.json, relative to the workspace
 * @param workspace - Checkout root
 * @returns Output values
 */
export function runOutputs(
  run: RunResult,
  notesDir: string | null,
  workspace: string
): Record<string, string> {
  const generated = run.personas.filter((p) => p.usage);
  const calls = generated.reduce((n, p) => n + (p.usage?.calls ?? 0), 0);
  const costs = generated.map((p) => p.usage?.costUsd ?? null);
  const cost = costs.some((c) => c === null)
    ? "n/a"
    : costs.reduce<number>((n, c) => n + (c ?? 0), 0).toFixed(4);
  const outputs: Record<string, string> = {
    key: run.key,
    from: run.range.from ?? "",
    to: run.range.to,
    "github-requests": String(run.github.total),
    "llm-calls": String(calls),
    "llm-cost-usd": generated.length === 0 ? "0.0000" : cost,
  };
  if (notesDir) {
    outputs["notes-dir"] = notesDir;
    outputs["notes-digest"] = sha256(readFileSync(join(workspace, notesDir, "notes.json"), "utf8"));
  }
  return outputs;
}

/**
 * Runs `generate`.
 *
 * @param request - Range, personas, flags and workspace
 * @param config - Resolved configuration
 * @param deps - Pipeline dependencies; `notifySecrets` holds notify credentials by variable name
 * @returns Summary, outputs and files; the run result for the publish layer
 * @throws ReleaseRayError from any pipeline stage, or exit 2 before any work
 *   when a publishing run's notify credential is missing
 */
export async function generate(
  request: GenerateRequest,
  config: ResolvedConfig,
  deps: RunDeps & { persisted?: PersistedDeps; notifySecrets?: NotifySecrets }
): Promise<ModeResult & { run: RunResult }> {
  const notify = config.config.outputs.notify;
  const secrets = deps.notifySecrets ?? {};
  if (request.publish) assertNotifyCredentials(notify, request.personas ?? null, secrets);
  const ran = await run(request, config, deps);
  let published = {
    releaseChanged: false,
    releaseUrl: ran.release?.url ?? null,
    changelogChanged: false,
  };
  const publishWarnings: string[] = [];
  if (request.publish && deps.persisted) {
    const personas: PersistedPersona[] = ran.personas
      .filter((p) => p.plans && p.text !== undefined)
      .map((p) => ({ id: p.id, gen: p.gen, text: p.text!, plans: p.plans! }));
    const outcome = await applyPersisted(
      personas,
      {
        key: ran.key,
        date: ran.date,
        release: ran.release,
        touchesWorkflows: ran.touchesWorkflows,
      },
      {
        githubRelease: config.config.outputs.githubRelease,
        changelog: config.config.outputs.changelog,
      },
      deps.persisted
    );
    published = outcome;
    publishWarnings.push(...outcome.warnings);
  }
  // Count the run's own release and CHANGELOG requests too: the snapshot in
  // `ran` was taken before the persisted sinks wrote.
  const out: RunResult = { ...ran, github: deps.github.usage() };
  const files = config.config.outputs.files;
  const mode = result();
  let notesDir: string | null = null;
  if (files.enabled) {
    mode.files = writeNotesFiles(out, request.workspace, files.dir);
    notesDir = join(files.dir, keyDir(out.key));
  }
  mode.summary = config.config.outputs.summary.enabled
    ? renderSummary(out, { filesDir: notesDir ?? undefined })
    : "";
  mode.outputs = {
    ...runOutputs(out, notesDir, request.workspace),
    "release-url": published.releaseUrl ?? "",
    "release-changed": String(published.releaseChanged),
    "changelog-changed": String(published.changelogChanged),
  };
  mode.warnings = [...out.warnings, ...publishWarnings];

  // Notifications go last, after the GitHub targets (§6.4 step 11).
  if (request.publish && notify.length > 0) {
    const { owner, repo, serverUrl } = deps.repo;
    const primaryChanged =
      ran.primary === "githubRelease"
        ? published.releaseChanged
        : ran.primary === "changelog"
          ? published.changelogChanged
          : false;
    const outcome = await applyNotify(
      notify,
      ran.personas.map((p) => ({ id: p.id, text: p.text })),
      {
        key: ran.key,
        repoFullName: `${owner}/${repo}`,
        primaryChanged,
        override: request.notify ?? null,
        ...(published.releaseUrl ? { releaseUrl: published.releaseUrl } : {}),
        ...(ran.range.from
          ? { compareUrl: generateCompareUrl(serverUrl, owner, repo, ran.range.from, ran.range.to) }
          : {}),
      },
      secrets
    );
    const reported = notifyReport(outcome);
    if (mode.summary) mode.summary += reported.summary;
    mode.errors.push(...reported.errors);
    if (reported.errors.length > 0) mode.exitCode = EXIT_CODES.partial;
  }
  return { ...mode, run: out };
}
