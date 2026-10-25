# ReleaseRay

ReleaseRay is a GitHub Action that turns the pull requests and issues merged between two tags into release notes written for different readers: engineers, your internal customer-facing team, and customers. It runs in your own workflow, on your own LLM key, and publishes to your GitHub Release and `CHANGELOG.md`.

> **Status: under construction.** There is no release yet. The first usable version will be `v1.0.0`; until then, nothing here is ready to use in a workflow.

## What it will do

- Read tags, commits and PR numbers from your checkout, and PR and issue content from the GitHub REST API.
- Classify changes into sections you can configure.
- Write one set of notes per persona with the LLM provider you choose (OpenAI or an OpenAI-compatible endpoint, or AWS Bedrock).
- Publish to the GitHub Release, `CHANGELOG.md`, the job summary and workspace files, without duplicating notes on re-runs.

Configuration lives in `.releaseray/config.yml` in your repository. The maintainer runs no service: nothing is sent anywhere except to GitHub and to the LLM provider you configure.

## License

[MIT](LICENSE)
