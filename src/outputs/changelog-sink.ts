/**
 * The CHANGELOG sink (CONVERSION-PLAN §7.3): a marked `## [<key>] - <date>`
 * entry holding the persona's text with headings one level down, placed in
 * SemVer order below any `## [Unreleased]` section.
 */
import { shiftHeadings } from "../core/render/markdown";
import { outputDigest } from "../core/state/digest";
import { findMarkedBlocks } from "../core/state/marker";
import { isHumanEdited } from "../core/state/planner";
import { formatAsChangelog, upsertChangelogEntry, type UpsertResult } from "./changelog";

/** Header for a CHANGELOG created from nothing. */
export const NEW_CHANGELOG_HEADER =
  "# Changelog\n\nAll notable changes to this project are documented in this file.\n";

/** One persona's CHANGELOG write. */
export interface ChangelogWrite {
  key: string;
  persona: string;
  gen: string;
  /** Canonical text in release form. */
  text: string;
  /** Tag commit's committer date, YYYY-MM-DD. */
  date: string;
  onHumanEdit: "skip" | "overwrite";
}

/**
 * The CHANGELOG entry's inner text as the marked block holds it.
 *
 * @param write - Key, date and text
 * @returns The heading and the shifted body
 */
export function changelogInner(write: Pick<ChangelogWrite, "key" | "date" | "text">): string {
  return formatAsChangelog({
    version: write.key,
    date: write.date,
    content: shiftHeadings(write.text, 1),
  }).replace(/\n+$/, "");
}

/**
 * Applies one entry to CHANGELOG text.
 *
 * @param current - Current CHANGELOG content, or "" when the file is missing
 * @param write - The entry
 * @returns The new content and what was done
 */
export function applyChangelogEntry(current: string, write: ChangelogWrite): UpsertResult {
  const base = current.trim() ? current : NEW_CHANGELOG_HEADER;
  const inner = changelogInner(write);
  return upsertChangelogEntry(
    base,
    { version: write.key, date: write.date, content: shiftHeadings(write.text, 1) },
    { key: write.key, persona: write.persona, gen: write.gen, out: outputDigest(inner) },
    { onHumanEdit: write.onHumanEdit }
  );
}

/** What {@link syncChangelogEntry} did. */
export type SyncEntryAction = "created" | "updated" | "unchanged" | "skipped-human";

/**
 * Mirrors one release block into CHANGELOG text for `mode: sync-changelog`
 * (CONVERSION-PLAN §9.5). An entry ReleaseRay wrote is brought in line with
 * the release; one a person edited, or an unmarked entry for the same
 * version, is replaced only with `onHumanEdit: overwrite`.
 *
 * @param current - Current CHANGELOG content, or "" when the file is missing
 * @param write - The release block's key, persona, `gen` and text, and the entry date
 * @returns The new content, what was done, and a warning when an entry was left alone
 */
export function syncChangelogEntry(
  current: string,
  write: ChangelogWrite
): { content: string; action: SyncEntryAction; warning?: string } {
  const sameKey = findMarkedBlocks(current).filter((b) => b.fields.key === write.key);
  const block = sameKey.find((b) => b.fields.persona === write.persona);
  if (!block && sameKey.length > 0) {
    return {
      content: current,
      action: "skipped-human",
      warning: `CHANGELOG has a ${sameKey[0].fields.persona} entry for ${write.key}, not ${write.persona}; it was left unchanged`,
    };
  }
  if (block) {
    const edited = isHumanEdited(block);
    if (!edited && block.fields.gen === write.gen && block.inner === changelogInner(write)) {
      return { content: current, action: "unchanged" };
    }
    if (edited && write.onHumanEdit === "skip") {
      return {
        content: current,
        action: "skipped-human",
        warning: `The CHANGELOG entry for ${write.key} was edited by hand; left as is (onHumanEdit: skip)`,
      };
    }
  }
  const applied = applyChangelogEntry(current, write);
  if (applied.action === "skipped-unmarked") {
    return { content: current, action: "skipped-human", warning: applied.warning };
  }
  if (applied.content === current) return { content: current, action: "unchanged" };
  return { content: applied.content, action: applied.action === "created" ? "created" : "updated" };
}
