/**
 * @fileoverview Enhanced pattern detection for PR classification
 * Privacy-friendly: Uses only PR titles, descriptions, and commit messages
 * No code diff data required
 */

// ============================================================================
// BREAKING CHANGE PATTERNS
// ============================================================================

export const BREAKING_PATTERNS = [
  // Conventional Commits
  /^(feat|fix|chore|docs|refactor|perf|test)!:/i, // "feat!: ..."
  /^BREAKING CHANGE:/im, // In commit body or PR description
  /\[breaking\]/i, // [breaking] tag
  /\(breaking\)/i, // (breaking) tag

  // Semantic indicators
  /\bremov(e|ed|ing)\s+(the\s+)?api\b/i, // "removed API", "removing the API"
  /\bremov(e|ed|ing)\s+(the\s+)?endpoint\b/i, // "removed endpoint"
  /\bdeprecate(d)?\s+and\s+remov(e|ed)\b/i, // "deprecated and removed"
  /\bmigration\s+required\b/i, // "migration required"
  /\bbreaking\s+change/i, // "breaking change"
  /\bincompatible\s+with\b/i, // "incompatible with"
  /\bnot\s+backward[s]?\s+compatible\b/i, // "not backward compatible"

  // Version indicators
  /\bmajor\s+version\b/i, // "major version"
  /\bv?\d+\.0\.0\b/, // "v2.0.0" (major version bump)

  // API/Interface changes
  /\bremov(e|ed|ing)\s+support\s+for\b/i, // "removing support for"
  /\bno\s+longer\s+support(s|ed)?\b/i, // "no longer supported"
  /\bchanged?\s+(the\s+)?signature\b/i, // "changed signature"
  /\bmodified?\s+(the\s+)?interface\b/i, // "modified interface"
];

// ============================================================================
// SECURITY PATTERNS
// ============================================================================

export const SECURITY_PATTERNS = [
  // CVE identifiers
  /\b(CVE-\d{4}-\d{4,})\b/, // CVE-2024-1234

  // Security keywords
  /\bvulnerability\b/i,
  /\bsecurity\s+(fix|patch|update|issue)\b/i,
  /\bauth(entication|orization)\s+(fix|bypass|issue)\b/i,

  // Attack types
  /\b(xss|cross[- ]site\s+scripting)\b/i,
  /\b(csrf|cross[- ]site\s+request\s+forgery)\b/i,
  /\bsql\s+injection\b/i,
  /\bremote\s+code\s+execution\b/i,
  /\b(rce)\b/i,

  // Security concepts
  /\bprivilege\s+escalation\b/i,
  /\bunauthorized\s+access\b/i,
  /\bdata\s+leak\b/i,
  /\bsensitive\s+data\s+exposure\b/i,
  /\bpassword\s+(leak|exposure|hash)\b/i,
];

// ============================================================================
// DEPRECATION PATTERNS
// ============================================================================

export const DEPRECATION_PATTERNS = [
  /\bdeprecated?\b/i, // "deprecated", "deprecate"
  /\bplease\s+use\b.{0,50}\binstead\b/i, // "please use X instead"
  /\bwill\s+be\s+removed\b/i, // "will be removed in v3"
  /\bno\s+longer\s+maintained\b/i, // "no longer maintained"
  /\blegacy\s+(code|api|endpoint)\b/i, // "legacy API"
  /\bphasing\s+out\b/i, // "phasing out"
  /\bscheduled\s+for\s+removal\b/i, // "scheduled for removal"
];

// ============================================================================
// PERFORMANCE PATTERNS
// ============================================================================

export const PERFORMANCE_PATTERNS = [
  /\bperformance\s+(improvement|optimization|boost)\b/i,
  /\boptimize[ds]?\b/i,
  /\bfaster\b/i,
  /\bspeed\s+up\b/i,
  /\breduced?\s+(latency|response\s+time)\b/i,
  /\bcache[ds]?\b/i,
  /\b\d+%\s+faster\b/i, // "40% faster"
  /\b\d+x\s+faster\b/i, // "2x faster"
  /\bmemory\s+(usage|optimization|leak\s+fix)\b/i,
];

