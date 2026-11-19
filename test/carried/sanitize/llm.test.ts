/**
 * Carried from packages/shared/src/utils/__tests__/llm-sanitize.test.ts at 7d1d56f8.
 * The sanitizeForStorage cases retired with the function. Token-shaped
 * fixtures are assembled at runtime (CONVERSION-PLAN §10.6).
 */
import { describe, it, expect } from "vitest";
import { EYJ, GHP, SK_LIVE, XOXB } from "../../helpers/secret-fixtures";
import {
  sanitizeForLLM,
  sanitizeCommentForLLM,
  sanitizeCommitForLLM,
} from "../../../src/core/sanitize/llm";

describe("sanitizeForLLM", () => {
  describe("code block removal", () => {
    it("should remove code blocks", () => {
      const input = `
Fixed authentication bug

\`\`\`typescript
const apiKey = "${SK_LIVE}1234567890";
const token = "very_secret_token";
\`\`\`
`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[code block removed]");
      expect(output).not.toContain("sk_live");
      expect(output).not.toContain("very_secret_token");
    });

    it("should remove multiple code blocks", () => {
      const input = `
\`\`\`bash
export API_KEY=secret123
\`\`\`

Some text

\`\`\`javascript
const password = "admin123";
\`\`\`
`;
      const output = sanitizeForLLM(input);
      const blockCount = (output.match(/\[code block removed\]/g) || []).length;
      expect(blockCount).toBe(2);
      expect(output).not.toContain("secret123");
      expect(output).not.toContain("admin123");
    });
  });

  describe("inline code with secrets", () => {
    it("should redact inline code with 'key' keyword", () => {
      const input = "Set `api_key=sk_test_12345` in your config";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("sk_test_12345");
    });

    it("should redact inline code with 'token' keyword", () => {
      const input = `Use \`github_token=${GHP}abc123def456\` for authentication`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain(`${GHP}abc123`);
    });

    it("should redact inline code with 'secret' keyword", () => {
      const input = "Configure `client_secret=very_secret_value` first";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("very_secret_value");
    });

    it("should redact inline code with 'password' keyword", () => {
      const input = "Default `password=admin123` needs changing";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("admin123");
    });

    it("should preserve safe inline code", () => {
      const input = "Call `fetchData()` to retrieve results";
      const output = sanitizeForLLM(input);
      expect(output).toBe(input);
    });
  });

  describe("URLs with tokens in query params", () => {
    it("should redact URLs with token param", () => {
      const input = "Visit https://api.example.com/endpoint?token=abc123&foo=bar";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[url-redacted]");
      expect(output).not.toContain("token=abc123");
    });

    it("should redact URLs with key param", () => {
      const input = "Call https://example.com/api?key=secret123";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[url-redacted]");
      expect(output).not.toContain("key=secret123");
    });

    it("should redact URLs with api_key param", () => {
      const input = `Endpoint: https://api.service.com/data?api_key=${SK_LIVE}xyz`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[url-redacted]");
      expect(output).not.toContain(`${SK_LIVE}xyz`);
    });

    it("should preserve safe URLs", () => {
      const input = "See https://github.com/acme/repo/pull/123 for details";
      const output = sanitizeForLLM(input);
      expect(output).toBe(input);
    });
  });

  describe("secret pattern redaction", () => {
    it("should redact generic API keys", () => {
      const input = `Configure api_key=${SK_LIVE}1234567890abcdef in .env`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${SK_LIVE}1234567890abcdef`);
    });

    it("should redact Bearer tokens", () => {
      const input = `Authorization: Bearer ${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`);
    });

    it("should redact AWS access keys", () => {
      const input = "AWS credentials: AKIAIOSFODNN7EXAMPLE";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("should redact GitHub tokens (ghp_)", () => {
      const input = `GITHUB_TOKEN=${GHP}1234567890abcdefghijklmnopqrstuvwxyz`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${GHP}1234567890`);
    });

    it("should redact GitHub tokens (gho_)", () => {
      const input = "OAuth token: gho_abcdefghijklmnopqrstuvwxyz1234567890";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("gho_abcdefghijklmnopqrstuvwxyz");
    });

    it("should redact OpenAI API keys", () => {
      const input = "OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz";
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("sk-1234567890abcdefghijklmnopqrstuvwxyz");
    });

    it("should redact Slack tokens", () => {
      const input = `SLACK_TOKEN=${XOXB}1234567890-1234567890-abcdefghijklmnopqrstuvwx`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${XOXB}1234567890`);
    });

    it("should redact Stripe API keys", () => {
      const input = `${SK_LIVE}1234567890abcdefghijklmnopqr`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${SK_LIVE}1234567890`);
    });

    it("should redact JWT tokens", () => {
      const input = `JWT: ${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${EYJ}zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
      const output = sanitizeForLLM(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(`${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`);
    });
  });

  describe("edge cases", () => {
    it("should handle null input", () => {
      const output = sanitizeForLLM(null);
      expect(output).toBe("");
    });

    it("should handle undefined input", () => {
      const output = sanitizeForLLM(undefined);
      expect(output).toBe("");
    });

    it("should handle empty string", () => {
      const output = sanitizeForLLM("");
      expect(output).toBe("");
    });

    it("should preserve safe text", () => {
      const input = "Fixed authentication bug and improved performance";
      const output = sanitizeForLLM(input);
      expect(output).toBe(input);
    });

    it("should preserve issue/PR references", () => {
      const input = "Fixes #123, closes #456, resolves #789";
      const output = sanitizeForLLM(input);
      expect(output).toBe(input);
    });
  });

  describe("real-world PR body scenarios", () => {
    it("should sanitize a PR body with secrets in code block", () => {
      const input = `
## What Changed
Implemented OAuth2 authentication

## Setup Instructions
\`\`\`bash
export CLIENT_ID=abc123
export CLIENT_SECRET=very_secret_value
export REDIRECT_URI=https://app.example.com/callback
\`\`\`

## Testing
Test endpoint: https://api.example.com/test?token=test_token_123

Fixes #245
`;

      const output = sanitizeForLLM(input);

      // Should preserve structure and issue refs
      expect(output).toContain("## What Changed");
      expect(output).toContain("Fixes #245");

      // Should redact secrets
      expect(output).toContain("[code block removed]");
      expect(output).toContain("[url-redacted]");
      expect(output).not.toContain("very_secret_value");
      expect(output).not.toContain("test_token_123");
    });

    it("should handle PR body with inline secrets", () => {
      const input = `
Fixed bug in authentication flow

Set \`api_key=sk_test_12345\` for testing
Use \`password=admin123\` to login

See https://github.com/acme/repo/pull/251
`;

      const output = sanitizeForLLM(input);

      // Should preserve GitHub URLs and structure
      expect(output).toContain("github.com");
      expect(output).toContain("Fixed bug");

      // Should redact inline secrets
      expect(output).not.toContain("sk_test_12345");
      expect(output).not.toContain("admin123");
    });

    it("should preserve technical details while removing secrets", () => {
      const input = `
Refactored authentication middleware to support OAuth2 PKCE flow

- Added PKCE code verifier generation
- Implemented state parameter validation
- Updated token exchange endpoint

Token format: Bearer <jwt_token>
Configure with: secret=your_secret_here

Closes #245
`;

      const output = sanitizeForLLM(input);

      // Should preserve technical context
      expect(output).toContain("OAuth2 PKCE");
      expect(output).toContain("state parameter validation");
      expect(output).toContain("Closes #245");

      // Should redact secret patterns
      expect(output).not.toContain("secret=your_secret_here");
    });
  });

  describe("combined patterns", () => {
    it("should handle multiple secret types in same text", () => {
      const input = `
\`\`\`bash
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export GITHUB_TOKEN=${GHP}abcdefghijklmnopqrstuvwxyz123456
export OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz
\`\`\`

Test with Bearer ${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig
`;

      const output = sanitizeForLLM(input);

      expect(output).toContain("[code block removed]");
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(output).not.toContain(`${GHP}abcdefghijklmnopqrstuvwxyz`);
      expect(output).not.toContain("sk-1234567890");
      expect(output).not.toContain(`${EYJ}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`);
    });
  });
});

