/**
 * `mode: adopt` (CONVERSION-PLAN §9.5, PD-9): takes over release bodies and
 * CHANGELOG entries that something else wrote, such as the hosted App, by
 * wrapping them in markers with `gen=adopted`. The next run then treats them
 * as current and writes nothing, instead of appending a second copy.
 *
 * No LLM call. One release read and at most one write per tag. Writes are
 * paced for GitHub's content-creation limits (§5.7): 1 second apart when a
 * run plans at most 80, 7.2 seconds apart otherwise, and a run stops after
 * 400 with the next safe start time.
 */
import type { ResolvedConfig } from "../config/resolve";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import { assertFullHistory, selectTags } from "../core/range/resolve";
import { adoptChangelogEntry } from "../outputs/changelog";
import { adoptReleaseBody, releaseWriteError } from "../outputs/github-release/sink";
import { applyChangelogEdit } from "../outputs/persisted";
import { result, tagTable, type ModeResult, type TagModeDeps, type TagModeRequest } from "./types";

/** Write pacing for bulk adoption (CONVERSION-PLAN §5.7). */
export const ADOPT_PACING = {
  /** A run planning at most this many writes stays under 80 a minute at 1 second apart. */
  burstWrites: 80,
  burstSpacingMs: 1_000,
  /** 3,600 seconds over 500 writes: no 60-minute span exceeds 500. */
  spacingMs: 7_200,
  /** Writes per run, leaving headroom under 500 an hour (an assumption, §5.7). */
  maxWrites: 400,
  /** The content-creation window. */
  windowMs: 60 * 60 * 1_000,
} as const;

interface Row {
  release: string;
  changelog: string;
}

/**
 * Formats a time for notices: ISO 8601 in UTC, to the second.
 *
 * @param ms - Milliseconds since the epoch
 * @returns For example `2026-11-23T14:05:00Z`
 */
export function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Runs `adopt`.
 *
 * @param request - `to` or `allTags`, and the workspace
 * @param config - Resolved configuration
 * @param deps - Git, release API, CHANGELOG push, clock and sleep
 * @returns Summary, outputs and warnings; a resume notice when the write cap stopped the run
 * @throws ReleaseRayError: exit 2 for a shallow clone or bad tags, 3 when GitHub refuses the first write, 6 when the push is rejected, 7 when a write fails after others succeeded
 */
