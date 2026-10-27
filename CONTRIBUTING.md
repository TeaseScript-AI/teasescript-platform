# Contributing

TeaseScript is built by its owner with a team of agents. This page is for reporters from outside the repository.

## Report an issue

- Use an issue form: **Bug**, **Task or feature request**, or **Decision**. Only the first field is required, and a
  blank issue is fine too.
- Lead with what goes wrong and when you run into it; put logs and diagnosis last.
- Search open and closed issues first, and add new evidence to an existing issue instead of opening a duplicate.
- With `gh`, use the forms' headings in the same order ([`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)) and set
  the type and triage label, for example
  `gh issue create --type Bug --label "needs triage" --title "…" --body-file issue.md`.

## Review a pull request

Leave one comment per review with, for each finding, a reproduction, the expected and actual behavior, and whether it
blocks the merge.

## Work in the repository

Start with [`AGENTS.md`](AGENTS.md); [`docs/DEVELOPMENT-WORKFLOW.md`](docs/DEVELOPMENT-WORKFLOW.md) covers issues,
labels, pull requests and reviews.
