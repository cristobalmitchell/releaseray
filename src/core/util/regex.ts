/**
 * Regular expressions written in configuration as `source` or `/source/flags`.
 */

const SLASHED = /^\/(.+)\/([a-z]*)$/s;

/**
 * Compiles a pattern written as `source` or `/source/flags`.
 *
 * @param pattern - The pattern text
 * @returns The compiled expression, without the `g` or `y` flags so `test` stays stateless
 * @throws SyntaxError when the pattern or its flags are invalid
 */
export function compilePattern(pattern: string): RegExp {
  const slashed = SLASHED.exec(pattern);
  if (!slashed) return new RegExp(pattern);
  return new RegExp(slashed[1], slashed[2].replace(/[gy]/g, ""));
}

/**
 * Whether a label entry is written as `/regex/` rather than an exact name.
 *
 * @param label - A configured label entry
 * @returns True for the `/source/flags` form
 */
export function isSlashedPattern(label: string): boolean {
  return SLASHED.test(label);
}

/**
 * Compiles a configured label: `/regex/` as written, anything else as a
 * whole-name match that ignores case.
 *
 * @param label - Exact label name or `/source/flags`
 * @returns The compiled expression
 * @throws SyntaxError when a `/regex/` entry is invalid
 */
export function compileLabel(label: string): RegExp {
  if (isSlashedPattern(label)) return compilePattern(label);
  return new RegExp(`^${label.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}
