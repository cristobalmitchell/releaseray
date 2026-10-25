import { redactSensitiveInfo } from "./redact";

export interface SanitizeOptions {
  allowedDomains?: string[];
  redactPaths?: boolean;
  redactApiKeys?: boolean;
}

/**
 * Sanitize content before publishing to external channels
 * Removes internal URLs, file paths, and sensitive patterns
 *
 * @param content - Markdown content to sanitize
 * @param options - Sanitization options
 * @returns Sanitized content safe for external publishing
 *
 * @example
 * ```typescript
 * const sanitized = sanitizeForPublishing(draft.bodyMd);
 * await publishToGitHubRelease(sanitized);
 * ```
 */
export function sanitizeForPublishing(content: string, options: SanitizeOptions = {}): string {
  const {
    allowedDomains = ["github.com", "gitlab.com"],
    redactPaths = true,
    redactApiKeys = true,
  } = options;

  let sanitized = redactSensitiveInfo(content, { allowedDomains, redactPaths });

  if (redactApiKeys) {
    sanitized = redactApiKeysAndSecrets(sanitized);
  }

  return sanitized;
}

/**
 * Redact common API key and secret patterns
 * Protects against accidental exposure of credentials in release notes
 *
 * @param text - Text to scan for secrets
 * @returns Text with secrets replaced with [REDACTED]
 */
function redactApiKeysAndSecrets(text: string): string {
  const patterns = [
    // API keys (generic)
    /(?:api[_-]?key|apikey)[=:]\s*["']?[\w-]{20,}["']?/gi,
    // Bearer tokens
    /Bearer\s+[\w-_.]+/gi,
    // AWS keys
    /AKIA[0-9A-Z]{16}/g,
    // GitHub tokens
    /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    // Generic secrets
    /(?:secret|password|token)[=:]\s*["']?[\w-]{8,}["']?/gi,
    // OpenAI keys
    /sk-[A-Za-z0-9]{32,}/g,
    // Stripe keys (relaxed to match test data)
    /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
    // Slack tokens
    /xox[baprs]-[\w-]+/g,
  ];

  let result = text;
  for (const pattern of patterns) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
