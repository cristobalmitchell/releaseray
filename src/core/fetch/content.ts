/**
 * Fetches PR and linked-issue content once per release, within the request
 * budget, and records what happened to every PR number (CONVERSION-PLAN §5.8).
 *
 * Order: preflight gate, PRs (and their comments when enabled), re-gate with
 * the real linked-issue count, linked issues (and their comments).
 */
import { extractLinkedIssues } from "../classify/linked-issues";
import { EXIT_CODES, ReleaseRayError } from "../errors";
import { compileLabel } from "../util/regex";
import { estimateRequests, gateBudget, type EnrichmentPlan, type GateResult } from "./budget";
import type { CommentData, GitHubReader, IssueData, PullData } from "./github";
import { isHttpError } from "./policy";

/** What happened to a PR number from the range. */
export type CompletenessState =
  | { state: "fetched" }
  | { state: "excluded"; rule: string }
  | { state: "not-a-pull-request" }
  | { state: "not-found" };

/** A PR kept for the notes. */
export interface FetchedPull extends PullData {
  comments: CommentData[];
  /** Issue numbers its body links to. */
  linkedIssues: number[];
}

/** A linked issue kept for the notes. */
export interface FetchedIssue extends IssueData {
  comments: CommentData[];
}

/** Options from `enrichment`, `classification.exclude` and `github`. */
export interface FetchOptions {
  enrichment: {
    bodies: boolean;
    linkedIssues: boolean;
    maxLinkedIssues: number;
    comments: boolean;
    commentAuthorAssociations: readonly string[];
  };
  exclude: { labels: readonly string[]; authors: readonly string[]; titlePatterns: RegExp[] };
  github: {
    maxRequests?: number;
    onBudgetExceeded: "fail" | "wait" | "degrade";
    maxWaitMinutes: number;
  };
  /** Release lookup and write still to come: 2, 1 or 0. */
  releaseRequests: number;
  sleep: (ms: number) => Promise<void>;
  /** Current time in milliseconds. */
  now: () => number;
}

/** Everything the fetch phase produced. */
export interface FetchResult {
  pulls: FetchedPull[];
  issues: FetchedIssue[];
  /** One entry per PR number from the range. */
  states: Map<number, CompletenessState>;
  /** The enrichment actually used after any degrade. */
  plan: EnrichmentPlan;
  /** Enrichment dropped to fit the budget, in order. */
  drops: string[];
  /** Things worth listing in the summary that did not stop the run. */
  notes: string[];
  /** The preflight estimate R̂. */
  estimate: number;
}

/** Waits longer than this make the PRs already read stale enough to re-read. */
const REFETCH_AFTER_WAIT_MS = 60_000;

function incomplete(what: string, error: unknown): ReleaseRayError {
  const status = isHttpError(error) ? ` (HTTP ${error.status})` : "";
  return new ReleaseRayError(
    `Could not fetch ${what}${status}; nothing was generated or written`,
    EXIT_CODES.incomplete,
    ["Check the token's permissions (contents: read, pull-requests: read) and re-run"],
    { cause: error }
  );
}

function is404(error: unknown): boolean {
  return isHttpError(error) && error.status === 404;
}

function exclusionRule(pull: PullData, options: FetchOptions): string | null {
  for (const label of options.exclude.labels) {
    const pattern = compileLabel(label);
    const hit = pull.labels.find((l) => pattern.test(l));
    if (hit) return `label ${hit}`;
  }
  if (pull.author && options.exclude.authors.includes(pull.author)) return `author ${pull.author}`;
  const title = options.exclude.titlePatterns.find((p) => p.test(pull.title));
  if (title) return `title /${title.source}/`;
  return null;
}

async function runGate(
  gate: () => GateResult,
  options: FetchOptions,
  onWaited: (ms: number) => Promise<void>
): Promise<Extract<GateResult, { action: "proceed" }>> {
  for (let waits = 0; ; waits++) {
    const result = gate();
    if (result.action === "proceed") return result;
    if (waits > 0) {
      throw new ReleaseRayError(
        "The GitHub request budget still does not fit after waiting for the reset",
        EXIT_CODES.budget,
        []
      );
    }
    const ms = Math.max(0, result.untilMs - options.now());
    await options.sleep(ms);
    await onWaited(ms);
  }
}

async function fetchComments(
  reader: GitHubReader,
  number: number,
  isPull: boolean,
  allowed: readonly string[],
  notes: string[]
): Promise<CommentData[]> {
  try {
    const lists = await Promise.all([
      reader.listComments(number),
      ...(isPull ? [reader.listReviews(number)] : []),
    ]);
    return lists.flat().filter((c) => allowed.includes(c.association));
  } catch {
    // Comments are optional: keep the item body-only and say so.
    notes.push(`#${number}: comments could not be fetched; used the body only`);
    return [];
  }
}

/**
 * Fetches the content for a range's PR numbers.
 *
 * @param reader - GitHub reads over the run's throttled client
 * @param prNumbers - PR numbers from the range, ascending
 * @param options - Enrichment, exclusions, budget policy and clock
 * @returns PRs, linked issues, completeness states and budget decisions
 * @throws ReleaseRayError exit 3 when the budget does not fit, exit 4 when a
 *   read fails after retries; in both cases before any generation
 */
