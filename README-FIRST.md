# Read this first

## Authority and conflict handling

Use project material in this order:

1. Check whether an accepted ADR, accepted specification, or controlling current topic document covers the exact
   issue. An owner product or technical decision becomes durable only after it is synchronized into the applicable
   accepted source. Until then, chat, issue, pull-request, test, CI, review, or wish text may prove intent, behavior,
   or execution state but remains evidence or task context.
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

## Documentation routing

Follow the start route in `AGENTS.md`. Load a topic document only when the assignment depends on its detailed contract.
Exact source layout, internal format revisions, dependency versions, test results, and live workflow state belong in
their executable or topic sources rather than this task router.

- `CURRENT-DESIGN.md`: stable cross-component architecture, trust, isolation, persistence, language/library, and
  deterministic-runtime boundaries.
- `PHASE-STATUS.md`: current phase, gates, implemented capability groups, and major exclusions.
- `AGENTS.md`: start route, coding, review, and Git rules for every agent.
- `docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md`: implementation, final self-review, and explicitly assigned
  pull-request reviews; `docs/review-and-audit/AUDIT.md`: explicitly assigned audits only.
- `docs/DEVELOPMENT-WORKFLOW.md`: universal issue, branch, pull-request,
  review, documentation, merge, and verification rules.
- `docs/agents/README.md`: technical capability router for source acquisition,
  permitted writes, verification, and publication constraints; task guidance is routed separately.
- `tools/chatgpt-project-agent/docs/LOCAL-AGENT-BOOTSTRAP.md`: project-agent source and installed-layout contract.
- `docs/chatgpt-project/SYSTEM-PROMPT.txt`: repository-maintained ChatGPT Project Settings prompt candidate; read only
  for prompt maintenance or deliberate owner-approved synchronization. It does not prove the live Project Settings state.
- `docs/README.md`: documentation map.
- `docs/PRODUCT.md`: creator audience and product intent. For language or authoring-tool design, also read
  `docs/TEASESCRIPT.md#language-design-intent` for simplicity, defaults, and advanced control.
- `docs/CODE-EDITOR.md`: browser code editor and tooling integration.
- `docs/DEBUGGER.md`: runtime inspection, simulation, and debug execution.
- `docs/ui/PLAYER-UI.md`: normative Standard Player UI. While `Upstream contract integration` is non-empty, Player work
  must also read that section.
- `docs/ui/UI-DESIGN-AND-ENGINEERING.md`: shared UI guidance; narrow tasks use its focused reading route.
- `docs/DOCUMENTATION-OWNERSHIP.md`: mandatory documentation-edit/review guidance and the boundary between canonical repository material and shared research.
- `docs/specifications/`: accepted consolidated specifications.
- `docs/decisions/`: accepted and proposed ADRs.
- `docs/OPEN-DECISIONS.md`: unresolved choices; read it only when the task depends on a gap that current authority does not resolve.
- `docs/planning/`: the release roadmap (`RELEASE-ROADMAP.md`) and active, non-implemented planning, within the
  authority limits of items 5 and 6 above; read `docs/planning/README.md` for its lifecycle and authority boundary.
- `docs/reference/`: routing notices for research intentionally stored outside this repository.
