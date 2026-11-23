/**
 * The GitHub Release sink (CONVERSION-PLAN §7.2): one marked block per key
 * and persona in the release body. Updates send only `body`; text outside
 * the block is kept byte for byte.
 */
import type { Octokit } from "@octokit/rest";
import { EXIT_CODES, ReleaseRayError } from "../../core/errors";
import { isHttpError } from "../../core/fetch/policy";
import { outputDigest } from "../../core/state/digest";
import { findMarkedBlocks, writeMarkedBlock } from "../../core/state/marker";
import type { SinkPlan } from "../../core/state/planner";
import { isSemverPrerelease, renderReleaseName } from "./api";

/** A release as the sink sees it. */
export interface ReleaseTarget {
  id: number;
  body: string;
  url: string;
}

/** Release reads and writes; tests replace it with a fake. */
export interface ReleaseApi {
  get(tag: string): Promise<ReleaseTarget | null>;
  /** Sends only the body. */
  updateBody(id: number, body: string): Promise<ReleaseTarget>;
  create(input: {
    tag: string;
    name: string;
    body: string;
    prerelease: boolean;
  }): Promise<ReleaseTarget>;
}

/**
 * The release API over the run's Octokit.
 *
 * @param octokit - Client whose requests pass through the request policy
 * @param repo - Repository coordinates
 * @returns The API
 */
export function createReleaseApi(
  octokit: Octokit,
  repo: { owner: string; repo: string }
): ReleaseApi {
  const toTarget = (data: {
    id: number;
    body?: string | null;
    html_url: string;
  }): ReleaseTarget => ({
    id: data.id,
    body: data.body ?? "",
    url: data.html_url,
  });
  return {
    async get(tag) {
      try {
        const { data } = await octokit.rest.repos.getReleaseByTag({ ...repo, tag });
        return toTarget(data);
      } catch (error) {
        if (!(isHttpError(error) && error.status === 404)) throw error;
      }
      // "Get a release by tag name" returns published releases only. A draft
      // for the tag shows in the newest page of the list (to tokens that can
      // push), so a person's draft is updated rather than duplicated.
      const { data } = await octokit.rest.repos.listReleases({ ...repo, per_page: 100 });
      const draft = data.find((r) => r.draft && r.tag_name === tag);
      return draft ? toTarget(draft) : null;
    },
    async updateBody(id, body) {
      const { data } = await octokit.rest.repos.updateRelease({ ...repo, release_id: id, body });
      return toTarget(data);
    },
    async create(input) {
      const { data } = await octokit.rest.repos.createRelease({
        ...repo,
        tag_name: input.tag,
        name: input.name,
        body: input.body,
        draft: false,
        prerelease: input.prerelease,
      });
      return toTarget(data);
    },
  };
}

/** What the release sink needs to write one persona's block. */
export interface ReleaseWrite {
  key: string;
  persona: string;
  gen: string;
  /** Canonical text in release form. */
  text: string;
  plan: SinkPlan;
  current: ReleaseTarget | null;
  mode: "section" | "replace";
  nameTemplate: string;
  prerelease: "auto" | boolean;
  /** The tag's target commit changes workflow files. */
  touchesWorkflows: boolean;
}

/**
 * The release body after writing the block.
 *
 * @param body - Current body
 * @param block - The marked block to write
 * @param write - Plan and mode
 * @returns The new body
 */
export function nextReleaseBody(
  body: string,
  block: string,
  write: Pick<ReleaseWrite, "plan" | "mode" | "key" | "persona">
): string {
  const existing = findMarkedBlocks(body).find(
    (b) => b.fields.key === write.key && b.fields.persona === write.persona
  );
  if (existing) return `${body.slice(0, existing.start)}${block}${body.slice(existing.end)}`;
  if (write.mode === "replace") return block;
  return body.trim() ? `${body.replace(/\s+$/, "")}\n\n${block}` : block;
}

function writeError(
  error: unknown,
  write: ReleaseWrite,
  action: "create" | "update"
): ReleaseRayError {
  const status = isHttpError(error) ? error.status : 0;
  const message = isHttpError(error) ? (error.message ?? "") : String(error);
  const details: string[] = [];
  if (/Resource not accessible by integration/i.test(message)) {
    details.push("The token lacks contents: write; add it to the job's permissions");
  }
  if ((status === 404 || status === 403) && action === "create") {
    details.push(
      write.touchesWorkflows
        ? `The tag's commit changes .github/workflows/, and GITHUB_TOKEN cannot create a release for it. Pass a PAT or GitHub App token with workflows write as github-token (see the app-token recipe)`
        : "Check that the token can write releases (contents: write)"
    );
  }
  return new ReleaseRayError(
    `Could not ${action} the GitHub Release for ${write.key} (HTTP ${status || "error"})`,
    EXIT_CODES.budget,
    details,
    { cause: error }
  );
}

/**
 * Writes one persona's block according to its plan.
 *
 * @param api - Release API
 * @param write - Key, persona, text, plan and settings
 * @returns Whether the release changed, its URL, and any warning
 * @throws ReleaseRayError (exit 3) when GitHub refuses the write
 */
export async function applyReleasePlan(
  api: ReleaseApi,
  write: ReleaseWrite
): Promise<{
  changed: boolean;
  url: string | null;
  /** The release after the write, from the write's response. */
  target: ReleaseTarget | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const { plan } = write;
  if (plan.action !== "create" && plan.action !== "update") {
    return { changed: false, url: write.current?.url ?? null, target: write.current, warnings };
  }
  const block = writeMarkedBlock(
    { key: write.key, persona: write.persona, gen: write.gen, out: outputDigest(write.text) },
    write.text
  );
  if (!write.current) {
    if (write.touchesWorkflows) {
      warnings.push(
        `The commit for ${write.key} changes .github/workflows/; GITHUB_TOKEN cannot create its release. Use a PAT or GitHub App token (the app-token recipe)`
      );
    }
    try {
      const created = await api.create({
        tag: write.key,
        name: renderReleaseName(write.nameTemplate, write.key),
        body: block,
        prerelease: write.prerelease === "auto" ? isSemverPrerelease(write.key) : write.prerelease,
      });
      return { changed: true, url: created.url, target: created, warnings };
    } catch (error) {
      throw writeError(error, write, "create");
    }
  }
  const body = nextReleaseBody(write.current.body, block, write);
  if (body === write.current.body) {
    return { changed: false, url: write.current.url, target: write.current, warnings };
  }
  try {
    const updated = await api.updateBody(write.current.id, body);
    return { changed: true, url: updated.url, target: updated, warnings };
  } catch (error) {
    throw writeError(error, write, "update");
  }
}
