/**
 * The Action entry layer: reads inputs and the event, dispatches the mode,
 * and reports through the job summary, step outputs, annotations and the
 * exit code. The only module (with `index.ts`) that touches the runner.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type LoadedConfig } from "../config/load";
import { configureLogger } from "../core/logger";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import { createGitHubReader, createOctokit, type GitHubReader } from "../core/fetch/github";
import { createProvider, hasPricing, type LLMProvider } from "../core/llm/provider";
import { createFakeProvider } from "../core/llm/providers/fake";
import { findUnknownPlaceholders, PERSONA_TEMPLATE_PLACEHOLDERS } from "../core/prompt/build";
import { templatesWithOverrides } from "../core/prompt/templates";
import { createGit } from "../core/range/git";
import { doctor } from "../modes/doctor";
import { generate } from "../modes/generate";
import { publish } from "../modes/publish";
import { migratePersonas } from "../modes/migrate-personas";
import { preview } from "../modes/preview";
import type { ModeResult } from "../modes/types";
import { validateConfig } from "../modes/validate-config";
import { planEvent, readContext, type Env, type RunContext } from "./context";
import { readInputs, type Inputs } from "./inputs";
import type { ActionsIO } from "./io";
import { createActionsLogSink } from "./logger-sink";
import { createReleaseApi, type ReleaseApi } from "../outputs/github-release/sink";
import type { PersistedDeps } from "../outputs/persisted";
import { GENERATED_BY_TRAILER } from "../outputs/push";

/** Most annotations of one kind per step (GitHub shows 10). */
export const MAX_ANNOTATIONS = 10;

/** Set to `true` to use the deterministic fake model; for tests and the e2e harness only. */
export const FAKE_LLM_ENV = "RELEASERAY_LLM_FAKE";

/** Everything `main` needs from outside. */
export interface MainDeps {
  io: ActionsIO;
  env: Env;
  readFile?: (path: string) => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the GitHub clients, for tests. */
  github?: (
    token: string,
    ctx: RunContext,
    config: LoadedConfig | null
  ) => GitHubReader | { reader: GitHubReader; release: ReleaseApi };
  /** Replaces provider creation, for tests. */
  provider?: (config: LoadedConfig) => Promise<LLMProvider>;
}

/**
 * Config values that come from inputs, merged over the file.
 *
 * @param inputs - Parsed inputs
 * @returns Overrides for `loadConfig`
 */
export function configOverrides(inputs: Inputs): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  if (inputs.createRelease) outputs.githubRelease = { createIfMissing: true };
  if (inputs.push !== null) outputs.changelog = { push: inputs.push };
  return {
    ...(inputs.allowNonAncestor ? { range: { allowNonAncestor: true } } : {}),
    ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
  };
}

function report(io: ActionsIO, kind: "error" | "warning", lines: readonly string[]): void {
  if (lines.length === 0) return;
  const emit = kind === "error" ? io.error : io.warning;
  if (lines.length <= MAX_ANNOTATIONS) {
    for (const line of lines) emit(line);
    return;
  }
  for (const line of lines.slice(0, MAX_ANNOTATIONS - 1)) emit(line);
  emit(`${lines.length - (MAX_ANNOTATIONS - 1)} more ${kind}s; see the job summary`);
}

function defaultGitHub(sleep: (ms: number) => Promise<void>): NonNullable<MainDeps["github"]> {
  return (token, ctx, config) => {
    if (!token) {
      throw new ReleaseRayError("No GitHub token", EXIT_CODES.invalid, [
        "Leave github-token at its default (github.token) or pass a PAT or App token",
      ]);
    }
    const { octokit, policy } = createOctokit({
      token,
      baseUrl: ctx.apiUrl,
      concurrency: config?.config.github.concurrency ?? 1,
      maxWaitMinutes: config?.config.github.maxWaitMinutes ?? 0,
      sleep,
      now: () => Date.now(),
    });
    const repo = { owner: ctx.owner, repo: ctx.repo };
    return {
      reader: createGitHubReader(octokit, policy, repo),
      release: createReleaseApi(octokit, repo),
    };
  };
}

