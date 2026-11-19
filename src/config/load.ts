/**
 * Reads `.releaseray/config.yml`, applies defaults < file < inputs, and
 * validates before any GitHub or LLM call (CONVERSION-PLAN §4.1, §4.6).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { z } from "zod";
import { LineCounter, parseDocument } from "yaml";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import { SECRET_PATTERNS } from "../core/sanitize/llm";
import { resolveConfig, type ResolvedConfig } from "./resolve";
import { ConfigSchema, type Config } from "./schema";

/** Where the config lives unless the `config` input says otherwise. */
export const DEFAULT_CONFIG_PATH = ".releaseray/config.yml";

/** Longest `instructionsFile` accepted, the same cap as inline `instructions`. */
const MAX_INSTRUCTIONS_CHARS = 2000;

/** Keys that hold a credential; configuration names environment variables instead. */
const CREDENTIAL_KEY =
  /^(api[-_]?key|access[-_]?key|secret([-_]?key)?|client[-_]?secret|(access[-_]?|auth[-_]?)?token|password|passwd|private[-_]?key|webhook[-_]?url)$/i;

/**
 * Secret shapes checked in values. The bearer pattern is left out because it
 * matches ordinary prose such as "Bearer tokens" in persona instructions.
 */
const SECRET_VALUE_PATTERNS = SECRET_PATTERNS.filter((p) => !p.source.startsWith("Bearer")).map(
  (p) => new RegExp(p.source, p.flags.replace("g", ""))
);

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Repository checkout root. */
  workspace: string;
  /** Config path relative to the workspace. */
  path?: string;
  /** Values from Action inputs, merged over the file. */
  overrides?: Record<string, unknown>;
}

/** A validated, resolved config. */
export interface LoadedConfig extends ResolvedConfig {
  /** Whether the file existed or only defaults applied. */
  source: "file" | "defaults";
  /** Problems worth a warning that do not stop the run. */
  warnings: string[];
}

/**
 * Formats an issue path as `personas[2].tone.formality`.
 *
 * @param path - Keys and indexes
 * @returns The dotted path, or `(root)` when empty
 */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out ? `.${String(key)}` : String(key);
  }
  return out || "(root)";
}

/**
 * Formats Zod issues as `path: message` lines, one per unknown key.
 *
 * @param issues - Issues from a failed parse
 * @returns One line per problem
 */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${formatPath([...issue.path, key])}: unknown key`);
    }
    return [`${formatPath(issue.path)}: ${issue.message}`];
  });
}

/**
 * Finds credential-like keys and secret-shaped string values anywhere in a
 * raw config (CONVERSION-PLAN §4.1).
 *
 * @param value - The parsed YAML
 * @param path - Path of `value`, for messages
 * @returns `path: message` lines
 */
export function findCredentials(value: unknown, path: PropertyKey[] = []): string[] {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((p) => p.test(value))
      ? [`${formatPath(path)}: looks like a secret; store it in an Actions secret instead`]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findCredentials(v, [...path, i]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => {
      const here = [...path, key];
      const own = CREDENTIAL_KEY.test(key)
        ? [
            `${formatPath(here)}: credentials do not belong in the config; name an environment variable (for example webhookUrlEnv or apiKeyEnv)`,
          ]
        : [];
      return [...own, ...findCredentials(v, here)];
    });
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges `over` into `base`: objects merge key by key, everything else replaces.
 *
 * @param base - Lower-precedence values
 * @param over - Higher-precedence values; `undefined` leaves the base value
 * @returns A new merged object
 */
export function mergeLayers(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeLayers(current, value) : value;
  }
  return out;
}

/**
 * Validates a raw config object: credentials, schema and cross-field rules.
 *
 * @param raw - Parsed YAML merged with input overrides
 * @returns The parsed config
 * @throws ReleaseRayError with exit code 2 and `path: message` details
 */
export function parseConfig(raw: unknown): Config {
  const credentials = findCredentials(raw);
  const result = ConfigSchema.safeParse(raw);
  const problems = [...credentials, ...(result.success ? [] : formatIssues(result.error.issues))];
  if (problems.length > 0 || !result.success) {
    throw new ReleaseRayError("Invalid configuration", EXIT_CODES.invalid, problems);
  }
  return result.data;
}

/**
 * Warnings for settings that are valid but easy to get wrong.
 *
 * @param config - A parsed config
 * @returns Warning lines
 */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.github.onBudgetExceeded === "wait" && config.github.maxWaitMinutes > 0) {
    warnings.push(
      `github.onBudgetExceeded is wait: set the job's timeout-minutes above ${config.github.maxWaitMinutes} plus the run time`
    );
  }
  return warnings;
}

