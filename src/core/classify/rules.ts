/**
 * @fileoverview Enhanced privacy-friendly classification logic
 * Uses only PR metadata (titles, descriptions, labels, commits, comments) - no code diffs
 *
 * Lifted from packages/shared/src/utils/enhanced-classification.ts at
 * 7d1d56f8. Categories and the label map are data (CONVERSION-PLAN PD-14):
 * callers pass label rules and the resolved category list, and `Internal` is
 * a real category. Two scoring fixes: a reviewer comment counts as much as a
 * keyword match (0.4), and a security mention in a linked issue's comments
 * triggers the security priority override, as one in a PR comment does.
 */

import { detectPatterns, parsePRStructure, extractStructureSignals } from "./patterns";
import { sanitizeCommentForLLM } from "../sanitize/llm";
import { BUILTIN_CATEGORIES, type ClassifiedItem, type GroupedChanges } from "../types";

/**
 * Comment data for enriched classification
 */
export interface PRCommentInput {
  body: string;
  author: string;
  commentType: string; // "issue_comment" | "review_comment" | "review_body"
  reviewState?: string | null; // "APPROVED" | "CHANGES_REQUESTED" | etc.
}

/**
 * Issue comment data for enriched classification
 */
export interface IssueCommentInput {
  body: string;
  author: string;
}

/** One label rule: a label matching `pattern` puts the PR in `category`. */
export interface LabelRule {
  pattern: RegExp;
  category: string;
}

/** The hosted product's label map, in priority order. */
export const DEFAULT_LABEL_RULES: LabelRule[] = [
  { pattern: /^type:\s*feature$/i, category: "Features" },
  { pattern: /^type:\s*enhancement$/i, category: "Improvements" },
  { pattern: /^type:\s*(bug|fix)$/i, category: "Fixes" },
  { pattern: /^type:\s*performance$/i, category: "Performance" },
  { pattern: /^type:\s*security$/i, category: "Security" },
  { pattern: /^type:\s*docs?$/i, category: "Docs" },
  { pattern: /^type:\s*(refactor|test|chore)$/i, category: "Internal" },
  { pattern: /^breaking/i, category: "Breaking Changes" },
  { pattern: /^deprecation$/i, category: "Deprecations" },
  { pattern: /feature/i, category: "Features" },
  { pattern: /(bug|fix)/i, category: "Fixes" },
  { pattern: /performance/i, category: "Performance" },
  { pattern: /security/i, category: "Security" },
  { pattern: /doc(s|umentation)?/i, category: "Docs" },
];

/** Classifier configuration; every field defaults to the built-ins. */
export interface ClassifierOptions {
  /** Label rules, checked in order before nothing else. */
  labelRules?: LabelRule[];
  /** Categories a PR may land in. A rule or pattern outside the list falls back. */
  categories?: readonly string[];
  /** Category for PRs with no signal, or a signal outside `categories`. */
  fallbackCategory?: string;
}

/** A category from configuration with exact-match labels. */
export interface CategoryLabels {
  title: string;
  labels: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turns configured categories into label rules, placed ahead of the built-in
 * rules so a configured label wins. Labels match whole and ignore case.
 *
 * @param categories - Categories with their labels
 * @param base - Rules to append after the configured ones
 * @returns The combined rule list
 */
export function labelRulesFromCategories(
  categories: CategoryLabels[],
  base: LabelRule[] = DEFAULT_LABEL_RULES
): LabelRule[] {
  const configured = categories.flatMap((c) =>
    c.labels.map((label) => ({
      pattern: new RegExp(`^${escapeRegExp(label.trim())}$`, "i"),
      category: c.title,
    }))
  );
  return [...configured, ...base];
}

interface ResolvedOptions {
  labelRules: LabelRule[];
  categories: readonly string[];
  fallbackCategory: string;
}

function resolveOptions(options: ClassifierOptions = {}): ResolvedOptions {
  return {
    labelRules: options.labelRules ?? DEFAULT_LABEL_RULES,
    categories: options.categories ?? BUILTIN_CATEGORIES,
    fallbackCategory: options.fallbackCategory ?? "Improvements",
  };
}

/**
 * Insights extracted from comment analysis
 */
interface CommentInsights {
  mentionsSecurity: boolean;
  mentionsBreaking: boolean;
  mentionsPerformance: boolean;
  mentionsMigration: boolean;
  mentionsDeprecation: boolean;
  suggestedLabels: string[];
  keyPoints: string[];
  reviewApproved: boolean;
  reviewChangesRequested: boolean;
}

/**
 * Enhanced privacy-friendly PR classification
 * Uses: titles, descriptions, labels, commit messages, PR structure, comments
 * Does NOT use: code diffs, file contents
 *
 * @param prs - Pull requests with optional comments
 * @param issues - Issues with optional comments
 * @param options - Label rules and categories; defaults to the built-ins
 * @returns Grouped and classified changes
 */
export async function enhancedClassifyChanges(
  prs: Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    linkedIssueIds: number[];
    author: string;
    comments?: PRCommentInput[]; // Optional comment enrichment
  }>,
  issues: Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    comments?: IssueCommentInput[]; // Optional comment enrichment
  }>,
  options?: ClassifierOptions
): Promise<GroupedChanges> {
  const resolved = resolveOptions(options);
  const classifiedItems: Array<ClassifiedItem & { category: string }> = [];

  for (const pr of prs) {
    const classification = await classifyPR(pr, issues, resolved);
    classifiedItems.push(classification);
  }

  // Group by category
  const categoryMap = new Map<string, ClassifiedItem[]>();

  for (const item of classifiedItems) {
    const category = item.category;
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }

    // Remove category from item (it's in the group structure)
    const { category: _, ...itemWithoutCategory } = item;
    categoryMap.get(category)!.push(itemWithoutCategory);
  }

  // Convert to GroupedChanges format
  const grouped = Array.from(categoryMap.entries()).map(([category, items]) => ({
    category,
    items,
  }));

  return { grouped };
}