// ============================================================================
// BUG FIX PATTERNS
// ============================================================================

export const BUG_FIX_PATTERNS = [
  /^fix(es)?:/i, // Conventional commit: "fix:"
  /\bfix(es|ed|ing)?\s+(a\s+)?bug\b/i,
  /\bfix(es|ed|ing)?\s+(the\s+)?issue\b/i,
  /\bfix(es|ed|ing)?\s+(an?\s+)?error\b/i,
  /\bresolv(e|ed|es|ing)\b/i,
  /\bclos(e|ed|es|ing)\s+#\d+/i, // "closes #123"
  /\bfix(es)?\s+#\d+/i, // "fixes #456"
  /\bbugfix\b/i,
  /\bpatch\b/i,
  /\bcorrect(ed|s)?\b/i,
];

// ============================================================================
// FEATURE PATTERNS
// ============================================================================

export const FEATURE_PATTERNS = [
  /^feat(ure)?:/i, // Conventional commit: "feat:"
  /\badd(s|ed|ing)?\s+(new\s+)?feature\b/i,
  /\bnew\s+(functionality|capability)\b/i,
  /\bintroduc(e|ed|ing)\b/i,
  /\bimplement(s|ed|ing)?\b/i,
  /\bcreate[ds]?\s+(a\s+)?new\b/i,
];

// ============================================================================
// ENHANCEMENT PATTERNS
// ============================================================================

export const ENHANCEMENT_PATTERNS = [
  /\benhance(d|ment|s)?\b/i,
  /\bimprov(e|ed|es|ing|ement)\b/i,
  /\bupdate[ds]?\b/i,
  /\bupgrad(e|ed|es|ing)\b/i,
  /\bbetter\b/i,
  /\brefine[ds]?\b/i,
];

// ============================================================================
// DOCUMENTATION PATTERNS
// ============================================================================

export const DOCUMENTATION_PATTERNS = [
  /^docs?:/i, // Conventional commit: "docs:"
  /\bdocumentation\b/i,
  /\breadme\b/i,
  /\bupdate[ds]?\s+(the\s+)?docs?\b/i,
  /\badd(s|ed)?\s+(the\s+)?docs?\b/i,
  /\bcomments?\b/i,
  /\bjsdoc\b/i,
  /\b\.md$/i, // Markdown files
];

// ============================================================================
// INTERNAL/REFACTOR PATTERNS
// ============================================================================

export const INTERNAL_PATTERNS = [
  /^(refactor|test|chore|style|build|ci):/i, // Conventional commits
  /\brefactor(ed|ing|s)?\b/i,
  /\bcode\s+cleanup\b/i,
  /\brestructur(e|ed|ing)\b/i,
  /\btest(s|ing)?\b/i,
  /\bunit\s+test\b/i,
  /\bintegration\s+test\b/i,
  /\bdependenc(y|ies)\s+update\b/i,
  /\bchore\b/i,
];

// ============================================================================
// PATTERN MATCHING FUNCTIONS
// ============================================================================

export interface PatternMatch {
  category: string;
  confidence: number;
  patterns: string[];
  signals: string[];
}

/**
 * Detect patterns in text (PR title, body, or commit messages)
 * @param text - Text to analyze
 * @returns Array of detected patterns with confidence scores
 */
