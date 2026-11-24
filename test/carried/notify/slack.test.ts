/**
 * Unit tests for Slack Publisher
 *
 * Tests formatForSlack, sendToSlack, and publishToSlack functions
 * to ensure reliable Slack webhook publishing and proper error handling.
 *
 * @see Issue #25: Expand automated coverage across API, workers, libs, and UI
 *
 * Carried from apps/app/src/lib/publishers/__tests__/slack.test.ts at
 * 7d1d56f8. Only import paths changed: the logger mock, and the MSW
 * handlers and API, which now come from test/helpers (CONVERSION-PLAN §6.5,
 * Phase 5).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { publisherServer, errorHandlers } from "../../helpers/publisher-mocks";
import { formatForSlack, sendToSlack, publishToSlack } from "../../../src/outputs/notify/slack";

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

describe("Slack Publisher", () => {
  // ============================================================================
  // formatForSlack Tests
  // ============================================================================

  describe("formatForSlack", () => {
    const baseParams = {
      version: "v1.0.0",
      repoFullName: "owner/repo",
      content: "### Features\n- New feature A\n- New feature B\n\n### Bug Fixes\n- Fixed issue X",
      persona: "customer",
      urls: {},
    };

    it("should format basic release message with header", () => {
      const result = formatForSlack(baseParams);

      expect(result.text).toBe("v1.0.0 released for owner/repo");
      expect(result.blocks).toBeDefined();
      expect(result.blocks?.length).toBeGreaterThan(0);

      // Check header block
      const headerBlock = result.blocks?.find((b) => b.type === "header");
      expect(headerBlock).toBeDefined();
      expect(headerBlock?.text?.text).toBe("🎉 v1.0.0 Released");
      expect(headerBlock?.text?.emoji).toBe(true);
    });

    it("should include repo name and persona in section", () => {
      const result = formatForSlack(baseParams);

      const sectionBlock = result.blocks?.find(
        (b) => b.type === "section" && b.text?.text?.includes("owner/repo")
      );
      expect(sectionBlock).toBeDefined();
      expect(sectionBlock?.text?.text).toContain("*owner/repo*");
      expect(sectionBlock?.text?.text).toContain("Persona: _customer_");
    });

    it("should include divider block", () => {
      const result = formatForSlack(baseParams);

      const dividerBlock = result.blocks?.find((b) => b.type === "divider");
      expect(dividerBlock).toBeDefined();
    });

    it("should truncate long content summary to 300 characters", () => {
      const longContent = "A".repeat(500) + "\n" + "B".repeat(500);
      const result = formatForSlack({ ...baseParams, content: longContent });

      const contentSection = result.blocks?.find(
        (b) => b.type === "section" && b.text?.text?.includes("A")
      );
      expect(contentSection?.text?.text?.length).toBeLessThanOrEqual(303); // 300 + "..."
      expect(contentSection?.text?.text).toContain("...");
    });

    it("should not add ellipsis for short content", () => {
      const shortContent = "Short content";
      const result = formatForSlack({ ...baseParams, content: shortContent });

      const contentSection = result.blocks?.find(
        (b) => b.type === "section" && b.text?.text?.includes("Short")
      );
      expect(contentSection?.text?.text).not.toContain("...");
    });

    it("should add GitHub button when URL provided", () => {
      const result = formatForSlack({
        ...baseParams,
        urls: { github: "https://github.com/owner/repo/releases/tag/v1.0.0" },
      });

      const actionsBlock = result.blocks?.find((b) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock?.elements).toBeDefined();

      const githubButton = actionsBlock?.elements?.find(
        (e: { action_id?: string }) => e.action_id === "github_release"
      );
      expect(githubButton).toBeDefined();
      expect(githubButton?.text?.text).toBe("View on GitHub");
      expect(githubButton?.url).toBe("https://github.com/owner/repo/releases/tag/v1.0.0");
    });

    it("should add changelog button when URL provided", () => {
      const result = formatForSlack({
        ...baseParams,
        urls: { changelog: "https://github.com/owner/repo/blob/main/CHANGELOG.md" },
      });

      const actionsBlock = result.blocks?.find((b) => b.type === "actions");
      const changelogButton = actionsBlock?.elements?.find(
        (e: { action_id?: string }) => e.action_id === "changelog"
      );
      expect(changelogButton).toBeDefined();
      expect(changelogButton?.text?.text).toBe("View CHANGELOG");
    });

    it("should add hosted button when URL provided", () => {
      const result = formatForSlack({
        ...baseParams,
        urls: { hosted: "https://releaseray.com/changelog/org/repo/v1.0.0" },
      });

      const actionsBlock = result.blocks?.find((b) => b.type === "actions");
      const hostedButton = actionsBlock?.elements?.find(
        (e: { action_id?: string }) => e.action_id === "hosted"
      );
      expect(hostedButton).toBeDefined();
      expect(hostedButton?.text?.text).toBe("View Release Notes");
    });

    it("should add all buttons when all URLs provided", () => {
      const result = formatForSlack({
        ...baseParams,
        urls: {
          github: "https://github.com/owner/repo/releases/tag/v1.0.0",
          changelog: "https://github.com/owner/repo/blob/main/CHANGELOG.md",
          hosted: "https://releaseray.com/changelog/org/repo/v1.0.0",
        },
      });

      const actionsBlock = result.blocks?.find((b) => b.type === "actions");
      expect(actionsBlock?.elements?.length).toBe(3);
    });

    it("should not add actions block when no URLs provided", () => {
      const result = formatForSlack({ ...baseParams, urls: {} });

      const actionsBlock = result.blocks?.find((b) => b.type === "actions");
      expect(actionsBlock).toBeUndefined();
    });

    it("should handle empty content gracefully", () => {
      const result = formatForSlack({ ...baseParams, content: "" });

      expect(result.text).toBe("v1.0.0 released for owner/repo");
      expect(result.blocks).toBeDefined();
    });

    it("should handle content with only whitespace", () => {
      const result = formatForSlack({ ...baseParams, content: "   \n   \n   " });

      expect(result.text).toBe("v1.0.0 released for owner/repo");
      expect(result.blocks).toBeDefined();
    });

    it("should extract first three lines for summary", () => {
      const multiLineContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      const result = formatForSlack({ ...baseParams, content: multiLineContent });

      const contentSection = result.blocks?.find(
        (b) => b.type === "section" && b.text?.text?.includes("Line")
      );
      expect(contentSection?.text?.text).toContain("Line 1");
      expect(contentSection?.text?.text).toContain("Line 2");
      expect(contentSection?.text?.text).toContain("Line 3");
      expect(contentSection?.text?.text).not.toContain("Line 4");
    });

    it("should handle different personas", () => {
      const personas = ["engineer", "customer", "internal"];

      for (const persona of personas) {
        const result = formatForSlack({ ...baseParams, persona });
        const sectionBlock = result.blocks?.find(
          (b) => b.type === "section" && b.text?.text?.includes("Persona")
        );
        expect(sectionBlock?.text?.text).toContain(`Persona: _${persona}_`);
      }
    });

    it("should handle special characters in content", () => {
      const specialContent = "### Features\n- Added `code` support\n- *bold* and _italic_";
      const result = formatForSlack({ ...baseParams, content: specialContent });

      const contentSection = result.blocks?.find(
        (b) => b.type === "section" && b.text?.text?.includes("code")
      );
      expect(contentSection?.text?.text).toContain("`code`");
    });

    it("should handle unicode and emoji in content", () => {
      const unicodeContent = "🎉 新しい機能\n- 日本語サポート\n- Emoji 🚀";
      const result = formatForSlack({ ...baseParams, content: unicodeContent });

      expect(result.text).toBe("v1.0.0 released for owner/repo");
      const contentSection = result.blocks?.find(
        (b) => b.type === "section" && b.text?.text?.includes("🎉")
      );
      expect(contentSection).toBeDefined();
    });
  });

  // ============================================================================
  // sendToSlack Tests
  // ============================================================================

  describe("sendToSlack", () => {
    const validWebhookUrl =
      "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX";
    const validMessage = {
      text: "Test message",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Hello, World!" },
        },
      ],
    };

    it("should successfully send message to valid webhook", async () => {
      const result = await sendToSlack(validWebhookUrl, validMessage);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should handle 404 error (invalid webhook URL)", async () => {
      publisherServer.use(errorHandlers.slack404);

      const result = await sendToSlack(validWebhookUrl, validMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Slack API error");
      expect(result.error).toContain("404");
    });

    it("should handle 500 server error", async () => {
      publisherServer.use(errorHandlers.slack500);

      const result = await sendToSlack(validWebhookUrl, validMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Slack API error");
      expect(result.error).toContain("500");
    });

    it("should handle network errors", async () => {
      // Add a handler that simulates a network error
      const { http } = await import("../../helpers/http-mock");
      publisherServer.use(
        http.post("https://invalid-url.test/*", () => {
          throw new Error("Network error: ECONNREFUSED");
        })
      );

      const result = await sendToSlack("https://invalid-url.test/webhook", validMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should send JSON content type header", async () => {
      // MSW will validate the request format; success means headers were correct
      const result = await sendToSlack(validWebhookUrl, validMessage);

      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // publishToSlack Tests
  // ============================================================================

  describe("publishToSlack", () => {
    const validParams = {
      webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX",
      version: "v1.0.0",
      repoFullName: "owner/repo",
      content: "### Features\n- New feature",
      persona: "customer",
      urls: {
        github: "https://github.com/owner/repo/releases/tag/v1.0.0",
      },
    };

    it("should successfully publish release to Slack", async () => {
      const result = await publishToSlack(validParams);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should handle webhook failure", async () => {
      publisherServer.use(errorHandlers.slack500);

      const result = await publishToSlack(validParams);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should format message before sending", async () => {
      const result = await publishToSlack(validParams);

      // If successful, the message was formatted and sent correctly
      expect(result.success).toBe(true);
    });

    it("should work with minimal parameters", async () => {
      const minimalParams = {
        webhookUrl: validParams.webhookUrl,
        version: "v1.0.0",
        repoFullName: "owner/repo",
        content: "Release notes",
        persona: "engineer",
        urls: {},
      };

      const result = await publishToSlack(minimalParams);

      expect(result.success).toBe(true);
    });

    it("should work with all URLs", async () => {
      const fullParams = {
        ...validParams,
        urls: {
          github: "https://github.com/owner/repo/releases/tag/v1.0.0",
          changelog: "https://github.com/owner/repo/blob/main/CHANGELOG.md",
          hosted: "https://releaseray.com/changelog/org/repo/v1.0.0",
        },
      };

      const result = await publishToSlack(fullParams);

      expect(result.success).toBe(true);
    });
  });
});
