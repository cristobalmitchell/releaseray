# Security

ReleaseRay runs in your workflow, on your runner, with your token and your model key. This page covers what it sends where, how it treats repository text, and how to run it safely on public repositories. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Data flow

- **Sent to your LLM provider:** pull request and linked-issue titles and bodies (sanitized and truncated to `enrichment.maxBodyChars`), labels, author logins, commit subjects for commit-only ranges, and, only when `enrichment.comments` is on, comments from owners, members and collaborators.
- **Sent to GitHub:** REST reads for those items, `GET /rate_limit`, the release lookup and write, and the CHANGELOG push.
- **Sent to the notification services you configure, and only those:** one persona's published (already filtered) notes, the release key, the repository name and the release link. Slack webhook URLs must be `https` on `hooks.slack.com` or `hooks.slack-gov.com`, Teams URLs on `*.webhook.office.com` or `*.office365.com`, and Intercom calls go only to `api.intercom.io`; any other host is refused before a request is made.
- **Sent nowhere else.** No telemetry, no analytics, no service run by the maintainer.
- **Not sent to the model:** code diffs, file contents, secrets in the configuration (there are none: credentials are environment variables).

Before text reaches the model, the input sanitizer removes code blocks, secret-shaped strings (keys, tokens, JWTs), URLs carrying tokens, email addresses, HTML comments, and zero-width and bidirectional control characters.

## Prompt injection

Merged pull requests and issues are written by contributors, possibly outside contributors and bots. The model has no tools, no network access and no credentials; which targets are written, with which token, comes only from your config and workflow. The realistic risk is therefore to the published text: false claims, phishing links, mass mentions, invented changes, cost inflation through long bodies, and attempts to move internal-persona content into public notes.

| Layer                           | What it does                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reduce input                    | Sanitizing as above; bodies capped; comments off by default and, when on, kept only from trusted associations                                                                                                                                                                                                                         |
| Separate data from instructions | All repository text is one JSON value inside an `<untrusted_input_json>` block after the instructions. `<`, `>` and `&` in it are escaped, so text cannot close the block, and the prompt tells the model the block is data                                                                                                           |
| Isolate personas                | Each persona is its own model call; no persona's output enters another's prompt, so injected text cannot carry internal notes into public ones                                                                                                                                                                                        |
| Constrain output                | Length caps; references must name items fetched for the release (others are removed, including pull and issue URLs); sections limited to the persona's; contributors taken from PR authors, never from the model; off-allowlist links redacted; raw HTML and images removed; `@mentions` written as code so notes never notify anyone |
| Keep a human in the loop        | Dispatch with `publish: false`, read the summary, then dispatch with `publish: true`; or use the hardened workflow with an environment that requires reviewers. `onHumanEdit: skip` protects corrections                                                                                                                              |

The [prompt-injection suite](../test/injection/) runs nine hostile pull requests (instruction override, a closing delimiter in a body, hidden HTML comments, zero-width text, link bait, mention spam, an image beacon, a fake breaking-change claim and a 50 KB body) through the whole pipeline with a model that obeys the injection. Every published persona must come out schema-valid with no off-allowlist link, unknown reference, live mention, image or raw HTML.

Separating data from instructions reduces injection; it does not eliminate it. A model can still be persuaded to describe a change misleadingly in plain words. Review published notes the way you review anything else contributors write.

## Workflow safety

- **Events.** `pull_request_target` and `workflow_run` are refused: both can run with a write token on behalf of code from a fork. `pull_request` runs only `mode: preview`, which never calls the model and never writes.
- **Inputs, not interpolation.** Every example passes values to the Action as inputs and to scripts through `env:`; none puts `${{ }}` inside a `run:` script.
- **Least privilege.** Workflows grant nothing at the top level; each job asks for what it needs ([docs/tokens.md](tokens.md)).
- **The hardened split.** On public repositories that merge outside contributions, use [`release-notes-hardened.yml`](../examples/workflows/release-notes-hardened.yml): the job holding the LLM key has a read-only token, and the job that writes never sees the key. `mode: publish` refuses a `notes.json` whose sha256 differs from the generate job's `notes-digest`.
- **Credentials.** The token is masked in logs, and so is each notification webhook URL and token: the Action reads only the variables that `outputs.notify` names, and never prints, logs or summarizes their values. The CHANGELOG push authenticates with an explicit header built from `github-token` and registered as a secret; it clears any header `actions/checkout` persisted, and git subprocesses do not receive the LLM or cloud credentials.

## Internal persona visibility

The built-in `internal` persona asks for customer-success talking points, competitive positioning and objection handling. Actions logs and summaries of a public repository are public.

| Surface                                                            | Public repository                                                                           | Private repository |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------ |
| Job summary                                                        | Internal personas withheld, with a notice, unless `outputs.allowInternalOnPublicRepo: true` | Included           |
| Workspace files and `notes.json` (and any artifact made from them) | Withheld unless `allowInternalOnPublicRepo: true`                                           | Included           |
| GitHub Release, CHANGELOG                                          | Only with `outputs.allowInternalOutputs: true` (a config error otherwise)                   | Same               |
| Slack, Teams, Intercom                                             | Allowed in a single-job run; never through the hardened split's artifact                    | Allowed            |

Repository visibility comes from the event payload; when it is missing, the repository is treated as public. A persona with no eligible output is not generated, which also saves the model call.

## Supply chain

- One committed bundle, `dist/action.js`, rebuilt and compared in CI; `dist/licenses.txt` lists every bundled package.
- Dependencies pinned to exact versions; Dependabot for npm and Actions; a lockfile guard rejects hosted-product SDKs.
- Third-party actions in CI and examples pinned to full commit SHAs.
- gitleaks on every pull request; token-shaped test fixtures are assembled at run time.
- Releases are immutable. Pin `uses:` to the full commit SHA of a release.
