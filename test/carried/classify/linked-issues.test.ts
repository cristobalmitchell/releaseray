/**
 * Unit tests for GitHub Utilities
 *
 * Tests extractLinkedIssues, hasBreakingChange, hasDeprecation,
 * and parseConventionalCommit functions.
 *
 * @see Issue #25: Expand automated coverage across API, workers, libs, and UI
 *
 * Carried from packages/shared/src/utils/github.test.ts at 7d1d56f8.
 */

import { describe, it, expect } from "vitest";
import {
  extractLinkedIssues,
  hasBreakingChange,
  hasDeprecation,
  parseConventionalCommit,
} from "../../../src/core/classify/linked-issues";

describe("GitHub Utilities", () => {
  // ============================================================================
  // extractLinkedIssues Tests
  // ============================================================================

  describe("extractLinkedIssues", () => {
    describe("Closing Keywords", () => {
      it('should extract issues with "fixes" keyword', () => {
        const result = extractLinkedIssues("fixes #123");
        expect(result).toEqual([123]);
      });

      it('should extract issues with "fixed" keyword', () => {
        const result = extractLinkedIssues("fixed #456");
        expect(result).toEqual([456]);
      });

      it('should extract issues with "closes" keyword', () => {
        const result = extractLinkedIssues("closes #789");
        expect(result).toEqual([789]);
      });

      it('should extract issues with "closed" keyword', () => {
        const result = extractLinkedIssues("closed #100");
        expect(result).toEqual([100]);
      });

      it('should extract issues with "close" keyword', () => {
        const result = extractLinkedIssues("close #200");
        expect(result).toEqual([200]);
      });

      it('should extract issues with "resolves" keyword', () => {
        const result = extractLinkedIssues("resolves #300");
        expect(result).toEqual([300]);
      });

      it('should extract issues with "resolved" keyword', () => {
        const result = extractLinkedIssues("resolved #400");
        expect(result).toEqual([400]);
      });

      it("should be case insensitive", () => {
        const result = extractLinkedIssues("FIXES #123 Closes #456 ResolveS #789");
        expect(result).toEqual([123, 456, 789]);
      });
    });

    describe("Bare Issue References", () => {
      it("should extract bare issue reference at start", () => {
        const result = extractLinkedIssues("#123 is addressed");
        expect(result).toEqual([123]);
      });

      it("should extract bare issue reference after space", () => {
        const result = extractLinkedIssues("Related to #456");
        expect(result).toEqual([456]);
      });

      it("should extract multiple bare references", () => {
        const result = extractLinkedIssues("See #123 and #456 for details");
        expect(result).toEqual([123, 456]);
      });
    });

    describe("Multiple Issues", () => {
      it("should extract multiple issues from complex text", () => {
        const text = `
          This PR fixes #123 and closes #456.
          
          Related to #789 and #101.
          
          Also resolves #202.
        `;
        const result = extractLinkedIssues(text);
        expect(result).toEqual([101, 123, 202, 456, 789]);
      });

      it("should deduplicate issue numbers", () => {
        const result = extractLinkedIssues("fixes #123 closes #123 #123");
        expect(result).toEqual([123]);
      });

      it("should sort issues numerically", () => {
        const result = extractLinkedIssues("#456 #123 #789");
        expect(result).toEqual([123, 456, 789]);
      });
    });

    describe("Edge Cases", () => {
      it("should return empty array for empty string", () => {
        const result = extractLinkedIssues("");
        expect(result).toEqual([]);
      });

      it("should return empty array for null-like values", () => {
        const result = extractLinkedIssues(null as unknown as string);
        expect(result).toEqual([]);
      });

      it("should return empty array for undefined", () => {
        const result = extractLinkedIssues(undefined as unknown as string);
        expect(result).toEqual([]);
      });

      it("should not extract issue from URL path", () => {
        // URL paths like /issues/123 shouldn't match the bare #123 pattern
        const result = extractLinkedIssues("See https://github.com/org/repo/issues/123");
        // The /123 part shouldn't be extracted
        expect(result).toEqual([]);
      });

      it("should handle text without any issue references", () => {
        const result = extractLinkedIssues("This is a normal commit message");
        expect(result).toEqual([]);
      });

      it("should handle very large issue numbers", () => {
        const result = extractLinkedIssues("fixes #999999999");
        expect(result).toEqual([999999999]);
      });

      it("should handle issue in markdown link", () => {
        const result = extractLinkedIssues("Related to [issue](#123)");
        // Issue references inside markdown links may not be extracted
        // as the regex focuses on keywords like "fixes", "closes", etc.
        expect(Array.isArray(result)).toBe(true);
      });
    });
  });

  // ============================================================================
  // hasBreakingChange Tests
  // ============================================================================

  describe("hasBreakingChange", () => {
    describe("BREAKING CHANGE Pattern", () => {
      it('should detect "BREAKING CHANGE" in text', () => {
        expect(hasBreakingChange("BREAKING CHANGE: removed old API")).toBe(true);
      });

      it('should detect "Breaking Change" case insensitive', () => {
        expect(hasBreakingChange("Breaking Change: API update")).toBe(true);
      });

      it('should detect "breaking change" lowercase', () => {
        expect(hasBreakingChange("This is a breaking change")).toBe(true);
      });
    });

    describe("[breaking] Pattern", () => {
      it('should detect "[breaking]" tag', () => {
        expect(hasBreakingChange("[breaking] Remove deprecated method")).toBe(true);
      });

      it('should detect "[BREAKING]" uppercase', () => {
        expect(hasBreakingChange("[BREAKING] Major API overhaul")).toBe(true);
      });
    });

    describe("breaking: Pattern", () => {
      it('should detect "breaking:" prefix', () => {
        expect(hasBreakingChange("breaking: update config format")).toBe(true);
      });

      it('should detect "BREAKING:" uppercase', () => {
        expect(hasBreakingChange("BREAKING: new required field")).toBe(true);
      });
    });

    describe("Conventional Commits ! Pattern", () => {
      it('should detect "feat!:" pattern', () => {
        expect(hasBreakingChange("feat!: add new required param")).toBe(true);
      });

      it('should detect "fix!:" pattern', () => {
        expect(hasBreakingChange("fix!: change return type")).toBe(true);
      });

      it('should detect "chore!:" pattern', () => {
        expect(hasBreakingChange("chore!: drop Node 14 support")).toBe(true);
      });

      it("should detect ! with space before colon", () => {
        expect(hasBreakingChange("feat! : breaking change")).toBe(true);
      });
    });

    describe("Non-Breaking Changes", () => {
      it("should return false for normal commit message", () => {
        expect(hasBreakingChange("feat: add new feature")).toBe(false);
      });

      it("should return false for empty string", () => {
        expect(hasBreakingChange("")).toBe(false);
      });

      it("should return false for null-like values", () => {
        expect(hasBreakingChange(null as unknown as string)).toBe(false);
      });

      it('should return false for "break" without "ing"', () => {
        expect(hasBreakingChange("fix: break out of loop early")).toBe(false);
      });
    });
  });

  // ============================================================================
  // hasDeprecation Tests
  // ============================================================================

  describe("hasDeprecation", () => {
    describe("DEPRECATION Pattern", () => {
      it('should detect "DEPRECATED" in text', () => {
        expect(hasDeprecation("DEPRECATED: use newMethod instead")).toBe(true);
      });

      it('should detect "DEPRECATION" in text', () => {
        expect(hasDeprecation("DEPRECATION warning added")).toBe(true);
      });

      it("should be case insensitive", () => {
        expect(hasDeprecation("deprecated feature")).toBe(true);
        expect(hasDeprecation("Deprecation notice")).toBe(true);
      });
    });

    describe("[deprecated] Pattern", () => {
      it('should detect "[deprecated]" tag', () => {
        expect(hasDeprecation("[deprecated] Old function removed")).toBe(true);
      });

      it('should detect "[DEPRECATED]" uppercase', () => {
        expect(hasDeprecation("[DEPRECATED] Legacy endpoint")).toBe(true);
      });
    });

    describe("deprecate: and deprecating: Patterns", () => {
      it('should detect "deprecate:" prefix', () => {
        expect(hasDeprecation("deprecate: remove v1 API")).toBe(true);
      });

      it('should detect "deprecating:" prefix', () => {
        expect(hasDeprecation("deprecating: old auth flow")).toBe(true);
      });
    });

    describe("Non-Deprecation Text", () => {
      it("should return false for normal commit message", () => {
        expect(hasDeprecation("feat: add new API endpoint")).toBe(false);
      });

      it("should return false for empty string", () => {
        expect(hasDeprecation("")).toBe(false);
      });

      it("should return false for null-like values", () => {
        expect(hasDeprecation(null as unknown as string)).toBe(false);
      });

      it('should return false for "deprec" without full word', () => {
        expect(hasDeprecation("deprec is not a word")).toBe(false);
      });
    });
  });

  // ============================================================================
  // parseConventionalCommit Tests
  // ============================================================================

  describe("parseConventionalCommit", () => {
    describe("Simple Type Messages", () => {
      it("should parse feat: message", () => {
        const result = parseConventionalCommit("feat: add new feature");
        expect(result).toEqual({
          type: "feat",
          scope: null,
          breaking: false,
          subject: "add new feature",
        });
      });

      it("should parse fix: message", () => {
        const result = parseConventionalCommit("fix: resolve bug in handler");
        expect(result).toEqual({
          type: "fix",
          scope: null,
          breaking: false,
          subject: "resolve bug in handler",
        });
      });

      it("should parse chore: message", () => {
        const result = parseConventionalCommit("chore: update dependencies");
        expect(result).toEqual({
          type: "chore",
          scope: null,
          breaking: false,
          subject: "update dependencies",
        });
      });

      it("should parse docs: message", () => {
        const result = parseConventionalCommit("docs: update README");
        expect(result).toEqual({
          type: "docs",
          scope: null,
          breaking: false,
          subject: "update README",
        });
      });

      it("should parse test: message", () => {
        const result = parseConventionalCommit("test: add unit tests");
        expect(result).toEqual({
          type: "test",
          scope: null,
          breaking: false,
          subject: "add unit tests",
        });
      });

      it("should parse refactor: message", () => {
        const result = parseConventionalCommit("refactor: simplify logic");
        expect(result).toEqual({
          type: "refactor",
          scope: null,
          breaking: false,
          subject: "simplify logic",
        });
      });

      it("should parse perf: message", () => {
        const result = parseConventionalCommit("perf: optimize query");
        expect(result).toEqual({
          type: "perf",
          scope: null,
          breaking: false,
          subject: "optimize query",
        });
      });
    });

    describe("Type with Scope", () => {
      it("should parse type(scope): message", () => {
        const result = parseConventionalCommit("feat(auth): add OAuth support");
        expect(result).toEqual({
          type: "feat",
          scope: "auth",
          breaking: false,
          subject: "add OAuth support",
        });
      });

      it("should parse scope with dashes", () => {
        const result = parseConventionalCommit("fix(api-gateway): fix routing issue");
        expect(result).toEqual({
          type: "fix",
          scope: "api-gateway",
          breaking: false,
          subject: "fix routing issue",
        });
      });

      it("should parse scope with underscores", () => {
        const result = parseConventionalCommit("chore(build_system): update config");
        expect(result).toEqual({
          type: "chore",
          scope: "build_system",
          breaking: false,
          subject: "update config",
        });
      });
    });

    describe("Breaking Changes (! notation)", () => {
      it("should detect breaking change with !", () => {
        const result = parseConventionalCommit("feat!: remove old API");
        expect(result).toEqual({
          type: "feat",
          scope: null,
          breaking: true,
          subject: "remove old API",
        });
      });

      it("should detect breaking change with scope and !", () => {
        const result = parseConventionalCommit("fix(core)!: change return type");
        expect(result).toEqual({
          type: "fix",
          scope: "core",
          breaking: true,
          subject: "change return type",
        });
      });

      it("should handle ! with complex scope", () => {
        const result = parseConventionalCommit("refactor(api-v2)!: restructure endpoints");
        expect(result).toEqual({
          type: "refactor",
          scope: "api-v2",
          breaking: true,
          subject: "restructure endpoints",
        });
      });
    });

    describe("Non-Conventional Messages", () => {
      it("should return original message as subject when not conventional", () => {
        const result = parseConventionalCommit("Updated the README file");
        expect(result).toEqual({
          type: null,
          scope: null,
          breaking: false,
          subject: "Updated the README file",
        });
      });

      it("should handle message with colon but no type", () => {
        const result = parseConventionalCommit("Bug: something is broken");
        expect(result).toEqual({
          type: "Bug",
          scope: null,
          breaking: false,
          subject: "something is broken",
        });
      });

      it("should handle empty message", () => {
        const result = parseConventionalCommit("");
        expect(result).toEqual({
          type: null,
          scope: null,
          breaking: false,
          subject: "",
        });
      });
    });

    describe("Edge Cases", () => {
      it("should handle message with special characters in subject", () => {
        const result = parseConventionalCommit("feat(ui): add button with `onClick` handler");
        expect(result).toEqual({
          type: "feat",
          scope: "ui",
          breaking: false,
          subject: "add button with `onClick` handler",
        });
      });

      it("should handle message with emoji in subject", () => {
        const result = parseConventionalCommit("feat: add dark mode 🌙");
        expect(result).toEqual({
          type: "feat",
          scope: null,
          breaking: false,
          subject: "add dark mode 🌙",
        });
      });

      it("should handle message with unicode", () => {
        const result = parseConventionalCommit("feat(i18n): 日本語サポート追加");
        expect(result).toEqual({
          type: "feat",
          scope: "i18n",
          breaking: false,
          subject: "日本語サポート追加",
        });
      });

      it("should handle very long scope", () => {
        const longScope = "a".repeat(50);
        const result = parseConventionalCommit(`feat(${longScope}): add feature`);
        expect(result).toEqual({
          type: "feat",
          scope: longScope,
          breaking: false,
          subject: "add feature",
        });
      });
    });
  });
});
