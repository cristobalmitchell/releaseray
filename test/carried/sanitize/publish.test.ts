/**
 * Carried from apps/app/src/lib/publishers/__tests__/sanitize.test.ts at 7d1d56f8.
 * Token-shaped fixtures are assembled at runtime (CONVERSION-PLAN §10.6).
 */
import { describe, it, expect } from "vitest";
import { EYJ, GHP, SK_LIVE, XOXB } from "../../helpers/secret-fixtures";
import { sanitizeForPublishing } from "../../../src/core/sanitize/publish";

describe("sanitizeForPublishing", () => {
  describe("internal URL redaction", () => {
    it("should redact internal Slack URLs", () => {
      const input = "Check https://acme.slack.com/archives/C123456 for discussion";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("slack.com");
    });

    it("should redact internal Jira URLs", () => {
      const input = "Fixed bug from https://acme.atlassian.net/browse/PROJ-123";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("atlassian.net");
    });

    it("should redact internal Linear URLs", () => {
      const input = "Implemented https://linear.app/acme/issue/ENG-456";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("linear.app");
    });

    it("should preserve GitHub URLs", () => {
      const input = "See https://github.com/acme/repo/pull/123 for details";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("github.com");
      expect(output).not.toContain("[redacted]");
    });

    it("should preserve GitLab URLs", () => {
      const input = "Merged https://gitlab.com/acme/repo/-/merge_requests/456";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("gitlab.com");
      expect(output).not.toContain("[redacted]");
    });

    it("should allow custom allowed domains", () => {
      const input = "Check https://docs.acme.com/guide for instructions";
      const output = sanitizeForPublishing(input, {
        allowedDomains: ["docs.acme.com"],
      });
      expect(output).toContain("docs.acme.com");
      expect(output).not.toContain("[redacted]");
    });
  });

  describe("file path redaction", () => {
    it("should redact absolute file paths", () => {
      const input = "Modified /src/components/Button.tsx";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[path]");
      expect(output).not.toContain("/src/components");
    });

    it("should redact relative file paths", () => {
      const input = "Updated packages/shared/utils/index.ts";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[path]");
      expect(output).not.toContain("packages/shared");
    });

    it("should not redact when redactPaths is false", () => {
      const input = "Modified /src/components/Button.tsx";
      const output = sanitizeForPublishing(input, { redactPaths: false });
      expect(output).toContain("/src/components");
    });
  });

  describe("API key and secret redaction", () => {
    it("should redact generic API keys", () => {
      const input = `Use api_key=${SK_LIVE}1234567890abcdefghij in config`;
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${SK_LIVE}1234567890abcdefghij`);
    });

    it("should redact Bearer tokens", () => {
      const input = `Authorization: Bearer ${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`;
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`);
    });

    it("should redact AWS access keys", () => {
      const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("should redact GitHub tokens", () => {
      const input = `GITHUB_TOKEN=${GHP}1234567890abcdefghijklmnopqrstuvwxyz`;
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${GHP}1234567890abcdefghijklmnopqrstuvwxyz`);
    });

    it("should redact OpenAI API keys", () => {
      const input = "OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz";
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("sk-1234567890abcdefghijklmnopqrstuvwxyz");
    });

    it("should redact Stripe API keys", () => {
      const input = `STRIPE_SECRET_KEY=${SK_LIVE}1234567890abcdefghijklmn`;
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${SK_LIVE}1234567890abcdefghijklmn`);
    });

    it("should redact Slack tokens", () => {
      const input = `SLACK_TOKEN=${XOXB}1234567890-1234567890-abcdefghijklmnopqrstuvwx`;
      const output = sanitizeForPublishing(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${XOXB}1234567890`);
    });

    it("should not redact when redactApiKeys is false", () => {
      const input = "Use api_key=sk_test_12345 in config";
      const output = sanitizeForPublishing(input, { redactApiKeys: false });
      expect(output).toContain("sk_test_12345");
    });
  });

  describe("combined scenarios", () => {
    it("should handle text with multiple redaction types", () => {
      const input = `
        Fixed bug in /src/auth/login.ts
        See https://acme.slack.com/archives/C123456
        API key: ${SK_LIVE}1234567890abcdefghij
        Reference: https://github.com/acme/repo/pull/123
      `;
      const output = sanitizeForPublishing(input);

      // Should redact
      expect(output).toContain("[path]");
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("/src/auth");
      expect(output).not.toContain("slack.com");
      expect(output).not.toContain(`${SK_LIVE}1234567890`);

      // Should preserve
      expect(output).toContain("github.com");
    });

    it("should preserve PR references and issue numbers", () => {
      const input = "Fixes #123, closes #456, see PR #789";
      const output = sanitizeForPublishing(input);
      expect(output).toBe(input); // Should remain unchanged
    });

    it("should handle empty strings", () => {
      const output = sanitizeForPublishing("");
      expect(output).toBe("");
    });

    it("should handle text with no sensitive data", () => {
      const input = "Fixed authentication bug and improved performance";
      const output = sanitizeForPublishing(input);
      expect(output).toBe(input);
    });
  });

  describe("real-world release notes", () => {
    it("should sanitize a typical engineer release note", () => {
      const input = `
## Features
- Implemented OAuth2 PKCE flow in /src/auth/oauth.ts (#245)
- Added Redis session store - check https://acme.slack.com/C123 for config
- Configure with REDIS_URL=redis://localhost:6379 and REDIS_TOKEN=${SK_LIVE}abc123

## Bug Fixes
- Fixed race condition in webhook processor (#251)
- See https://github.com/acme/repo/pull/251 for details
`;

      const output = sanitizeForPublishing(input);

      // Should preserve structure and GitHub URLs
      expect(output).toContain("## Features");
      expect(output).toContain("## Bug Fixes");
      expect(output).toContain("github.com");
      expect(output).toContain("#245");
      expect(output).toContain("#251");

      // Should redact sensitive data
      expect(output).not.toContain("/src/auth/oauth.ts");
      expect(output).not.toContain("slack.com");
      expect(output).not.toContain(`${SK_LIVE}abc123`);
    });
  });
});
