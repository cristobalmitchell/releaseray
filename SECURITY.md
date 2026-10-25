# Security policy

## Supported versions

Security fixes go to the latest `v1.x` release. After a new major version ships, the previous major receives security fixes for three months.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's [private vulnerability reporting](https://github.com/cristobalmitchell/releaseray/security/advisories/new) for this repository.

Include what you can of the following:

- the version or commit SHA you used;
- the workflow file and `.releaseray/config.yml`, with secrets removed;
- what an attacker controls (for example PR titles, PR bodies, issue text, or repository files) and what they can achieve;
- steps to reproduce.

You should get an acknowledgement within 7 days. Fixes are released as a patch version, and the advisory is published once a fixed release is available.

## Scope

In scope: the Action's code in this repository, its published `dist/` bundle, and the example workflows under `examples/`.

Out of scope: your LLM provider, GitHub itself, and workflows you have changed from the examples. Prompt injection that only changes the wording of generated notes, without bypassing the output filters (links, mentions, HTML and images), is a known limitation rather than a vulnerability; reports that bypass those filters are in scope.
