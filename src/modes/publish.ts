/**
 * `mode: publish`, the write job of the hardened split (CONVERSION-PLAN
 * §8.3): refuses a `notes.json` whose sha256 differs from `expected-digest`,
 * re-reads and re-plans the targets, writes from the stored text, then sends
 * the notifications. It makes no LLM call and needs no git history.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedConfig } from "../config/resolve";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import { sha256 } from "../core/state/digest";
import { planSink, type PlanTarget } from "../core/state/planner";
import { generateCompareUrl } from "../outputs/github-release/api";
import {
  applyNotify,
  assertNotifyCredentials,
  notifyReport,
  type NotifySecrets,
} from "../outputs/notify/sink";
import { applyPersisted, type PersistedDeps, type PersistedPersona } from "../outputs/persisted";
import { result, type ModeResult } from "./types";

/** `publish` request. */
export interface PublishRequest {
  workspace: string;
  /** Directory holding notes.json, relative to the workspace. */
  notesDir: string;
  expectedDigest: string;
  /** The `notify` input: replaces every notify entry's `when` for this run. */
  notify?: "primary-changed" | "always" | null;
}

/** What the notify sink needs in `publish`. */
export interface PublishNotifyDeps {
  repo: { owner: string; repo: string; serverUrl: string };
  /** Credential values by environment variable name. */
  secrets: NotifySecrets;
}

interface NotesJson {
  key: string;
  range: {
    kind: string;
    from?: string | null;
    to?: string;
    date: string;
    touchesWorkflows: boolean;
  };
  personas: Array<{ id: string; gen: string; text: string | null }>;
}

/**
 * Runs `publish`.
 *
 * @param request - Workspace, notes directory and expected digest
 * @param config - Resolved configuration from the checkout
 * @param deps - Release API, workspace and push credentials
 * @param notifyDeps - Repository and notify credentials; without them no notification is sent
 * @returns Outputs for the release and CHANGELOG
 * @throws ReleaseRayError (exit 2) on a missing or mismatched notes.json, or a
 *   missing notify credential, before any write
 */
export async function publish(
  request: PublishRequest,
  config: ResolvedConfig,
  deps: PersistedDeps,
  notifyDeps?: PublishNotifyDeps
): Promise<ModeResult> {
  if (!request.notesDir || !request.expectedDigest) {
    throw new ReleaseRayError(
      "mode: publish needs notes-dir and expected-digest",
      EXIT_CODES.invalid,
      ["Pass the generate job's notes-dir artifact path and its notes-digest output"]
    );
  }
  const file = resolve(request.workspace, join(request.notesDir, "notes.json"));
  if (!existsSync(file)) {
    throw new ReleaseRayError(
      `${join(request.notesDir, "notes.json")} does not exist`,
      EXIT_CODES.invalid,
      []
    );
  }
  const raw = readFileSync(file, "utf8");
  const digest = sha256(raw);
  if (digest !== request.expectedDigest.trim()) {
    throw new ReleaseRayError(
      "notes.json does not match expected-digest; nothing was written",
      EXIT_CODES.invalid,
      [`expected ${request.expectedDigest.trim()}, found ${digest}`]
    );
  }
  const notes = JSON.parse(raw) as NotesJson;
  const c = config.config;
  const notify = notifyDeps ? c.outputs.notify : [];
  assertNotifyCredentials(notify, null, notifyDeps?.secrets ?? {});
  const isTag = notes.range.kind === "tag";

  const release =
    isTag && c.outputs.githubRelease.enabled && deps.release
      ? await deps.release.get(notes.key)
      : null;
  const changelogFile = resolve(request.workspace, c.outputs.changelog.path);
  const targets: Array<PlanTarget & { persona: string }> = [];
  if (isTag && c.outputs.githubRelease.enabled && deps.release) {
    targets.push({
      sink: "github-release",
      persona: c.outputs.githubRelease.persona,
      exists: release !== null,
      text: release?.body ?? "",
      mode: c.outputs.githubRelease.mode,
      onHumanEdit: c.outputs.githubRelease.onHumanEdit,
      createIfMissing: c.outputs.githubRelease.createIfMissing,
    });
  }
  if (c.outputs.changelog.enabled) {
    targets.push({
      sink: "changelog",
      persona: c.outputs.changelog.persona,
      exists: true,
      text: existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : "",
      mode: "section",
      onHumanEdit: c.outputs.changelog.onHumanEdit,
      createIfMissing: true,
    });
  }

  const mode = result();
  const personas: PersistedPersona[] = [];
  for (const target of targets) {
    const persona = notes.personas.find((p) => p.id === target.persona);
    if (!persona?.text) {
      mode.warnings.push(
        `notes.json has no text for ${target.persona}; the ${target.sink === "changelog" ? "CHANGELOG" : "release"} was not written`
      );
      continue;
    }
    const plan = planSink(target, {
      key: notes.key,
      persona: persona.id,
      gen: persona.gen,
      force: false,
    });
    if (plan.warning) mode.warnings.push(plan.warning);
    let entry = personas.find((p) => p.id === persona.id);
    if (!entry) {
      entry = { id: persona.id, gen: persona.gen, text: persona.text, plans: {} };
      personas.push(entry);
    }
    if (target.sink === "github-release") entry.plans.githubRelease = plan;
    else entry.plans.changelog = plan;
  }

  const written = await applyPersisted(
    personas,
    {
      key: notes.key,
      date: notes.range.date,
      release,
      touchesWorkflows: notes.range.touchesWorkflows,
    },
    { githubRelease: c.outputs.githubRelease, changelog: c.outputs.changelog },
    deps
  );
  mode.warnings.push(...written.warnings);
  mode.outputs = {
    key: notes.key,
    "notes-digest": digest,
    "release-url": written.releaseUrl ?? "",
    "release-changed": String(written.releaseChanged),
    "changelog-changed": String(written.changelogChanged),
    "llm-calls": "0",
    "llm-cost-usd": "0.0000",
  };
  mode.summary = [
    `# ReleaseRay publish: ${notes.key}`,
    "",
    `- GitHub Release: ${written.releaseChanged ? `written (${written.releaseUrl})` : "unchanged"}`,
    `- CHANGELOG: ${written.changelogChanged ? (written.pushed ? "written and pushed" : "written") : "unchanged"}`,
    "",
  ].join("\n");

  if (notifyDeps && notify.length > 0) {
    const { owner, repo, serverUrl } = notifyDeps.repo;
    // The release target is listed first when there is one: it is the primary.
    const primary = targets[0]?.sink ?? null;
    const notified = await applyNotify(
      notify,
      notes.personas.map((p) => ({ id: p.id, text: p.text })),
      {
        key: notes.key,
        repoFullName: `${owner}/${repo}`,
        primaryChanged:
          primary === "github-release"
            ? written.releaseChanged
            : primary === "changelog"
              ? written.changelogChanged
              : false,
        override: request.notify ?? null,
        ...(written.releaseUrl ? { releaseUrl: written.releaseUrl } : {}),
        ...(notes.range.from && notes.range.to
          ? {
              compareUrl: generateCompareUrl(
                serverUrl,
                owner,
                repo,
                notes.range.from,
                notes.range.to
              ),
            }
          : {}),
      },
      notifyDeps.secrets
    );
    const reported = notifyReport(notified);
    mode.summary += reported.summary;
    mode.errors.push(...reported.errors);
    if (reported.errors.length > 0) mode.exitCode = EXIT_CODES.partial;
  }
  return mode;
}
