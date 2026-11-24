/**
 * CHANGELOG.md formatting
 * Writes release notes into CHANGELOG.md text
 * Follows Keep a Changelog format: https://keepachangelog.com/
 *
 * Lifted from apps/app/src/lib/publishers/changelog.ts at 7d1d56f8 (the pure
 * functions). Changes (CONVERSION-PLAN §7.3):
 * - entries are inserted by splicing text, so everything outside the new or
 *   replaced entry stays byte for byte;
 * - entries are ordered by SemVer, newest first, below an existing
 *   `[Unreleased]` section (the hosted code put new entries above it);
 * - an entry the Action wrote carries marker comments and is replaced by
 *   version; an unmarked entry for the same version is human text, left
 *   unchanged with a warning.
 *
 * `publishToChangelog` and the branch-protection probe were not lifted; the
 * push loop replaces them in Phase 3.
 */
import { createLogger } from "../core/logger";
import { outputDigest } from "../core/state/digest";
import {
  ADOPTED_GEN,
  parseMarkerLine,
  writeMarkedBlock,
  type MarkerFields,
} from "../core/state/marker";
import { compareSemver, parseSemver } from "../core/util/semver";

const logger = createLogger("changelog-publisher");

export interface ChangelogEntry {
  version: string;
  date: string;
  content: string;
  compareUrl?: string;
}

/**
 * Format a release note draft into Keep a Changelog format
 *
 * Converts a single release entry into the standardized Keep a Changelog format.
 * Each entry includes version, date, content, and optional compare URL.
 *
 * @param entry - Release entry to format
 * @returns Formatted changelog entry string
 *
 * @example
 * ```
 * ## [1.2.0] - 2024-01-15
 *
 * ### Added
 * - New feature X
 * - New feature Y
 *
 * [1.2.0]: https://github.com/user/repo/compare/v1.1.0...v1.2.0
 * ```
 */
export function formatAsChangelog(entry: ChangelogEntry): string {
  let changelog = `## [${entry.version}] - ${entry.date}\n\n`;

  // Add the content (already formatted from draft)
  changelog += entry.content;

  // Add compare link at the end if available
  if (entry.compareUrl) {
    changelog += `\n\n[${entry.version}]: ${entry.compareUrl}\n`;
  }

  return changelog;
}

const VERSION_HEADING = /^##\s+\[([^\]]+)\](?:\s+-\s+(.+))?/;

/**
 * Parse existing CHANGELOG.md to extract entries and structure
 *
 * Parses a Keep a Changelog formatted file into structured data.
 * Preserves header, all version entries, and footer (comparison links).
 * Marker comments are not part of any entry's content.
 *
 * @param content - Raw CHANGELOG.md content
 * @returns Parsed structure with header, entries array, and footer
 */
export function parseChangelog(content: string): {
  header: string;
  entries: ChangelogEntry[];
  footer: string;
} {
  const lines = content.split("\n");
  const entries: ChangelogEntry[] = [];
  let header = "";
  const footer = "";
  let currentEntry: Partial<ChangelogEntry> | null = null;
  let inHeader = true;
  let entryContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // Skip undefined lines
    if (parseMarkerLine(line)) continue;

    // Check for version header (## [version] - date or ## [Unreleased])
    const versionMatch = line.match(VERSION_HEADING);

    if (versionMatch) {
      inHeader = false;

      // Save previous entry if exists
      if (currentEntry) {
        entries.push({
          version: currentEntry.version!,
          date: currentEntry.date!,
          content: entryContent.join("\n").trim(),
          compareUrl: currentEntry.compareUrl,
        });
        entryContent = [];
      }

      // Start new entry; an entry without a date keeps an empty one
      currentEntry = {
        version: versionMatch[1],
        date: versionMatch[2] || "",
      };
    } else if (inHeader) {
      // Accumulate header lines
      header += line + "\n";
    } else if (currentEntry) {
      // Accumulate entry content
      const linkMatch = line?.match(/^\[([^\]]+)\]:\s+(.+)/);
      if (linkMatch && linkMatch[1] === currentEntry.version) {
        currentEntry.compareUrl = linkMatch[2] || "";
      } else {
        entryContent.push(line || "");
      }
    }
  }

  // Save last entry
  if (currentEntry) {
    entries.push({
      version: currentEntry.version!,
      date: currentEntry.date!,
      content: entryContent.join("\n").trim(),
      compareUrl: currentEntry.compareUrl,
    });
  }

  return {
    header: header.trim(),
    entries,
    footer,
  };
}

