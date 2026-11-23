/**
 * Text clean-up shared by providers without a native JSON mode.
 */

/**
 * Strips one surrounding markdown code fence from a model's JSON reply.
 *
 * Some models (Claude among them) wrap JSON in ```json ... ``` fences even
 * when told not to.
 *
 * @param text - The model's reply
 * @returns The reply without the fence, trimmed
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}
