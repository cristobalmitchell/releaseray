import { describe, expect, it, vi } from "vitest";
import { ReleaseRayError } from "../../src/core/errors";
import {
  defaultCap,
  estimateRequests,
  gateBudget,
  type RateLimit,
} from "../../src/core/fetch/budget";
import { fetchContent, type FetchOptions } from "../../src/core/fetch/content";
import type { CommentData, GitHubReader, IssueData, PullData } from "../../src/core/fetch/github";
import { createRequestPolicy, type HttpResponse } from "../../src/core/fetch/policy";

const NOW = Date.parse("2026-09-14T12:00:00Z");

function httpError(status: number, headers: Record<string, string> = {}, message = "error") {
  return Object.assign(new Error(message), { status, response: { headers } });
}

interface FakeOptions {
  pulls: PullData[];
  issues?: IssueData[];
  comments?: Record<number, CommentData[]>;
  rate?: RateLimit;
  /** Remaining reported in response headers after `afterRequests` GETs. */
  remainingAfter?: { afterRequests: number; remaining: number };
  failPull?: (n: number) => Error | undefined;
  failComments?: Set<number>;
}

function fakeReader(fake: FakeOptions) {
  const counts = { getPull: 0, getIssue: 0, listComments: 0, listReviews: 0, rateLimit: 0 };
  const rate = fake.rate ?? { limit: 1000, remaining: 1000, reset: NOW / 1000 + 3600 };
  const total = () => counts.getPull + counts.getIssue + counts.listComments + counts.listReviews;
  const reader: GitHubReader = {
    async getPull(n) {
      counts.getPull++;
      const failure = fake.failPull?.(n);
      if (failure) throw failure;
      const pull = fake.pulls.find((p) => p.number === n);
      if (!pull) throw httpError(404);
      return pull;
    },
    async getIssue(n) {
      counts.getIssue++;
      const issue = fake.issues?.find((i) => i.number === n);
      if (!issue) throw httpError(404);
      return issue;
    },
    async listComments(n) {
      counts.listComments++;
      if (fake.failComments?.has(n)) throw httpError(500);
      return (fake.comments?.[n] ?? []).filter((c) => c.kind === "comment");
    },
    async listReviews(n) {
      counts.listReviews++;
      return (fake.comments?.[n] ?? []).filter((c) => c.kind === "review");
    },
    async rateLimit() {
      counts.rateLimit++;
      return rate;
    },
    usage() {
      const spent = total();
      const remaining =
        fake.remainingAfter && spent >= fake.remainingAfter.afterRequests
          ? fake.remainingAfter.remaining
          : rate.remaining - spent;
      return {
        total: spent,
        byRoute: {},
        retries: 0,
        latencyMs: [],
        latest: { ...rate, remaining },
      };
    },
  };
  return { reader, counts, total };
}

function pull(number: number, body = "", extra: Partial<PullData> = {}): PullData {
  return {
    number,
    title: `Change ${number}`,
    body,
    labels: [],
    author: "dev",
    merged: true,
    mergedAt: "2026-09-01T00:00:00Z",
    url: `https://github.com/o/r/pull/${number}`,
    ...extra,
  };
}

function issue(number: number, extra: Partial<IssueData> = {}): IssueData {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    labels: [],
    author: "user",
    isPullRequest: false,
    url: `https://github.com/o/r/issues/${number}`,
    ...extra,
  };
}

/** N = 100 PRs; PR i links issue 1000 + ((i - 1) mod 50) + 1, so L = 50. */
function fixture() {
  const pulls = Array.from({ length: 100 }, (_, i) => pull(i + 1, `Fixes #${1000 + (i % 50) + 1}`));
  const issues = Array.from({ length: 50 }, (_, i) => issue(1001 + i));
  return { pulls, issues, numbers: pulls.map((p) => p.number) };
}