/** One entry's place in the file, by line. */
interface EntrySpan {
  version: string;
  /** First line: the begin marker when present, otherwise the heading */
  start: number;
  /** Line after the entry */
  end: number;
  marker: MarkerFields | null;
}

/**
 * Finds each entry's line range. A begin marker on the last non-blank line
 * before a heading belongs to that heading's entry.
 */
function findEntrySpans(lines: string[]): EntrySpan[] {
  const spans: EntrySpan[] = [];
  let pendingMarker: { line: number; fields: MarkerFields } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = parseMarkerLine(lines[i]);
    if (marker?.type === "begin") {
      pendingMarker = { line: i, fields: marker.fields };
      continue;
    }
    const heading = VERSION_HEADING.exec(lines[i]);
    if (heading) {
      const start = pendingMarker ? pendingMarker.line : i;
      if (spans.length > 0) spans[spans.length - 1].end = start;
      spans.push({
        version: heading[1],
        start,
        end: lines.length,
        marker: pendingMarker?.fields ?? null,
      });
      pendingMarker = null;
    } else if (lines[i].trim() !== "") {
      pendingMarker = null;
    }
  }
  return spans;
}

function isUnreleased(version: string): boolean {
  return version.toLowerCase() === "unreleased";
}

/**
 * Line where a new entry goes: below `[Unreleased]`, above the first entry
 * with a lower SemVer version. A key that is not SemVer, such as a date
 * window's key, goes above the newest SemVer entry.
 */
function insertionLine(spans: EntrySpan[], version: string, lineCount: number): number {
  const newVersion = parseSemver(version);
  for (const span of spans) {
    if (isUnreleased(span.version)) continue;
    if (!newVersion) return span.start;
    const existing = parseSemver(span.version);
    if (existing && compareSemver(existing, newVersion) < 0) return span.start;
  }
  if (spans.length === 0) return lineCount;
  // After the last entry, but above a trailing block of link references.
  return spans[spans.length - 1].end;
}

function trailingLinkStart(lines: string[], from: number): number {
  let i = lines.length;
  while (i > from && (lines[i - 1].trim() === "" || /^\[[^\]]+\]:\s/.test(lines[i - 1]))) i--;
  while (i < lines.length && lines[i].trim() === "") i++;
  return i;
}

/** Splices a block into the text at a line, keeping one blank line around it. */
function spliceAt(lines: string[], at: number, block: string, removeUntil = at): string {
  const before = lines.slice(0, at).join("\n").replace(/\n*$/, "");
  const after = lines.slice(removeUntil).join("\n").replace(/^\n*/, "").replace(/\n*$/, "");
  const parts = [before, block.replace(/\n*$/, ""), after].filter((p) => p.length > 0);
  return parts.join("\n\n") + "\n";
}

/**
 * Add a new entry to CHANGELOG.md
 *
 * Entries stay in SemVer order, newest first, below an `[Unreleased]`
 * section. An entry with the same version is left alone (idempotent).
 *
 * @param existingContent - Current CHANGELOG.md content
 * @param newEntry - New release entry
 * @returns Updated changelog, or the unchanged input when the version exists
 *
 * @see https://keepachangelog.com/en/1.0.0/ - Official Keep a Changelog standard
 */
export function prependToChangelog(existingContent: string, newEntry: ChangelogEntry): string {
  const lines = existingContent.split("\n");
  const spans = findEntrySpans(lines);

  // Check if entry already exists (idempotent)
  if (spans.some((s) => s.version === newEntry.version)) {
    logger.warn("Changelog entry already exists, skipping", { version: newEntry.version });
    return existingContent;
  }

  let at = insertionLine(spans, newEntry.version, lines.length);
  if (spans.length > 0 && at === spans[spans.length - 1].end) {
    at = trailingLinkStart(lines, spans[spans.length - 1].start + 1);
  }
  return spliceAt(lines, at, formatAsChangelog(newEntry));
}

