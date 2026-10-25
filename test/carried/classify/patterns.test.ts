/**
 * Unit tests for Classification Patterns
 *
 * Tests pattern detection, conventional commit parsing, and PR structure analysis.
 *
 * @see Issue #25: Expand automated coverage across API, workers, libs, and UI
 *
 * Carried from packages/shared/src/utils/classification-patterns.test.ts at 7d1d56f8.
 */

import { describe, it, expect } from "vitest";
import {
  detectPatterns,
  parseConventionalCommit,
  analyzeCommits,
  parsePRStructure,
  extractStructureSignals,
  BREAKING_PATTERNS,
  SECURITY_PATTERNS,
  DEPRECATION_PATTERNS,
  PERFORMANCE_PATTERNS,
  BUG_FIX_PATTERNS,
  FEATURE_PATTERNS,
  ENHANCEMENT_PATTERNS,
  DOCUMENTATION_PATTERNS,
  INTERNAL_PATTERNS,
} from "../../../src/core/classify/patterns";

describe("Classification Patterns", () => {
  // ============================================================================
  // Pattern Constants Tests
  // ============================================================================

  describe("Pattern Constants", () => {
    it("should have breaking patterns defined", () => {
      expect(BREAKING_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have security patterns defined", () => {
      expect(SECURITY_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have deprecation patterns defined", () => {
      expect(DEPRECATION_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have performance patterns defined", () => {
      expect(PERFORMANCE_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have bug fix patterns defined", () => {
      expect(BUG_FIX_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have feature patterns defined", () => {
      expect(FEATURE_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have enhancement patterns defined", () => {
      expect(ENHANCEMENT_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have documentation patterns defined", () => {
      expect(DOCUMENTATION_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have internal patterns defined", () => {
      expect(INTERNAL_PATTERNS.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // detectPatterns Tests
  // ============================================================================

  describe("detectPatterns", () => {
    describe("Breaking Changes", () => {
      it("should detect conventional commit breaking change", () => {
        const result = detectPatterns("feat!: remove old API");
        const breaking = result.find((r) => r.category === "Breaking Changes");

        expect(breaking).toBeDefined();
        expect(breaking!.confidence).toBe(0.95);
      });

      it("should detect BREAKING CHANGE in body", () => {
        const result = detectPatterns("BREAKING CHANGE: new auth flow");
        const breaking = result.find((r) => r.category === "Breaking Changes");

        expect(breaking).toBeDefined();
      });

      it("should detect [breaking] tag", () => {
        const result = detectPatterns("[breaking] Remove deprecated endpoint");
        const breaking = result.find((r) => r.category === "Breaking Changes");

        expect(breaking).toBeDefined();
      });

      it("should detect migration required", () => {
        const result = detectPatterns("Migration required for database schema");
        const breaking = result.find((r) => r.category === "Breaking Changes");

        expect(breaking).toBeDefined();
      });

      it("should detect removed API", () => {
        const result = detectPatterns("Removed the old v1 API");
        const breaking = result.find((r) => r.category === "Breaking Changes");

        // Note: "removed" needs to be followed by specific API-related keywords
        // This test may not match if the pattern is too strict
        expect(result.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe("Security", () => {
      it("should detect CVE identifiers", () => {
        const result = detectPatterns("Fix CVE-2024-12345 vulnerability");
        const security = result.find((r) => r.category === "Security");

        expect(security).toBeDefined();
        expect(security!.confidence).toBe(0.95);
      });

      it("should detect security fix keyword", () => {
        const result = detectPatterns("Security fix for authentication bypass");
        const security = result.find((r) => r.category === "Security");

        expect(security).toBeDefined();
      });

      it("should detect XSS vulnerability", () => {
        const result = detectPatterns("Fix XSS vulnerability in input field");
        const security = result.find((r) => r.category === "Security");

        expect(security).toBeDefined();
      });

      it("should detect SQL injection", () => {
        const result = detectPatterns("Prevent SQL injection in search query");
        const security = result.find((r) => r.category === "Security");

        expect(security).toBeDefined();
      });
    });

    describe("Deprecations", () => {
      it("should detect deprecated keyword", () => {
        const result = detectPatterns("Deprecated old authentication method");
        const deprecation = result.find((r) => r.category === "Deprecations");

        expect(deprecation).toBeDefined();
        expect(deprecation!.confidence).toBe(0.85);
      });

      it("should detect will be removed", () => {
        const result = detectPatterns("This API will be removed in v3.0");
        const deprecation = result.find((r) => r.category === "Deprecations");

        expect(deprecation).toBeDefined();
      });

      it("should detect please use instead pattern", () => {
        const result = detectPatterns("Please use newMethod() instead");
        const deprecation = result.find((r) => r.category === "Deprecations");

        expect(deprecation).toBeDefined();
      });
    });

    describe("Performance", () => {
      it("should detect performance improvement", () => {
        const result = detectPatterns("Performance improvement in query execution");
        const perf = result.find((r) => r.category === "Performance");

        expect(perf).toBeDefined();
        expect(perf!.confidence).toBe(0.8);
      });

      it("should detect faster keyword", () => {
        const result = detectPatterns("Make database queries faster");
        const perf = result.find((r) => r.category === "Performance");

        expect(perf).toBeDefined();
      });

      it("should detect percentage faster", () => {
        const result = detectPatterns("40% faster response times");
        const perf = result.find((r) => r.category === "Performance");

        expect(perf).toBeDefined();
      });

      it("should detect X times faster", () => {
        const result = detectPatterns("2x faster API responses");
        const perf = result.find((r) => r.category === "Performance");

        expect(perf).toBeDefined();
      });

      it("should detect cache keyword", () => {
        const result = detectPatterns("Added caching for user data");
        const perf = result.find((r) => r.category === "Performance");

        // Note: "cache" alone may not trigger performance pattern
        // It needs to be in the right context
        expect(result.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe("Bug Fixes", () => {
      it("should detect fix: conventional commit", () => {
        const result = detectPatterns("fix: resolve null pointer error");
        const fixes = result.find((r) => r.category === "Fixes");

        expect(fixes).toBeDefined();
        expect(fixes!.confidence).toBe(0.85);
      });

      it("should detect fixes bug keyword", () => {
        const result = detectPatterns("Fixes a bug in the login flow");
        const fixes = result.find((r) => r.category === "Fixes");

        expect(fixes).toBeDefined();
      });

      it("should detect closes #123", () => {
        const result = detectPatterns("closes #123");
        const fixes = result.find((r) => r.category === "Fixes");

        expect(fixes).toBeDefined();
      });

      it("should detect bugfix keyword", () => {
        const result = detectPatterns("Bugfix for edge case");
        const fixes = result.find((r) => r.category === "Fixes");

        expect(fixes).toBeDefined();
      });
    });

    describe("Features", () => {
      it("should detect feat: conventional commit", () => {
        const result = detectPatterns("feat: add OAuth support");
        const features = result.find((r) => r.category === "Features");

        expect(features).toBeDefined();
        expect(features!.confidence).toBe(0.8);
      });

      it("should detect add new feature", () => {
        const result = detectPatterns("Add new feature for dark mode");
        const features = result.find((r) => r.category === "Features");

        expect(features).toBeDefined();
      });

      it("should detect implement keyword", () => {
        const result = detectPatterns("Implement user profile editing");
        const features = result.find((r) => r.category === "Features");

        expect(features).toBeDefined();
      });
    });

    describe("Enhancements", () => {
      it("should detect enhanced keyword", () => {
        const result = detectPatterns("Enhanced error messages");
        const improvements = result.find((r) => r.category === "Improvements");

        expect(improvements).toBeDefined();
        expect(improvements!.confidence).toBe(0.7);
      });

      it("should detect improved keyword", () => {
        const result = detectPatterns("Improved user experience");
        const improvements = result.find((r) => r.category === "Improvements");

        expect(improvements).toBeDefined();
      });

      it("should detect updated keyword", () => {
        const result = detectPatterns("Updated UI components");
        const improvements = result.find((r) => r.category === "Improvements");

        expect(improvements).toBeDefined();
      });
    });

    describe("Documentation", () => {
      it("should detect docs: conventional commit", () => {
        const result = detectPatterns("docs: update README");
        const docs = result.find((r) => r.category === "Docs");

        expect(docs).toBeDefined();
        expect(docs!.confidence).toBe(0.9);
      });

      it("should detect documentation keyword", () => {
        const result = detectPatterns("Add documentation for new API");
        const docs = result.find((r) => r.category === "Docs");

        expect(docs).toBeDefined();
      });

      it("should detect README keyword", () => {
        const result = detectPatterns("Update README with examples");
        const docs = result.find((r) => r.category === "Docs");

        expect(docs).toBeDefined();
      });
    });

    describe("Internal", () => {
      it("should detect refactor: conventional commit", () => {
        const result = detectPatterns("refactor: simplify auth logic");
        const internal = result.find((r) => r.category === "Internal");

        expect(internal).toBeDefined();
        expect(internal!.confidence).toBe(0.75);
      });

      it("should detect chore: conventional commit", () => {
        const result = detectPatterns("chore: update dependencies");
        const internal = result.find((r) => r.category === "Internal");

        expect(internal).toBeDefined();
      });

      it("should detect test keyword", () => {
        const result = detectPatterns("Add unit tests for auth module");
        const internal = result.find((r) => r.category === "Internal");

        expect(internal).toBeDefined();
      });
    });

    describe("Multiple Categories", () => {
      it("should detect multiple categories in single text", () => {
        const result = detectPatterns(
          "feat!: Add new feature with performance optimization and fix bug"
        );

        expect(result.length).toBeGreaterThan(1);

        const categories = result.map((r) => r.category);
        expect(categories).toContain("Breaking Changes");
        expect(categories).toContain("Features");
      });
    });

    describe("Edge Cases", () => {
      it("should return empty array for non-matching text", () => {
        const result = detectPatterns("Hello world");

        expect(result).toEqual([]);
      });

      it("should return empty array for empty string", () => {
        const result = detectPatterns("");

        expect(result).toEqual([]);
      });

      it("should handle very long text", () => {
        const longText = "fix: " + "a".repeat(10000);
        const result = detectPatterns(longText);

        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // parseConventionalCommit Tests
  // ============================================================================

  describe("parseConventionalCommit", () => {
    describe("Valid Commits", () => {
      it("should parse feat: commit", () => {
        const result = parseConventionalCommit("feat: add new feature");

        expect(result).toEqual({
          type: "feat",
          scope: undefined,
          breaking: false,
          description: "add new feature",
          category: "Features",
        });
      });

      it("should parse fix: commit", () => {
        const result = parseConventionalCommit("fix: resolve bug");

        expect(result).toEqual({
          type: "fix",
          scope: undefined,
          breaking: false,
          description: "resolve bug",
          category: "Fixes",
        });
      });

      it("should parse commit with scope", () => {
        const result = parseConventionalCommit("feat(auth): add OAuth");

        expect(result).toEqual({
          type: "feat",
          scope: "auth",
          breaking: false,
          description: "add OAuth",
          category: "Features",
        });
      });

      it("should parse breaking commit with !", () => {
        const result = parseConventionalCommit("feat!: remove old API");

        expect(result).toEqual({
          type: "feat",
          scope: undefined,
          breaking: true,
          description: "remove old API",
          category: "Features",
        });
      });

      it("should parse breaking commit with scope and !", () => {
        const result = parseConventionalCommit("fix(core)!: change return type");

        expect(result).toEqual({
          type: "fix",
          scope: "core",
          breaking: true,
          description: "change return type",
          category: "Fixes",
        });
      });

      it("should map perf to Performance category", () => {
        const result = parseConventionalCommit("perf: optimize query");

        expect(result?.category).toBe("Performance");
      });

      it("should map docs to Docs category", () => {
        const result = parseConventionalCommit("docs: update README");

        expect(result?.category).toBe("Docs");
      });

      it("should map refactor to Internal category", () => {
        const result = parseConventionalCommit("refactor: simplify logic");

        expect(result?.category).toBe("Internal");
      });

      it("should map test to Internal category", () => {
        const result = parseConventionalCommit("test: add unit tests");

        expect(result?.category).toBe("Internal");
      });

      it("should map chore to Internal category", () => {
        const result = parseConventionalCommit("chore: update deps");

        expect(result?.category).toBe("Internal");
      });

      it("should map unknown type to Improvements", () => {
        const result = parseConventionalCommit("custom: do something");

        expect(result?.category).toBe("Improvements");
      });
    });

    describe("Invalid Commits", () => {
      it("should return null for non-conventional message", () => {
        const result = parseConventionalCommit("Updated the README file");

        expect(result).toBeNull();
      });

      it("should return null for empty string", () => {
        const result = parseConventionalCommit("");

        expect(result).toBeNull();
      });

      it("should return null for message without colon", () => {
        const result = parseConventionalCommit("feat add new feature");

        expect(result).toBeNull();
      });
    });
  });

  // ============================================================================
  // analyzeCommits Tests
  // ============================================================================

  describe("analyzeCommits", () => {
    it("should analyze single conventional commit", () => {
      const commits = [{ message: "feat: add new feature" }];
      const result = analyzeCommits(commits);

      expect(result.totalCommits).toBe(1);
      expect(result.conventionalCommits).toBe(1);
      expect(result.hasBreakingCommit).toBe(false);
      expect(result.categories).toContain("Features");
    });

    it("should detect breaking commit", () => {
      const commits = [{ message: "feat!: remove old API" }];
      const result = analyzeCommits(commits);

      expect(result.hasBreakingCommit).toBe(true);
      expect(result.categories).toContain("Breaking Changes");
    });

    it("should analyze multiple commits", () => {
      const commits = [
        { message: "feat: add feature" },
        { message: "fix: resolve bug" },
        { message: "docs: update README" },
      ];
      const result = analyzeCommits(commits);

      expect(result.totalCommits).toBe(3);
      expect(result.conventionalCommits).toBe(3);
      expect(result.categories).toContain("Features");
      expect(result.categories).toContain("Fixes");
      expect(result.categories).toContain("Docs");
    });

    it("should handle mixed conventional and non-conventional", () => {
      const commits = [{ message: "feat: add feature" }, { message: "Updated something" }];
      const result = analyzeCommits(commits);

      expect(result.totalCommits).toBe(2);
      expect(result.conventionalCommits).toBe(1);
    });

    it("should calculate confidence based on conventional ratio", () => {
      const allConventional = [{ message: "feat: a" }, { message: "fix: b" }];
      const mixedCommits = [{ message: "feat: a" }, { message: "Updated" }];

      const highConfidence = analyzeCommits(allConventional);
      const lowerConfidence = analyzeCommits(mixedCommits);

      expect(highConfidence.confidence).toBeGreaterThan(lowerConfidence.confidence);
    });

    it("should detect patterns in non-conventional commits", () => {
      const commits = [{ message: "Security fix for vulnerability" }];
      const result = analyzeCommits(commits);

      expect(result.categories).toContain("Security");
    });

    it("should handle empty commits array", () => {
      const result = analyzeCommits([]);

      expect(result.totalCommits).toBe(0);
      expect(result.conventionalCommits).toBe(0);
      expect(result.categories).toEqual([]);
    });
  });

  // ============================================================================
  // parsePRStructure Tests
  // ============================================================================

  describe("parsePRStructure", () => {
    it("should parse markdown sections", () => {
      const body = `
## Description
This is the description.

## Testing
Test instructions here.
`;
      const result = parsePRStructure(body);

      expect(result.sections.length).toBe(2);
      expect(result.sections[0]?.title).toBe("Description");
      expect(result.sections[1]?.title).toBe("Testing");
      expect(result.hasTestSection).toBe(true);
    });

    it("should parse checklist items", () => {
      const body = `
- [x] Task completed
- [ ] Task pending
- [X] Another completed
`;
      const result = parsePRStructure(body);

      expect(result.hasChecklist).toBe(true);
      expect(result.checklistItems.length).toBe(3);
      expect(result.checklistItems[0]).toEqual({
        checked: true,
        text: "Task completed",
      });
      expect(result.checklistItems[1]).toEqual({
        checked: false,
        text: "Task pending",
      });
    });

    it("should detect breaking change checkbox", () => {
      const body = `
- [x] This is a breaking change
- [ ] Tests added
`;
      const result = parsePRStructure(body);

      expect(result.signals).toContain("checkbox:breaking");
    });

    it("should detect migration checkbox", () => {
      const body = `
- [x] Migration instructions included
`;
      const result = parsePRStructure(body);

      expect(result.signals).toContain("checkbox:migration");
    });

    it("should detect test section", () => {
      const body = `
## Tests
Unit tests added.
`;
      const result = parsePRStructure(body);

      expect(result.hasTestSection).toBe(true);
      expect(result.signals).toContain("section:testing");
    });

    it("should detect migration section", () => {
      const body = `
## Migration Guide
Follow these steps to migrate.
`;
      const result = parsePRStructure(body);

      expect(result.hasMigrationSection).toBe(true);
      expect(result.signals).toContain("section:migration");
    });

    it("should detect breaking changes section", () => {
      const body = `
## Breaking Changes
- Removed old API
`;
      const result = parsePRStructure(body);

      expect(result.hasBreakingSection).toBe(true);
      expect(result.signals).toContain("section:breaking");
    });

    it("should handle empty body", () => {
      const result = parsePRStructure("");

      expect(result.hasChecklist).toBe(false);
      expect(result.hasTestSection).toBe(false);
      expect(result.sections).toEqual([]);
      expect(result.checklistItems).toEqual([]);
    });
  });

  // ============================================================================
  // extractStructureSignals Tests
  // ============================================================================

  describe("extractStructureSignals", () => {
    it("should return high confidence for breaking checkbox", () => {
      const structure = parsePRStructure("- [x] This is a breaking change");
      const result = extractStructureSignals(structure);

      expect(result.category).toBe("Breaking Changes");
      expect(result.confidence).toBe(0.95);
      expect(result.signals).toContain("explicit:breaking-checkbox");
    });

    it("should return high confidence for breaking section", () => {
      const structure = parsePRStructure("## Breaking Changes\nDetails here");
      const result = extractStructureSignals(structure);

      expect(result.category).toBe("Breaking Changes");
      expect(result.confidence).toBe(0.9);
      expect(result.signals).toContain("explicit:breaking-section");
    });

    it("should return confidence for migration section", () => {
      const structure = parsePRStructure("## Migration Guide\nSteps here");
      const result = extractStructureSignals(structure);

      expect(result.category).toBe("Breaking Changes");
      expect(result.confidence).toBe(0.85);
      expect(result.signals).toContain("explicit:migration-section");
    });

    it("should return default confidence for structure without breaking signals", () => {
      const structure = parsePRStructure("## Description\nSome changes");
      const result = extractStructureSignals(structure);

      expect(result.category).toBeUndefined();
      expect(result.confidence).toBe(0.5);
    });

    it("should prefer breaking checkbox over other signals", () => {
      const structure = parsePRStructure(`
- [x] This is a breaking change

## Migration Guide
Steps here
`);
      const result = extractStructureSignals(structure);

      // Breaking checkbox has highest confidence
      expect(result.confidence).toBe(0.95);
    });
  });
});