export function detectPatterns(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  // Breaking changes (highest priority)
  const breakingMatches = BREAKING_PATTERNS.filter((p) => p.test(text));
  if (breakingMatches.length > 0) {
    matches.push({
      category: "Breaking Changes",
      confidence: 0.95, // High confidence
      patterns: breakingMatches.map((p) => p.source),
      signals: ["pattern:breaking"],
    });
  }

  // Security (highest priority)
  const securityMatches = SECURITY_PATTERNS.filter((p) => p.test(text));
  if (securityMatches.length > 0) {
    matches.push({
      category: "Security",
      confidence: 0.95,
      patterns: securityMatches.map((p) => p.source),
      signals: ["pattern:security"],
    });
  }

  // Deprecations
  const deprecationMatches = DEPRECATION_PATTERNS.filter((p) => p.test(text));
  if (deprecationMatches.length > 0) {
    matches.push({
      category: "Deprecations",
      confidence: 0.85,
      patterns: deprecationMatches.map((p) => p.source),
      signals: ["pattern:deprecation"],
    });
  }

  // Performance
  const perfMatches = PERFORMANCE_PATTERNS.filter((p) => p.test(text));
  if (perfMatches.length > 0) {
    matches.push({
      category: "Performance",
      confidence: 0.8,
      patterns: perfMatches.map((p) => p.source),
      signals: ["pattern:performance"],
    });
  }

  // Bug fixes
  const bugMatches = BUG_FIX_PATTERNS.filter((p) => p.test(text));
  if (bugMatches.length > 0) {
    matches.push({
      category: "Fixes",
      confidence: 0.85,
      patterns: bugMatches.map((p) => p.source),
      signals: ["pattern:bugfix"],
    });
  }

  // Features
  const featureMatches = FEATURE_PATTERNS.filter((p) => p.test(text));
  if (featureMatches.length > 0) {
    matches.push({
      category: "Features",
      confidence: 0.8,
      patterns: featureMatches.map((p) => p.source),
      signals: ["pattern:feature"],
    });
  }

  // Enhancements
  const enhancementMatches = ENHANCEMENT_PATTERNS.filter((p) => p.test(text));
  if (enhancementMatches.length > 0) {
    matches.push({
      category: "Improvements",
      confidence: 0.7,
      patterns: enhancementMatches.map((p) => p.source),
      signals: ["pattern:enhancement"],
    });
  }

  // Documentation
  const docsMatches = DOCUMENTATION_PATTERNS.filter((p) => p.test(text));
  if (docsMatches.length > 0) {
    matches.push({
      category: "Docs",
      confidence: 0.9,
      patterns: docsMatches.map((p) => p.source),
      signals: ["pattern:docs"],
    });
  }

  // Internal/Refactor
  const internalMatches = INTERNAL_PATTERNS.filter((p) => p.test(text));
  if (internalMatches.length > 0) {
    matches.push({
      category: "Internal",
      confidence: 0.75,
      patterns: internalMatches.map((p) => p.source),
      signals: ["pattern:internal"],
    });
  }

  return matches;
}

/**
 * Parse conventional commit message
 * Format: type(scope)?: description
 * Examples:
 *   feat(auth): add OAuth support
 *   fix!: resolve memory leak
 *   docs: update README
 */
export interface ConventionalCommit {
  type: string; // feat, fix, docs, etc.
  scope?: string; // (auth), (api), etc.
  breaking: boolean; // Has ! after type
  description: string;
  category?: string; // Mapped category
}

export function parseConventionalCommit(message: string): ConventionalCommit | null {
  // Match: type(scope)!?: description
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)/);

  if (!match) return null;

  const [, type, scope, breaking, description] = match;

  // Type guard - type is required in regex match
  if (!type) return null;

  // Map conventional commit types to categories
  const typeMap: Record<string, string> = {
    feat: "Features",
    feature: "Features",
    fix: "Fixes",
    perf: "Performance",
    docs: "Docs",
    style: "Internal",
    refactor: "Internal",
    test: "Internal",
    build: "Internal",
    ci: "Internal",
    chore: "Internal",
  };

  return {
    type: type.toLowerCase(),
    scope: scope || undefined,
    breaking: breaking === "!",
    description: description?.trim() || "",
    category: typeMap[type.toLowerCase()] || "Improvements",
  };
}

/**
 * Analyze multiple commit messages
 * @param commits - Array of commit message strings
 * @returns Aggregated analysis
 */
export interface CommitAnalysis {
  totalCommits: number;
  conventionalCommits: number;
  hasBreakingCommit: boolean;
  categories: string[];
  signals: string[];
  confidence: number;
}

