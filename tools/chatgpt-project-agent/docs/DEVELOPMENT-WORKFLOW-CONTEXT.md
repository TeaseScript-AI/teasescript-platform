# ChatGPT project-agent development workflow context

**Purpose:** Stable startup routing for a connector-local session.
**Authority:** After checkout, the repository's `AGENTS.md`, `README-FIRST.md`,
`docs/agents/README.md`, assigned issue or pull request, and relevant current
documents control the exact work.

## Before checkout

This environment selects the connector-local source/workspace route by
capability: it has a GitHub control-plane connector plus local shell/filesystem,
but no supported network clone or fetch.

1. Use one narrow connector file read from current `main` to obtain
   `docs/agents/CONNECTOR-SOURCE-ACQUISITION.md`.
2. Follow that current canonical guide to resolve one exact source artifact and
   run the trusted installed preparation helper.
3. Do not copy its fixed-index, mailbox, polling, timing, or compatibility
   details into this installed derivative; the canonical acquisition owner may replace them.
4. Continue only from the fully verified local checkout.

The setup/runtime migration remains tracked by issue #210. Do not invent a
missing setup command or treat the structural source layout as a completed
distribution.

## After checkout

Read applicable `AGENTS.md`, repository `README-FIRST.md`, and the assigned issue
or pull request. Select the technical capability route in `docs/agents/README.md`;
normally this is `docs/agents/CONNECTOR-LOCAL.md`. Use local shell, Git, editor,
search, and test tools for repository work, and use the connector only for live
GitHub state and permitted writes. Follow the task documents selected by
`README-FIRST.md`.

Universal issue, branch, pull-request, review, documentation, merge, and
verification rules remain in `docs/DEVELOPMENT-WORKFLOW.md`. Do not reproduce
them here.

## Publication and task changes

Read `docs/agents/PUBLICATION-CONSTRAINED.md` and then
`docs/PATCH-PUBLICATION.md` only when a concrete publication constraint exists.
Add `docs/agents/ORCHESTRATOR.md` only for explicitly coordinated multi-agent
work. Re-select the capability route when technical capabilities, branch/head,
or permitted publication writes change; use `README-FIRST.md` for task changes.

## Ownership

The owner decides product scope, priorities, gates, and unresolved product or
architecture choices. Present realistic options and consequences compactly
rather than silently choosing. Temporary task state remains outside GitHub;
accepted results belong in the appropriate canonical owner.
