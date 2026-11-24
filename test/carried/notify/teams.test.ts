/**
 * Integration tests for Microsoft Teams Publisher
 *
 * Tests the Teams webhook integration with mocked HTTP responses
 * to ensure reliable publishing and proper error handling.
 *
 * Carried from apps/app/src/server/publish/__tests__/teams.test.ts at
 * 7d1d56f8. Only import paths changed: the MSW handlers and API now come
 * from test/helpers (CONVERSION-PLAN §6.5, Phase 5).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { publisherServer, errorHandlers } from "../../helpers/publisher-mocks";
import { publishToTeams } from "../../../src/outputs/notify/teams";

// Start MSW server before all tests
beforeAll(() => publisherServer.listen({ onUnhandledRequest: "error" }));

// Reset handlers after each test
afterEach(() => publisherServer.resetHandlers());

// Clean up after all tests
afterAll(() => publisherServer.close());

describe("Teams Publisher", () => {
  const validOptions = {
    title: "Release v1.0.0",
    body: "## Features\n- New authentication system\n- Improved dashboard\n\n## Bug Fixes\n- Fixed memory leak",
    version: "v1.0.0",
    repoName: "owner/repo",
    webhookUrl:
      "https://company.webhook.office.com/webhookb2/GUID@TENANT-GUID/IncomingWebhook/CHANNEL-ID/CONNECTOR-ID",
    compareUrl: "https://github.com/owner/repo/compare/v0.9.0...v1.0.0",
    releaseUrl: "https://github.com/owner/repo/releases/tag/v1.0.0",
  };

  describe("Success Cases", () => {
    it("should successfully publish to valid webhook URL", async () => {
      const result = await publishToTeams(validOptions);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should create Adaptive Card payload", async () => {
      // The actual formatting is tested implicitly by the API accepting the payload
      const result = await publishToTeams(validOptions);

      expect(result.success).toBe(true);
    });

    it("should handle missing optional fields", async () => {
      const result = await publishToTeams({
        title: "Release v1.0.0",
        body: "Simple release notes",
        version: "v1.0.0",
        repoName: "owner/repo",
        webhookUrl: validOptions.webhookUrl,
        // No compareUrl or releaseUrl
      });

      expect(result.success).toBe(true);
    });

    it("should truncate long content", async () => {
      const longBody = "# Feature\n" + "This is a very long feature description. ".repeat(200);

      const result = await publishToTeams({
        ...validOptions,
        body: longBody,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle 404 (invalid webhook URL)", async () => {
      publisherServer.use(errorHandlers.teams404);

      const result = await publishToTeams(validOptions);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("404");
    });

    it("should handle 500 (Teams service error)", async () => {
      publisherServer.use(errorHandlers.teams500);

      const result = await publishToTeams(validOptions);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("500");
    });

    it("should handle missing webhook URL", async () => {
      const result = await publishToTeams({
        ...validOptions,
        webhookUrl: undefined,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("webhook");
    });

    it("should validate webhook URL format", async () => {
      const result = await publishToTeams({
        ...validOptions,
        webhookUrl: "not-a-valid-url",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty body", async () => {
      const result = await publishToTeams({
        ...validOptions,
        body: "",
      });

      expect(result.success).toBe(true);
    });

    it("should handle markdown with special characters", async () => {
      const result = await publishToTeams({
        ...validOptions,
        body: "## Special Characters\n- `code`\n- **bold**\n- _italic_\n- [link](url)",
      });

      expect(result.success).toBe(true);
    });

    it("should handle unicode and emoji", async () => {
      const result = await publishToTeams({
        ...validOptions,
        body: "🎉 新しい機能 ✨\n- 日本語サポート\n- Emoji support 🚀",
      });

      expect(result.success).toBe(true);
    });
  });
});