/**
 * Analyze comments to extract classification insights
 * @see docs/COMMENTS_COMMITS_ENRICHMENT.md for patterns
 */
function analyzeComments(comments: PRCommentInput[] | undefined): CommentInsights {
  const insights: CommentInsights = {
    mentionsSecurity: false,
    mentionsBreaking: false,
    mentionsPerformance: false,
    mentionsMigration: false,
    mentionsDeprecation: false,
    suggestedLabels: [],
    keyPoints: [],
    reviewApproved: false,
    reviewChangesRequested: false,
  };

  if (!comments || comments.length === 0) {
    return insights;
  }

  for (const comment of comments) {
    // Skip empty comments
    if (!comment.body) continue;

    // Sanitize for analysis (remove PII but keep keywords)
    const sanitized = sanitizeCommentForLLM(comment.body, 1000);
    const lower = sanitized.toLowerCase();

    // Security mentions
    if (/security|cve|vulnerab|exploit|attack|injection|xss|csrf/i.test(lower)) {
      insights.mentionsSecurity = true;
      if (!insights.suggestedLabels.includes("security")) {
        insights.suggestedLabels.push("security");
      }
    }

    // Breaking change mentions
    if (/breaking|backwards?\s*compat|incompatible|migration\s*required/i.test(lower)) {
      insights.mentionsBreaking = true;
      if (!insights.suggestedLabels.includes("breaking")) {
        insights.suggestedLabels.push("breaking");
      }
    }

    // Performance mentions
    if (/performance|optimize|faster|slower|benchmark|latency|throughput/i.test(lower)) {
      insights.mentionsPerformance = true;
      if (!insights.suggestedLabels.includes("performance")) {
        insights.suggestedLabels.push("performance");
      }
    }

    // Migration mentions
    if (/migration|migrate|upgrade\s*path|data\s*conversion/i.test(lower)) {
      insights.mentionsMigration = true;
    }

    // Deprecation mentions
    if (/deprecat|sunset|end[\s-]*of[\s-]*life|eol|legacy/i.test(lower)) {
      insights.mentionsDeprecation = true;
      if (!insights.suggestedLabels.includes("deprecation")) {
        insights.suggestedLabels.push("deprecation");
      }
    }

    // Check review state for approval signals
    if (comment.commentType === "review_body" && comment.reviewState) {
      if (comment.reviewState === "APPROVED") {
        insights.reviewApproved = true;
      } else if (comment.reviewState === "CHANGES_REQUESTED") {
        insights.reviewChangesRequested = true;
      }
    }

    // Extract key points from review comments (often contain important context)
    if (comment.commentType === "review_body" && sanitized.length > 20) {
      // Take first sentence as a key point
      const firstSentence = sanitized.split(/[.!?]/)[0]?.trim();
      if (firstSentence && firstSentence.length > 10 && firstSentence.length < 150) {
        insights.keyPoints.push(firstSentence);
      }
    }
  }

  // Limit key points to top 3
  insights.keyPoints = insights.keyPoints.slice(0, 3);

  return insights;
}

/**
 * Classify a single PR using privacy-friendly signals
 * Now includes comment analysis for enriched context
 */
