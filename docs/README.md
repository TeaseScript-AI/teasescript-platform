# Documentation map

## Authority and lifecycle

- `../README-FIRST.md`: authority and conflict-routing rules.
- `specifications/accepted-syntaxes-v30.md`: accepted consolidated syntax baseline.
- `decisions/`: accepted and proposed ADRs; each file states its status.
- `../CURRENT-DESIGN.md`: stable cross-component architecture and implementation boundaries.
- `../PHASE-STATUS.md`: current phase, gate, and high-level implemented-capability status.
- `OPEN-DECISIONS.md`: unresolved choices only; it is not accepted authority.
- `../WISHES.xml`: product intent and decision history; wishes are not automatic implementation decisions.

## Current topic documents

- `PRODUCT.md`
- `ARCHITECTURE.md`
- `TEASESCRIPT.md`
- `RUNTIME.md`
- `RESOURCE-LIMITS.md`: canonical resource-limit inventory, evidence/policy status, coupling, and reassessment routing.
- `DATA-AND-API.md`
- `LIBRARIES.md`
- `SECURITY.md`
- `CONTINUOUS-PERSONALITIES.md`
- `CODE-EDITOR.md`
- `UI-DESIGN-AND-ENGINEERING.md`: cross-surface UI engineering, responsive, interaction, and design-quality
  guardrails.
- `LLM-INTEGRATION.md`
- `MATH-EXPRESSIONS.md`
- `TESTING.md`: current testing strategy, runtime invariants, and future quality gates.

These files provide maintained topic detail and orientation. They must not duplicate or override accepted syntax or
ADRs.

## Development workflow

- `../README-FIRST.md` selects the repository-wide task route.
- `agents/README.md` selects the direct-repository or connector-local technical capability route and adds the
  publication-constrained overlay only for a concrete restriction.
- `review-and-audit/README.md` mirrors the `../README-FIRST.md` task choice locally and links to normal
  implementation/review guidance or explicitly assigned audit guidance.
- `DEVELOPMENT-WORKFLOW.md` owns the universal issue, branch, pull-request, documentation, merge, and verification
  workflow.
- `PATCH-PUBLICATION.md` owns the verified patch protocol and security contract.
- `../tools/chatgpt-project-agent/docs/LOCAL-AGENT-BOOTSTRAP.md` owns the project-agent source and installed-layout
  contract; `chatgpt-project/README-FIRST.md` is the compact project-folder wayfinder; and
  `chatgpt-project/SYSTEM-PROMPT.txt` is the repository-maintained prompt candidate for deliberate owner-approved
  synchronization; it does not prove the live ChatGPT Project Settings state.
- `../AGENTS.md` contains the short mandatory rules that apply to every agent.

Focused guides contain their own procedure. This map does not duplicate their route tables or steps. Temporary work
breakdowns, executor assignments, and merge tracking remain outside the repository.

## Implementation, review, and audit

`../README-FIRST.md` selects the repository-wide task and routes directly to the shared implementation/review guide or
the separate explicitly assigned audit guide. `review-and-audit/README.md` mirrors that choice as the local subrouter;
detailed procedures remain in those two guides.

## Planning

`planning/README.md` defines the lifecycle and authority boundary for this directory. It contains the release-roadmap
progress record plus active, non-implemented planning; entries do not schedule themselves or define accepted behavior.

- `planning/RELEASE-ROADMAP.md` records owner-selected release-stage placement, open release-stage outcomes, and
  compact roadmap progress history.
- `planning/PLAYER-UI-FOLLOW-UPS.md` keeps active, non-implemented Standard Player presentation follow-ups.
- `planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md` retains open timer-handle and advanced recovery-point direction.
- `planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md` retains open camera ownership, capture, media-lifetime, and
  browser/server time-integrity direction.
- `planning/MAINTENANCE-CANDIDATES.md` lists optimization and maintenance candidates to revalidate when selected for
  implementation.

## Reference

`CAPABILITY-MATRIX.md` is the compact repository-level capability-research summary. `reference/` explains where
non-authoritative capability research, legacy documents, and source archives are stored. Large third-party source
examples and historical package material are intentionally kept outside this repository.

## Documentation ownership

See `DOCUMENTATION-OWNERSHIP.md` for mandatory documentation-edit/review guidance and the boundary between canonical repository documentation and the shared project research archive.
