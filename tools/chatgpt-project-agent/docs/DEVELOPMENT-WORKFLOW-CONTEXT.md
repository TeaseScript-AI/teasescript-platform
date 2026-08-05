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
or pull request. Select the capability route in `docs/agents/README.md`; normally
this is `docs/agents/CONNECTOR-LOCAL.md`, with role overlays only when assigned.
Use local shell, Git, editor, search, and test tools for repository work, and use
the connector only for live GitHub state and permitted writes.

Universal issue, branch, pull-request, review, documentation, merge, and
verification rules remain in `docs/DEVELOPMENT-WORKFLOW.md`. Do not reproduce
them here.

## Publication and role changes

Read `docs/agents/PUBLICATION-CONSTRAINED.md` and then
`docs/PATCH-PUBLICATION.md` only when a concrete publication constraint exists.
Add the orchestrator or reviewer route only when that role is assigned. Re-select
the route when capabilities, task, branch/head, work phase, or permitted writes
change.

## Ownership

The owner decides product scope, priorities, gates, and unresolved product or
architecture choices. Present realistic options and consequences compactly
rather than silently choosing. Temporary task state remains outside GitHub;
accepted results belong in the appropriate canonical owner.