export async function adopt(
  request: TagModeRequest,
  config: ResolvedConfig,
  deps: TagModeDeps
): Promise<ModeResult> {
  assertFullHistory(deps.git);
  const c = config.config;
  const tags = selectTags(deps.git, request, c.range.tagPattern);
  const mode = result();
  const notices: string[] = [];
  const rows = new Map<string, Row>(tags.map((t) => [t, { release: "-", changelog: "-" }]));

  // 1. Read every release and plan, so the spacing fits the number of writes.
  const releasePersona = c.outputs.githubRelease.persona;
  const planned: Array<{ tag: string; id: number; body: string }> = [];
  if (!c.outputs.githubRelease.enabled) {
    notices.push("outputs.githubRelease.enabled is false: release bodies were not read");
  } else if (deps.release) {
    for (const tag of tags) {
      const row = rows.get(tag)!;
      const current = await deps.release.get(tag);
      if (!current) {
        row.release = "no release";
        continue;
      }
      const plan = adoptReleaseBody(current.body, tag, releasePersona);
      if (plan.action === "adopt") {
        planned.push({ tag, id: current.id, body: plan.body });
        row.release = "planned";
      } else if (plan.action === "marked") {
        row.release = "already marked";
      } else if (plan.action === "empty") {
        row.release = "empty body";
      } else {
        row.release = "skipped";
        mode.warnings.push(
          `The release body for ${tag} has ReleaseRay markers for another key or persona, or a broken marker; it was left unchanged`
        );
      }
    }
  }

  // 2. Write, paced (§5.7).
  const spacing =
    planned.length <= ADOPT_PACING.burstWrites
      ? ADOPT_PACING.burstSpacingMs
      : ADOPT_PACING.spacingMs;
  const batch = planned.slice(0, ADOPT_PACING.maxWrites);
  let first: number | null = null;
  let last = 0;
  let written = 0;
  for (const write of batch) {
    if (first !== null) {
      const wait = last + spacing - deps.now();
      if (wait > 0) await deps.sleep(wait);
    }
    const at = deps.now();
    try {
      await deps.release!.updateBody(write.id, write.body);
    } catch (error) {
      const failure = releaseWriteError(
        error,
        { key: write.tag, touchesWorkflows: false },
        "update"
      );
      if (written === 0) throw failure;
      throw new ReleaseRayError(
        `Partial adopt: ${written} release${written === 1 ? "" : "s"} adopted before ${write.tag} failed`,
        EXIT_CODES.partial,
        [failure.message, ...failure.details, "Re-run adopt: adopted releases are skipped"],
        { cause: failure }
      );
    }
    first ??= at;
    last = at;
    written++;
    rows.get(write.tag)!.release = "adopted";
  }
  const nextStart = first === null ? null : first + ADOPT_PACING.windowMs;
  const pending = planned.slice(batch.length);
  for (const p of pending) rows.get(p.tag)!.release = "pending (write cap)";
  if (pending.length > 0) {
    mode.warnings.push(
      `Stopped after ${ADOPT_PACING.maxWrites} release writes, the cap for one run; ${pending.length} release${pending.length === 1 ? "" : "s"} still need adopting, starting with ${pending[0].tag}. ` +
        `Next safe start: ${formatTime(nextStart!)}, one hour after this run's first write (GitHub allows 500 content-creating requests an hour, and writes by other workflows count too). Releases already adopted are skipped`
    );
  }

  // 3. CHANGELOG entries, in the workspace and pushed in one commit.
  let changelog = { changed: false, pushed: false };
  if (!c.outputs.changelog.enabled) {
    notices.push("outputs.changelog.enabled is false: CHANGELOG was not read");
  } else {
    const persona = c.outputs.changelog.persona;
    const labels = { adopted: "adopted", marked: "already marked", missing: "no entry" } as const;
    // The first call is on the workspace file and fills the table; push attempts re-apply.
    let recorded = false;
    const edit = (text: string) => {
      let acc = text;
      for (const tag of tags) {
        const done = adoptChangelogEntry(acc, tag, persona);
        acc = done.content;
        if (!recorded) rows.get(tag)!.changelog = labels[done.action];
      }
      recorded = true;
      return acc;
    };
    changelog = applyChangelogEdit(edit, tags, c.outputs.changelog, deps.persisted);
    if (changelog.changed && !changelog.pushed) mode.files.push(c.outputs.changelog.path);
  }

  const adoptedCount = [...rows.values()].filter((r) => r.changelog === "adopted").length;
  mode.outputs = {
    ...(tags.length === 1 ? { key: tags[0] } : {}),
    "release-changed": String(written > 0),
    "changelog-changed": String(changelog.changed),
    "github-requests": String(deps.requests?.() ?? 0),
    "llm-calls": "0",
    "llm-cost-usd": "0.0000",
  };
  mode.summary = [
    `# ReleaseRay adopt: ${tags.length === 1 ? tags[0] : `${tags.length} tags`}`,
    "",
    `- GitHub Release (\`${releasePersona}\`): ${written} adopted${pending.length > 0 ? `, ${pending.length} pending` : ""}`,
    `- CHANGELOG (\`${c.outputs.changelog.persona}\`): ${adoptedCount} adopted${changelog.pushed ? " and pushed" : ""}`,
    ...(nextStart !== null
      ? [`- Next safe start for another bulk adopt: ${formatTime(nextStart)}`]
      : []),
    ...notices.map((n) => `- ${n}`),
    "",
    ...tagTable(new Map([...rows].map(([tag, r]) => [tag, [r.release, r.changelog]])), [
      "GitHub Release",
      "CHANGELOG",
    ]),
    "",
  ].join("\n");
  return mode;
}
