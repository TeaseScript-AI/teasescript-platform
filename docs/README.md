# Documentation map

## Authority

- `../README-FIRST.md`: authority and conflict-routing rules.
- `specifications/accepted-syntaxes-v30.md`: accepted consolidated syntax baseline.
- `decisions/`: accepted and proposed ADRs; each file states its status.
- `../CURRENT-DESIGN.md`: current architecture and implementation boundaries.
- `../PHASE-STATUS.md`: milestone and verification status.
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

- `DEVELOPMENT-WORKFLOW.md` defines the GitHub-native issue, agent, branch, pull-request, coordinated-work, documentation, and final-verification process.
- `../AGENTS.md` contains the mandatory task, coding, review, and Git rules for every agent.
- `../tools/work-packages/README.md` defines the explicit fallback for agents that cannot complete the normal GitHub branch and pull-request flow.

Temporary work breakdowns, executor assignments, package files, and merge tracking remain outside the repository.

## Planning

- `planning/POC-TO-ALPHA-BACKLOG.md` lists owner-selected work that remains required before a stated POC, pre-alpha, or alpha gate. An item may remain unscheduled and is not implementation scope until a phase plan or coordinator assignment selects its ID.
- `planning/LANGUAGE-LIBRARY-AND-SESSION-DIRECTIONS.md` records the latest owner-selected language simplicity, Standard Library slice, smart-autoplay, input accessibility, explicit timer-handle, library-scope, pause, and recovery direction. For text pacing and public timer API direction it supersedes the older corresponding sections in the camera/media follow-up file.
- `planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md` remains the camera, captured-media, and time-integrity planning source. Its older text-pacing and timer-API sections are historical where the newer language/library/session direction explicitly supersedes them.
- `planning/PLAYER-UI-MOCKUPS.md` contains the non-authoritative player-iframe UI design draft and links to the executable issue #77 mockup assets.
- `planning/MAINTENANCE-CANDIDATES.md` records unscheduled, non-authoritative repository-maintenance opportunities that require fresh evidence and explicit selection before implementation.
- `planning/POST-POC-DEVELOPMENT-BACKLOG.md` is a legacy mixed backlog retained for later triage. Its entries are not automatically required.
- Other files in `planning/` contain proposals and gap analysis. They do not define accepted architecture, syntax, or current implementation scope.

## Reference

`reference/` contains repository-level routing and concise non-authoritative summaries. Detailed capability research, legacy documents, third-party source archives, screenshots, and historical packages remain outside this repository.

- `reference/PLAYER-UI-RESEARCH.md` summarizes the browser, responsive-layout, accessibility, and provenance research used by the issue #77 player UI proposal.

## Documentation ownership

See `DOCUMENTATION-OWNERSHIP.md` for the boundary between canonical repository documentation and the shared project research archive.
