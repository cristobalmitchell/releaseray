/**
 * Workspace files (CONVERSION-PLAN §7.1): `<dir>/<key>/<persona>.md` with
 * markers, and `<dir>/<key>/notes.json` with text, digests, completeness and
 * usage. Both are deterministic for the same input, so they can be committed
 * or compared; timings appear only in the job summary.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunResult } from "../core/run";
import { writeMarkedBlock } from "../core/state/marker";

/** Version of the `notes.json` layout. */
export const NOTES_VERSION = 1;

/**
 * A key as a single safe directory name (`pkg/v1.0.0` becomes `pkg_v1.0.0`).
 *
 * @param key - Release key
 * @returns The directory name
 */
export function keyDir(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The `notes.json` content for a run: only personas whose files sink is on.
 *
 * @param result - The run result
 * @returns A JSON-ready object
 */
export function buildNotesJson(result: RunResult): Record<string, unknown> {
  const { range } = result;
  return {
    version: NOTES_VERSION,
    key: result.key,
    range: {
      kind: range.kind,
      from: range.from,
      to: range.to,
      toSha: range.toSha,
      firstRelease: range.firstRelease,
      date: result.date,
      touchesWorkflows: result.touchesWorkflows,
      commits: range.commits.length,
      pullRequests: range.prNumbers,
      excludedBySubject: range.excludedPRNumbers,
    },
    commitOnly: result.commitOnly,
    inputDigest: result.inputDigest,
    personas: result.personas
      .filter((p) => p.sinks.files)
      .map((p) => ({
        id: p.id,
        name: p.name,
        visibility: p.visibility,
        status: p.status,
        gen: p.gen,
        plans: p.plans
          ? Object.fromEntries(Object.entries(p.plans).map(([sink, plan]) => [sink, plan?.action]))
          : null,
        out: p.out ?? null,
        text: p.text ?? null,
        validation: p.report ?? null,
        llm: p.usage
          ? {
              calls: p.usage.calls,
              model: p.usage.model,
              provider: p.usage.provider,
              promptTokens: p.usage.promptTokens,
              completionTokens: p.usage.completionTokens,
              costUsd: p.usage.costUsd,
            }
          : null,
      })),
    withheld: result.personas
      .filter((p) => !p.sinks.files && p.withheld.length > 0)
      .map((p) => p.id),
    completeness: result.completeness,
    enrichmentDropped: result.drops,
    github: {
      requests: result.github.total,
      byRoute: result.github.byRoute,
      retries: result.github.retries,
      estimate: result.estimate,
    },
    warnings: result.warnings,
    notices: result.notices,
  };
}

/**
 * Writes the persona files and `notes.json`.
 *
 * @param result - The run result
 * @param workspace - Checkout root
 * @param dir - `outputs.files.dir`, relative to the workspace
 * @returns Paths written, relative to the workspace
 */
export function writeNotesFiles(result: RunResult, workspace: string, dir: string): string[] {
  const relDir = join(dir, keyDir(result.key));
  const absDir = resolve(workspace, relDir);
  mkdirSync(absDir, { recursive: true });
  const written: string[] = [];
  for (const persona of result.personas) {
    if (!persona.sinks.files || persona.text === undefined || persona.out === undefined) continue;
    const file = join(relDir, `${persona.id}.md`);
    const block = writeMarkedBlock(
      { key: result.key, persona: persona.id, gen: persona.gen, out: persona.out },
      persona.text
    );
    writeFileSync(resolve(workspace, file), `${block}\n`);
    written.push(file);
  }
  const notes = join(relDir, "notes.json");
  writeFileSync(resolve(workspace, notes), `${JSON.stringify(buildNotesJson(result), null, 2)}\n`);
  written.push(notes);
  return written;
}
