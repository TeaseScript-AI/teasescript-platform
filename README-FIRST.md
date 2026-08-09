# Read this first

## Authority and conflict handling

Use project material in this order:

1. Check whether an accepted ADR, accepted specification, or controlling current topic document covers the exact
   issue. A post-V30 owner decision becomes durable only after it is synchronized into the applicable accepted source.
   Chat, issue, pull-request, test, review, or wish text remains evidence or task context until that synchronization
   occurs.
2. For TeaseScript syntax and semantics, use `docs/specifications/accepted-syntaxes-v30.md` unless a later accepted
   ADR or accepted specification update supersedes the exact point within its stated scope.
3. Use `CURRENT-DESIGN.md` and `PHASE-STATUS.md` for current architecture and implementation status.
4. Use the task-specific current topic document in `docs/`.
5. Use `docs/planning/RELEASE-ROADMAP.md` for owner-selected release-stage placement, open release-stage outcomes,
   and compact roadmap progress history. Placement does not schedule work or define accepted architecture, syntax,
   behavior, or current status.
6. Use other files in `docs/planning/` only for active, non-implemented planning. Planning text is non-authoritative,
   does not schedule implementation, and may not override accepted decisions or current topic sources.
7. Use `WISHES.xml` for product intent and decision history; an active wish is not automatically an implementation decision or backlog commitment.
8. Treat capability research, old project packages, audit reports, and source examples as non-authoritative reference material.

When files conflict, identify the exact conflict. Do not silently combine historical syntax, planning proposals, and accepted syntax.

## Current design and status

Use `CURRENT-DESIGN.md` for the stable cross-component architecture, trust, isolation, persistence, language/library,
and deterministic-runtime boundaries. Use `PHASE-STATUS.md` for the current phase, gates, implemented capability
groups, and major exclusions. Load a topic document only when the assignment depends on its detailed contract.

Exact source layout, internal format revisions, dependency versions, test results, and live workflow state belong in
their executable or topic sources rather than this task router.

## Documentation routing

Start with applicable `AGENTS.md` instructions and the assigned issue or pull
request. Select the capability route in `docs/agents/README.md`, then load only
the task-controlling sources required by that route. Before
implementation, final self-review, or an explicitly assigned pull-request review,
read `docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md`. Read
`docs/review-and-audit/AUDIT.md` only for an explicitly assigned audit; ordinary
work does not load both routes. Read `CURRENT-DESIGN.md` for
architecture-affecting or broad cross-component work and `PHASE-STATUS.md` for
milestone, gate, integration-status, or current-capability work.

- `CURRENT-DESIGN.md`: current architecture and implementation boundaries.
- `PHASE-STATUS.md`: current phase, gate, and high-level implemented-capability status.
- `AGENTS.md`: coding, review, and Git rules for every agent.
- `docs/review-and-audit/`: role-based implementation, review, and explicitly
  assigned audit guidance.
- `docs/DEVELOPMENT-WORKFLOW.md`: universal issue, branch, pull-request,
  review, documentation, merge, and verification rules.
- `docs/agents/README.md`: technical capability router for source acquisition,
  permitted writes, verification, and publication constraints; task guidance is routed separately.
- `tools/chatgpt-project-agent/docs/LOCAL-AGENT-BOOTSTRAP.md`: project-agent source and installed-layout contract.
- `docs/chatgpt-project/SYSTEM-PROMPT.txt`: repository-maintained ChatGPT Project Settings prompt candidate; read only
  for prompt maintenance or deliberate owner-approved synchronization. It does not prove the live Project Settings state.
- `docs/README.md`: documentation map.
- `docs/DOCUMENTATION-OWNERSHIP.md`: mandatory documentation-edit/review guidance and the boundary between canonical repository material and shared research.
- `docs/specifications/`: accepted consolidated specifications.
- `docs/decisions/`: accepted and proposed ADRs.
- `docs/OPEN-DECISIONS.md`: unresolved choices; read it only when the task depends on a gap that current authority does not resolve.
- `docs/planning/RELEASE-ROADMAP.md`: owner-selected release-stage placement, open release-stage outcomes, and compact
  roadmap progress history; it does not schedule work or replace current implementation status.
- `docs/planning/`: release-stage roadmap plus active, non-implemented planning; read `docs/planning/README.md` for its
  lifecycle and authority boundary. Entries are non-authoritative and not automatically scheduled.
- `docs/reference/`: routing notices for research intentionally stored outside this repository.