describe("sanitizeCommentForLLM", () => {
  describe("@mention anonymization", () => {
    it("should anonymize @mentions", () => {
      const input = "Thanks @john-doe for the review!";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("Thanks @[user] for the review!");
      expect(output).not.toContain("@john-doe");
    });

    it("should anonymize multiple @mentions", () => {
      const input = "cc @alice @bob @charlie";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("cc @[user] @[user] @[user]");
    });

    it("should preserve bot mentions", () => {
      const input = "Thanks @dependabot[bot] for the update!";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("dependabot[bot]");
    });

    it("should preserve bot mentions with different names", () => {
      const input = "Review by @github-actions[bot]";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("github-actions[bot]");
    });
  });

  describe("email redaction", () => {
    it("should redact email addresses", () => {
      const input = "Contact john@example.com for details";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("Contact [email] for details");
      expect(output).not.toContain("john@example.com");
    });

    it("should redact multiple email addresses", () => {
      const input = "Send to alice@test.org or bob@company.io";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("Send to [email] or [email]");
    });
  });

  describe("internal URL filtering", () => {
    it("should filter localhost URLs", () => {
      const input = "See http://localhost:3000/api/test for testing";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("[internal-url]");
      expect(output).not.toContain("localhost:3000");
    });

    it("should filter 127.0.0.1 URLs", () => {
      const input = "Access https://127.0.0.1:8080/dashboard";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("[internal-url]");
      expect(output).not.toContain("127.0.0.1");
    });

    it("should filter 192.168.x.x URLs", () => {
      const input = "Internal server: http://192.168.1.100/api";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("[internal-url]");
      expect(output).not.toContain("192.168.1.100");
    });

    it("should filter 10.x.x.x URLs", () => {
      const input = "VPN URL: https://10.0.0.50:443/connect";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("[internal-url]");
      expect(output).not.toContain("10.0.0.50");
    });

    it("should preserve public URLs", () => {
      const input = "See https://github.com/acme/repo/pull/123 for details";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("https://github.com/acme/repo/pull/123");
    });
  });

  describe("file path removal", () => {
    it("should remove file paths", () => {
      const input = "Check /Users/john/project/src/components/Button.tsx";
      const output = sanitizeCommentForLLM(input);
      expect(output).toContain("[file-path]");
      expect(output).not.toContain("/Users/john/project");
    });

    it("should preserve short paths", () => {
      const input = "Update the /api endpoint";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("Update the /api endpoint");
    });
  });

  describe("truncation", () => {
    it("should truncate long comments", () => {
      const input = "x".repeat(3000);
      const output = sanitizeCommentForLLM(input, 2000);
      expect(output.length).toBeLessThanOrEqual(2020); // Allow for truncation message
      expect(output).toContain("[truncated]");
    });

    it("should not truncate short comments", () => {
      const input = "This is a short comment";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("This is a short comment");
      expect(output).not.toContain("[truncated]");
    });

    it("should respect custom max length", () => {
      const input = "a".repeat(200);
      const output = sanitizeCommentForLLM(input, 100);
      expect(output.length).toBeLessThanOrEqual(120);
      expect(output).toContain("[truncated]");
    });
  });

  describe("edge cases", () => {
    it("should handle null input", () => {
      expect(sanitizeCommentForLLM(null)).toBe("");
    });

    it("should handle undefined input", () => {
      expect(sanitizeCommentForLLM(undefined)).toBe("");
    });

    it("should trim whitespace", () => {
      const input = "  Comment with whitespace  ";
      const output = sanitizeCommentForLLM(input);
      expect(output).toBe("Comment with whitespace");
    });
  });

  describe("real-world comment scenarios", () => {
    it("should sanitize a review comment", () => {
      const input = `
Great work @john-doe! This looks good to me.

A few suggestions:
- Consider using /src/utils/helpers.ts for the utility function
- Check http://localhost:3000/test to verify locally

Contact me at john@company.com if you have questions.

LGTM 👍
`;
      const output = sanitizeCommentForLLM(input);

      expect(output).toContain("Great work @[user]");
      expect(output).toContain("[file-path]");
      expect(output).toContain("[internal-url]");
      expect(output).toContain("[email]");
      expect(output).toContain("LGTM 👍");
      expect(output).not.toContain("@john-doe");
      expect(output).not.toContain("john@company.com");
    });
  });
});