export type UpsertAction = "created" | "replaced" | "skipped-unmarked";

export interface UpsertResult {
  content: string;
  action: UpsertAction;
  warning?: string;
}

/**
 * Write a marked entry: replace the marked entry for the same version and
 * persona, or insert a new one in SemVer order. An unmarked entry for the
 * same version is human text: it is kept unless `onHumanEdit` is
 * `overwrite`.
 *
 * @param existingContent - Current CHANGELOG.md content
 * @param entry - The entry to write
 * @param marker - Marker fields; `marker.key` should equal `entry.version`
 * @param options - `onHumanEdit`: `skip` (default) or `overwrite`
 * @returns The new content and what was done
 */
export function upsertChangelogEntry(
  existingContent: string,
  entry: ChangelogEntry,
  marker: MarkerFields,
  options: { onHumanEdit?: "skip" | "overwrite" } = {}
): UpsertResult {
  const block = writeMarkedBlock(marker, formatAsChangelog(entry).replace(/\n+$/, ""));
  const lines = existingContent.split("\n");
  const spans = findEntrySpans(lines);
  const same = spans.find((s) => s.version === entry.version);

  if (same && !same.marker && options.onHumanEdit !== "overwrite") {
    const warning = `CHANGELOG.md already has an entry for ${entry.version} that ReleaseRay did not write; it was left unchanged. Run mode: adopt to let ReleaseRay manage it.`;
    logger.warn(warning, { version: entry.version });
    return { content: existingContent, action: "skipped-unmarked", warning };
  }
  if (same) {
    return { content: spliceAt(lines, same.start, block, same.end), action: "replaced" };
  }

  let at = insertionLine(spans, entry.version, lines.length);
  if (spans.length > 0 && at === spans[spans.length - 1].end) {
    at = trailingLinkStart(lines, spans[spans.length - 1].start + 1);
  }
  return { content: spliceAt(lines, at, block), action: "created" };
}

/** What {@link adoptChangelogEntry} did. */
export type AdoptEntryAction = "adopted" | "marked" | "missing";

/**
 * Wrap an unmarked `## [<key>]` entry in markers with `gen=adopted` and the
 * `out` of its text, so the next run treats it as current (CONVERSION-PLAN
 * §9.5). The entry's text is kept; a trailing block of link references at
 * the end of the file stays outside the markers.
 *
 * @param existingContent - Current CHANGELOG.md content
 * @param key - Release key, the entry's version
 * @param persona - The CHANGELOG persona
 * @returns The new content, and `adopted`, `marked` (already has markers) or `missing` (no entry)
 */
export function adoptChangelogEntry(
  existingContent: string,
  key: string,
  persona: string
): { content: string; action: AdoptEntryAction } {
  const lines = existingContent.split("\n");
  const spans = findEntrySpans(lines);
  const span = spans.find((s) => s.version === key);
  if (!span) return { content: existingContent, action: "missing" };
  if (span.marker) return { content: existingContent, action: "marked" };
  const end =
    span === spans[spans.length - 1] ? trailingLinkStart(lines, span.start + 1) : span.end;
  const inner = lines.slice(span.start, end).join("\n").replace(/\s+$/, "");
  const block = writeMarkedBlock(
    { key, persona, gen: ADOPTED_GEN, out: outputDigest(inner) },
    inner
  );
  return { content: spliceAt(lines, span.start, block, end), action: "adopted" };
}

/**
 * Create a default CHANGELOG.md if one doesn't exist
 *
 * Generates a new CHANGELOG.md with proper header following Keep a Changelog standard.
 * Used when publishing the first release to a repository without an existing changelog.
 *
 * @param firstEntry - The first release entry to include
 * @returns Complete CHANGELOG.md content with header and first entry
 */
export function createDefaultChangelog(firstEntry: ChangelogEntry): string {
  return `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

${formatAsChangelog(firstEntry)}
`;
}