function clients(made: GitHubReader | { reader: GitHubReader; release: ReleaseApi }): {
  reader: GitHubReader;
  release: ReleaseApi | null;
} {
  return "reader" in made
    ? { reader: made.reader, release: made.release }
    : { reader: made, release: null };
}

/** The branch to push CHANGELOG to: the checked-out branch, else the default branch. */
function pushBranch(ctx: RunContext): string {
  try {
    const branch = createGit(ctx.workspace).run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // Fall through to the default branch.
  }
  const repository = ctx.payload.repository as { default_branch?: unknown } | undefined;
  return String(repository?.default_branch ?? "main");
}

function persistedDeps(
  io: ActionsIO,
  env: Env,
  ctx: RunContext,
  token: string,
  release: ReleaseApi | null
): PersistedDeps {
  return {
    release,
    workspace: ctx.workspace,
    push: {
      serverUrl: ctx.serverUrl,
      token,
      setSecret: io.setSecret,
      // git needs PATH and HOME, not the LLM or cloud credentials.
      env: Object.fromEntries(
        Object.entries(env).filter(
          ([k]) => !/(_API_KEY|_SECRET|_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN)$/.test(k)
        )
      ),
      branch: pushBranch(ctx),
    },
  };
}

function defaultProvider(env: Env, io: ActionsIO): NonNullable<MainDeps["provider"]> {
  return async (config) => {
    if (env[FAKE_LLM_ENV] === "true") {
      io.warning(`${FAKE_LLM_ENV} is set: using the fake model; the notes are placeholders`);
      return createFakeProvider();
    }
    const { llm } = config.config;
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey) io.setSecret(apiKey);
    const anthropicApiKey = env.ANTHROPIC_API_KEY;
    if (anthropicApiKey) io.setSecret(anthropicApiKey);
    try {
      return await createProvider(
        {
          provider: llm.provider,
          model: config.model,
          baseUrl: llm.baseUrl,
          region: llm.region,
        },
        { openaiApiKey: apiKey, anthropicApiKey }
      );
    } catch (error) {
      throw new ReleaseRayError("The LLM provider could not be set up", EXIT_CODES.invalid, [
        (error as Error).message,
      ]);
    }
  };
}

function loadTemplates(workspace: string) {
  const { templates, overridden } = templatesWithOverrides(
    join(workspace, ".releaseray", "prompts")
  );
  const unknown = findUnknownPlaceholders(templates.persona, PERSONA_TEMPLATE_PLACEHOLDERS);
  if (unknown.length > 0) {
    throw new ReleaseRayError("Invalid prompt override", EXIT_CODES.invalid, [
      `.releaseray/prompts/persona.md: unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(", ")}`,
    ]);
  }
  return { templates, overridden };
}

/**
 * Runs the Action once.
 *
 * @param deps - Runner I/O, environment and test seams
 * @returns The process exit code
 */