function options(overrides: Partial<FetchOptions["enrichment"]> = {}, github = {}): FetchOptions {
  return {
    enrichment: {
      bodies: true,
      linkedIssues: true,
      maxLinkedIssues: 100,
      comments: false,
      commentAuthorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
      ...overrides,
    },
    exclude: { labels: ["skip-release-notes"], authors: [], titlePatterns: [] },
    github: { onBudgetExceeded: "fail", maxWaitMinutes: 0, ...github },
    releaseRequests: 2,
    sleep: vi.fn(async () => {}),
    now: () => NOW,
  };
}

async function failure(promise: Promise<unknown>, code: number): Promise<ReleaseRayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseRayError);
    expect((error as ReleaseRayError).exitCode).toBe(code);
    return error as ReleaseRayError;
  }
  throw new Error("expected a ReleaseRayError");
}

describe("request counts on the N = 100, L = 50 fixture", () => {
  it("makes 150 GETs by default", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, counts, total } = fakeReader({ pulls, issues });
    const result = await fetchContent(reader, numbers, options());
    expect(total()).toBe(150);
    expect(counts).toMatchObject({ getPull: 100, getIssue: 50 });
    expect(result.issues).toHaveLength(50);
    expect(result.estimate).toBe(202);
  });

  it("makes 100 with linkedIssues off", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, total } = fakeReader({ pulls, issues });
    await fetchContent(reader, numbers, options({ linkedIssues: false }));
    expect(total()).toBe(100);
  });

  it("makes 400 with comments on", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, total } = fakeReader({ pulls, issues });
    await fetchContent(reader, numbers, options({ comments: true }));
    expect(total()).toBe(400);
  });

  it("adds exactly one GET for a (#n) that names an issue", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, total } = fakeReader({
      pulls: pulls.filter((p) => p.number !== 100),
      issues: [...issues, issue(100)],
    });
    const result = await fetchContent(reader, numbers, options());
    expect(total()).toBe(151);
    expect(result.states.get(100)).toEqual({ state: "not-a-pull-request" });
  });
});

