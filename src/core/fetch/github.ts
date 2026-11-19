/**
 * The GitHub reads the fetch phase needs, over one throttled Octokit
 * (CONVERSION-PLAN §5.1). Tests replace {@link GitHubReader} with a fake.
 */
import { Octokit } from "@octokit/rest";
import type { RateLimit } from "./budget";
import {
  createRequestPolicy,
  type PolicyOptions,
  type RequestPolicy,
  type UsageSnapshot,
} from "./policy";

/** A pull request as the pipeline uses it. */
export interface PullData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string | null;
  merged: boolean;
  mergedAt: string | null;
  url: string;
}

/** An issue as the pipeline uses it. */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string | null;
  /** True when the number belongs to a pull request. */
  isPullRequest: boolean;
  url: string;
}

/** A comment or review body with its author's association. */
export interface CommentData {
  author: string | null;
  body: string;
  /** `author_association`, such as OWNER, MEMBER, COLLABORATOR or NONE. */
  association: string;
  kind: "comment" | "review";
}

/** Reads used by the fetch phase. Errors carry an HTTP `status`. */
export interface GitHubReader {
  getPull(number: number): Promise<PullData>;
  getIssue(number: number): Promise<IssueData>;
  /** Conversation comments on an issue or pull request. */
  listComments(number: number): Promise<CommentData[]>;
  /** Review bodies on a pull request. */
  listReviews(number: number): Promise<CommentData[]>;
  /** `GET /rate_limit`, core resource. */
  rateLimit(): Promise<RateLimit>;
  /** Requests made so far. */
  usage(): UsageSnapshot;
}

/** Repository coordinates. */
export interface RepoRef {
  owner: string;
  repo: string;
}

type Label = string | { name?: string | null };

function labelNames(labels: Label[] | undefined): string[] {
  return (labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((name) => name.length > 0);
}

/** Options for {@link createOctokit}. */
export interface OctokitOptions extends PolicyOptions {
  token: string;
  /** REST base URL, such as `https://api.github.com` or a GHES `/api/v3` URL. */
  baseUrl?: string;
  userAgent?: string;
  /** Replaces the global fetch, for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Creates the one Octokit a run uses, with every request passing through the
 * request policy.
 *
 * @param options - Token, base URL and policy settings
 * @returns The client and its policy
 */
export function createOctokit(options: OctokitOptions): {
  octokit: Octokit;
  policy: RequestPolicy;
} {
  const policy = createRequestPolicy(options);
  const octokit = new Octokit({
    auth: options.token,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    userAgent: options.userAgent ?? "releaseray-action",
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });
  octokit.hook.wrap(
    "request",
    (request, requestOptions) =>
      policy.send(
        request as unknown as Parameters<RequestPolicy["send"]>[0],
        requestOptions as unknown as Parameters<RequestPolicy["send"]>[1]
      ) as unknown as ReturnType<typeof request>
  );
  return { octokit, policy };
}

/**
 * The fetch-phase reads over an Octokit created by {@link createOctokit}.
 *
 * @param octokit - Client whose requests pass through `policy`
 * @param policy - The client's request policy, for usage
 * @param repo - Repository coordinates
 * @returns The reader
 */
export function createGitHubReader(
  octokit: Octokit,
  policy: RequestPolicy,
  repo: RepoRef
): GitHubReader {
  return {
    async getPull(number) {
      const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: number });
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        labels: labelNames(data.labels),
        author: data.user?.login ?? null,
        merged: data.merged,
        mergedAt: data.merged_at,
        url: data.html_url,
      };
    },
    async getIssue(number) {
      const { data } = await octokit.rest.issues.get({ ...repo, issue_number: number });
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        labels: labelNames(data.labels as Label[]),
        author: data.user?.login ?? null,
        isPullRequest: data.pull_request !== undefined && data.pull_request !== null,
        url: data.html_url,
      };
    },
    async listComments(number) {
      const data = await octokit.paginate(octokit.rest.issues.listComments, {
        ...repo,
        issue_number: number,
        per_page: 100,
      });
      return data.map((c) => ({
        author: c.user?.login ?? null,
        body: c.body ?? "",
        association: c.author_association,
        kind: "comment" as const,
      }));
    },
    async listReviews(number) {
      const data = await octokit.paginate(octokit.rest.pulls.listReviews, {
        ...repo,
        pull_number: number,
        per_page: 100,
      });
      return data
        .filter((r) => (r.body ?? "").trim().length > 0)
        .map((r) => ({
          author: r.user?.login ?? null,
          body: r.body ?? "",
          association: r.author_association,
          kind: "review" as const,
        }));
    },
    async rateLimit() {
      const { data } = await octokit.rest.rateLimit.get();
      return {
        limit: data.resources.core.limit,
        remaining: data.resources.core.remaining,
        reset: data.resources.core.reset,
      };
    },
    usage: () => policy.usage(),
  };
}
