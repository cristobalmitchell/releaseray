/**
 * Action inputs (CONVERSION-PLAN §8.1). A `with:` value that evaluates to
 * an empty string reaches the Action as `''`, not as the declared default,
 * so every input is read through {@link readInputs}, which maps blanks to
 * the defaults below. Booleans are parsed here rather than with
 * `getBooleanInput`, which throws on `''`.
 */
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import type { ActionsIO } from "./io";

/** Modes, in `action.yml` order. */
export const MODES = [
  "generate",
  "publish",
  "preview",
  "doctor",
  "validate-config",
  "migrate-personas",
] as const;

export type Mode = (typeof MODES)[number];

/**
 * Every input and its default. `action.yml` must declare the same set; a
 * unit test compares them. `github-token` defaults to `github.token` in
 * `action.yml`; a blank value is an error at use.
 */
export const INPUT_DEFAULTS = {
  mode: "generate",
  "github-token": "",
  config: ".releaseray/config.yml",
  to: "",
  from: "",
  since: "",
  until: "",
  key: "",
  personas: "",
  publish: "",
  "create-release": "false",
  push: "",
  "notes-dir": "",
  "expected-digest": "",
  "allow-non-ancestor": "false",
  force: "false",
  "allow-sparse": "false",
  "preview-prompts": "false",
  "all-tags": "false",
  "personas-file": ".releaseray/personas.yml",
  notify: "",
} as const;

export type InputName = keyof typeof INPUT_DEFAULTS;

/** Parsed inputs. Tri-state booleans are `null` when blank. */
export interface Inputs {
  mode: Mode;
  githubToken: string;
  config: string;
  to: string;
  from: string;
  since: string;
  until: string;
  key: string;
  personas: string[] | null;
  publish: boolean | null;
  createRelease: boolean;
  push: boolean | null;
  notesDir: string;
  expectedDigest: string;
  allowNonAncestor: boolean;
  force: boolean;
  allowSparse: boolean;
  previewPrompts: boolean;
  allTags: boolean;
  personasFile: string;
}

const TRUE = ["true", "True", "TRUE"];
const FALSE = ["false", "False", "FALSE"];

function invalidInput(name: string, message: string): ReleaseRayError {
  return new ReleaseRayError(`Invalid input ${name}`, EXIT_CODES.invalid, [`${name}: ${message}`]);
}

/**
 * Parses a boolean the way `getBooleanInput` does, with blank meaning null.
 *
 * @param name - Input name, for the error
 * @param value - Raw value
 * @returns The boolean, or null when blank
 * @throws ReleaseRayError (exit 2) on anything else
 */
export function parseBoolean(name: string, value: string): boolean | null {
  const v = value.trim();
  if (v === "") return null;
  if (TRUE.includes(v)) return true;
  if (FALSE.includes(v)) return false;
  throw invalidInput(name, `expected true or false, got "${v}"`);
}

/**
 * Reads and parses every input.
 *
 * @param io - Runner I/O
 * @returns The inputs, blanks mapped to defaults
 * @throws ReleaseRayError (exit 2) for an unknown mode or a malformed boolean
 */
export function readInputs(io: Pick<ActionsIO, "getInput">): Inputs {
  const raw = (name: InputName): string => {
    const value = io.getInput(name).trim();
    return value === "" ? INPUT_DEFAULTS[name] : value;
  };
  const bool = (name: InputName): boolean => parseBoolean(name, raw(name)) ?? false;
  const triState = (name: InputName): boolean | null => parseBoolean(name, io.getInput(name));

  const mode = raw("mode");
  if (mode === "adopt" || mode === "sync-changelog") {
    throw invalidInput("mode", `${mode} arrives in v1.1`);
  }
  if (!(MODES as readonly string[]).includes(mode)) {
    throw invalidInput("mode", `expected one of ${MODES.join(", ")}, got "${mode}"`);
  }
  const personas = raw("personas");
  return {
    mode: mode as Mode,
    githubToken: raw("github-token"),
    config: raw("config"),
    to: raw("to"),
    from: raw("from"),
    since: raw("since"),
    until: raw("until"),
    key: raw("key"),
    personas: personas
      ? personas
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
      : null,
    publish: triState("publish"),
    createRelease: bool("create-release"),
    push: triState("push"),
    notesDir: raw("notes-dir"),
    expectedDigest: raw("expected-digest"),
    allowNonAncestor: bool("allow-non-ancestor"),
    force: bool("force"),
    allowSparse: bool("allow-sparse"),
    previewPrompts: bool("preview-prompts"),
    allTags: bool("all-tags"),
    personasFile: raw("personas-file"),
  };
}
