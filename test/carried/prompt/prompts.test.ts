/**
 * Unit tests for LLM Prompt Templates
 *
 * Tests prompt validation, generation input validation, and prompt constants.
 *
 * Carried from packages/shared/src/prompts/index.test.ts at 7d1d56f8.
 */

import { describe, it, expect } from "vitest";
import {
  PROMPT_VERSION,
  GENERATION_THRESHOLDS,
  validateGenerationInput,
} from "../../../src/core/prompt/build";
import { SYSTEM_PROMPT } from "../../../src/core/prompt/templates";

describe("Prompt Constants", () => {
  it("should have valid prompt version", () => {
    expect(PROMPT_VERSION).toBeDefined();
    expect(PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have non-empty system prompt", () => {
    expect(SYSTEM_PROMPT).toBeDefined();
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
    // Edited (CONVERSION-PLAN §6.2): the prompt no longer names the product.
    expect(SYSTEM_PROMPT).not.toContain("ReleaseRay");
  });

  it("should have anti-hallucination rules in system prompt", () => {
    expect(SYSTEM_PROMPT).toContain("ANTI-HALLUCINATION");
    expect(SYSTEM_PROMPT).toContain("ONLY describe changes");
    expect(SYSTEM_PROMPT).toContain("NEVER invent");
  });
});

describe("Generation Thresholds", () => {
  it("should have reasonable minimum PR threshold", () => {
    expect(GENERATION_THRESHOLDS.MIN_PRS).toBeGreaterThanOrEqual(1);
    expect(GENERATION_THRESHOLDS.MIN_PRS).toBeLessThan(10);
  });

  it("should have warn threshold higher than minimum", () => {
    expect(GENERATION_THRESHOLDS.WARN_THRESHOLD_PRS).toBeGreaterThan(GENERATION_THRESHOLDS.MIN_PRS);
  });

  it("should have reasonable content length thresholds", () => {
    expect(GENERATION_THRESHOLDS.MIN_CONTENT_LENGTH).toBeGreaterThan(0);
    expect(GENERATION_THRESHOLDS.WARN_THRESHOLD_CONTENT).toBeGreaterThan(
      GENERATION_THRESHOLDS.MIN_CONTENT_LENGTH
    );
  });
});

describe("validateGenerationInput", () => {
  describe("Valid Cases", () => {
    it("should validate input with sufficient PRs", () => {
      const prs = [
        {
          title: "feat: Add user authentication with JWT tokens",
          body: "This PR implements user authentication using JWT tokens with refresh token rotation for enhanced security.",
        },
        {
          title: "fix: Resolve race condition in webhook processing",
          body: "Fixed a critical race condition that could cause duplicate webhook processing.",
        },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.contentLength).toBeGreaterThan(GENERATION_THRESHOLDS.MIN_CONTENT_LENGTH);
    });

    it("should validate input with sufficient commits", () => {
      const prs: Array<{ title: string; body?: string }> = [];
      const commits = [
        { message: "feat: Add new feature with comprehensive implementation details" },
        { message: "fix: Resolve bug with detailed explanation of the issue" },
        { message: "docs: Update documentation with new feature information" },
        { message: "test: Add comprehensive test coverage" },
      ];

      const result = validateGenerationInput(prs, commits);

      expect(result.valid).toBe(true);
    });

    it("should calculate correct content length", () => {
      const prs = [
        { title: "12345", body: "67890" }, // 10 chars
        { title: "ABCDE", body: "FGHIJ" }, // 10 chars
      ];

      const result = validateGenerationInput(prs);

      expect(result.contentLength).toBe(20);
    });

    it("should handle PRs with null body", () => {
      const prs = [
        { title: "feat: Add comprehensive user authentication system", body: null },
        {
          title: "fix: Fix critical bug in payment processing",
          body: "This PR resolves a critical issue with payment processing that was causing transactions to fail intermittently.",
        },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.contentLength).toBeGreaterThan(0);
    });
  });

  describe("Invalid Cases", () => {
    it("should reject when no PRs or commits", () => {
      const result = validateGenerationInput([], []);

      expect(result.valid).toBe(false);
      expect(result.warning).toContain("No PRs or commits found");
    });

    it("should reject when insufficient PRs and commits", () => {
      const prs: Array<{ title: string }> = [];
      const commits = [{ message: "fix: small fix" }]; // Only 1 commit

      const result = validateGenerationInput(prs, commits);

      expect(result.valid).toBe(false);
      expect(result.warning).toContain("Insufficient data");
    });

    it("should reject when content length too short", () => {
      const prs = [{ title: "fix", body: "." }]; // Very short content

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(false);
      expect(result.warning).toContain("Insufficient content");
    });
  });

  describe("Warning Cases", () => {
    it("should warn when PR count is low but valid", () => {
      const prs = [
        {
          title: "feat: Implement comprehensive authentication system",
          body: "This PR adds a complete authentication system with OAuth2, JWT tokens, refresh token rotation, and secure session management for enhanced user security.",
        },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.warning).toContain("Low PR count");
    });

    it("should warn when content volume is low but valid", () => {
      const prs = [
        { title: "feat: Add feature one with details", body: "Description one" },
        { title: "feat: Add feature two with details", body: "Description two" },
        { title: "feat: Add feature three", body: "Description three" },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      if (result.contentLength < GENERATION_THRESHOLDS.WARN_THRESHOLD_CONTENT) {
        expect(result.warning).toContain("Low content volume");
      }
    });

    it("should have no warning for good data", () => {
      const prs = [
        {
          title: "feat: Add comprehensive user authentication system",
          body: "This PR implements a complete authentication system with OAuth2, JWT tokens, refresh token rotation, and secure session management. It includes full test coverage and documentation.",
        },
        {
          title: "fix: Resolve critical race condition in webhook processing",
          body: "Fixed a race condition that could cause duplicate webhook events to be processed, leading to data inconsistencies. Added comprehensive locking mechanism and retry logic.",
        },
        {
          title: "feat: Add email notification system",
          body: "Implemented email notifications with customizable templates and delivery tracking via SendGrid integration. Includes support for transactional and marketing emails with full analytics.",
        },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.warning).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should handle PRs with very long bodies", () => {
      const longBody = "A".repeat(10000);
      const prs = [{ title: "feat: Long PR", body: longBody }];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.contentLength).toBeGreaterThan(10000);
    });

    it("should handle mix of PRs and commits", () => {
      const prs = [
        {
          title: "feat: Add new authentication feature",
          body: "Implemented comprehensive authentication with JWT tokens and refresh logic.",
        },
      ];
      const commits = [
        { message: "feat: Additional authentication improvements with OAuth2 support" },
        { message: "fix: Resolve token expiration issues in authentication flow" },
      ];

      const result = validateGenerationInput(prs, commits);

      expect(result.valid).toBe(true);
      expect(result.contentLength).toBeGreaterThan(0);
    });

    it("should handle empty commit messages", () => {
      const prs = [
        {
          title: "feat: Add comprehensive feature implementation",
          body: "This PR implements a complete feature with full test coverage, documentation, and extensive error handling for production use.",
        },
      ];
      const commits = [{ message: "" }, { message: "" }];

      const result = validateGenerationInput(prs, commits);

      expect(result.valid).toBe(true);
    });

    it("should handle undefined vs null body", () => {
      const prs = [
        {
          title: "feat: Implement comprehensive user authentication system",
          body: undefined as any,
        },
        { title: "feat: Add OAuth2 integration with multiple providers", body: null },
        {
          title: "feat: Implement complete session management",
          body: "Full session management with Redis-backed storage and automatic cleanup.",
        },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.contentLength).toBeGreaterThan(0);
    });

    it("should handle special characters in content", () => {
      const prs = [
        {
          title: "feat: Add 🚀 emoji support with comprehensive internationalization",
          body: "Adds emoji support with unicode characters: 你好世界 Привет мир. Includes full RTL support, bidirectional text handling, and comprehensive character encoding for international users.",
        },
      ];

      const result = validateGenerationInput(prs);

      expect(result.valid).toBe(true);
      expect(result.contentLength).toBeGreaterThan(0);
    });
  });
});