describe("sanitizeCommitForLLM", () => {
  describe("git metadata removal", () => {
    it("should remove Co-authored-by lines", () => {
      const input = `feat: add new feature

Implemented the new feature

Co-authored-by: John Doe <john@example.com>
Co-authored-by: Jane Smith <jane@example.com>`;

      const output = sanitizeCommitForLLM(input);

      expect(output).toContain("feat: add new feature");
      expect(output).toContain("Implemented the new feature");
      expect(output).not.toContain("Co-authored-by");
      expect(output).not.toContain("john@example.com");
      expect(output).not.toContain("jane@example.com");
    });

    it("should remove Signed-off-by lines", () => {
      const input = `fix: resolve bug

Fixed the issue

Signed-off-by: Developer Name <dev@company.com>`;

      const output = sanitizeCommitForLLM(input);

      expect(output).toContain("fix: resolve bug");
      expect(output).not.toContain("Signed-off-by");
      expect(output).not.toContain("dev@company.com");
    });

    it("should remove Reviewed-by lines", () => {
      const input = `chore: update deps

Updated dependencies

Reviewed-by: Reviewer <reviewer@test.com>`;

      const output = sanitizeCommitForLLM(input);

      expect(output).not.toContain("Reviewed-by");
      expect(output).not.toContain("reviewer@test.com");
    });

    it("should remove Acked-by lines", () => {
      const input = `feat: important change

Description here

Acked-by: Manager <manager@corp.com>`;

      const output = sanitizeCommitForLLM(input);

      expect(output).not.toContain("Acked-by");
      expect(output).not.toContain("manager@corp.com");
    });

    it("should remove Cc lines", () => {
      const input = `fix: critical fix

Fixed the issue

Cc: team@company.com, lead@company.com`;

      const output = sanitizeCommitForLLM(input);

      expect(output).not.toContain("Cc:");
      expect(output).not.toContain("team@company.com");
    });
  });

  describe("combined scenarios", () => {
    it("should handle a full commit message with multiple metadata", () => {
      const input = `feat(auth): implement OAuth2 support (#123)

Added OAuth2 authentication with the following features:
- PKCE flow support
- Token refresh mechanism
- Multiple provider support

Testing locally at http://localhost:3000/auth/callback

Fixes: #123
Related: #456

Co-authored-by: Alice <alice@example.com>
Co-authored-by: Bob <bob@example.com>
Signed-off-by: Developer <dev@company.com>
Reviewed-by: Manager <manager@company.com>`;

      const output = sanitizeCommitForLLM(input);

      // Should preserve commit content
      expect(output).toContain("feat(auth): implement OAuth2 support");
      expect(output).toContain("PKCE flow support");
      expect(output).toContain("Token refresh mechanism");
      expect(output).toContain("Fixes: #123");

      // Should remove metadata with emails
      expect(output).not.toContain("Co-authored-by");
      expect(output).not.toContain("Signed-off-by");
      expect(output).not.toContain("Reviewed-by");
      expect(output).not.toContain("alice@example.com");
      expect(output).not.toContain("bob@example.com");
      expect(output).not.toContain("dev@company.com");

      // Should sanitize internal URL
      expect(output).toContain("[internal-url]");
      expect(output).not.toContain("localhost:3000");
    });
  });

  describe("edge cases", () => {
    it("should handle null input", () => {
      expect(sanitizeCommitForLLM(null)).toBe("");
    });

    it("should handle undefined input", () => {
      expect(sanitizeCommitForLLM(undefined)).toBe("");
    });

    it("should handle simple commit messages", () => {
      const input = "fix: resolve null pointer exception";
      const output = sanitizeCommitForLLM(input);
      expect(output).toBe("fix: resolve null pointer exception");
    });

    it("should collapse multiple newlines from removed lines", () => {
      const input = `feat: add feature


Description

Co-authored-by: Test <test@test.com>


Signed-off-by: Test <test@test.com>


End`;

      const output = sanitizeCommitForLLM(input);

      // Should not have more than 2 consecutive newlines
      expect(output).not.toMatch(/\n{3,}/);
    });
  });
});