function readInstructionsFiles(config: Config, workspace: string): Record<string, string> {
  const files: Record<string, string> = {};
  const problems: string[] = [];
  const root = realpathSync(workspace);
  const allowedDir = join(root, ".releaseray");
  (config.personas ?? []).forEach((persona, i) => {
    const file = persona.instructionsFile;
    if (file === undefined) return;
    const at = formatPath(["personas", i, "instructionsFile"]);
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) {
      problems.push(`${at}: ${file} does not exist`);
      return;
    }
    // A symlink inside .releaseray/ must not lead out of it.
    const real = realpathSync(absolute);
    const rel = relative(allowedDir, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      problems.push(`${at}: ${file} resolves outside .releaseray/`);
      return;
    }
    const text = readFileSync(real, "utf8");
    if (text.length > MAX_INSTRUCTIONS_CHARS) {
      problems.push(`${at}: ${file} is longer than ${MAX_INSTRUCTIONS_CHARS} characters`);
      return;
    }
    files[file] = text;
  });
  if (problems.length > 0) {
    throw new ReleaseRayError("Invalid configuration", EXIT_CODES.invalid, problems);
  }
  return files;
}

/**
 * Loads, validates and resolves the config. A missing file means defaults.
 *
 * @param options - Workspace, config path and input overrides
 * @returns The resolved config, its source and warnings
 * @throws ReleaseRayError with exit code 2 on invalid YAML or configuration
 */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const path = options.path ?? DEFAULT_CONFIG_PATH;
  const absolute = resolve(options.workspace, path);
  let raw: Record<string, unknown> = { version: 1 };
  let source: LoadedConfig["source"] = "defaults";

  if (existsSync(absolute)) {
    const lineCounter = new LineCounter();
    const doc = parseDocument(readFileSync(absolute, "utf8"), {
      prettyErrors: false,
      lineCounter,
    });
    if (doc.errors.length > 0) {
      throw new ReleaseRayError(
        "Invalid configuration",
        EXIT_CODES.invalid,
        doc.errors.map((e) => {
          const at = lineCounter.linePos(e.pos[0]);
          return `${path}:${at.line}:${at.col}: ${e.message.split("\n")[0]}`;
        })
      );
    }
    const parsed: unknown = doc.toJS();
    if (parsed !== null && parsed !== undefined && !isPlainObject(parsed)) {
      throw new ReleaseRayError("Invalid configuration", EXIT_CODES.invalid, [
        `${path}: the file must hold a mapping`,
      ]);
    }
    raw = isPlainObject(parsed) ? parsed : raw;
    source = "file";
  } else if (options.path !== undefined && options.path !== DEFAULT_CONFIG_PATH) {
    throw new ReleaseRayError("Invalid configuration", EXIT_CODES.invalid, [
      `${path}: file not found`,
    ]);
  }

  const config = parseConfig(options.overrides ? mergeLayers(raw, options.overrides) : raw);
  const instructionsFiles = readInstructionsFiles(config, options.workspace);
  return {
    ...resolveConfig(config, instructionsFiles),
    source,
    warnings: configWarnings(config),
  };
}
