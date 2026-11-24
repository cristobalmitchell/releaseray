/**
 * Per-sink planning for the persisted outputs, the GitHub Release and
 * CHANGELOG (CONVERSION-PLAN §9.3). Pure: it reads the target's current text
 * and decides, per persona, whether to write and where the text comes from.
 */
import { shiftHeadings } from "../render/markdown";
import { outputDigest } from "./digest";
import { findMarkedBlocks, type MarkedBlock } from "./marker";

/** What a sink will do for one persona. */
export type SinkAction = "noop" | "create" | "update" | "skip" | "skip-human";

/** A sink's plan. */
export interface SinkPlan {
  action: SinkAction;
  /** True when the plan writes and so needs the persona's text. */
  needsText: boolean;
  /** The existing block for this key and persona, if any. */
  block?: MarkedBlock;
  /** Shown as a notice. */
  notice?: string;
  /** Shown as a warning. */
  warning?: string;
}

/** The current state of one persisted target. */
export interface PlanTarget {
  sink: "github-release" | "changelog";
  /** Whether the release exists. A CHANGELOG always exists for planning; a missing file is empty. */
  exists: boolean;
  /** Release body or CHANGELOG content. */
  text: string;
  /** `section` appends a block; `replace` (release only) replaces the body. */
  mode: "section" | "replace";
  onHumanEdit: "skip" | "overwrite";
  /** Release only. */
  createIfMissing: boolean;
}

/** What is being planned. */
export interface PlanRequest {
  key: string;
  persona: string;
  /** The new generation digest. */
  gen: string;
  force: boolean;
}

/**
 * Whether a block was edited by a person: its inner text no longer hashes
 * to the `out` written with it.
 *
 * @param block - A marked block
 * @returns True when edited
 */
export function isHumanEdited(block: MarkedBlock): boolean {
  return outputDigest(block.inner) !== block.fields.out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether CHANGELOG text holds an unmarked `## [<key>]` entry.
 *
 * @param text - CHANGELOG content
 * @param key - Release key
 * @returns True when an entry for the key exists outside any block
 */
export function hasUnmarkedEntry(text: string, key: string): boolean {
  const blocks = findMarkedBlocks(text);
  const heading = new RegExp(`^## \\[${escapeRegExp(key)}\\]`, "gm");
  for (const match of text.matchAll(heading)) {
    const at = match.index ?? 0;
    if (!blocks.some((b) => at >= b.start && at < b.end)) return true;
  }
  return false;
}

/**
 * Plans one persisted sink for one persona.
 *
 * @param target - The sink's current text and settings
 * @param request - Key, persona, new `gen` and `force`
 * @returns The plan
 */
export function planSink(target: PlanTarget, request: PlanRequest): SinkPlan {
  const write = (action: "create" | "update", extra: Partial<SinkPlan> = {}): SinkPlan => ({
    action,
    needsText: true,
    ...extra,
  });

  if (target.sink === "github-release" && !target.exists) {
    return target.createIfMissing
      ? write("create")
      : {
          action: "skip",
          needsText: false,
          notice: `No GitHub Release for ${request.key}; set outputs.githubRelease.createIfMissing: true to create one`,
        };
  }

  const blocks = findMarkedBlocks(target.text);
  const block = blocks.find(
    (b) => b.fields.key === request.key && b.fields.persona === request.persona
  );

  if (!block) {
    if (target.sink === "changelog" && hasUnmarkedEntry(target.text, request.key)) {
      return target.onHumanEdit === "overwrite"
        ? write("update")
        : {
            action: "skip-human",
            needsText: false,
            warning: `CHANGELOG already has an unmarked entry for ${request.key}; left as is (onHumanEdit: skip)`,
          };
    }
    if (target.sink === "github-release" && target.mode === "replace") return write("update");
    const unmarked = target.text.trim().length > 0 && blocks.length === 0;
    return write(
      "create",
      unmarked && target.sink === "github-release"
        ? {
            warning: `The release body for ${request.key} has text without ReleaseRay markers; the notes are appended below it. Run mode: adopt (v1.1) to take it over`,
          }
        : {}
    );
  }

  const edited = isHumanEdited(block);
  const matches = block.fields.gen === request.gen || block.fields.gen === "adopted";

  if (edited && target.onHumanEdit === "skip" && (request.force || !matches)) {
    return {
      action: "skip-human",
      needsText: false,
      block,
      warning: `The ${request.persona} block for ${request.key} in ${target.sink === "changelog" ? "CHANGELOG" : "the GitHub Release"} was edited by hand; left as is (onHumanEdit: skip)`,
    };
  }
  if (request.force) return write("update", { block });
  if (matches) return { action: "noop", needsText: false, block };
  return write("update", { block });
}

/** Text found in a persisted block, in release form (headings at level 2). */
export interface StoredText {
  text: string;
  from: "github-release" | "changelog";
}

/**
 * Finds stored text for a persona whose `gen` equals the new one, in either
 * target. CHANGELOG blocks are shifted up one heading level to release form.
 *
 * @param targets - Current text of each persisted target
 * @param request - Key, persona and new `gen`
 * @returns The text, or null when nothing matches or `force` is set
 */
export function findStoredText(
  targets: ReadonlyArray<Pick<PlanTarget, "sink" | "text">>,
  request: PlanRequest
): StoredText | null {
  if (request.force) return null;
  for (const target of targets) {
    const block = findMarkedBlocks(target.text).find(
      (b) =>
        b.fields.key === request.key &&
        b.fields.persona === request.persona &&
        b.fields.gen === request.gen &&
        !isHumanEdited(b)
    );
    if (!block) continue;
    // A CHANGELOG block starts with its "## [key] - date" heading, which the release form lacks.
    const text =
      target.sink === "changelog"
        ? shiftHeadings(block.inner.replace(/^## \[[^\]]*\][^\n]*\n+/, ""), -1)
        : block.inner;
    return { text, from: target.sink };
  }
  return null;
}

/**
 * Whether a persona routed only to the summary, files or notifications is
 * generated in this run (CONVERSION-PLAN §9.3).
 *
 * @param state - Whether any persisted sink is enabled, whether the primary
 *   target changes, `force`, and whether one of its notifications posts on
 *   every publishing run (`when: always`)
 * @returns True when it should be generated
 */
export function generatesUnpersisted(state: {
  persistedEnabled: boolean;
  primaryChanged: boolean;
  force: boolean;
  notifyAlways?: boolean;
}): boolean {
  return (
    !state.persistedEnabled || state.primaryChanged || state.force || Boolean(state.notifyAlways)
  );
}