async function classifyPR(
  pr: {
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    linkedIssueIds: number[];
    author: string;
    comments?: PRCommentInput[];
  },
  allIssues: Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    comments?: IssueCommentInput[];
  }>,
  options: ResolvedOptions
): Promise<ClassifiedItem & { category: string }> {
  const signals: string[] = [];
  const scores: Record<string, number> = {};

  // 1. Label-based classification (60% weight) - Most reliable
  const labelCategory = classifyByLabels(pr.labels, options.labelRules);
  if (labelCategory) {
    scores[labelCategory] = (scores[labelCategory] || 0) + 0.6;
    signals.push(`label:${labelCategory.toLowerCase()}`);
  }

  // 2. Enhanced keyword detection (40% weight)
  const combinedText = `${pr.title}\n${pr.body || ""}`;
  const patternMatches = detectPatterns(combinedText);

  for (const match of patternMatches) {
    // Weight by pattern confidence
    scores[match.category] = (scores[match.category] || 0) + match.confidence * 0.4;
    signals.push(...match.signals);
  }

  // 3. PR structure analysis (20% weight)
  if (pr.body) {
    const structure = parsePRStructure(pr.body);
    const structureSignal = extractStructureSignals(structure);

    if (structureSignal.category) {
      scores[structureSignal.category] =
        (scores[structureSignal.category] || 0) + structureSignal.confidence * 0.2;
      signals.push(...structureSignal.signals);
    }
  }

  // 4. Linked issue analysis (15% weight)
  const linkedIssues = allIssues.filter((issue) => pr.linkedIssueIds.includes(issue.number));
  let issueCommentsMentionSecurity = false;

  for (const issue of linkedIssues) {
    const issueCategory = classifyByLabels(issue.labels, options.labelRules);
    if (issueCategory) {
      scores[issueCategory] = (scores[issueCategory] || 0) + 0.15;
      signals.push(`linked-issue:${issueCategory.toLowerCase()}`);
    }

    // Check issue title for keywords
    const issuePatterns = detectPatterns(issue.title);
    for (const pattern of issuePatterns) {
      scores[pattern.category] = (scores[pattern.category] || 0) + 0.1;
    }

    // Analyze issue comments if available (10% weight)
    if (issue.comments && issue.comments.length > 0) {
      const issueCommentInsights = analyzeComments(
        issue.comments.map((c) => ({
          body: c.body,
          author: c.author,
          commentType: "issue_comment",
        }))
      );

      issueCommentsMentionSecurity ||= issueCommentInsights.mentionsSecurity;

      for (const label of issueCommentInsights.suggestedLabels) {
        const category = labelToCategory(label);
        if (category) {
          scores[category] = (scores[category] || 0) + 0.1;
          signals.push(`issue-comment:${label}`);
        }
      }
    }
  }

  // 5. Comment-based classification (40% weight, the same as keywords: a
  //    reviewer naming the effect of a change is as strong a signal as the
  //    author's own wording)
  const commentInsights = analyzeComments(pr.comments);

  // Apply comment-derived insights
  for (const label of commentInsights.suggestedLabels) {
    const category = labelToCategory(label);
    if (category) {
      scores[category] = (scores[category] || 0) + 0.4;
      signals.push(`comment:${label}`);
    }
  }

  // 6. PRIORITY OVERRIDES (Breaking changes and Security always win)
  const hasBreaking =
    pr.labels.some((l) => /breaking/i.test(l)) ||
    patternMatches.some((m: { category: string }) => m.category === "Breaking Changes") ||
    /breaking change/i.test(pr.body || "") ||
    commentInsights.mentionsBreaking;

  if (hasBreaking) {
    scores["Breaking Changes"] = 1.0; // Override all other scores
    signals.push("priority:breaking");
  }

  const hasSecurity =
    pr.labels.some((l) => /security/i.test(l)) ||
    patternMatches.some((m: { category: string }) => m.category === "Security") ||
    /CVE-\d{4}-\d{4,}/.test(pr.body || "") ||
    commentInsights.mentionsSecurity ||
    issueCommentsMentionSecurity;

  if (hasSecurity) {
    scores["Security"] = 1.0; // Override all other scores
    signals.push("priority:security");
  }

  // Find highest scoring category among the allowed ones
  const entries = Object.entries(scores).filter(([c]) => options.categories.includes(c));
  const [category, score] =
    entries.length > 0
      ? entries.reduce((a, b) => (b[1] > a[1] ? b : a))
      : [options.fallbackCategory, 0.5]; // Default fallback

  const confidence = Math.min(score, 1.0);

  // Determine flags
  const flags = {
    breaking: hasBreaking || category === "Breaking Changes",
    security: hasSecurity || category === "Security",
    deprecation:
      pr.labels.some((l) => /deprecat/i.test(l)) ||
      patternMatches.some((m: { category: string }) => m.category === "Deprecations") ||
      commentInsights.mentionsDeprecation,
  };

  // Build enhanced description using comment key points if available
  let description = (pr.body || pr.title).substring(0, 200);
  if (commentInsights.keyPoints.length > 0) {
    const keyPointSummary = commentInsights.keyPoints[0];
    if (keyPointSummary && description.length + keyPointSummary.length < 200) {
      description = `${description.trim()}. ${keyPointSummary}`;
    }
  }

  return {
    category,
    title: pr.title.substring(0, 140),
    description: description.substring(0, 200),
    ref: { pr: pr.number },
    labels: pr.labels,
    flags,
    confidence,
    signals,
  };
}

