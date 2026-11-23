/**
 * Descriptions of every config key: the one source for the JSON Schema's
 * `description` fields (editor hovers) and for docs/configuration.md. Paths
 * use `[]` for array items. A unit test fails when a schema key has none.
 */

/** Section headings and introductions, by top-level key. */
export const SECTIONS: Record<string, { title: string; intro: string }> = {
  version: { title: "Version", intro: "The config format version." },
  range: {
    title: "Range",
    intro:
      "How the commits for a release are chosen. Everything comes from local git, so the checkout needs `fetch-depth: 0`.",
  },
  classification: {
    title: "Classification",
    intro:
      "Categories, the labels and commit types that map to them, and what to leave out. Configured categories merge over the nine built-ins by id.",
  },
  enrichment: {
    title: "Enrichment",
    intro:
      "What is fetched from GitHub besides each pull request's title and labels. More enrichment means more REST requests and a longer prompt.",
  },
  personas: {
    title: "Personas",
    intro:
      "Who the notes are written for. Entries merge over the built-ins `engineer`, `internal` and `customer` by slug; other slugs add personas.",
  },
  outputs: {
    title: "Outputs",
    intro:
      "Where the notes go. The job summary and workspace files are on by default; the GitHub Release is written when `publish` resolves to true.",
  },
  llm: {
    title: "LLM",
    intro:
      "The model provider and its limits. Keys come from environment variables, never from this file.",
  },
  github: {
    title: "GitHub requests",
    intro: "The REST request budget and what to do when a release would exceed it.",
  },
  sanitize: { title: "Sanitizing", intro: "What is removed from published text." },
  render: { title: "Rendering", intro: "How the Markdown looks." },
};

