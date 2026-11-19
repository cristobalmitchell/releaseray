/**
 * The CHANGELOG sink (CONVERSION-PLAN §7.3): a marked `## [<key>] - <date>`
 * entry holding the persona's text with headings one level down, placed in
 * SemVer order below any `## [Unreleased]` section.
 */
import { shiftHeadings } from "../core/render/markdown";
import { outputDigest } from "../core/state/digest";
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
