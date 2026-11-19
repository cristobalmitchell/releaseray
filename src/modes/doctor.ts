/**
 * `mode: doctor`: checks the setup without calling the LLM or writing
 * anything. The issue templates ask for its job summary.
 */
import { loadConfig, type LoadedConfig } from "../config/load";
import { ReleaseRayError } from "../core/errors";
import type { GitHubReader } from "../core/fetch/github";
import { isShallow, mergedTags, type Git } from "../core/range/git";
import { globToRegExp } from "../core/range/resolve";
import { compareSemver, parseSemver } from "../core/util/semver";
import { result, type ModeResult } from "./types";

/** One check's outcome. */
export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** `doctor` request: what the entry layer can see. */
export interface DoctorRequest {
  workspace: string;
  configPath?: string;
  /** Which credentials are present in the environment; never their values. */
  credentials: { openai: boolean; aws: boolean };
  visibility: "public" | "private" | "unknown";
  /** `process.versions.node`. */
  nodeVersion: string;
}

const ICON = { ok: "✅", warn: "⚠️", fail: "❌" } as const;

/**
 * Runs `doctor`.
 *
 * @param request - Workspace, config path, credential presence and repository visibility
 * @param deps - Git and GitHub reads
 * @returns The checks as a summary table; `errors` lists failed checks
 */
export async function doctor(
  request: DoctorRequest,
  deps: { git: Git; github: GitHubReader }
): Promise<ModeResult & { checks: Check[] }> {
  const checks: Check[] = [];
  let loaded: LoadedConfig | null = null;

  try {
    loaded = loadConfig({ workspace: request.workspace, path: request.configPath });
    checks.push({
      name: "Configuration",
      status: loaded.warnings.length > 0 ? "warn" : "ok",
      detail:
        (loaded.source === "file" ? "Valid" : "No config file; defaults apply") +
        (loaded.warnings.length > 0 ? `. ${loaded.warnings.join(" ")}` : ""),
    });
  } catch (error) {
    if (!(error instanceof ReleaseRayError)) throw error;
    checks.push({
      name: "Configuration",
      status: "fail",
      detail: `${error.details.length} problem(s); run mode: validate-config for the list`,
    });
  }

  const major = Number(request.nodeVersion.split(".")[0]);
  checks.push({
    name: "Node.js",
    status: major >= 24 ? "ok" : "fail",
    detail: `${request.nodeVersion}${major >= 24 ? "" : "; the Action needs Node 24"}`,
  });

  if (isShallow(deps.git)) {
    checks.push({
      name: "Checkout",
      status: "fail",
      detail: "Shallow clone: set fetch-depth: 0 on actions/checkout",
    });
  } else {
    checks.push({ name: "Checkout", status: "ok", detail: "Full history" });
    const pattern = loaded?.config.range.tagPattern ?? "v*";
    const re = globToRegExp(pattern);
    const tags = mergedTags(deps.git, "HEAD").filter((t) => re.test(t.name));
    const versions = tags
      .map((t) => ({ name: t.name, v: parseSemver(t.name) }))
      .filter((t) => t.v !== null)
      .sort((a, b) => compareSemver(b.v!, a.v!));
    checks.push({
      name: "Tags",
      status: versions.length > 0 ? "ok" : "warn",
      detail:
        versions.length > 0
          ? `${tags.length} tags on HEAD match \`${pattern}\`; latest \`${versions[0].name}\``
          : `No SemVer tag on HEAD matches \`${pattern}\`; the first release will start at the root commit`,
    });
  }

  try {
    const rate = await deps.github.rateLimit();
    checks.push({
      name: "GitHub token",
      status: rate.remaining < 100 ? "warn" : "ok",
      detail: `Core limit ${rate.limit}/hour (${rate.limit <= 1000 ? "GITHUB_TOKEN" : "PAT or App token"}), ${rate.remaining} remaining`,
    });
  } catch {
    checks.push({
      name: "GitHub token",
      status: "fail",
      detail: "GET /rate_limit failed; check the github-token input",
    });
  }

  const provider = loaded?.config.llm.provider ?? "openai";
  const keyPresent = provider === "bedrock" ? request.credentials.aws : request.credentials.openai;
  checks.push({
    name: "LLM credentials",
    status: keyPresent ? "ok" : "warn",
    detail: keyPresent
      ? `${provider}: credentials found in the environment`
      : provider === "bedrock"
        ? "bedrock: no AWS_ACCESS_KEY_ID in the environment; generate will fail unless another credential source applies"
        : "openai: OPENAI_API_KEY is not set; generate will fail (preview and validate-config do not need it)",
  });
  if (loaded) {
    checks.push({ name: "Model", status: "ok", detail: `${provider} / ${loaded.model}` });
  }

  const internal = loaded?.personas.filter((p) => p.visibility === "internal") ?? [];
  checks.push({
    name: "Repository visibility",
    status: "ok",
    detail:
      request.visibility === "private"
        ? "Private: every persona may appear in the summary and files"
        : `${request.visibility === "public" ? "Public" : "Unknown (treated as public)"}: ${
            internal.length > 0 && !loaded?.config.outputs.allowInternalOnPublicRepo
              ? `${internal.map((p) => p.id).join(", ")} withheld from the summary and files`
              : "no persona is withheld"
          }`,
  });

  const mode = result(
    [
      "# ReleaseRay doctor",
      "",
      "| Check | Status | Detail |",
      "| --- | :---: | --- |",
      ...checks.map((c) => `| ${c.name} | ${ICON[c.status]} | ${c.detail.replace(/\|/g, "\\|")} |`),
      "",
    ].join("\n")
  );
  mode.errors = checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`);
  mode.warnings = checks.filter((c) => c.status === "warn").map((c) => `${c.name}: ${c.detail}`);
  if (mode.errors.length > 0) mode.exitCode = 2;
  return { ...mode, checks };
}
