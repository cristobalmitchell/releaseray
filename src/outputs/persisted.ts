/**
 * Applies the persisted-sink plans: the GitHub Release block, then the
 * CHANGELOG entry and its push (CONVERSION-PLAN §6.4 step 11). Used by
 * `generate` with publish on, and by `publish` from a `notes.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import type { SinkPlan } from "../core/state/planner";
import { applyChangelogEntry } from "./changelog-sink";
import { applyReleasePlan, type ReleaseApi, type ReleaseTarget } from "./github-release/sink";
import { GITHUB_ACTIONS_BOT, pushChangelog, type PushOptions } from "./push";

/** One persona's text and plans, from a run or a notes.json. */
export interface PersistedPersona {
  id: string;
  gen: string;
  text: string;
  plans: { githubRelease?: SinkPlan; changelog?: SinkPlan };
}

/** Settings from `outputs.githubRelease` and `outputs.changelog`. */
export interface PersistedSettings {
  githubRelease: {
    mode: "section" | "replace";
    nameTemplate: string;
    prerelease: "auto" | boolean;
  };
  changelog: {
    path: string;
    onHumanEdit: "skip" | "overwrite";
    push: boolean;
    branch?: string;
    commitMessage: string;
    author?: { name: string; email: string };
  };
}

/** What the publish layer needs from outside. */
export interface PersistedDeps {
  release: ReleaseApi | null;
  workspace: string;
  /** Present when the CHANGELOG may be pushed. */
  push?: Omit<
    PushOptions,
    "workspace" | "branch" | "path" | "message" | "key" | "author" | "apply"
  > & {
    /** The checked-out branch, or the repository's default branch when detached. */
    branch: string;
  };
}

/** What the publish layer did. */
export interface PersistedOutcome {
  releaseChanged: boolean;
  releaseUrl: string | null;
  changelogChanged: boolean;
  pushed: boolean;
  warnings: string[];
}

/**
 * Applies every persona's persisted plans.
 *
 * @param personas - Text and plans per persona
 * @param context - Key, entry date, release snapshot and workflow-file flag
 * @param settings - Output settings
 * @param deps - Release API, workspace and push credentials
 * @returns Whether each target changed
 * @throws ReleaseRayError: exit 3 or 6 from a sink, or 7 when one sink wrote before another failed
 */
export async function applyPersisted(
  personas: readonly PersistedPersona[],
  context: { key: string; date: string; release: ReleaseTarget | null; touchesWorkflows: boolean },
  settings: PersistedSettings,
  deps: PersistedDeps
): Promise<PersistedOutcome> {
  const outcome: PersistedOutcome = {
    releaseChanged: false,
    releaseUrl: context.release?.url ?? null,
    changelogChanged: false,
    pushed: false,
    warnings: [],
  };
  let release = context.release;
  const wrote = () => outcome.releaseChanged || outcome.changelogChanged;

  try {
    for (const p of personas) {
      const plan = p.plans.githubRelease;
      if (!plan || !deps.release) continue;
      const result = await applyReleasePlan(deps.release, {
        key: context.key,
        persona: p.id,
        gen: p.gen,
        text: p.text,
        plan,
        current: release,
        mode: settings.githubRelease.mode,
        nameTemplate: settings.githubRelease.nameTemplate,
        prerelease: settings.githubRelease.prerelease,
        touchesWorkflows: context.touchesWorkflows,
      });
      outcome.warnings.push(...result.warnings);
      if (result.changed) {
        outcome.releaseChanged = true;
        outcome.releaseUrl = result.url;
        release = result.target;
      }
    }

    for (const p of personas) {
      const plan = p.plans.changelog;
      if (!plan || (plan.action !== "create" && plan.action !== "update")) continue;
      const write = {
        key: context.key,
        persona: p.id,
        gen: p.gen,
        text: p.text,
        date: context.date,
        onHumanEdit: settings.changelog.onHumanEdit,
      };
      const file = resolve(deps.workspace, settings.changelog.path);
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      const applied = applyChangelogEntry(current, write);
      if (applied.warning) outcome.warnings.push(applied.warning);
      if (applied.content !== current) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, applied.content);
        outcome.changelogChanged = true;
      }
      if (settings.changelog.push && deps.push) {
        const pushed = pushChangelog({
          ...deps.push,
          workspace: deps.workspace,
          branch: settings.changelog.branch ?? deps.push.branch,
          path: settings.changelog.path,
          message: settings.changelog.commitMessage.replace(/\{\{\s*key\s*\}\}/g, context.key),
          key: context.key,
          author: settings.changelog.author ?? GITHUB_ACTIONS_BOT,
          apply: (text) => {
            const next = applyChangelogEntry(text, write);
            return next.action === "skipped-unmarked" ? null : next.content;
          },
        });
        outcome.pushed = pushed.pushed;
        if (pushed.pushed) outcome.changelogChanged = true;
      }
    }
  } catch (error) {
    if (error instanceof ReleaseRayError && wrote() && error.exitCode !== EXIT_CODES.push) {
      throw new ReleaseRayError(
        `Partial publish: ${error.message}`,
        EXIT_CODES.partial,
        error.details,
        {
          cause: error,
        }
      );
    }
    throw error;
  }
  return outcome;
}