export async function fetchContent(
  reader: GitHubReader,
  prNumbers: readonly number[],
  options: FetchOptions
): Promise<FetchResult> {
  const notes: string[] = [];
  const drops: string[] = [];
  const states = new Map<number, CompletenessState>();
  const issueCache = new Map<number, IssueData>();
  const startSpent = reader.usage().total;

  // 1. Preflight: estimate with F = 0 and L̂ = N, against GET /rate_limit.
  let plan: EnrichmentPlan = {
    linkedIssues: options.enrichment.linkedIssues,
    comments: options.enrichment.comments,
    maxLinkedIssues: options.enrichment.maxLinkedIssues,
  };
  let rate = await reader.rateLimit();
  const preflight = await runGate(
    () =>
      gateBudget({
        estimate: (p) =>
          estimateRequests(
            { pulls: prNumbers.length, releaseRequests: options.releaseRequests },
            p
          ),
        plan,
        rate,
        maxRequests: options.github.maxRequests,
        onBudgetExceeded: options.github.onBudgetExceeded,
        maxWaitMinutes: options.github.maxWaitMinutes,
        now: options.now(),
        stage: "preflight",
      }),
    options,
    async () => {
      rate = await reader.rateLimit();
    }
  );
  plan = preflight.plan;
  drops.push(...preflight.drops);

  // 2. Pull requests, each once.
  async function fetchPulls(): Promise<PullData[]> {
    const pulls: PullData[] = [];
    await Promise.all(
      prNumbers.map(async (number) => {
        try {
          pulls.push(await reader.getPull(number));
          return;
        } catch (error) {
          if (!is404(error)) throw incomplete(`pull request #${number}`, error);
        }
        // A `(#n)` can name an issue; one lookup tells the two apart (F).
        try {
          const issue = await reader.getIssue(number);
          issueCache.set(number, issue);
          states.set(number, { state: "not-a-pull-request" });
        } catch (error) {
          if (!is404(error)) throw incomplete(`#${number}`, error);
          states.set(number, { state: "not-found" });
        }
      })
    );
    return pulls.sort((a, b) => a.number - b.number);
  }
  let rawPulls = await fetchPulls();

  // 3. Re-gate with the real number of linked issues, before fetching any.
  const kept: Array<{ pull: PullData; linked: number[] }> = [];
  const prSet = new Set(prNumbers);
  function selectPulls() {
    kept.length = 0;
    for (const pull of rawPulls) {
      const rule = exclusionRule(pull, options);
      if (rule) states.set(pull.number, { state: "excluded", rule });
      else {
        states.set(pull.number, { state: "fetched" });
        kept.push({ pull, linked: extractLinkedIssues(pull.body).filter((n) => !prSet.has(n)) });
      }
    }
  }
  selectPulls();

  function linkedToFetch(currentPlan: EnrichmentPlan): { fetch: number[]; dropped: number } {
    if (!currentPlan.linkedIssues) return { fetch: [], dropped: 0 };
    const all = [...new Set(kept.flatMap((k) => k.linked))].sort((a, b) => a - b);
    const capped = all.slice(0, currentPlan.maxLinkedIssues);
    return { fetch: capped.filter((n) => !issueCache.has(n)), dropped: all.length - capped.length };
  }

  const regate = await runGate(
    () => {
      const usage = reader.usage();
      const latest = usage.latest ?? rate;
      return gateBudget({
        estimate: (p) => {
          const linked = linkedToFetch(p).fetch.length;
          const pullComments = p.comments ? 2 * kept.length : 0;
          return linked + (p.comments ? linked : 0) + pullComments + options.releaseRequests;
        },
        // PR comments are fetched after this gate, so the re-gate can still drop them.
        plan,
        rate: latest,
        maxRequests: options.github.maxRequests,
        spent: usage.total - startSpent,
        onBudgetExceeded: options.github.onBudgetExceeded,
        maxWaitMinutes: options.github.maxWaitMinutes,
        now: options.now(),
        stage: "after the PR fetch",
      });
    },
    options,
    async (waited) => {
      rate = await reader.rateLimit();
      if (waited > REFETCH_AFTER_WAIT_MS) {
        // Data read before a long wait can be hours old (RC B.1.6).
        rawPulls = await fetchPulls();
        selectPulls();
        notes.push("Re-read the pull requests after waiting for the rate-limit reset");
      }
    }
  );
  plan = regate.plan;
  drops.push(...regate.drops.filter((d) => !drops.includes(d)));

  // 4. PR comments, then linked issues and their comments.
  const pulls: FetchedPull[] = [];
  for (const { pull, linked } of kept) {
    const comments = plan.comments
      ? await fetchComments(
          reader,
          pull.number,
          true,
          options.enrichment.commentAuthorAssociations,
          notes
        )
      : [];
    pulls.push({
      ...pull,
      body: options.enrichment.bodies ? pull.body : "",
      comments,
      linkedIssues: plan.linkedIssues ? linked : [],
    });
  }

  const { fetch, dropped } = linkedToFetch(plan);
  if (dropped > 0) {
    notes.push(`${dropped} linked issues over enrichment.maxLinkedIssues were not fetched`);
  }
  await Promise.all(
    fetch.map(async (number) => {
      try {
        issueCache.set(number, await reader.getIssue(number));
      } catch (error) {
        if (!is404(error)) throw incomplete(`linked issue #${number}`, error);
        notes.push(`Linked issue #${number} was not found`);
      }
    })
  );

  const issues: FetchedIssue[] = [];
  if (plan.linkedIssues) {
    const wanted = new Set(kept.flatMap((k) => k.linked));
    for (const number of [...issueCache.keys()].sort((a, b) => a - b)) {
      const issue = issueCache.get(number)!;
      if (!wanted.has(number)) continue;
      if (issue.isPullRequest) {
        notes.push(`#${number} is a pull request outside the range; not used as a linked issue`);
        continue;
      }
      const comments = plan.comments
        ? await fetchComments(
            reader,
            number,
            false,
            options.enrichment.commentAuthorAssociations,
            notes
          )
        : [];
      issues.push({ ...issue, body: options.enrichment.bodies ? issue.body : "", comments });
    }
  }

  return { pulls, issues, states, plan, drops, notes, estimate: preflight.estimate };
}
