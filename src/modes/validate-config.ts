/**
 * `mode: validate-config`: the same checks a run makes before any GitHub or
 * LLM call (CONVERSION-PLAN §4.6), with no secrets needed.
 */
import { loadConfig } from "../config/load";
import { ReleaseRayError } from "../core/errors";
import { result, type ModeResult } from "./types";

/**
 * Runs `validate-config`.
 *
 * @param request - Workspace and config path
 * @returns A result whose `errors` hold `path: message` lines when the config is invalid
 */
export function validateConfig(request: { workspace: string; path?: string }): ModeResult {
  const mode = result();
  const shown = request.path ?? ".releaseray/config.yml";
  try {
    const loaded = loadConfig({ workspace: request.workspace, path: request.path });
    mode.warnings = loaded.warnings;
    mode.summary = [
      "# ReleaseRay: configuration is valid",
      "",
      loaded.source === "file"
        ? `\`${shown}\` passes every check.`
        : `No \`${shown}\`; the built-in defaults apply.`,
      "",
      `Personas: ${loaded.personas.map((p) => `\`${p.id}\` (${p.visibility})`).join(", ")}.`,
      "",
    ].join("\n");
    return mode;
  } catch (error) {
    if (!(error instanceof ReleaseRayError)) throw error;
    mode.errors = error.details.length > 0 ? error.details : [error.message];
    mode.exitCode = error.exitCode;
    mode.summary = [
      "# ReleaseRay: configuration is invalid",
      "",
      `\`${shown}\` has ${mode.errors.length} problem${mode.errors.length === 1 ? "" : "s"}:`,
      "",
      ...mode.errors.map((e) => `- \`${e.replace(/`/g, "'")}\``),
      "",
    ].join("\n");
    return mode;
  }
}
