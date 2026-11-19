import type { GitHubReader, IssueData, PullData } from "../../src/core/fetch/github";

/**
 * A GitHub reader over recorded data, counting requests like the real one.
 *
 * @param data - Recorded pulls and issues
 * @returns The reader and its request count
 */
export function recordedGitHub(data: { pulls: PullData[]; issues: IssueData[] }) {
  let total = 0;
  const byRoute: Record<string, number> = {};
  const count = (route: string) => {
    total++;
    byRoute[route] = (byRoute[route] ?? 0) + 1;
  };
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const reader: GitHubReader = {
    async getPull(n) {
      count("GET /repos/{owner}/{repo}/pulls/{pull_number}");
      const pull = data.pulls.find((p) => p.number === n);
      if (!pull) throw notFound();
      return pull;
    },
    async getIssue(n) {
      count("GET /repos/{owner}/{repo}/issues/{issue_number}");
      const issue = data.issues.find((i) => i.number === n);
      if (!issue) throw notFound();
      return issue;
    },
    async listComments() {
      count("GET /repos/{owner}/{repo}/issues/{issue_number}/comments");
      return [];
    },
    async listReviews() {
      count("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
      return [];
    },
    async rateLimit() {
      return { limit: 1000, remaining: 1000, reset: 1789000000 };
    },
    usage: () => ({ total, byRoute: { ...byRoute }, retries: 0, latencyMs: [] }),
  };
  return { reader, requests: () => total };
}
