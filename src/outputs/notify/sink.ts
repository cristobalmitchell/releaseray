/**
 * The notify sink (CONVERSION-PLAN §6.4 step 11, §7.4): the last sink of a
 * publishing run. Each `outputs.notify` entry posts its persona's text when
 * the primary persisted target (the GitHub Release, else the CHANGELOG)
 * changed in this run, or when its `when` (or the `notify` input) is
 * `always`. A re-run that changes nothing therefore sends nothing.
 *
 * Credentials arrive as values keyed by the environment variable each entry
 * names; the Action entry layer reads and masks them. Messages never include
 * them.
 */
import type { Config } from "../../config/schema";
import { EXIT_CODES, ReleaseRayError } from "../../core/errors";
import { publishToIntercom } from "./intercom";
import { publishToSlack } from "./slack";
import { publishToTeams } from "./teams";

/** One `outputs.notify` entry. */
export type NotifyEntry = Config["outputs"]["notify"][number];

/** When an entry posts. */
export type NotifyWhen = NotifyEntry["when"];

/** What a run knows when it reaches the notify sink. */
export interface NotifyContext {
  /** Release key, such as `v1.2.0`. */
  key: string;
  /** `owner/repo`. */
  repoFullName: string;
  /** Whether the primary persisted target changed in this run. */
  primaryChanged: boolean;
  /** The `notify` input; when set, it replaces every entry's `when`. */
  override: NotifyWhen | null;
  /** The GitHub Release, when there is one. */
  releaseUrl?: string;
  /** The compare view for the range, when it has a start. */
  compareUrl?: string;
}

/** A persona's published text; absent when it was not generated in this run. */
export interface NotifyPersona {
  id: string;
  text?: string | null;
}

/** One entry's outcome. */
export interface NotifyResult {
  type: NotifyEntry["type"];
  persona: string;
  status: "sent" | "skipped" | "failed";
  detail: string;
}

/** What the sink did. */
export interface NotifyOutcome {
  results: NotifyResult[];
  sent: number;
  failed: number;
}

/** Credential values by environment variable name. */
export type NotifySecrets = Readonly<Record<string, string | undefined>>;

/**
 * The environment variable that holds an entry's webhook URL or access token.
 *
 * @param entry - The entry
 * @returns The variable name
 */
export function credentialEnv(entry: NotifyEntry): string {
  return entry.type === "intercom" ? entry.apiKeyEnv : entry.webhookUrlEnv;
}

/**
 * Renders an Intercom title from its template.
 *
 * @param template - `titleTemplate`, where `{{key}}` is the release key
 * @param key - Release key
 * @returns The article title
 */
export function renderTitle(template: string, key: string): string {
  return template.replace(/\{\{\s*key\s*\}\}/g, key);
}

/**
 * Whether an entry posts in this run.
 *
 * @param entry - The entry
 * @param context - Whether the primary target changed, and the `notify` input
 * @returns True when it should post
 */
export function shouldNotify(
  entry: Pick<NotifyEntry, "when">,
  context: Pick<NotifyContext, "primaryChanged" | "override">
): boolean {
  return (context.override ?? entry.when) === "always" || context.primaryChanged;
}

/**
 * Names the credentials that the given entries need and the environment lacks.
 *
 * @param entries - The entries that may post in this run
 * @param secrets - Values by variable name
 * @returns Missing variable names, de-duplicated, in entry order
 */
export function missingCredentials(
  entries: readonly NotifyEntry[],
  secrets: NotifySecrets
): string[] {
  return [...new Set(entries.map(credentialEnv).filter((name) => !secrets[name]))];
}

async function post(
  entry: NotifyEntry,
  persona: string,
  text: string,
  secret: string,
  context: NotifyContext
): Promise<{ success: boolean; error?: string; url?: string }> {
  switch (entry.type) {
    case "slack":
      return publishToSlack({
        webhookUrl: secret,
        version: context.key,
        repoFullName: context.repoFullName,
        content: text,
        persona,
        urls: context.releaseUrl ? { github: context.releaseUrl } : {},
      });
    case "teams":
      return publishToTeams({
        webhookUrl: secret,
        title: `Release ${context.key}`,
        body: text,
        version: context.key,
        repoName: context.repoFullName,
        ...(context.releaseUrl ? { releaseUrl: context.releaseUrl } : {}),
        ...(context.compareUrl ? { compareUrl: context.compareUrl } : {}),
      });
    case "intercom":
      return publishToIntercom({
        apiKey: secret,
        collectionId: entry.collectionId,
        title: renderTitle(entry.titleTemplate, context.key),
        body: text,
        version: context.key,
        repoFullName: context.repoFullName,
        state: entry.state,
      });
  }
}

