/**
 * `mode: generate`: run the pipeline, write the workspace files and the job
 * summary. Persisted sinks are applied by the publish layer when `publish`
 * resolves to true.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/resolve";
import { run, type RunDeps, type RunRequest, type RunResult } from "../core/run";
import { sha256 } from "../core/state/digest";
import { keyDir, writeNotesFiles } from "../outputs/files";
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
 * @param deps - Pipeline dependencies
 * @returns Summary, outputs and files; the run result for the publish layer
 * @throws ReleaseRayError from any pipeline stage
 */
export async function generate(
  request: GenerateRequest,
  config: ResolvedConfig,
  deps: RunDeps & { persisted?: PersistedDeps }
): Promise<ModeResult & { run: RunResult }> {
  const out = await run(request, config, deps);
  let published = {
    releaseChanged: false,
    releaseUrl: out.release?.url ?? null,
    changelogChanged: false,
  };
  const publishWarnings: string[] = [];
  if (request.publish && deps.persisted) {
    const personas: PersistedPersona[] = out.personas
      .filter((p) => p.plans && p.text !== undefined)
      .map((p) => ({ id: p.id, gen: p.gen, text: p.text!, plans: p.plans! }));
    const outcome = await applyPersisted(
      personas,
      {
        key: out.key,
        date: out.date,
        release: out.release,
        touchesWorkflows: out.touchesWorkflows,
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
  return { ...mode, run: out };
}
