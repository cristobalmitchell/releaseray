/**
 * Sanitization of PR, issue, comment and commit text before it reaches the LLM.
 *
 * Lifted from packages/shared/src/utils/llm-sanitize.ts at 7d1d56f8, with
 * these fixes (CONVERSION-PLAN PD-25, §10.2):
 * - emails are redacted before mentions, so `john@example.com` no longer
 *   becomes `john@[user].com`;
 * - bot handles such as `@dependabot[bot]` are kept whole;
 * - the file-path rule no longer eats the path of a public URL;
 * - the secret rule needs `=` or `:` after the keyword, so prose such as
 *   "Token refresh mechanism" survives;
 * - HTML comments, zero-width characters and bidirectional controls are
 *   removed, and the input delimiter cannot be smuggled in;
 * - titles get their own sanitizer.
 *
 * `sanitizeForStorage` had no production caller and was not lifted.
 */

/** Zero-width characters and bidirectional controls that can hide text. */
const HIDDEN_CHARACTERS =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u061C\u00AD]/g;

/** Opening or closing tag of the prompt's input block, in any spacing or case. */
const INPUT_DELIMITER = /<\s*\/?\s*untrusted_input_json\s*>/gi;

/**
 * Shapes of credentials: keyword assignments, bearer tokens, and AWS, GitHub,
 * OpenAI, Slack, Stripe and JWT tokens. Global, for use with `replace`.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // Generic API keys and secrets (long alphanumeric strings with common keywords)
  /(?:api[_-]?key|apikey|secret|password|token|auth)[=:]["']?[\w-]{16,}["']?/gi,
  // Bearer tokens
  /Bearer\s+[\w-_.]+/gi,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // GitHub tokens (classic and fine-grained)
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // OpenAI API keys
  /sk-[A-Za-z0-9]{32,}/g,
  // Slack tokens
  /xox[baprs]-[\w-]+/g,
  // Stripe API keys
  /[rs]k_(?:live|test)_[A-Za-z0-9]{24,}/g,
  // Generic JWT tokens (3 base64 segments separated by dots)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/**
 * Removes text a reader cannot see: HTML comments, zero-width characters and
 * bidirectional controls. Also neutralizes the prompt's input delimiter.
 *
 * @param text - Raw text
 * @returns Text without hidden content
 */
export function stripHiddenText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(HIDDEN_CHARACTERS, "")
    .replace(INPUT_DELIMITER, "[delimiter removed]");
}

/**
 * Sanitize PR/issue content before sending to LLM
 * Removes patterns that could contain secrets to protect against accidental exposure
 *
 * @param text - PR/issue title or body text
 * @returns Sanitized text safe for LLM processing
 *
 * @example
 * ```typescript
 * const sanitized = sanitizeForLLM(pr.body);
 * await callLLM(sanitized);
 * ```
 */
export function sanitizeForLLM(text: string | null | undefined): string {
  if (!text) return "";

  let sanitized = stripHiddenText(text);

  // Remove code blocks that might contain secrets
  // Preserves that there was code, but removes the actual content
  sanitized = sanitized.replace(/```[\s\S]*?```/g, "[code block removed]");

  // Remove inline code with secret-like patterns
  // Looks for backtick code containing words like "key", "token", etc.
  sanitized = sanitized.replace(/`[^`]*(?:key|token|secret|password|api)[^`]*`/gi, "[redacted]");

  // Remove URLs with tokens/keys in query params
  // Example: https://api.example.com?token=abc123
  sanitized = sanitized.replace(
    /https?:\/\/[^\s]*[?&](?:token|key|secret|api_key)=[^\s&]*/gi,
    "[url-redacted]"
  );

  // Remove common secret patterns

  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized;
}

/**
 * Sanitize a PR or issue title before sending it to the LLM. Titles get the
 * same secret and hidden-text rules as bodies, on one line.
 *
 * @param title - PR or issue title
 * @param maxLength - Maximum length (default 300 chars)
 * @returns Sanitized single-line title
 */
