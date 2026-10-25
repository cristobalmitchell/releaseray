# Contributing

Thanks for helping. ReleaseRay has a single maintainer, so small, focused pull requests with tests get reviewed fastest.

## Before you open an issue

Bug reports need the job summary from a run with `mode: doctor`, and from `mode: validate-config` if the problem may be in your configuration. The issue templates ask for both. Remove secrets and anything private before pasting.

## Development

Requirements: Node 24 and pnpm 10.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

The CI checks you will see on a pull request:

- `lint`, `typecheck` and `test`;
- `secret-scan`, which runs gitleaks over the tree;
- `check-deps`, which fails if the lockfile contains a hosting SDK the Action must never need;
- `check-boundary`, which fails if code outside `src/action/` imports `@actions/core` or `@actions/github`, or reads `process.env`. The core takes plain inputs and returns plain results, so it stays testable without a workflow run.

Tests never set environment variables globally. If a test needs a token-shaped string, build it at runtime instead of writing it out literally, so secret scanners stay quiet.

## Branches and commits

- Work on a short-lived branch named `{type}/{issue-number}-{short-description}`, for example `fix/42-changelog-ordering`, and open a pull request into `main`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and reference an issue: `fix(changelog): keep [Unreleased] first (#42)`.
- Releases are cut from `main` by tag. Tags are immutable.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