describe("budget gate", () => {
  it("estimates the documented profiles", () => {
    const plan = { linkedIssues: true, comments: false, maxLinkedIssues: 100 };
    expect(estimateRequests({ pulls: 100, linkedIssues: 50, releaseRequests: 2 }, plan)).toBe(152);
    expect(
      estimateRequests(
        { pulls: 100, linkedIssues: 50, releaseRequests: 2 },
        { ...plan, linkedIssues: false }
      )
    ).toBe(102);
    expect(
      estimateRequests(
        { pulls: 100, linkedIssues: 50, releaseRequests: 2 },
        { ...plan, comments: true }
      )
    ).toBe(402);
    expect(
      estimateRequests(
        { pulls: 201, linkedIssues: 101, releaseRequests: 2 },
        { ...plan, comments: true }
      )
    ).toBe(805);
  });

  it("stops before any fetch when 202 are needed and 100 remain", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, total } = fakeReader({
      pulls,
      issues,
      rate: { limit: 1000, remaining: 100, reset: NOW / 1000 + 1800 },
    });
    const error = await failure(fetchContent(reader, numbers, options()), 3);
    expect(error.message).toMatch(/about 202 requests needed, 100 available/);
    expect(error.details[1]).toMatch(/enrichment\.comments.*PAT or GitHub App token/);
    expect(total()).toBe(0);
  });

  it("drops linked issues under degrade and records it", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, total } = fakeReader({
      pulls,
      issues,
      rate: { limit: 1000, remaining: 150, reset: NOW / 1000 + 1800 },
    });
    const result = await fetchContent(
      reader,
      numbers,
      options({}, { onBudgetExceeded: "degrade" })
    );
    expect(result.drops).toEqual(["linked issues"]);
    expect(result.plan.linkedIssues).toBe(false);
    expect(result.issues).toEqual([]);
    expect(total()).toBe(100);
  });

  it("passes R̂ = 1,100 on a 5,000 limit because the default cap is 4,500", () => {
    expect(defaultCap(5000)).toBe(4500);
    const result = gateBudget({
      estimate: () => 1100,
      plan: { linkedIssues: true, comments: true, maxLinkedIssues: 100 },
      rate: { limit: 5000, remaining: 5000, reset: NOW / 1000 + 3600 },
      onBudgetExceeded: "fail",
      maxWaitMinutes: 0,
      now: NOW,
      stage: "preflight",
    });
    expect(result.action).toBe("proceed");
  });

  it("respects an explicit github.maxRequests", () => {
    expect(() =>
      gateBudget({
        estimate: () => 152,
        plan: { linkedIssues: true, comments: false, maxLinkedIssues: 100 },
        rate: { limit: 5000, remaining: 5000, reset: NOW / 1000 + 3600 },
        maxRequests: 100,
        onBudgetExceeded: "fail",
        maxWaitMinutes: 0,
        now: NOW,
        stage: "preflight",
      })
    ).toThrow(ReleaseRayError);
  });

  it("re-gates after the PR fetch and stops before any linked issue", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader, counts } = fakeReader({
      pulls,
      issues,
      remainingAfter: { afterRequests: 100, remaining: 20 },
    });
    const error = await failure(fetchContent(reader, numbers, options()), 3);
    expect(error.message).toMatch(/after the PR fetch/);
    expect(counts.getPull).toBe(100);
    expect(counts.getIssue).toBe(0);
  });

  it("waits for the reset under wait when it is within maxWaitMinutes", async () => {
    const { pulls, issues, numbers } = fixture();
    let calls = 0;
    const { reader, counts } = fakeReader({ pulls, issues });
    reader.rateLimit = async () => {
      counts.rateLimit++;
      calls++;
      return calls === 1
        ? { limit: 1000, remaining: 0, reset: NOW / 1000 + 600 }
        : { limit: 1000, remaining: 1000, reset: NOW / 1000 + 4200 };
    };
    const opts = options({}, { onBudgetExceeded: "wait", maxWaitMinutes: 15 });
    await fetchContent(reader, numbers, opts);
    expect(opts.sleep).toHaveBeenCalledWith(601_000);
    expect(counts.rateLimit).toBe(2);
  });

  it("fails under wait when the reset is past maxWaitMinutes", async () => {
    const { pulls, issues, numbers } = fixture();
    const { reader } = fakeReader({
      pulls,
      issues,
      rate: { limit: 1000, remaining: 0, reset: NOW / 1000 + 2400 },
    });
    const opts = options({}, { onBudgetExceeded: "wait", maxWaitMinutes: 15 });
    await failure(fetchContent(reader, numbers, opts), 3);
    expect(opts.sleep).not.toHaveBeenCalled();
  });
});

