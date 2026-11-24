/**
 * Marker blocks in persisted targets (GitHub Release bodies, CHANGELOG.md).
 *
 * ```md
 * <!-- releaseray:begin v=1 key=v1.4.0 persona=engineer gen=3f1c9a07b2d4e815 out=9a07c3d1e6f2b408 -->
 *
 * …canonical Markdown for this persona…
 *
 * <!-- releaseray:end key=v1.4.0 persona=engineer -->
 * ```
 *
 * `gen` and `out` are computed elsewhere (CONVERSION-PLAN §9.2); this module
 * only reads and writes the comments and the text between them.
 */

/** Marker format version. */
export const MARKER_VERSION = 1;

/**
 * The `gen` that `mode: adopt` writes. It matches any generation digest, so
 * the next run leaves an adopted block alone until `force` (CONVERSION-PLAN §9.2).
 */
export const ADOPTED_GEN = "adopted";

export interface MarkerFields {
  /** Release key: the tag, or a date window's explicit key */
  key: string;
  persona: string;
  /** Generation digest, or `adopted` */
  gen: string;
  /** Digest of the block's inner text as written */
  out: string;
}

export interface MarkedBlock {
  fields: MarkerFields;
  /** Text between the begin and end comments, without the surrounding blank lines */
  inner: string;
  /** Offset of the begin comment */
  start: number;
  /** Offset just past the end comment */
  end: number;
}

const VALUE = /^[^\s<>]+$/;

/**
 * Whether a value can appear in a marker comment without breaking it.
 *
 * @param value - A key, persona or digest
 * @returns False for an empty value or one with spaces, `<`, `>` or `--`
 */
export function isMarkerValue(value: string): boolean {
  return VALUE.test(value) && !value.includes("--");
}

function checkValue(name: string, value: string): void {
  if (!isMarkerValue(value)) {
    throw new Error(`Marker ${name} must be non-empty, without spaces, <, > or "--": ${value}`);
  }
}

/**
 * Writes the begin comment.
 *
 * @param fields - Marker fields
 * @returns The comment line
 * @throws Error when a value could break the comment
 */
export function writeBeginMarker(fields: MarkerFields): string {
  for (const name of ["key", "persona", "gen", "out"] as const) checkValue(name, fields[name]);
  return `<!-- releaseray:begin v=${MARKER_VERSION} key=${fields.key} persona=${fields.persona} gen=${fields.gen} out=${fields.out} -->`;
}

/**
 * Writes the end comment.
 *
 * @param fields - The block's key and persona
 * @returns The comment line
 */
export function writeEndMarker(fields: Pick<MarkerFields, "key" | "persona">): string {
  checkValue("key", fields.key);
  checkValue("persona", fields.persona);
  return `<!-- releaseray:end key=${fields.key} persona=${fields.persona} -->`;
}

const BEGIN = /<!-- releaseray:begin v=(\d+) key=(\S+) persona=(\S+) gen=(\S+) out=(\S+) -->/g;
const END = /<!-- releaseray:end key=(\S+) persona=(\S+) -->/g;

export type MarkerLine =
  | { type: "begin"; version: number; fields: MarkerFields }
  | { type: "end"; key: string; persona: string };

/**
 * Parses one line holding a begin or end comment.
 *
 * @param line - A line of text
 * @returns The parsed marker, or null when the line is not exactly one marker
 */
export function parseMarkerLine(line: string): MarkerLine | null {
  const trimmed = line.trim();
  const begin = new RegExp(`^${BEGIN.source}$`).exec(trimmed);
  if (begin) {
    return {
      type: "begin",
      version: Number(begin[1]),
      fields: { key: begin[2], persona: begin[3], gen: begin[4], out: begin[5] },
    };
  }
  const end = new RegExp(`^${END.source}$`).exec(trimmed);
  if (end) return { type: "end", key: end[1], persona: end[2] };
  return null;
}

/**
 * Wraps text in begin and end comments, separated by blank lines.
 *
 * @param fields - Marker fields
 * @param inner - The block's text
 * @returns The marked block
 */
export function writeMarkedBlock(fields: MarkerFields, inner: string): string {
  return `${writeBeginMarker(fields)}\n\n${inner}\n\n${writeEndMarker(fields)}`;
}

/**
 * Finds every complete marked block. A begin without a matching end (same
 * key and persona) is ignored, so a human who deletes the end comment gets
 * an unmarked text rather than a block that swallows the rest of the file.
 *
 * @param text - Release body or CHANGELOG text
 * @returns Blocks in order of appearance
 */
export function findMarkedBlocks(text: string): MarkedBlock[] {
  const blocks: MarkedBlock[] = [];
  for (const begin of text.matchAll(BEGIN)) {
    const fields: MarkerFields = { key: begin[2], persona: begin[3], gen: begin[4], out: begin[5] };
    const from = (begin.index ?? 0) + begin[0].length;
    const endText = writeEndMarker(fields);
    const endAt = text.indexOf(endText, from);
    if (endAt === -1) continue;
    const nextBegin = text.slice(from, endAt).search(/<!-- releaseray:begin /);
    if (nextBegin !== -1) continue;
    blocks.push({
      fields,
      inner: text.slice(from, endAt).replace(/^\n+/, "").replace(/\n+$/, ""),
      start: begin.index ?? 0,
      end: endAt + endText.length,
    });
  }
  return blocks;
}