/** Field descriptions by path. */
export const DESCRIPTIONS: Record<string, string> = {
  $schema: "Editor hint; ignored by the Action.",
  version: "Always 1.",

  "range.tagPattern": "Glob over tag names that count as releases, as `git tag --list` reads it.",
  "range.includePrereleases": "Let a prerelease tag be the previous tag of a release.",
  "range.allowNonAncestor":
    "Allow an explicit `from` that is not an ancestor of `to`. The `allow-non-ancestor` input sets it for one run.",
  "range.fallbackToCommits":
    "Write notes from commit messages when no commit names a pull request.",
  "range.maxPullRequests":
    "Stop before any REST call when a range names more pull requests than this; set `from` or narrow the window.",

  "classification.categories": "Categories to add, or built-in categories to change, by id.",
  "classification.categories[].id":
    "Slug. A built-in id (breaking, security, features, improvements, fixes, performance, deprecations, docs, internal) changes that category.",
  "classification.categories[].title":
    "Name the classifier and the model see. Default: the built-in title, or the id in words.",
  "classification.categories[].labels":
    "Pull request labels that put a change here: exact names (any case) or `/regex/flags`.",
  "classification.categories[].conventionalTypes":
    "Conventional-commit types that map here, such as feat, fix or ci.",
  "classification.categories[].internal":
    "Hide this category from personas that exclude internal changes.",
  "classification.conventionalCommits": "Read conventional-commit prefixes in titles and commits.",
  "classification.fallbackCategory":
    "Category for changes with no other signal; unknown model sections merge into its section.",
  "classification.exclude.labels":
    "Pull requests with any of these labels are left out (exact names or `/regex/`).",
  "classification.exclude.authors":
    "Pull requests by these logins are left out, such as `renovate[bot]`.",
  "classification.exclude.titlePatterns":
    "Regular expressions (`source` or `/source/flags`) matched against commit subjects and pull request titles; matches are left out.",

  "enrichment.bodies": "Send pull request and issue bodies to the model.",
  "enrichment.linkedIssues": "Fetch issues that pull request bodies link to (one request each).",
  "enrichment.maxLinkedIssues": "Most linked issues fetched per release.",
  "enrichment.comments":
    "Fetch comments and reviews (two requests per pull request, one per issue). Off by default: it costs requests and widens prompt-injection exposure.",
  "enrichment.commentAuthorAssociations": "Keep only comments from these author associations.",
  "enrichment.maxBodyChars": "Characters of each body sent to the model.",

  personas: "Persona entries, merged over the built-ins by slug.",
  "personas[].slug":
    "Lowercase id. engineer, internal and customer change a built-in; anything else adds a persona.",
  "personas[].extends": "Start a new persona from a built-in's rules and sections.",
  "personas[].name": "Display name in the summary.",
  "personas[].description": "Who this persona is for; sent to the model.",
  "personas[].enabled": "Set false to stop generating this persona.",
  "personas[].visibility":
    "internal personas are withheld from public outputs and from public repositories' summaries. Default: internal for `internal` and personas extending it.",
  "personas[].tone.formality": "0 casual to 100 formal. Default 50; 0 is kept.",
  "personas[].tone.technicalDepth": "0 plain language to 100 technical. Default 50.",
  "personas[].tone.enthusiasm": "0 neutral to 100 enthusiastic. Default 30.",
  "personas[].tone.detail": "0 brief to 100 comprehensive. Default 50.",
  "personas[].instructions": "Extra instructions for the model, up to 2,000 characters.",
  "personas[].instructionsFile": "Like `instructions`, from a file under `.releaseray/`.",
  "personas[].include.identifiers": "Show pull request and issue numbers and commit SHAs.",
  "personas[].include.breakingChanges": "Ask for breaking changes.",
  "personas[].include.migrationGuides": "Ask for migration guides.",
  "personas[].include.highlights": "Render the Highlights section.",
  "personas[].include.upgradeInstructions": "Render upgrade instructions.",
  "personas[].include.contributors": "Render the contributors line (from pull request authors).",
  "personas[].sections":
    "The sections to write, in order (at most 15). Replaces the persona's default sections.",
  "personas[].sections[].id":
    "Slug. A standard section id (breaking-changes, features, bug-fixes, …) keeps its category mapping.",
  "personas[].sections[].name": "Heading in the notes.",
  "personas[].sections[].description": "What belongs in this section; sent to the model.",
  "personas[].sections[].categories":
    "Category ids this section collects. Empty: the standard section's categories, or the category with the same id.",
  "personas[].sections[].enabled": "Set false to hide the section.",
  "personas[].excludeCategories":
    "Category ids this persona never shows. The built-in customer persona excludes internal.",

  "outputs.summary.enabled": "Write notes, usage and completeness to the job summary.",
  "outputs.summary.personas": "`all`, or the slugs to show.",
  "outputs.files.enabled": "Write `<dir>/<key>/<persona>.md` and `notes.json` in the workspace.",
  "outputs.files.dir": "Directory for the workspace files, relative to the checkout.",
  "outputs.githubRelease.enabled":
    "Write a block into the GitHub Release when `publish` resolves to true.",
  "outputs.githubRelease.persona": "The persona whose notes go into the release.",
  "outputs.githubRelease.mode":
    "`section` appends a marked block and keeps other text; `replace` writes the whole body.",
  "outputs.githubRelease.onHumanEdit":
    "`skip` leaves a block a person edited; `overwrite` replaces it.",
  "outputs.githubRelease.createIfMissing":
    "Create the release when none exists for the tag. The `create-release` input sets it for one run.",
  "outputs.githubRelease.nameTemplate": "Name of a created release; `{{tag}}` is the tag.",
  "outputs.githubRelease.prerelease":
    "Prerelease flag of a created release; `auto` follows SemVer.",
  "outputs.changelog.enabled": "Write a marked entry into the CHANGELOG file in the workspace.",
  "outputs.changelog.path": "CHANGELOG path, relative to the checkout.",
  "outputs.changelog.persona": "The persona whose notes go into the CHANGELOG.",
  "outputs.changelog.onHumanEdit":
    "`skip` leaves an entry a person wrote or edited; `overwrite` replaces it.",
  "outputs.changelog.push": "Commit and push the entry. The `push` input sets it for one run.",
  "outputs.changelog.branch":
    "Branch to push to. Default: the checked-out branch, else the default branch.",
  "outputs.changelog.commitMessage": "Commit subject; `{{key}}` is the release key.",
  "outputs.changelog.author.name": "Commit author name. Default: github-actions[bot].",
  "outputs.changelog.author.email": "Commit author email.",
  "outputs.notify": "Slack, Teams and Intercom. Arrives in v1.1; rejected until then.",
  "outputs.allowInternalOutputs": "Allow an internal persona on the GitHub Release or CHANGELOG.",
  "outputs.allowInternalOnPublicRepo":
    "Show internal personas in the summary and files of a public repository.",

  "llm.provider": "`openai` (or any OpenAI-compatible endpoint), `bedrock` or `anthropic`.",
  "llm.model":
    "Model id. Default: gpt-5-mini on openai, Claude Haiku 4.5 on bedrock, claude-opus-5-5 on anthropic. Bedrock accepts inference-profile ARNs.",
  "llm.baseUrl": "OpenAI-compatible endpoint (openai only).",
  "llm.region": "AWS region (bedrock only; required there).",
  "llm.maxCompletionTokens": "Most tokens per model response.",
  "llm.maxInputTokens":
    "Most input tokens per persona call, estimated at 4 characters each and checked before any call.",
  "llm.concurrency": "Persona calls in parallel.",
  "llm.retries": "Times to ask again after invalid output; transient errors retry separately.",
  "llm.pricing.inputPer1M": "USD per million input tokens, for a model the built-in table lacks.",
  "llm.pricing.outputPer1M": "USD per million output tokens.",

  "github.maxRequests": "Request cap for a run. Default: 90% of the token's hourly core limit.",
  "github.concurrency": "REST reads in parallel. Writes are always serial.",
  "github.onBudgetExceeded":
    "When the estimate does not fit: `fail` (exit 3), `wait` for the reset within `maxWaitMinutes`, or `degrade` (drop comments, then linked issues). Also governs `llm.maxInputTokens`.",
  "github.maxWaitMinutes":
    "Longest wait for a rate-limit reset. Raise the job's `timeout-minutes` to match.",

  "sanitize.allowedDomains":
    "Hosts (and their subdomains) whose links are kept; other links are redacted.",
  "sanitize.redactPaths": "Remove file paths from published text.",

  "render.emoji": "Emoji in section headings.",
  "render.compareLink": "End with a compare link from the previous tag.",
};
