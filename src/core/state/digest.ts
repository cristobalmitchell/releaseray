/**
 * Digests that make re-runs idempotent (CONVERSION-PLAN §9.2).
 *
 * - `in`: sha256 over the canonical JSON of what the model reads.
 * - `gen`: 16 hex characters over `in` plus everything else that shapes one
 *   persona's text. A re-run with the same `gen` reuses stored text.
 * - `out`: 16 hex characters over a block's inner text as written. A block
 *   whose text no longer hashes to its `out` was edited by a person.
 */
import { createHash } from "node:crypto";
import { sanitizeCommentForLLM, sanitizeForLLM, sanitizeTitleForLLM } from "../sanitize/llm";

/** The Action's major version, part of every `gen`. */
export const ACTION_MAJOR = "1";

/**
 * JSON with object keys sorted at every level and `undefined` dropped, so
 * equal values always serialize to equal text.
 *
 * @param value - Any JSON-compatible value
 * @returns Canonical JSON text
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * sha256 of text, in hex.
 *
 * @param text - Input text
 * @returns 64 hex characters
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Comment fields that reach the digest. */
interface CommentLike {
  author: string | null;
  body: string;
  association: string;
  kind: string;
}

/** What the input digest covers. */
export interface InputSnapshotSource {
  range: { from: string | null; to: string; commits: ReadonlyArray<{ sha: string }> };
  pulls: ReadonlyArray<{
    number: number;
    title: string;
    body: string;
    labels: readonly string[];
    author: string | null;
    mergedAt: string | null;
    comments: readonly CommentLike[];
  }>;
  issues: ReadonlyArray<{
    number: number;
    title: string;
    body: string;
    labels: readonly string[];
    author: string | null;
    comments: readonly CommentLike[];
  }>;
  /** `enrichment.comments`; comments count only when it is on. */
  comments: boolean;
}

function comments(list: readonly CommentLike[]) {
  return list.map((c) => ({
    author: c.author,
    association: c.association,
    kind: c.kind,
    body: sanitizeCommentForLLM(c.body),
  }));
}

/**
 * The input digest: the range, the fetched items after exclusions (sanitized
 * text, sorted labels, author and merge time), linked issues, and comments
 * only when comment enrichment is on. Timestamps such as `updated_at` and
 * reactions are left out, so they never change it.
 *
 * @param source - Range and fetched content
 * @returns 64 hex characters
 */
export function inputDigest(source: InputSnapshotSource): string {
  const snapshot = {
    range: {
      from: source.range.from,
      to: source.range.to,
      commits: source.range.commits.map((c) => c.sha),
    },
    pulls: source.pulls.map((p) => ({
      number: p.number,
      kind: "pull",
      title: sanitizeTitleForLLM(p.title),
      body: sanitizeForLLM(p.body),
      labels: [...p.labels].sort(),
      author: p.author,
      mergedAt: p.mergedAt,
      comments: source.comments ? comments(p.comments) : undefined,
    })),
    issues: source.issues.map((i) => ({
      number: i.number,
      kind: "issue",
      title: sanitizeTitleForLLM(i.title),
      body: sanitizeForLLM(i.body),
      labels: [...i.labels].sort(),
      author: i.author,
      comments: source.comments ? comments(i.comments) : undefined,
    })),
  };
  return sha256(canonicalJson(snapshot));
}

/** What a persona's generation digest covers besides the input. */
export interface GenerationParts {
  input: string;
  /** The persona's resolved configuration. */
  persona: unknown;
  /** Digests of the system and persona templates in use. */
  templates: { system: string; persona: string };
  provider: string;
  model: string;
  maxCompletionTokens: number;
  render: unknown;
  actionMajor?: string;
}

/**
 * The generation digest for one persona.
 *
 * @param parts - Input digest, persona, templates, model settings and render options
 * @returns 16 hex characters
 */
export function generationDigest(parts: GenerationParts): string {
  return sha256(canonicalJson({ ...parts, actionMajor: parts.actionMajor ?? ACTION_MAJOR })).slice(
    0,
    16
  );
}

/**
 * The output digest of a block's inner text as written.
 *
 * @param inner - Text between the markers
 * @returns 16 hex characters
 */
export function outputDigest(inner: string): string {
  // The web editor saves CRLF; line endings alone are not an edit.
  return sha256(inner.replace(/\r\n/g, "\n")).slice(0, 16);
}