export function analyzeCommits(commits: Array<{ message: string }>): CommitAnalysis {
  const categories = new Set<string>();
  let conventionalCount = 0;
  let hasBreaking = false;
  const signals: string[] = [];

  for (const commit of commits) {
    // Try parsing as conventional commit
    const parsed = parseConventionalCommit(commit.message);

    if (parsed) {
      conventionalCount++;
      if (parsed.category) {
        categories.add(parsed.category);
      }
      if (parsed.breaking) {
        hasBreaking = true;
        categories.add("Breaking Changes");
        signals.push("commit:conventional-breaking");
      }
      signals.push(`commit:${parsed.type}`);
    }

    // Also check for keyword patterns in commit body
    const patterns = detectPatterns(commit.message);
    for (const pattern of patterns) {
      categories.add(pattern.category);
      signals.push(...pattern.signals);

      if (pattern.category === "Breaking Changes") {
        hasBreaking = true;
      }
    }
  }

  // Confidence based on conventional commit usage
  const conventionalRatio = conventionalCount / commits.length;
  const confidence = 0.5 + conventionalRatio * 0.4; // 0.5 - 0.9

  return {
    totalCommits: commits.length,
    conventionalCommits: conventionalCount,
    hasBreakingCommit: hasBreaking,
    categories: Array.from(categories),
    signals,
    confidence,
  };
}

/**
 * Parse PR description structure
 * Extracts checkboxes, sections, and templates
 */
export interface PRStructure {
  hasChecklist: boolean;
  hasTestSection: boolean;
  hasMigrationSection: boolean;
  hasBreakingSection: boolean;
  sections: Array<{ title: string; content: string }>;
  checklistItems: Array<{ checked: boolean; text: string }>;
  signals: string[];
}

export function parsePRStructure(body: string): PRStructure {
  const sections: Array<{ title: string; content: string }> = [];
  const checklistItems: Array<{ checked: boolean; text: string }> = [];
  const signals: string[] = [];

  // Parse markdown sections (## Heading)
  const lines = body.split("\n");
  let currentSection: { title: string; content: string } | null = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch && sectionMatch[1]) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        title: sectionMatch[1].trim(),
        content: "",
      };
    } else if (currentSection) {
      currentSection.content += line + "\n";
    }

    // Parse checklist items
    const checklistMatch = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (checklistMatch && checklistMatch[1] && checklistMatch[2]) {
      const checked = checklistMatch[1].toLowerCase() === "x";
      const text = checklistMatch[2].trim();
      checklistItems.push({ checked, text });

      // Check for breaking change checkbox
      if (checked && /breaking\s+change/i.test(text)) {
        signals.push("checkbox:breaking");
      }

      // Check for migration checkbox
      if (checked && /migration/i.test(text)) {
        signals.push("checkbox:migration");
      }
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  // Check for specific sections
  const hasTestSection = sections.some((s) => /test(s|ing)?/i.test(s.title));
  const hasMigrationSection = sections.some((s) => /migration|upgrade/i.test(s.title));
  const hasBreakingSection = sections.some((s) => /breaking/i.test(s.title));

  if (hasTestSection) signals.push("section:testing");
  if (hasMigrationSection) signals.push("section:migration");
  if (hasBreakingSection) signals.push("section:breaking");

  return {
    hasChecklist: checklistItems.length > 0,
    hasTestSection,
    hasMigrationSection,
    hasBreakingSection,
    sections,
    checklistItems,
    signals,
  };
}

/**
 * Extract classification signals from PR structure
 */
export function extractStructureSignals(structure: PRStructure): {
  category?: string;
  confidence: number;
  signals: string[];
} {
  const signals = [...structure.signals];
  let category: string | undefined;
  let confidence = 0.5;

  // Breaking change checkbox (highest confidence)
  const breakingCheckbox = structure.checklistItems.find((item) =>
    /breaking\s+change/i.test(item.text)
  );

  if (breakingCheckbox?.checked) {
    category = "Breaking Changes";
    confidence = 0.95; // User explicitly marked it
    signals.push("explicit:breaking-checkbox");
  }

  // Migration section suggests breaking change
  if (structure.hasMigrationSection) {
    category = category || "Breaking Changes";
    confidence = Math.max(confidence, 0.85);
    signals.push("explicit:migration-section");
  }

  // Breaking section
  if (structure.hasBreakingSection) {
    category = category || "Breaking Changes";
    confidence = Math.max(confidence, 0.9);
    signals.push("explicit:breaking-section");
  }

  return { category, confidence, signals };
}