export function sanitizeTitleForLLM(title: string | null | undefined, maxLength = 300): string {
  const sanitized = sanitizeForLLM(title).replace(/\s+/g, " ").trim();
  return sanitized.length > maxLength ? `${sanitized.substring(0, maxLength)}…` : sanitized;
}

/**
 * Sanitize comment content before sending to LLM
 * Removes PII and internal references as well as secrets
 *
 * @param comment - Comment body text
 * @param maxLength - Maximum length (default 2000 chars)
 * @returns Sanitized text safe for LLM processing
 *
 * @example
 * ```typescript
 * const sanitized = sanitizeCommentForLLM(prComment.body);
 * const enrichedContext = buildLLMPrompt(sanitized);
 * ```
 */
export function sanitizeCommentForLLM(
  comment: string | null | undefined,
  maxLength = 2000
): string {
  if (!comment) return "";

  let sanitized = stripHiddenText(comment);

  // 1. Remove email addresses, before mentions: the mention rule would
  //    otherwise turn john@example.com into john@[user].com
  sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]");

  // 2. Remove @mentions (except bot accounts for context)
  // Preserves @dependabot[bot] but anonymizes @john-doe. The lookahead also
  // rejects a following handle character, so the match cannot backtrack to a
  // shorter handle in front of "[bot]".
  sanitized = sanitized.replace(/@([a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-]|\[bot\])/g, "@[user]");

  // 3. Remove internal/private URLs (localhost, internal IPs)
  sanitized = sanitized.replace(
    /https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)[^\s]*/g,
    "[internal-url]"
  );

  // 4. Remove file paths (3+ segments starting with /), leaving the remaining
  //    public URLs intact
  const urls: string[] = [];
  sanitized = sanitized
    .replace(/https?:\/\/[^\s)]+/g, (url) => {
      urls.push(url);
      return `\uE000${urls.length - 1}\uE000`;
    })
    .replace(/(?:\/[a-zA-Z0-9_.-]+){3,}/g, "[file-path]")
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => urls[Number(index)] ?? "");

  // 5. Remove obvious secrets: a keyword followed by "=" or ":" and a value
  sanitized = sanitized.replace(
    /(?:password|secret|token|api_key|apikey)\s*[=:]\s*['"]?[^\s'"]+['"]?/gi,
    "[redacted]"
  );

  // 6. Apply base sanitization (code blocks, JWT tokens, etc.)
  sanitized = sanitizeForLLM(sanitized);

  // 7. Truncate to max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "... [truncated]";
  }

  return sanitized.trim();
}

/**
 * Sanitize commit message for LLM processing
 * Handles commit-specific patterns like Co-authored-by and Signed-off-by
 *
 * @param message - Full commit message (subject + body)
 * @returns Sanitized text safe for LLM processing
 *
 * @example
 * ```typescript
 * const sanitized = sanitizeCommitForLLM(commit.message);
 * const category = classifyCommit(sanitized);
 * ```
 */
export function sanitizeCommitForLLM(message: string | null | undefined): string {
  if (!message) return "";

  let sanitized = message;

  // Remove Co-authored-by lines (contain emails)
  sanitized = sanitized.replace(/^Co-authored-by:.*$/gim, "");

  // Remove Signed-off-by lines (contain emails)
  sanitized = sanitized.replace(/^Signed-off-by:.*$/gim, "");

  // Remove Reviewed-by lines (contain emails)
  sanitized = sanitized.replace(/^Reviewed-by:.*$/gim, "");

  // Remove Acked-by lines (contain emails)
  sanitized = sanitized.replace(/^Acked-by:.*$/gim, "");

  // Remove Cc lines (contain emails)
  sanitized = sanitized.replace(/^Cc:.*$/gim, "");

  // Trim multiple newlines from removed lines
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

  // Apply comment sanitization with slightly shorter max length
  return sanitizeCommentForLLM(sanitized, 1500);
}
