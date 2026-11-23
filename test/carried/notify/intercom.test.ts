/**
 * Unit tests for Intercom Publisher
 *
 * Tests publishToIntercom function for creating and updating
 * articles in Intercom Help Center with proper error handling.
 *
 * @see Issue #25: Expand automated coverage across API, workers, libs, and UI
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/
 *
 * Carried from apps/app/src/lib/publishers/__tests__/intercom.test.ts at
 * 7d1d56f8. Only import paths changed: the logger mock, and the MSW
 * handlers and API, which now come from test/helpers (CONVERSION-PLAN §6.5,
 * Phase 5).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "../../helpers/http-mock";
import { publisherServer, errorHandlers } from "../../helpers/publisher-mocks";
import { publishToIntercom } from "../../../src/outputs/notify/intercom";

// Mock logger to avoid console noise in tests
vi.mock("../../../src/core/logger", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

// Start MSW server before all tests
beforeAll(() => publisherServer.listen({ onUnhandledRequest: "error" }));

// Reset handlers after each test
afterEach(() => {
  publisherServer.resetHandlers();
  vi.clearAllMocks();
});

// Clean up after all tests
afterAll(() => publisherServer.close());

describe("Intercom Publisher", () => {
  // ============================================================================
  // Test Data
  // ============================================================================

  const validParams = {
    apiKey: "test-api-key",
    collectionId: "collection-123",
    title: "Release v1.0.0",
    body: "## Features\n- New feature A\n- New feature B\n\n## Bug Fixes\n- Fixed issue X",
    version: "v1.0.0",
    repoFullName: "owner/repo",
    state: "published" as const,
  };

  // ============================================================================
  // Success Cases - Create New Article
  // ============================================================================

  describe("Create New Article", () => {
    it("should successfully create a new article", async () => {
      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(true);
      expect(result.articleId).toBeDefined();
      expect(result.url).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("should return article URL from API response", async () => {
      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(true);
      expect(result.url).toContain("https://");
    });

    it("should convert markdown to HTML before sending", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "# Heading\n\n- List item 1\n- List item 2",
      });

      expect(result.success).toBe(true);
      // Markdown was converted to HTML (verified by successful API call)
    });

    it("should include optional description when provided", async () => {
      const result = await publishToIntercom({
        ...validParams,
        description: "Latest release notes for v1.0.0",
      });

      expect(result.success).toBe(true);
    });

    it("should include author ID when provided", async () => {
      const result = await publishToIntercom({
        ...validParams,
        authorId: 12345,
      });

      expect(result.success).toBe(true);
    });

    it("should default to draft state when not specified", async () => {
      const paramsWithoutState = {
        apiKey: validParams.apiKey,
        collectionId: validParams.collectionId,
        title: validParams.title,
        body: validParams.body,
        version: validParams.version,
        repoFullName: validParams.repoFullName,
      };

      const result = await publishToIntercom(paramsWithoutState);

      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // Success Cases - Update Existing Article
  // ============================================================================

  describe("Update Existing Article", () => {
    it("should update existing article when title matches", async () => {
      // Override the list handler to return an existing article
      publisherServer.use(
        http.get("https://api.intercom.io/articles", () => {
          return HttpResponse.json({
            type: "list",
            data: [
              {
                id: "existing-article-123",
                type: "article",
                title: "Release v1.0.0",
                body: "<p>Old content</p>",
                state: "published",
              },
            ],
            total_count: 1,
            pages: {
              type: "pages",
              page: 1,
              per_page: 50,
              total_pages: 1,
            },
          });
        })
      );

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(true);
      expect(result.articleId).toBeDefined();
    });

    it("should create new article when title does not match existing", async () => {
      // Override the list handler to return different title
      publisherServer.use(
        http.get("https://api.intercom.io/articles", () => {
          return HttpResponse.json({
            type: "list",
            data: [
              {
                id: "other-article-123",
                type: "article",
                title: "Different Title",
                body: "<p>Different content</p>",
                state: "published",
              },
            ],
            total_count: 1,
            pages: {
              type: "pages",
              page: 1,
              per_page: 50,
              total_pages: 1,
            },
          });
        })
      );

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(true);
      expect(result.articleId).toBeDefined();
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe("Error Handling", () => {
    it("should handle 401 unauthorized (invalid API key)", async () => {
      publisherServer.use(errorHandlers.intercom401);

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Intercom API error");
      expect(result.error).toContain("401");
    });

    it("should handle 403 forbidden (insufficient permissions)", async () => {
      publisherServer.use(errorHandlers.intercom403);

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Intercom API error");
      expect(result.error).toContain("403");
    });

    it("should handle 404 not found (collection not found)", async () => {
      publisherServer.use(errorHandlers.intercom404);

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Intercom API error");
      expect(result.error).toContain("404");
    });

    it("should handle 500 server error", async () => {
      publisherServer.use(errorHandlers.intercom500);

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Intercom API error");
      expect(result.error).toContain("500");
    });

    it("should gracefully handle article search failure", async () => {
      // Make article search fail, but article creation should still work
      publisherServer.use(
        http.get("https://api.intercom.io/articles", () => {
          return new HttpResponse("Internal Server Error", { status: 500 });
        })
      );

      const result = await publishToIntercom(validParams);

      // Should still succeed by creating a new article (search failure is non-fatal)
      expect(result.success).toBe(true);
    });

    it("should return error message for unknown errors", async () => {
      // Simulate network error by making both endpoints fail
      publisherServer.use(
        http.get("https://api.intercom.io/articles", () => {
          throw new Error("Network error");
        }),
        http.post("https://api.intercom.io/articles", () => {
          throw new Error("Network error");
        })
      );

      const result = await publishToIntercom(validParams);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ============================================================================
  // Markdown to HTML Conversion
  // ============================================================================

  describe("Markdown Conversion", () => {
    it("should convert headers to HTML", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "# H1\n## H2\n### H3",
      });

      expect(result.success).toBe(true);
    });

    it("should convert lists to HTML", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "- Item 1\n- Item 2\n\n1. First\n2. Second",
      });

      expect(result.success).toBe(true);
    });

    it("should convert code blocks to HTML", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "```javascript\nconst x = 1;\n```",
      });

      expect(result.success).toBe(true);
    });

    it("should convert inline formatting to HTML", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "**bold** and _italic_ and `code`",
      });

      expect(result.success).toBe(true);
    });

    it("should convert links to HTML", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "[Link text](https://example.com)",
      });

      expect(result.success).toBe(true);
    });

    it("should handle tables (GFM)", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "| Col1 | Col2 |\n|------|------|\n| A    | B    |",
      });

      expect(result.success).toBe(true);
    });

    it("should handle unicode and emoji", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "🎉 新しい機能\n- 日本語サポート\n- Emoji support 🚀",
      });

      expect(result.success).toBe(true);
    });

    it("should handle empty body", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "",
      });

      expect(result.success).toBe(true);
    });

    it("should handle body with only whitespace", async () => {
      const result = await publishToIntercom({
        ...validParams,
        body: "   \n   \n   ",
      });

      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    it("should handle very long body content", async () => {
      const longBody = "# Release Notes\n\n" + "- Feature ".repeat(1000);

      const result = await publishToIntercom({
        ...validParams,
        body: longBody,
      });

      expect(result.success).toBe(true);
    });

    it("should handle special characters in title", async () => {
      const result = await publishToIntercom({
        ...validParams,
        title: "Release v1.0.0 - Bug Fixes & Features (Alpha)",
      });

      expect(result.success).toBe(true);
    });

    it("should handle version with v prefix", async () => {
      const result = await publishToIntercom({
        ...validParams,
        version: "v1.0.0",
      });

      expect(result.success).toBe(true);
    });

    it("should handle version without v prefix", async () => {
      const result = await publishToIntercom({
        ...validParams,
        version: "1.0.0",
      });

      expect(result.success).toBe(true);
    });

    it("should handle repo full name with org", async () => {
      const result = await publishToIntercom({
        ...validParams,
        repoFullName: "my-organization/my-repo",
      });

      expect(result.success).toBe(true);
    });
  });
});
