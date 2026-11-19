/**
 * Request estimates and the budget gate (CONVERSION-PLAN §5.3, §5.8 item 1).
 * The gate runs before any fetch or LLM call, and again after the PR fetch
 * once the real number of linked issues is known.
 */
import { EXIT_CODES, ReleaseRayError } from "../errors";

/** Which enrichment the run fetches. */
export interface EnrichmentPlan {
  linkedIssues: boolean;
  comments: boolean;
  maxLinkedIssues: number;
}

/** Counts that drive an estimate. */
export interface EstimateCounts {
  /** Pull requests to fetch. */
  pulls: number;
  /** Linked issues to fetch, before the cap. Default: one per PR (L̂ = N). */
  linkedIssues?: number;
  /** `(#n)` references that 404 as PRs and need an issue lookup (F). */
  notPulls?: number;
  /** Release lookup and write: 2 for a publishing run, 1 for the hardened generate, 0 for previews. */
  releaseRequests: number;
}

/**
 * Upper estimate of REST requests counted against the primary limit.
 *
 * Default profile: N + F + min(L, cap) + release. Comments add one comment
 * list and one review list per PR and one comment list per linked issue.
 *
 * @param counts - N, L, F and release requests
 * @param plan - Enrichment
 * @returns The estimate R̂
 */
export function estimateRequests(counts: EstimateCounts, plan: EnrichmentPlan): number {
  const n = counts.pulls;
  const linked = plan.linkedIssues ? Math.min(counts.linkedIssues ?? n, plan.maxLinkedIssues) : 0;
  const comments = plan.comments ? 2 * n + linked : 0;
  return n + (counts.notPulls ?? 0) + linked + comments + counts.releaseRequests;
}

/** Rate-limit figures from `GET /rate_limit` or response headers. */
export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
}

/** Inputs to {@link gateBudget}. */
export interface GateInput {
  /** Estimate for a given plan; the gate calls it again after each drop. */
  estimate: (plan: EnrichmentPlan) => number;
  plan: EnrichmentPlan;
  rate: RateLimit;
  /** `github.maxRequests`; default 90% of the token's core limit. */
  maxRequests?: number;
  /** Requests already spent by this run, counted against the cap. */
  spent?: number;
  onBudgetExceeded: "fail" | "wait" | "degrade";
  maxWaitMinutes: number;
  /** Current time in milliseconds. */
  now: number;
  /** Which gate this is, for messages. */
  stage: "preflight" | "after the PR fetch";
}

/** What to do after the gate. */
export type GateResult =
  | {
      action: "proceed";
      plan: EnrichmentPlan;
      estimate: number;
      available: number;
      drops: string[];
    }
  | { action: "wait"; untilMs: number; estimate: number; available: number };

/**
 * The default request cap: 90% of the token's core limit.
 *
 * @param limit - `resources.core.limit`
 * @returns The cap
 */
export function defaultCap(limit: number): number {
  return Math.floor(limit * 0.9);
}

/**
 * Compares the estimate with the budget and applies `onBudgetExceeded`.
 *
 * @param input - Estimate, plan, rate limit and policy
 * @returns Proceed (possibly with a reduced plan) or wait until the reset
 * @throws ReleaseRayError (exit 3) when the budget does not fit and the policy cannot make it fit
 */
export function gateBudget(input: GateInput): GateResult {
  const cap = (input.maxRequests ?? defaultCap(input.rate.limit)) - (input.spent ?? 0);
  const available = Math.max(0, Math.min(cap, input.rate.remaining));
  let plan = { ...input.plan };
  let estimate = input.estimate(plan);
  if (estimate <= available) return { action: "proceed", plan, estimate, available, drops: [] };

  const resetMs = input.rate.reset * 1000;
  const resetWithinWait = resetMs - input.now <= input.maxWaitMinutes * 60_000;
  // Waiting helps only when the reset frees enough budget; the cap does not reset.
  if (input.onBudgetExceeded === "wait" && resetWithinWait && estimate <= cap) {
    return { action: "wait", untilMs: resetMs + 1000, estimate, available };
  }

  const drops: string[] = [];
  if (input.onBudgetExceeded === "degrade") {
    if (plan.comments) {
      plan = { ...plan, comments: false };
      drops.push("comments");
      estimate = input.estimate(plan);
    }
    if (estimate > available && plan.linkedIssues) {
      plan = { ...plan, linkedIssues: false };
      drops.push("linked issues");
      estimate = input.estimate(plan);
    }
    if (estimate <= available) return { action: "proceed", plan, estimate, available, drops };
  }

  throw new ReleaseRayError(
    `The GitHub request budget does not fit (${input.stage}): about ${estimate} requests needed, ${available} available`,
    EXIT_CODES.budget,
    [
      `Remaining ${input.rate.remaining} of ${input.rate.limit}; the limit resets at ${new Date(resetMs).toISOString()}`,
      "Turn off enrichment.comments, lower enrichment.maxLinkedIssues, raise github.maxRequests, or pass a PAT or GitHub App token",
    ]
  );
}
