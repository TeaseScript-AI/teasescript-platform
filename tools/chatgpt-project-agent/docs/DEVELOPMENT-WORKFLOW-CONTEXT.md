# ChatGPT project-agent development workflow context

**Purpose:** Compact routing context for connector-local ChatGPT sessions.
**Authority:** The verified checkout's `AGENTS.md`, repository
`README-FIRST.md`, `docs/DEVELOPMENT-WORKFLOW.md`, assigned issue or pull request,
and relevant current documents control the exact work.

## Default route

Use one coherent issue, one owning agent, one short-lived branch, one pull
request, independent review, CI, squash merge, and branch deletion by default.
Work in small verifiable steps, update directly affected documentation, and keep
the pull-request description aligned with the actual head.

For substantial connector-local work:

1. resolve and download one exact source artifact through the current connector workflow;
2. prepare and inspect the verified checkout with local shell, Git, editor, and test tools;
3. use the connector only for live GitHub state and permitted writes;
4. re-read the controlling documents when the task, head, phase, or publication route changes.

The ChatGPT project-agent setup/runtime migration remains tracked by issue #210.
Do not invent a missing setup command or treat this structural source layout as a
completed distribution.

## Publication

Immediately before a repository write, choose normal authenticated Git or the
verified patch-publication route in `docs/PATCH-PUBLICATION.md`. Do not improvise
low-level full-file, blob, tree, commit, or branch publication outside the exact
permitted route.

## Ownership

The owner decides product scope, priorities, gates, and unresolved product or
architecture choices. When owner input is required, present the realistic options
and consequences compactly rather than silently choosing. Temporary chat notes
stay outside GitHub; accepted results belong in the appropriate canonical file.
