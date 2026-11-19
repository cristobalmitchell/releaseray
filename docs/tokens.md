# Tokens and permissions

ReleaseRay uses one token, the `github-token` input, for REST calls and for the CHANGELOG push. It defaults to the workflow's `GITHUB_TOKEN`.

## Job permissions

Workflows should grant nothing at the top level (`permissions: {}`) and list what each job needs. Listing any scope sets every unlisted scope to `none`.

| Job                                                                                       | `permissions:`                                                                                                                   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `generate` without publishing; `preview`, `doctor`, `validate-config`, `migrate-personas` | `contents: read`, `pull-requests: read`, `issues: read`                                                                          |
| `generate` with publishing (release events, tag pushes)                                   | `contents: write`, `pull-requests: read`, `issues: read`                                                                         |
| `publish` job of the hardened split                                                       | `contents: write`                                                                                                                |
| A release job that dispatches the release-notes workflow                                  | `actions: write`                                                                                                                 |
| Bedrock with OIDC                                                                         | add `id-token: write` to the job that calls the model                                                                            |
| The CHANGELOG pull request recipe                                                         | `contents: write`, `pull-requests: write`, and the repository setting "Allow GitHub Actions to create and approve pull requests" |

## Request budget

| Token                                     | REST requests per hour                     |
| ----------------------------------------- | ------------------------------------------ |
| `GITHUB_TOKEN` on github.com              | 1,000 per repository                       |
| `GITHUB_TOKEN` on GitHub Enterprise Cloud | 15,000                                     |
| Fine-grained or classic PAT               | 5,000, shared with the user's other tokens |
| GitHub App installation token             | at least 5,000                             |

A release costs about `N + min(L, 100) + 2` requests with the default enrichment, where N is the number of pull requests and L the linked issues: 40 for 25 pull requests, 152 for 100. Comments add two requests per pull request and one per linked issue. Before fetching anything, ReleaseRay reads `GET /rate_limit` (which does not count) and compares its estimate with the lower of the remaining budget and `github.maxRequests` (default 90% of the limit). See `github.onBudgetExceeded` in the [configuration reference](configuration.md#github-requests).

Whether jobs and workflows in one repository share the `GITHUB_TOKEN` budget is not documented; the end-to-end tests will measure it and record the result here.

## When `GITHUB_TOKEN` is not enough

Pass a fine-grained PAT, or a token from a GitHub App you register (see the [App-token recipe](../examples/recipes/app-token.yml)), when:

- **The release commit changes `.github/workflows/`.** `GITHUB_TOKEN` cannot create a release whose target commit changes workflow files; GitHub answers 404 or 403. ReleaseRay warns before it tries. Updating an existing release is not affected. The token needs Workflows write.
- **The CHANGELOG branch is protected.** A push restriction or ruleset can reject `GITHUB_TOKEN`. Add the PAT's user or your App to the push list or as a bypass actor. Push lists and bypass actors exist only in organization repositories. Branches that require pull requests need a bypass actor or the [CHANGELOG pull request recipe](../examples/recipes/changelog-pr.yml); branches that require signed commits need the recipe, because the push loop's commits are unsigned.
- **The CHANGELOG commit must start other workflows.** Pushes, tags and releases made with `GITHUB_TOKEN` start no workflow runs. With a PAT or App token they do; ReleaseRay stops itself on its own commit through the `Generated-by: ReleaseRay` trailer.
- **The budget is too small.** Ranges with hundreds of pull requests and comments enabled can exceed 900 requests.

## Commit identity

With `GITHUB_TOKEN`, CHANGELOG commits are by `github-actions[bot]` (`41898282+github-actions[bot]@users.noreply.github.com`). With an App token, set `outputs.changelog.author` to the App's bot user so commits are attributed to it:

```bash
gh api "/users/<app-slug>[bot]" --jq .id
```

```yaml
outputs:
  changelog:
    author: { name: "<app-slug>[bot]", email: "<id>+<app-slug>[bot]@users.noreply.github.com" }
```

An App token lasts one hour; keep the job's `timeout-minutes` below 60.
