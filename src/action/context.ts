/**
 * The workflow run's context from the runner environment and the event
 * payload, and the event allowlist (CONVERSION-PLAN §8.7).
 */
import { readFileSync } from "node:fs";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import type { RangeRequest } from "../core/range/resolve";
import type { Inputs } from "./inputs";

/** Environment variables the entry layer reads. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What the run knows about itself. */
export interface RunContext {
  eventName: string;
  payload: Record<string, unknown>;
  owner: string;
  repo: string;
  serverUrl: string;
  apiUrl: string;
  workspace: string;
  refName: string;
  refType: string;
  visibility: "public" | "private" | "unknown";
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new ReleaseRayError(`${name} is not set`, EXIT_CODES.invalid, [
      "ReleaseRay runs only as a step in a GitHub Actions workflow",
    ]);
  }
  return value;
}

/**
 * Reads the run context.
 *
 * @param env - The runner environment
 * @param readFile - Reads the event payload file
 * @returns The context
 * @throws ReleaseRayError (exit 2) outside a workflow run
 */
export function readContext(
  env: Env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8")
): RunContext {
  const [owner, repo] = required(env, "GITHUB_REPOSITORY").split("/");
  const eventPath = env.GITHUB_EVENT_PATH;
  const payload = eventPath ? (JSON.parse(readFile(eventPath)) as Record<string, unknown>) : {};
  const repository = payload.repository as { private?: unknown } | undefined;
  return {
    eventName: required(env, "GITHUB_EVENT_NAME"),
    payload,
    owner,
    repo,
    serverUrl: env.GITHUB_SERVER_URL ?? "https://github.com",
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    workspace: required(env, "GITHUB_WORKSPACE"),
    refName: env.GITHUB_REF_NAME ?? "",
    refType: env.GITHUB_REF_TYPE ?? "",
    visibility:
      repository?.private === true
        ? "private"
        : repository?.private === false
          ? "public"
          : "unknown",
  };
}

/** What the event allows. */
export interface EventPlan {
  /** The mode to run; `pull_request` switches to `preview`. */
  mode: Inputs["mode"];
  /** The range request, for modes that resolve one. */
  range: RangeRequest | null;
  /** Whether persisted sinks may write. */
  publish: boolean;
  /** Preview prompts allowed (never on `pull_request`). */
  previewPrompts: boolean;
  notices: string[];
}

function invalid(message: string, detail?: string): ReleaseRayError {
  return new ReleaseRayError(message, EXIT_CODES.invalid, detail ? [detail] : []);
}

/**
 * Applies the event allowlist and resolves the range request and `publish`.
 *
 * @param ctx - Run context
 * @param inputs - Parsed inputs
 * @param today - YYYY-MM-DD, for unreleased keys
 * @returns The plan for this event
 * @throws ReleaseRayError (exit 2) for disallowed events or a missing `to`
 */
export function planEvent(ctx: RunContext, inputs: Inputs, today: string): EventPlan {
  const notices: string[] = [];
  const event = ctx.eventName;

  if (event === "pull_request_target") {
    throw invalid(
      "pull_request_target is not supported",
      "It grants a write token to code from forks. Use pull_request for previews"
    );
  }
  if (event === "workflow_run") {
    throw invalid(
      "workflow_run is not supported",
      "Dispatch the release-notes workflow from your release job instead (see the in-release-job example)"
    );
  }
  const allowed = ["release", "push", "workflow_dispatch", "schedule", "pull_request"];
  if (!allowed.includes(event)) {
    throw invalid(`The ${event} event is not supported`, `Supported: ${allowed.join(", ")}`);
  }

  let mode = inputs.mode;
  let previewPrompts = inputs.previewPrompts;
  if (event === "pull_request") {
    if (mode !== "preview")
      notices.push(`pull_request runs mode: preview only (asked for ${mode})`);
    mode = "preview";
    previewPrompts = false;
  }

  const rangeModes = ["generate", "preview"];
  if (!rangeModes.includes(mode)) {
    return { mode, range: null, publish: false, previewPrompts, notices };
  }

  // Event defaults for `to`.
  let to = inputs.to;
  let eventTag = "";
  if (event === "release") {
    const action = ctx.payload.action;
    if (action !== "published") {
      throw invalid(
        `release events with action "${String(action)}" are not supported`,
        "Use on: release: types: [published]"
      );
    }
    eventTag = String((ctx.payload.release as { tag_name?: unknown } | undefined)?.tag_name ?? "");
  } else if (event === "push" && ctx.refType === "tag") {
    eventTag = ctx.refName;
  }
  if (!to) to = eventTag;
  if (!to && (event === "schedule" || mode === "preview")) to = "HEAD";

  let range: RangeRequest;
  if (inputs.since) {
    if (!inputs.key) throw invalid("A date window needs the key input");
    range = {
      kind: "window",
      since: inputs.since,
      ...(inputs.until ? { until: inputs.until } : {}),
      key: inputs.key,
    };
  } else if (to === "HEAD") {
    range = { kind: "unreleased", today };
  } else if (to) {
    range = { kind: "tag", to, ...(inputs.from ? { from: inputs.from } : {}) };
  } else if (event === "push") {
    throw invalid(
      "A push to a branch needs an explicit to",
      "Pass the tag as the to input, as in the in-release-job example"
    );
  } else {
    throw invalid(
      "No release tag",
      "Set the to input; a workflow_dispatch run carries no event tag"
    );
  }

  // `publish`: true on release and tag pushes, false otherwise; never on a schedule or a preview.
  const eventPublishes = event === "release" || (event === "push" && ctx.refType === "tag");
  let publish = inputs.publish ?? eventPublishes;
  if (event === "schedule" && publish) {
    notices.push("Scheduled runs never publish; publish was turned off");
    publish = false;
  }
  if (mode === "preview") publish = false;

  return { mode, range, publish, previewPrompts, notices };
}