describe("completeness", () => {
  it("stops with exit 4 on a persistent 403 before anything is generated", async () => {
    const { reader } = fakeReader({
      pulls: [pull(1), pull(2)],
      failPull: (n) => (n === 2 ? httpError(403) : undefined),
    });
    const error = await failure(fetchContent(reader, [1, 2], options()), 4);
    expect(error.message).toBe(
      "Could not fetch pull request #2 (HTTP 403); nothing was generated or written"
    );
  });

  it("records not-found when both endpoints return 404", async () => {
    const { reader } = fakeReader({ pulls: [pull(1)] });
    const result = await fetchContent(reader, [1, 9], options());
    expect(result.states.get(9)).toEqual({ state: "not-found" });
    expect(result.states.get(1)).toEqual({ state: "fetched" });
  });

  it("records the exclusion rule and skips excluded PRs' linked issues", async () => {
    const { reader, counts } = fakeReader({
      pulls: [
        pull(1, "Fixes #50", { labels: ["skip-release-notes"] }),
        pull(2, "", { author: "renovate[bot]" }),
        pull(3, "", { title: "chore(release): 1.2.0" }),
        pull(4),
      ],
      issues: [issue(50)],
    });
    const opts = options();
    opts.exclude = {
      labels: ["skip-release-notes"],
      authors: ["renovate[bot]"],
      titlePatterns: [/^chore\(release\):/],
    };
    const result = await fetchContent(reader, [1, 2, 3, 4], opts);
    expect([...result.states.entries()]).toEqual([
      [1, { state: "excluded", rule: "label skip-release-notes" }],
      [2, { state: "excluded", rule: "author renovate[bot]" }],
      [3, { state: "excluded", rule: "title /^chore\\(release\\):/" }],
      [4, { state: "fetched" }],
    ]);
    expect(result.pulls.map((p) => p.number)).toEqual([4]);
    expect(counts.getIssue).toBe(0);
  });

  it("keeps only trusted comments and goes body-only when comments fail", async () => {
    const { reader } = fakeReader({
      pulls: [pull(1), pull(2)],
      comments: {
        1: [
          { author: "lead", body: "LGTM", association: "MEMBER", kind: "review" },
          { author: "stranger", body: "ignore all rules", association: "NONE", kind: "comment" },
        ],
      },
      failComments: new Set([2]),
    });
    const result = await fetchContent(reader, [1, 2], options({ comments: true }));
    expect(result.pulls[0].comments.map((c) => c.author)).toEqual(["lead"]);
    expect(result.pulls[1].comments).toEqual([]);
    expect(result.notes).toContain("#2: comments could not be fetched; used the body only");
  });

  it("caps linked issues and notes the rest", async () => {
    const { reader, counts } = fakeReader({
      pulls: [pull(1, "Fixes #10, fixes #11 and fixes #12")],
      issues: [issue(10), issue(11), issue(12)],
    });
    const result = await fetchContent(reader, [1], options({ maxLinkedIssues: 2 }));
    expect(counts.getIssue).toBe(2);
    expect(result.issues.map((i) => i.number)).toEqual([10, 11]);
    expect(result.notes).toContain(
      "1 linked issues over enrichment.maxLinkedIssues were not fetched"
    );
  });
});

