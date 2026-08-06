# Connector-local agent

## Select this route when

The agent has a GitHub control-plane connector plus local shell/filesystem tools, but normal network clone or
fetch is not a supported repository-acquisition path. Product names are examples only; the capability set
selects this route.

## Reading set

**Required**

- before checkout, the trusted project-agent wayfinder and installed workflow/bootstrap guidance available in
  the environment;
- [`CONNECTOR-SOURCE-ACQUISITION.md`](CONNECTOR-SOURCE-ACQUISITION.md) while obtaining or refreshing source;
- after checkout, applicable `AGENTS.md`, repository `README-FIRST.md`, the assigned issue or pull request,
  `docs/DEVELOPMENT-WORKFLOW.md`, and `docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md`;
- only the relevant topic documents, accepted decisions, code, and tests selected by the checkout route.

**Conditional**

- `PUBLICATION-CONSTRAINED.md` only when permitted connector writes cannot safely publish the tested result;
- `ORCHESTRATOR.md` only for explicitly coordinated multi-agent work;
- `tools/chatgpt-project-agent/docs/LOCAL-AGENT-BOOTSTRAP.md` for the maintained environment boundary or #210 work.

**Excluded by default**

- `DIRECT-REPOSITORY.md` and network clone/fetch workarounds;
- `docs/PATCH-PUBLICATION.md` before a real publication constraint exists;
- setup, archive/runtime-split, overlay, distribution, or external synchronization work still owned by #210.

## Source acquisition

Resolve one exact source identity, obtain its verified artifact through the single acquisition owner, and run
the trusted installed preparation helper. Inspect, edit, search, and test the resulting checkout locally. Do
not use repeated connector file reads as the normal repository-reading strategy and do not execute an
untrusted helper from the artifact being reviewed to establish its own trust.

The current fixed-index, regeneration, compatibility, timing, and polling details live only in
`CONNECTOR-SOURCE-ACQUISITION.md`. That owner may replace them without changing this route, universal workflow,
or installed derivative summaries.

## Writes

Use narrow connector calls for exact live GitHub state and writes that must occur on GitHub. Prefer metadata
calls over complete patches, conversations, or logs when the smaller operation answers the question. Before
any repository-content or ref write, confirm the selected publication route and its allowed operations. Do
not improvise low-level source publication.

## Verification

Run repository checks and `git diff --check` in the prepared checkout. Before any head-sensitive GitHub write
or handoff, resolve the live PR state again and stop if the head or relevant base moved.

## Publication and handoff

Use ordinary permitted connector writes for the GitHub-state operations authorized by the assigned task. When
a coherent tested source change cannot be published safely through those writes, add
`PUBLICATION-CONSTRAINED.md`; do not treat that overlay as the default. Use the handoff surface selected by the
repository start route.

## Context-efficient connector use

Prefer exact metadata, changed-file lists, one known file patch, bounded file context, and concrete failed-job
logs in that order. Complete PR patches, merged conversation timelines, broad listings, and full logs remain
valid when their complete contents are actually required, but are not discovery defaults.
