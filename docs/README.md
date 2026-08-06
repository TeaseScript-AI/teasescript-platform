# Documentation map

## Authority

- `../README-FIRST.md`: authority and conflict-routing rules.
- `specifications/accepted-syntaxes-v30.md`: accepted consolidated syntax baseline.
- `decisions/`: accepted and proposed ADRs; each file states its status.
- `../CURRENT-DESIGN.md`: current architecture and implementation boundaries.
- `../PHASE-STATUS.md`: current phase, gate, and high-level implemented-capability status.
- `../WISHES.xml`: product intent and decision history; wishes are not automatic implementation decisions.

## Current topic documents

- `PRODUCT.md`
- `ARCHITECTURE.md`
- `TEASESCRIPT.md`
- `RUNTIME.md`
- `DATA-AND-API.md`
- `LIBRARIES.md`
- `SECURITY.md`
- `CONTINUOUS-PERSONALITIES.md`
- `CODE-EDITOR.md`
- `LLM-INTEGRATION.md`
- `MATH-EXPRESSIONS.md`
- `CAPABILITY-MATRIX.md`
- `TESTING.md`: current testing strategy, runtime invariants, and future quality gates.
- `OPEN-DECISIONS.md`

These files provide concise current routing and must not duplicate or override accepted syntax or ADRs.

## Development workflow

- `DEVELOPMENT-WORKFLOW.md` owns universal issue, branch, pull-request,
  review, documentation, merge, and verification rules.
- `agents/README.md` selects a capability route without product or model names.
- `agents/DIRECT-REPOSITORY.md` covers normal repository, shell, networked
  Git, and authenticated GitHub access.
- `agents/CONNECTOR-LOCAL.md` covers exact-artifact, local-first work when
  normal network clone or fetch is unavailable.
- `agents/CONNECTOR-SOURCE-ACQUISITION.md` is the single owner for the
  replaceable connector artifact acquisition mechanics.
- `agents/PUBLICATION-CONSTRAINED.md` routes a concrete publication
  constraint to `PATCH-PUBLICATION.md`; it is not a default fallback.
- `agents/ORCHESTRATOR.md` is task guidance for explicitly selected coordinated assignments after capability
  selection; it is not another technical capability route.
- `PATCH-PUBLICATION.md` remains the sole verified patch protocol and security-contract owner.
- `../tools/chatgpt-project-agent/docs/LOCAL-AGENT-BOOTSTRAP.md` defines the
  project-agent source/installed layout and the remaining setup/runtime migration
  tracked by #210.
- `chatgpt-project/README-FIRST.md` is the compact project-folder wayfinder;
  installed task guides remain separate under
  `../tools/chatgpt-project-agent/docs/`.
- `../AGENTS.md` contains the short mandatory rules that apply to every agent.

Capability guides reference universal rules rather than copying them.
Temporary work breakdowns, executor assignments, and merge tracking remain
outside the repository.

## Implementation, review, and audit

- `review-and-audit/README.md` selects one role-based route.
- `review-and-audit/IMPLEMENTATION-AND-REVIEW.md` is read before implementation
  and reused for final self-review or an explicitly assigned pull-request review.
- `review-and-audit/AUDIT.md` is loaded only for an explicitly assigned audit.

Ordinary work does not load both guidance documents by default.

## Planning

`planning/README.md` defines the lifecycle and authority boundary for this directory. It contains only active,
non-implemented planning; entries are non-authoritative and do not schedule themselves.

- `planning/POC-TO-ALPHA-BACKLOG.md` lists owner-selected work that remains required before a stated POC, pre-alpha, or
  alpha gate.
- `planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md` retains open timer-handle and advanced recovery-point direction.
- `planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md` retains open camera ownership, capture, media-lifetime, and
  browser/server time-integrity direction.
- `planning/MAINTENANCE-CANDIDATES.md` lists unscheduled repository-maintenance opportunities that require fresh evidence
  and explicit selection before implementation.

## Reference

`reference/` explains where non-authoritative capability research, legacy documents, and source archives are stored. Large third-party source examples and historical package material are intentionally kept outside this repository.

## Documentation ownership

See `DOCUMENTATION-OWNERSHIP.md` for mandatory documentation-edit/review guidance and the boundary between canonical repository documentation and the shared project research archive.
