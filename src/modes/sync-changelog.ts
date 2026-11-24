/**
 * `mode: sync-changelog` (CONVERSION-PLAN §9.5): copies each published
 * release block into CHANGELOG.md with headings shifted one level, so a
 * CHANGELOG-only repository can backfill its history and maintainers who
 * edit release notes by hand can mirror those edits. Each entry keeps the
 * release block's `gen`, so the next run treats both as current.
 *
 * No LLM call and one REST read per tag; the CHANGELOG edit is one commit
 * when `push` is on.
 */
import type { ResolvedConfig } from "../config/resolve";
import { EXIT_CODES, ReleaseRayError } from "../core/errors";
import { commitDate } from "../core/range/git";
import { assertFullHistory, selectTags } from "../core/range/resolve";
import { findMarkedBlocks } from "../core/state/marker";
import { syncChangelogEntry, type ChangelogWrite } from "../outputs/changelog-sink";
import { applyChangelogEdit } from "../outputs/persisted";
import { result, tagTable, type ModeResult, type TagModeDeps, type TagModeRequest } from "./types";

/**
 * Runs `sync-changelog`.
 *
 * @param request - `to` or `allTags`, and the workspace
 * @param config - Resolved configuration; `outputs.changelog` sets the path, persona, `onHumanEdit` and push
 * @param deps - Git, release API and CHANGELOG push
 * @returns Summary, outputs and warnings
 * @throws ReleaseRayError: exit 2 for a shallow clone, bad tags or no release client, 6 when the push is rejected
 */
export async function syncChangelog(
  request: TagModeRequest,
  config: ResolvedConfig,
  deps: Pick<TagModeDeps, "git" | "release" | "persisted" | "requests">
): Promise<ModeResult> {
  assertFullHistory(deps.git);
  const c = config.config;
  const settings = c.outputs.changelog;
  const tags = selectTags(deps.git, request, c.range.tagPattern);
  if (!deps.release) {
    throw new ReleaseRayError("sync-changelog needs the GitHub Release API", EXIT_CODES.invalid);
  }
  const mode = result();
  const rows = new Map<string, string[]>(tags.map((t) => [t, ["-"]]));

  // 1. One read per tag: the release block for the CHANGELOG persona.
  const writes: ChangelogWrite[] = [];
  for (const tag of tags) {
    const row = rows.get(tag)!;
    const release = await deps.release.get(tag);
    if (!release) {
      row[0] = "no release";
      continue;
    }
    if (release.draft) {
      row[0] = "draft, skipped";
      continue;
    }
    const block = findMarkedBlocks(release.body.replace(/\r\n/g, "\n")).find(
      (b) => b.fields.key === tag && b.fields.persona === settings.persona
    );
    if (!block) {
      row[0] = `no ${settings.persona} block`;
      continue;
    }
    writes.push({
      key: tag,
      persona: settings.persona,
      gen: block.fields.gen,
      text: block.inner,
      date: commitDate(deps.git, tag),
      onHumanEdit: settings.onHumanEdit,
    });
  }

  // 2. Apply every entry to the workspace file, then push one commit.
  // The first call is on the workspace file and fills the table; push attempts re-apply.
  let recorded = false;
  const edit = (text: string) => {
    let acc = text;
    for (const write of writes) {
      const done = syncChangelogEntry(acc, write);
      acc = done.content;
      if (!recorded) {
        rows.get(write.key)![0] =
          done.action === "skipped-human" ? "skipped (hand-written or edited)" : done.action;
        if (done.warning) mode.warnings.push(done.warning);
      }
    }
    recorded = true;
    return acc;
  };
  const changelog =
    writes.length > 0
      ? applyChangelogEdit(
          edit,
          writes.map((w) => w.key),
          settings,
          deps.persisted
        )
      : { changed: false, pushed: false };
  if (changelog.changed && !changelog.pushed) mode.files.push(settings.path);

  const count = (action: string) => [...rows.values()].filter((r) => r[0] === action).length;
  mode.outputs = {
    ...(tags.length === 1 ? { key: tags[0] } : {}),
    "release-changed": "false",
    "changelog-changed": String(changelog.changed),
    "github-requests": String(deps.requests?.() ?? 0),
    "llm-calls": "0",
    "llm-cost-usd": "0.0000",
  };
  mode.summary = [
    `# ReleaseRay sync-changelog: ${tags.length === 1 ? tags[0] : `${tags.length} tags`}`,
    "",
    `- \`${settings.path}\` (\`${settings.persona}\`): ${count("created")} created, ${count("updated")} updated, ${count("unchanged")} unchanged${changelog.pushed ? "; pushed" : changelog.changed ? "; written to the workspace (push is off)" : ""}`,
    "",
    ...tagTable(rows, ["CHANGELOG"]),
    "",
  ].join("\n");
  return mode;
}