/**
 * Applies every notify entry, in order. One failure does not stop the rest.
 *
 * @param entries - `outputs.notify`
 * @param personas - Text per persona from this run
 * @param context - Key, repository, links, primary-target change and `notify` input
 * @param secrets - Credential values by environment variable name
 * @returns Per-entry results and counts
 */
export async function applyNotify(
  entries: readonly NotifyEntry[],
  personas: readonly NotifyPersona[],
  context: NotifyContext,
  secrets: NotifySecrets
): Promise<NotifyOutcome> {
  const results: NotifyResult[] = [];
  for (const entry of entries) {
    const base = { type: entry.type, persona: entry.persona };
    if (!shouldNotify(entry, context)) {
      results.push({ ...base, status: "skipped", detail: "the primary target did not change" });
      continue;
    }
    const persona = personas.find((p) => p.id === entry.persona);
    if (!persona) {
      results.push({ ...base, status: "skipped", detail: "persona not in this run" });
      continue;
    }
    if (!persona.text) {
      results.push({ ...base, status: "skipped", detail: "no text for this persona in this run" });
      continue;
    }
    const name = credentialEnv(entry);
    const secret = secrets[name];
    if (!secret) {
      results.push({ ...base, status: "failed", detail: `${name} is not set` });
      continue;
    }
    const outcome = await post(entry, entry.persona, persona.text, secret, context);
    results.push(
      outcome.success
        ? { ...base, status: "sent", detail: outcome.url ?? "sent" }
        : { ...base, status: "failed", detail: outcome.error ?? "unknown error" }
    );
  }
  return {
    results,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

const LABEL = { slack: "Slack", teams: "Teams", intercom: "Intercom" } as const;

/**
 * Summary lines for the outcome.
 *
 * @param outcome - What {@link applyNotify} returned
 * @returns Markdown list items, one per entry
 */
export function notifyLines(outcome: NotifyOutcome): string[] {
  return outcome.results.map(
    (r) =>
      `- ${LABEL[r.type]} (${r.persona}): ${r.status}${r.status === "sent" ? "" : `, ${r.detail}`}`
  );
}

/**
 * Error lines for failed entries.
 *
 * @param outcome - What {@link applyNotify} returned
 * @returns One line per failure
 */
export function notifyErrors(outcome: NotifyOutcome): string[] {
  return outcome.results
    .filter((r) => r.status === "failed")
    .map((r) => `Notification to ${LABEL[r.type]} (${r.persona}) failed: ${r.detail}`);
}

/**
 * Fails before any write when a publishing run's notify entries name an
 * environment variable that is not set.
 *
 * @param entries - `outputs.notify`
 * @param personas - The personas in this run, or null for all
 * @param secrets - Credential values by environment variable name
 * @throws ReleaseRayError (exit 2) naming each missing variable
 */
export function assertNotifyCredentials(
  entries: readonly NotifyEntry[],
  personas: readonly string[] | null,
  secrets: NotifySecrets
): void {
  const relevant = entries.filter((e) => !personas || personas.includes(e.persona));
  const missing = missingCredentials(relevant, secrets);
  if (missing.length === 0) return;
  throw new ReleaseRayError(
    "A notification credential is not set; nothing was written",
    EXIT_CODES.invalid,
    missing.map(
      (name) =>
        `${name} is not set: pass the secret to this step as env (${name}: \${{ secrets.${name} }})`
    )
  );
}

/**
 * What a mode reports for the notify sink: a summary section, and one error
 * per failed entry. Modes end such a run with exit 7 (partial publish).
 *
 * @param outcome - What {@link applyNotify} returned
 * @returns Summary Markdown (empty when there were no entries) and errors
 */
export function notifyReport(outcome: NotifyOutcome): { summary: string; errors: string[] } {
  if (outcome.results.length === 0) return { summary: "", errors: [] };
  return {
    summary: ["", "## Notifications", "", ...notifyLines(outcome), ""].join("\n"),
    errors: notifyErrors(outcome),
  };
}
