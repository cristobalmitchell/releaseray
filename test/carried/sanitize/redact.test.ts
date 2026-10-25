/**
 * Unit tests for Shared Utilities
 *
 * Tests redaction utilities.
 *
 * Carried from packages/shared/src/utils/index.test.ts at 7d1d56f8. The crypto
 * cases retired with ./crypto.
 */

import { describe, it, expect } from "vitest";
import {
  redactInternalLinks,
  redactFilePaths,
  redactSensitiveInfo,
} from "../../../src/core/sanitize/redact";

describe("Shared Utilities", () => {
  // ============================================================================
  // redactInternalLinks Tests
  // ============================================================================

  describe("redactInternalLinks", () => {
    it("should preserve GitHub URLs", () => {
      const text = "Check https://github.com/org/repo for details";
      const result = redactInternalLinks(text);
      expect(result).toContain("https://github.com/org/repo");
    });

    it("should preserve GitLab URLs", () => {
      const text = "See https://gitlab.com/org/repo";
      const result = redactInternalLinks(text);
      expect(result).toContain("https://gitlab.com/org/repo");
    });

    it("should redact internal URLs", () => {
      const text = "View at https://internal.company.com/dashboard";
      const result = redactInternalLinks(text);
      expect(result).toBe("View at [redacted]");
    });

    it("should allow custom domains", () => {
      const text = "Check https://docs.example.com/guide";
      const result = redactInternalLinks(text, ["example.com"]);
      expect(result).toContain("https://docs.example.com/guide");
    });

    it("should redact multiple URLs", () => {
      const text = "Visit https://internal.com and https://secret.net";
      const result = redactInternalLinks(text);
      expect(result).toBe("Visit [redacted] and [redacted]");
    });

    it("should handle invalid URLs", () => {
      const text = "Invalid: http://[invalid";
      const result = redactInternalLinks(text);
      expect(result).toBe("Invalid: [redacted]");
    });

    it("should handle URLs in markdown", () => {
      const text = "[Link](https://internal.com/path)";
      const result = redactInternalLinks(text);
      // The closing paren is part of the URL match
      expect(result).toBe("[Link]([redacted])");
    });
  });

  // ============================================================================
  // redactFilePaths Tests
  // ============================================================================

  describe("redactFilePaths", () => {
    it("should redact Unix paths", () => {
      const text = "File at /home/user/project/src/index.ts";
      const result = redactFilePaths(text);
      expect(result).toContain("[path]");
      expect(result).not.toContain("/home/user");
    });

    it("should redact relative paths", () => {
      const text = "Import from src/utils/helper.js";
      const result = redactFilePaths(text);
      expect(result).toContain("[path]");
    });

    it("should redact nested paths", () => {
      const text = "Check apps/web/src/components/Button.tsx";
      const result = redactFilePaths(text);
      expect(result).toContain("[path]");
    });

    it("should preserve non-path text", () => {
      const text = "This is a sentence without paths";
      const result = redactFilePaths(text);
      expect(result).toBe(text);
    });
  });

  // ============================================================================
  // redactSensitiveInfo Tests
  // ============================================================================

  describe("redactSensitiveInfo", () => {
    it("should redact both URLs and paths by default", () => {
      const text = "File at /home/user/file.txt and https://internal.com";
      const result = redactSensitiveInfo(text);
      expect(result).toContain("[path]");
      expect(result).toContain("[redacted]");
    });

    it("should preserve allowed domains", () => {
      const text = "Check https://github.com/org/repo";
      const result = redactSensitiveInfo(text, { redactPaths: false });
      expect(result).toContain("https://github.com/org/repo");
    });

    it("should skip path redaction when disabled", () => {
      const text = "File at src/index.ts";
      const result = redactSensitiveInfo(text, { redactPaths: false });
      expect(result).toBe(text);
    });

    it("should use custom allowed domains", () => {
      const text = "Visit https://docs.example.com/api";
      const result = redactSensitiveInfo(text, {
        allowedDomains: ["example.com"],
        redactPaths: false,
      });
      expect(result).toContain("https://docs.example.com/api");
    });

    it("should handle complex text", () => {
      const text = `Check https://github.com/org/repo for the code.`;
      const result = redactSensitiveInfo(text, { redactPaths: false });
      expect(result).toContain("github.com");
    });
  });
});
