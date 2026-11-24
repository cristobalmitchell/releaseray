# Migrating from the hosted ReleaseRay App

The hosted ReleaseRay GitHub App is being retired in favor of this Action. The Action does what the App's release-notes pipeline did, in your own workflow and with your own model key, and keeps nothing outside your repository.

## Steps

1. **Export your personas.** On the hosted dashboard, open Settings → Personas and download the YAML. Commit it as `.releaseray/personas.yml`, or anywhere in the repository.
2. **Convert them.** Add the [tools workflow](../examples/workflows/releaseray-tools.yml) and run it with `mode: migrate-personas`. It writes the converted config to the workspace (never over an existing file), shows it in the job summary, and uploads it as an artifact. Copy it to `.releaseray/config.yml` and commit it.
3. **Check the result.** Run the tools workflow with `mode: validate-config`, then `mode: preview` on a recent tag.
4. **Check what the App already published.** Open the GitHub Release for each tag the App handled. A range the App marked as failed may still have published, and a scheduled range may never have. Adopt only what is really there.
5. **Adopt the App's releases.** Run the tools workflow with `mode: adopt` and `all_tags` on (or one tag in `to`). See [Adopt and backfill](#adopt-and-backfill).
6. **Backfill CHANGELOG.md (optional).** If you turn on `outputs.changelog`, run the tools workflow with `mode: sync-changelog`, `all_tags` and `push` on.
7. **Add the release-notes workflow** from the [quickstart](../README.md#quickstart), and the `OPENAI_API_KEY` secret (or `ANTHROPIC_API_KEY` with `llm.provider: anthropic`), or the AWS credentials for Bedrock.
8. **Uninstall the App** once the workflow has published a release.

## Adopt and backfill

Both modes run from the `migrate` job of the [tools workflow](../examples/workflows/releaseray-tools.yml), which checks out the default branch with `fetch-depth: 0` and has `contents: write`. Neither calls the LLM or needs a model key.

**`mode: adopt`** takes over text the App wrote, so the Action never appends a second copy of it:

- For each tag (the `to` input, or every tag matching `range.tagPattern` with `all-tags: true`), it reads the GitHub Release and wraps an unmarked body in a block for `outputs.githubRelease.persona`, marked `gen=adopted`. Releases that are missing, empty or already marked are left alone.
- With `outputs.changelog.enabled`, it does the same for an unmarked `## [<tag>]` entry in `CHANGELOG.md`, and pushes the edit as one commit when `push` is on.
- The next release-notes run treats adopted blocks as current: no LLM call and no write. Run with `force: true` to replace an adopted block with generated notes; a block someone has edited since is still protected by `onHumanEdit: skip`.
- It costs one read and at most one write per tag. GitHub limits content-creating requests to 80 a minute and 500 an hour, so writes are 1 second apart when a run has at most 80 to make and 7.2 seconds apart otherwise. A run stops after 400 writes, about 48 minutes, and its warning names the next tag and the next safe start: one hour after its first write. Run it again after that time; adopted releases are skipped. Writes by other workflows in that hour count against the same limit.

**`mode: sync-changelog`** copies each release's block for `outputs.changelog.persona` into `CHANGELOG.md`, with headings shifted down one level and the date of the tag's commit, newest first below any `## [Unreleased]` section:

- It reads one release per tag. Drafts, releases without a ReleaseRay block (adopt them first) and missing releases are skipped.
- Each entry keeps the release block's `gen`, so the next release-notes run treats both as current.
- An entry ReleaseRay wrote is brought in line with the release, so hand edits made on the release page are mirrored. An entry someone wrote or edited in `CHANGELOG.md` is left alone unless `outputs.changelog.onHumanEdit` is `overwrite`.
- Without `push`, the edit stays in the runner's workspace. A second run with nothing changed makes no commit.

If a release body loses its marker comments later, for example in a hand edit, the next run sees it as unmarked and appends a block. Run `adopt` again for that tag, or use `outputs.githubRelease.mode: replace`.

## Settings and their config keys

| Hosted setting                                                | Config key                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona name, slug, description                               | `personas[].name`, `slug`, `description`                                                                                                                                                                                                                                                                                                                    |
| Tone sliders (formality, technical depth, enthusiasm, detail) | `personas[].tone.formality`, `technicalDepth`, `enthusiasm`, `detail`. A value of 0 is now kept; the App replaced it with 50                                                                                                                                                                                                                                |
| Custom instructions                                           | `personas[].instructions`, or `instructionsFile` under `.releaseray/`                                                                                                                                                                                                                                                                                       |
| Include identifiers, migration guides, breaking changes       | `personas[].include.identifiers`, `migrationGuides`, `breakingChanges`                                                                                                                                                                                                                                                                                      |
| Sections and the highlights, upgrade and contributors toggles | `personas[].sections`, `include.highlights`, `upgradeInstructions`, `contributors`                                                                                                                                                                                                                                                                          |
| Disabled persona                                              | `personas[].enabled: false`                                                                                                                                                                                                                                                                                                                                 |
| `tone` and `audienceLevel` text                               | Dropped: the App never sent them to the model. `migrate-personas` prints a notice; use the sliders or instructions                                                                                                                                                                                                                                          |
| Which persona goes to which channel                           | `outputs.githubRelease.persona`, `outputs.changelog.persona`, `outputs.notify[].persona`                                                                                                                                                                                                                                                                    |
| Bring-your-own Bedrock                                        | `llm.provider: bedrock`, `llm.region`, and your AWS credentials in the workflow                                                                                                                                                                                                                                                                             |
| Slack, Teams and Intercom integrations                        | `outputs.notify`, with webhook URLs and tokens as Actions secrets named by `webhookUrlEnv` or `apiKeyEnv`. Posts only when the release changed, never on a re-run; there is no connection-test message and no Intercom author field. The Intercom title comes from `titleTemplate` (default `Release {{key}}`), and an article is found again by that title |
| Scheduled publication                                         | A dispatch at the chosen time, or the [preview schedule](../examples/workflows/release-notes-preview.yml) for drafts                                                                                                                                                                                                                                        |

The persona YAML only carries the fields in the first rows. Sliders, sections and visibility toggles that you set on the dashboard are not in the download; set them in the config after converting.

## What is different

- **Your key, your bill.** The model runs on your OpenAI or AWS account. The job summary and the `llm-cost-usd` output show tokens and cost per release.
- **No dashboard.** Drafts appear in the job summary and as workspace files; edits happen in the GitHub Release or CHANGELOG, and ReleaseRay leaves hand-edited blocks alone.
- **No email digests or analytics.** Use a recipe step if you need to send notes elsewhere.
- **One repository per workflow.** Each repository runs its own workflow with its own config.
