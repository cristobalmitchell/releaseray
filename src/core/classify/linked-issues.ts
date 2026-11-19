/**
 * GitHub-specific utilities
 * Issue linking, PR parsing, etc.
 */

/**
 * Extract linked issue numbers from PR body or commit message
 * Supports common GitHub linking patterns:
 * - fixes #123, closes #456
 * - resolves #789
 * - Bare references: #123
 *
 * @param text - PR body, commit message, or issue description
 * @returns Array of unique issue numbers
 */
export function extractLinkedIssues(text: string): number[] {
  if (!text) return [];

  const issues = new Set<number>();

  // Pattern 1: Closing keywords (fixes, closes, resolves, etc.)
  // https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
  const closingKeywords = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  let match;
  while ((match = closingKeywords.exec(text)) !== null) {
    if (match[1]) {
      issues.add(parseInt(match[1], 10));
    }
  }

  // Pattern 2: Bare issue references (#123)
  // Be conservative: must be preceded by whitespace or start of string
  const bareReferences = /(?:^|\s)#(\d+)\b/g;
  while ((match = bareReferences.exec(text)) !== null) {
    if (match[1]) {
      issues.add(parseInt(match[1], 10));
    }
  }

  return Array.from(issues).sort((a, b) => a - b);
}

/**
 * Detect breaking change indicators in PR/commit text
 * @param text - PR body, commit message, or title
 * @returns true if breaking change detected
 */
export function hasBreakingChange(text: string): boolean {
  if (!text) return false;

  const breakingPatterns = [
    /BREAKING\s+CHANGE/i,
    /\[breaking\]/i,
    /breaking:/i,
    /!\s*:/, // Conventional Commits: feat!: or fix!:
  ];

  return breakingPatterns.some((pattern) => pattern.test(text));
}

/**
 * Detect deprecation notices in text
 * @param text - PR body, commit message, or title
 * @returns true if deprecation detected
 */
export function hasDeprecation(text: string): boolean {
  if (!text) return false;

  const deprecationPatterns = [/DEPRECAT(ED|ION)/i, /\[deprecated\]/i, /deprecat(e|ing):/i];

  return deprecationPatterns.some((pattern) => pattern.test(text));
}

/**
 * Parse conventional commit format
 * @param message - Commit message or PR title
 * @returns Parsed type, scope, and subject
 */
export function parseConventionalCommit(message: string): {
  type: string | null;
  scope: string | null;
  breaking: boolean;
  subject: string;
} {
  // Pattern: type(scope)!: subject
  const pattern = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
  const match = message.match(pattern);

  if (!match) {
    return {
      type: null,
      scope: null,
      breaking: false,
      subject: message,
    };
  }

  return {
    type: match[1] || null,
    scope: match[2] || null,
    breaking: !!match[3],
    subject: match[4] || message,
  };
}
