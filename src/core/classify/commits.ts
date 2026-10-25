/**
 * Commit fallback: classify a range from commit messages when it has no PRs.
 *
 * Lifted from the private helpers `classifyCommits` and
 * `extractLabelsFromCommit` in apps/workers/src/processors/single-draft.ts
 * (:753, :782) at 7d1d56f8, now exported. The classifier options pass through.
 */
import { createLogger } from "../logger";
import type { GroupedChanges } from "../types";
import {
  enhancedClassifyChanges,
  enhancedFallbackClassification,
  type ClassifierOptions,
} from "./rules";

const logger = createLogger("classify-commits");

export interface CommitInput {
  sha: string;
  message: string;
  subject: string;
  author: string;
}

/**
 * Classify commits into categories
 * Uses sanitized in-memory commit data
 *
 * @param commits - Commits in the range
 * @param options - Classifier options (label rules, categories)
 * @returns Grouped changes; the fallback classifier is used if the rules classifier throws
 */
export async function classifyCommits(
  commits: CommitInput[],
  options?: ClassifierOptions
): Promise<GroupedChanges> {
  const commitItems = commits.map((commit) => {
    const lines = commit.message.split("\n");
    const title = lines[0] || commit.subject;
    const body = lines.slice(1).join("\n").trim();

    return {
      number: 0,
      title: title.substring(0, 140),
      body: body.substring(0, 200) || title,
      labels: extractLabelsFromCommit(commit.message),
      linkedIssueIds: [] as number[],
      author: commit.author,
    };
  });

  try {
    return await enhancedClassifyChanges(commitItems, [], options);
  } catch (error) {
    logger.warn("Commit classification failed, using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return enhancedFallbackClassification(commitItems, options);
  }
}

/**
 * Extract pseudo-labels from commit message
 *
 * @param message - Full commit message
 * @returns Labels derived from the conventional-commit type and keywords
 */
export function extractLabelsFromCommit(message: string): string[] {
  const labels: string[] = [];
  const lowerMessage = message.toLowerCase();

  const conventionalMatch = message.match(/^(\w+)(?:\([\w-]+\))?:/);
  if (conventionalMatch && conventionalMatch[1]) {
    const type = conventionalMatch[1].toLowerCase();
    const typeToLabel: Record<string, string> = {
      feat: "feature",
      fix: "bug",
      docs: "documentation",
      perf: "performance",
      chore: "maintenance",
    };
    if (typeToLabel[type]) {
      labels.push(typeToLabel[type]);
    }
  }

  if (/BREAKING CHANGE:|!:/.test(message)) labels.push("breaking");
  if (/\b(security|vulnerability)\b/i.test(message)) labels.push("security");
  if (/\b(performance|optimize)\b/i.test(lowerMessage)) labels.push("performance");

  if (labels.length === 0) {
    labels.push("other");
  }

  return labels;
}