/**
 * Map suggested labels to categories
 */
function labelToCategory(label: string): string | null {
  const map: Record<string, string> = {
    security: "Security",
    breaking: "Breaking Changes",
    performance: "Performance",
    deprecation: "Deprecations",
    feature: "Features",
    fix: "Fixes",
    bug: "Fixes",
    docs: "Docs",
  };
  return map[label.toLowerCase()] || null;
}

/**
 * Map labels to categories (highest confidence signal)
 *
 * @param labels - PR or issue labels
 * @param rules - Label rules in priority order
 * @returns The first matching category, or null
 */
export function classifyByLabels(
  labels: string[],
  rules: LabelRule[] = DEFAULT_LABEL_RULES
): string | null {
  for (const label of labels) {
    for (const { pattern, category } of rules) {
      if (pattern.test(label)) {
        return category;
      }
    }
  }

  return null;
}

/**
 * Fallback classification with enhanced pattern detection
 * Used when LLM call fails
 *
 * @param prs - Pull requests
 * @param options - Label rules and categories; defaults to the built-ins
 * @returns Grouped and classified changes
 */
export function enhancedFallbackClassification(
  prs: Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    linkedIssueIds: number[];
  }>,
  options?: ClassifierOptions
): GroupedChanges {
  const resolved = resolveOptions(options);
  // Built from the category list, so Internal and custom categories are no
  // longer dropped here.
  const categoryMap: Record<string, ClassifiedItem[]> = Object.fromEntries(
    resolved.categories.map((c) => [c, []])
  );

  for (const pr of prs) {
    const signals: string[] = [];

    // Try label classification first
    let category = classifyByLabels(pr.labels, resolved.labelRules);

    // If no label match, use pattern detection
    if (!category) {
      const combinedText = `${pr.title}\n${pr.body || ""}`;
      const patterns = detectPatterns(combinedText);

      if (patterns.length > 0) {
        // Use highest confidence pattern
        const best = patterns.reduce((a, b) => (b.confidence > a.confidence ? b : a));
        category = best.category;
        signals.push(...best.signals);
      } else {
        category = resolved.fallbackCategory; // Default
        signals.push("fallback:default");
      }
    } else {
      signals.push(`label:${category.toLowerCase()}`);
    }

    // Check for breaking/security overrides
    const hasBreaking =
      pr.labels.some((l) => /breaking/i.test(l)) ||
      /breaking change/i.test(pr.body || "") ||
      /breaking/i.test(pr.title);

    if (hasBreaking) {
      category = "Breaking Changes";
      signals.push("override:breaking");
    }

    const hasSecurity =
      pr.labels.some((l) => /security/i.test(l)) || /CVE-\d{4}-\d{4,}/.test(pr.body || "");

    if (hasSecurity) {
      category = "Security";
      signals.push("override:security");
    }

    if (!categoryMap[category]) category = resolved.fallbackCategory;

    if (categoryMap[category]) {
      categoryMap[category]?.push({
        title: pr.title.substring(0, 140),
        description: (pr.body || pr.title).substring(0, 200),
        ref: { pr: pr.number },
        labels: pr.labels,
        flags: {
          breaking: hasBreaking,
          security: hasSecurity,
          deprecation: pr.labels.some((l) => /deprecat/i.test(l)),
        },
        confidence: 0.7, // Medium confidence for fallback
        signals,
      });
    }
  }

  // Convert to grouped format
  const grouped = Object.entries(categoryMap)
    .filter(([_, items]) => items.length > 0)
    .map(([category, items]) => ({
      category,
      items,
    }));

  return { grouped };
}
