/**
 * Runs the committed bundle, `dist/action.js`, as the Actions runner runs a
 * `node24` action: a fresh process in the workspace, inputs as `INPUT_*`
 * variables, the event payload in a file, and the output and summary files
 * the step writes to. Nothing else from the caller's environment leaks in.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./git-fixture";
import { parseAnnotations, parseOutputFile, type Annotations } from "./workflow-commands";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The bundle under test. */
export const BUNDLE = join(ROOT, "dist", "action.js");

/** What one step did. */
export interface ActionRun extends Annotations {
  /** The process exit code. */
  code: number;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
}

/** One step's setup. */
export interface ActionStep {
  workspace: string;
  event: string;
  /** Event payload; `repository` defaults to a public acme/widgets. */
  payload?: Record<string, unknown>;
  /** Inputs by name, as written under `with:`. */
  inputs?: Record<string, string>;
  /** GITHUB_API_URL: the fake server. */
  apiUrl: string;
  repository?: string;
  /** GITHUB_REF_NAME and GITHUB_REF_TYPE, for push events. */
  ref?: { name: string; type: "tag" | "branch" };
  /** Use the deterministic fake model (RELEASERAY_LLM_FAKE). Default true. */
  fakeModel?: boolean;
  /** Further variables, such as OPENAI_API_KEY. */
  env?: Record<string, string>;
  /** Directories to put before the system PATH. */
  pathPrefix?: string[];
}

/**
 * The variable name the runner uses for an input.
 *
 * @param name - Input name, such as `github-token`
 * @returns `INPUT_GITHUB-TOKEN`
 */
export function inputVariable(name: string): string {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

/**
 * Runs the bundle once.
 *
 * @param step - Workspace, event, inputs and environment
 * @returns Exit code, outputs, annotations and summary
 */
export async function runAction(step: ActionStep): Promise<ActionRun> {
  const files = tempDir("step");
  const eventPath = join(files, "event.json");
  const outputPath = join(files, "output");
  const summaryPath = join(files, "summary.md");
  const repository = step.repository ?? "acme/widgets";
  const payload = {
    ...step.payload,
    repository: {
      full_name: repository,
      private: false,
      default_branch: "main",
      ...(step.payload?.repository as Record<string, unknown> | undefined),
    },
  };
  writeFileSync(eventPath, JSON.stringify(payload));
  writeFileSync(outputPath, "");
  writeFileSync(summaryPath, "");

  const inputs = { "github-token": "fake-token", ...step.inputs };
  const env: Record<string, string> = {
    PATH: [...(step.pathPrefix ?? []), process.env.PATH ?? ""].join(":"),
    HOME: process.env.HOME ?? files,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: step.event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: step.workspace,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_API_URL: step.apiUrl,
    // Only links and the push's auth header use the server URL; the push goes
    // to the workspace's local origin, so the public value is kept for links.
    GITHUB_SERVER_URL: "https://github.com",
    RUNNER_TEMP: files,
    ...(step.ref ? { GITHUB_REF_NAME: step.ref.name, GITHUB_REF_TYPE: step.ref.type } : {}),
    ...(step.fakeModel === false ? {} : { RELEASERAY_LLM_FAKE: "true" }),
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [inputVariable(k), v])),
    ...step.env,
  };

  const child = spawn(process.execPath, [BUNDLE], { cwd: step.workspace, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  return {
    code,
    outputs: parseOutputFile(readFileSync(outputPath, "utf8")),
    summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "",
    stdout,
    stderr,
    ...parseAnnotations(stdout),
  };
}

/** A request the notify recorder answered. */
export interface RecordedNotification {
  method: string;
  url: string;
  body: string;
}

/**
 * Records the bundle's Slack, Teams and Intercom requests without changing
 * the bundle: `harness/notify-recorder.mjs` is preloaded with `--import` and
 * answers those hosts itself. Pass `env` into a step's `env`.
 *
 * @returns The variables to set, and a reader for the requests so far
 */
export function notifyRecorder(): {
  env: Record<string, string>;
  requests: () => RecordedNotification[];
} {
  const log = join(tempDir("notify"), "requests.jsonl");
  writeFileSync(log, "");
  const preload = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), "notify-recorder.mjs")
  );
  return {
    env: { NODE_OPTIONS: `--import=${preload.href}`, RELEASERAY_E2E_NOTIFY_LOG: log },
    requests: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedNotification),
  };
}