export async function main(deps: MainDeps): Promise<number> {
  const { io, env } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  configureLogger({
    level: env.RUNNER_DEBUG === "1" ? "debug" : "info",
    sink: createActionsLogSink(io),
  });

  let mode: ModeResult;
  try {
    const inputs = readInputs(io);
    const ctx = readContext(env, deps.readFile);
    // A push of ReleaseRay's own CHANGELOG commit (with a PAT or App token) must not loop.
    const headCommit = (ctx.payload.head_commit as { message?: unknown } | undefined)?.message;
    if (ctx.eventName === "push" && String(headCommit ?? "").includes(GENERATED_BY_TRAILER)) {
      io.notice("This push is ReleaseRay's own CHANGELOG commit; nothing to do");
      return 0;
    }
    const event = planEvent(ctx, inputs, now().toISOString().slice(0, 10));
    for (const n of event.notices) io.notice(n);
    const github = deps.github ?? defaultGitHub(sleep);
    const configPath = inputs.config;

    switch (event.mode) {
      case "validate-config":
        mode = validateConfig({ workspace: ctx.workspace, path: configPath });
        break;
      case "migrate-personas":
        mode = migratePersonas({
          workspace: ctx.workspace,
          personasFile: inputs.personasFile,
          configPath,
        });
        break;
      case "doctor": {
        let loaded: LoadedConfig | null = null;
        try {
          loaded = loadConfig({ workspace: ctx.workspace, path: configPath });
        } catch {
          // doctor reports the config problem itself.
        }
        mode = await doctor(
          {
            workspace: ctx.workspace,
            configPath,
            credentials: {
              openai: Boolean(env.OPENAI_API_KEY),
              anthropic: Boolean(env.ANTHROPIC_API_KEY),
              aws: Boolean(env.AWS_ACCESS_KEY_ID),
            },
            visibility: ctx.visibility,
            nodeVersion: process.versions.node,
          },
          {
            git: createGit(ctx.workspace),
            github: clients(github(inputs.githubToken, ctx, loaded)).reader,
          }
        );
        break;
      }
      case "preview":
      case "generate": {
        const config = loadConfig({
          workspace: ctx.workspace,
          path: configPath,
          overrides: configOverrides(inputs),
        });
        for (const w of config.warnings) io.warning(w);
        const { templates, overridden } = loadTemplates(ctx.workspace);
        if (overridden.length > 0) io.notice(`Prompt overrides in use: ${overridden.join(", ")}`);
        const made = clients(github(inputs.githubToken, ctx, config));
        const base = {
          git: createGit(ctx.workspace),
          github: made.reader,
          templates,
          repo: {
            owner: ctx.owner,
            repo: ctx.repo,
            serverUrl: ctx.serverUrl,
            visibility: ctx.visibility,
          },
          sleep,
          now: () => now().getTime(),
        };
        const request = {
          range: event.range!,
          ...(inputs.personas ? { personas: inputs.personas } : {}),
          allowSparse: inputs.allowSparse,
          workspace: ctx.workspace,
        };
        if (event.mode === "preview") {
          mode = await preview({ ...request, previewPrompts: event.previewPrompts }, config, base);
        } else {
          const provider = await (deps.provider ?? defaultProvider(env, io))(config);
          mode = await generate(
            { ...request, force: inputs.force, publish: event.publish },
            config,
            {
              ...base,
              llm: () => provider,
              priced: Boolean(config.config.llm.pricing) || hasPricing(config.model),
              ...(made.release ? { release: made.release } : {}),
              changelogText: () => {
                const file = join(ctx.workspace, config.config.outputs.changelog.path);
                return existsSync(file) ? readFileSync(file, "utf8") : "";
              },
              persisted: persistedDeps(io, env, ctx, inputs.githubToken, made.release),
            }
          );
        }
        break;
      }
      case "publish": {
        const config = loadConfig({
          workspace: ctx.workspace,
          path: configPath,
          overrides: configOverrides(inputs),
        });
        const made = clients(github(inputs.githubToken, ctx, config));
        mode = await publish(
          {
            workspace: ctx.workspace,
            notesDir: inputs.notesDir,
            expectedDigest: inputs.expectedDigest,
          },
          config,
          persistedDeps(io, env, ctx, inputs.githubToken, made.release)
        );
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ReleaseRayError)) {
      io.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      await io.writeSummary(
        `# ReleaseRay failed\n\nAn unexpected error stopped the run; see the log.\n`
      );
      return 1;
    }
    report(io, "error", [error.message, ...error.details]);
    await io.writeSummary(
      [
        "# ReleaseRay failed",
        "",
        `**${error.message}** (exit ${error.exitCode})`,
        "",
        ...error.details.map((d) => `- ${d}`),
        "",
      ].join("\n")
    );
    return error.exitCode;
  }

  for (const [name, value] of Object.entries(mode.outputs)) io.setOutput(name, value);
  report(io, "warning", mode.warnings);
  report(io, "error", mode.errors);
  if (mode.summary) await io.writeSummary(mode.summary);
  return mode.errors.length > 0 ? (mode.exitCode ?? 1) : 0;
}
