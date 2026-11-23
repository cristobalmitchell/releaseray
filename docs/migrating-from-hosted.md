# Migrating from the hosted ReleaseRay App

The hosted ReleaseRay GitHub App is being retired in favor of this Action. The Action does what the App's release-notes pipeline did, in your own workflow and with your own model key, and keeps nothing outside your repository.

## Steps

1. **Export your personas.** On the hosted dashboard, open Settings → Personas and download the YAML. Commit it as `.releaseray/personas.yml`, or anywhere in the repository.
2. **Convert them.** Add the [tools workflow](../examples/workflows/releaseray-tools.yml) and run it with `mode: migrate-personas`. It writes the converted config to the workspace (never over an existing file), shows it in the job summary, and uploads it as an artifact. Copy it to `.releaseray/config.yml` and commit it.
3. **Check the result.** Run the tools workflow with `mode: validate-config`, then `mode: preview` on a recent tag.
4. **Check what the App already published.** Before turning on publishing, open the GitHub Release for each recent tag. A range the App marked as failed may still have published, and a scheduled range may never have.
5. **Add the release-notes workflow** from the [quickstart](../README.md#quickstart), and the `OPENAI_API_KEY` secret (or `ANTHROPIC_API_KEY` with `llm.provider: anthropic`), or the AWS credentials for Bedrock.
6. **Uninstall the App** once the workflow has published a release.

Until `v1.1.0`, the Action appends its own block below text the App wrote, with a warning. `v1.1.0` adds `mode: adopt`, which marks the App's existing release bodies and CHANGELOG entries as taken over, so nothing is written twice; for releases the App already published, consider waiting for it or running with `publish: false`.

## Settings and their config keys

| Hosted setting                                                | Config key                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Persona name, slug, description                               | `personas[].name`, `slug`, `description`                                                                                     |
| Tone sliders (formality, technical depth, enthusiasm, detail) | `personas[].tone.formality`, `technicalDepth`, `enthusiasm`, `detail`. A value of 0 is now kept; the App replaced it with 50 |
| Custom instructions                                           | `personas[].instructions`, or `instructionsFile` under `.releaseray/`                                                        |
| Include identifiers, migration guides, breaking changes       | `personas[].include.identifiers`, `migrationGuides`, `breakingChanges`                                                       |
| Sections and the highlights, upgrade and contributors toggles | `personas[].sections`, `include.highlights`, `upgradeInstructions`, `contributors`                                           |
| Disabled persona                                              | `personas[].enabled: false`                                                                                                  |
| `tone` and `audienceLevel` text                               | Dropped: the App never sent them to the model. `migrate-personas` prints a notice; use the sliders or instructions           |
| Which persona goes to which channel                           | `outputs.githubRelease.persona`, `outputs.changelog.persona` (and `outputs.notify[].persona` from v1.1)                      |
| Bring-your-own Bedrock                                        | `llm.provider: bedrock`, `llm.region`, and your AWS credentials in the workflow                                              |
| Slack, Teams and Intercom integrations                        | `outputs.notify` from v1.1, with webhook URLs and keys as Actions secrets named by `webhookUrlEnv` or `apiKeyEnv`            |
| Scheduled publication                                         | A dispatch at the chosen time, or the [preview schedule](../examples/workflows/release-notes-preview.yml) for drafts         |

The persona YAML only carries the fields in the first rows. Sliders, sections and visibility toggles that you set on the dashboard are not in the download; set them in the config after converting.

## What is different

- **Your key, your bill.** The model runs on your OpenAI or AWS account. The job summary and the `llm-cost-usd` output show tokens and cost per release.
- **No dashboard.** Drafts appear in the job summary and as workspace files; edits happen in the GitHub Release or CHANGELOG, and ReleaseRay leaves hand-edited blocks alone.
- **No email digests or analytics.** Use a recipe step if you need to send notes elsewhere.
- **One repository per workflow.** Each repository runs its own workflow with its own config.