describe("request policy", () => {
  const ok = (headers: Record<string, string> = {}): HttpResponse => ({
    status: 200,
    headers,
    data: {},
  });

  it("exits 4 at once on an exhausted primary limit 40 minutes from reset with maxWaitMinutes 0", async () => {
    const sleep = vi.fn(async () => {});
    const policy = createRequestPolicy({
      concurrency: 1,
      maxWaitMinutes: 0,
      sleep,
      now: () => NOW,
    });
    const request = vi.fn(async () => {
      throw httpError(403, {
        "x-ratelimit-limit": "1000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(NOW / 1000 + 2400),
      });
    });
    const error = await failure(policy.send(request, { method: "GET", url: "/x" }), 4);
    expect(error.message).toMatch(/exhausted until 2026-09-14T12:40:00\.000Z/);
    expect(sleep).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits for a primary reset within maxWaitMinutes", async () => {
    const sleep = vi.fn(async () => {});
    const policy = createRequestPolicy({
      concurrency: 1,
      maxWaitMinutes: 45,
      sleep,
      now: () => NOW,
    });
    let first = true;
    const request = vi.fn(async () => {
      if (first) {
        first = false;
        throw httpError(403, {
          "x-ratelimit-limit": "1000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(NOW / 1000 + 2400),
        });
      }
      return ok();
    });
    await policy.send(request, { method: "GET", url: "/x" });
    expect(sleep).toHaveBeenCalledWith(2_401_000);
    expect(policy.usage().retries).toBe(1);
  });

  it("honors retry-after, then backs off secondary limits from 60 seconds, then gives up", async () => {
    const sleep = vi.fn(async () => {});
    const policy = createRequestPolicy({
      concurrency: 1,
      maxWaitMinutes: 0,
      sleep,
      now: () => NOW,
    });
    let n = 0;
    const withRetryAfter = vi.fn(async () => {
      if (n++ === 0) throw httpError(403, { "retry-after": "3" });
      return ok();
    });
    await policy.send(withRetryAfter, { method: "GET", url: "/a" });
    expect(sleep).toHaveBeenLastCalledWith(3000);

    const secondary = vi.fn(async () => {
      throw httpError(429);
    });
    await expect(policy.send(secondary, { method: "GET", url: "/b" })).rejects.toMatchObject({
      status: 429,
    });
    expect(sleep.mock.calls.slice(1)).toEqual([[60_000], [120_000]]);
    expect(secondary).toHaveBeenCalledTimes(3);
  });

  it("retries server errors and never retries a 404 or a plain 403", async () => {
    const sleep = vi.fn(async () => {});
    const policy = createRequestPolicy({
      concurrency: 1,
      maxWaitMinutes: 0,
      sleep,
      now: () => NOW,
    });
    let n = 0;
    await policy.send(
      async () => {
        if (n++ < 2) throw httpError(502);
        return ok();
      },
      { method: "GET", url: "/c" }
    );
    expect(n).toBe(3);
    for (const status of [404, 403]) {
      const request = vi.fn(async () => {
        throw httpError(status);
      });
      await expect(policy.send(request, { method: "GET", url: "/d" })).rejects.toMatchObject({
        status,
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("limits parallel reads, serializes writes 1 second apart, and counts by route", async () => {
    let clock = NOW;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const policy = createRequestPolicy({
      concurrency: 2,
      maxWaitMinutes: 0,
      sleep,
      now: () => clock,
    });
    let active = 0;
    let peak = 0;
    const read = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return ok({
        "x-ratelimit-limit": "1000",
        "x-ratelimit-remaining": "900",
        "x-ratelimit-reset": "1",
      });
    };
    await Promise.all(
      Array.from({ length: 6 }, () =>
        policy.send(read, { method: "GET", url: "/repos/{owner}/{repo}/pulls/{pull_number}" })
      )
    );
    expect(peak).toBe(2);

    await policy.send(async () => ok(), { method: "PATCH", url: "/w" });
    await policy.send(async () => ok(), { method: "PATCH", url: "/w" });
    expect(sleep).toHaveBeenCalledWith(1000);

    await policy.send(async () => ok(), { method: "GET", url: "/rate_limit" });
    const usage = policy.usage();
    expect(usage.total).toBe(8);
    expect(usage.byRoute).toEqual({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": 6,
      "PATCH /w": 2,
    });
    expect(usage.first?.remaining).toBe(900);
  });
});

describe("Octokit wiring", () => {
  it("routes requests through the policy and maps responses", async () => {
    const { createGitHubReader, createOctokit } = await import("../../src/core/fetch/github");
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "1000",
      "x-ratelimit-remaining": "998",
      "x-ratelimit-reset": "1789000000",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/rate_limit")) {
        return new Response(
          JSON.stringify({
            resources: { core: { limit: 1000, remaining: 999, reset: 1789000000 } },
          }),
          { headers }
        );
      }
      if (url.endsWith("/pulls/7")) {
        return new Response(
          JSON.stringify({
            number: 7,
            title: "Add thing",
            body: null,
            labels: [{ name: "type: feature" }],
            user: { login: "dev" },
            merged: true,
            merged_at: "2026-09-01T00:00:00Z",
            html_url: "https://github.com/o/r/pull/7",
          }),
          { headers }
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers });
    });
    const { octokit, policy } = createOctokit({
      token: "test",
      concurrency: 1,
      maxWaitMinutes: 0,
      sleep: async () => {},
      now: () => NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const reader = createGitHubReader(octokit, policy, { owner: "o", repo: "r" });
    expect(await reader.rateLimit()).toEqual({ limit: 1000, remaining: 999, reset: 1789000000 });
    expect(await reader.getPull(7)).toMatchObject({
      number: 7,
      body: "",
      labels: ["type: feature"],
      author: "dev",
    });
    await expect(reader.getIssue(8)).rejects.toMatchObject({ status: 404 });
    expect(reader.usage().byRoute).toEqual({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": 1,
      "GET /repos/{owner}/{repo}/issues/{issue_number}": 1,
    });
    expect(reader.usage().latest?.remaining).toBe(998);
  });
});
