# Architecture decision records

An ADR marked **Accepted** is authoritative within its stated scope. A **Proposed** ADR is not a final decision.

When a later accepted ADR or a post-V30 owner decision synchronized into the accepted specification conflicts
with V30, it overrides V30 only for the exact issue it decides. Otherwise V30 remains the accepted syntax
baseline.

When an older ADR example uses syntax superseded by V30, preserve the accepted capability only where the ADR still states it clearly; do not revive obsolete syntax.

## Decision index

| Decision | Status | Scope and when to read |
| --- | --- | --- |
| [0001](0001-browser-first.md) | Accepted | Browser-first UI and responsive PWA; read for execution location and future local-helper scope. |
| [0002](0002-one-engine.md) | Accepted | One runtime, state model and save format; read for engine integration or legacy import. |
| [0003](0003-module-selection.md) | Proposed | Path/glob and richer metadata module-selection proposal; read for unresolved selection policy; not: accepted file/tag rules in ADRs 0022–0023. |
| [0004](0004-expression-engine.md) | Proposed | TeaseScript-owned expression grammar proposal; read for expression-engine scope; not: an accepted ban on generated JavaScript execution. |
| [0005](0005-server-persistent-scheduler.md) | Accepted | Laravel/cron/PostgreSQL scheduling while browsers are closed; read for persistent deadlines and server events. |
| [0006](0006-session-and-personality-mode.md) | Accepted | One engine for finite sessions and persistent personalities; read for persistent-mode state ownership. |
| [0007](0007-content-modules-versus-libraries.md) | Accepted | Executable TeaseScript content versus reusable TypeScript libraries; read for module selection and library boundaries. |
| [0008](0008-event-execution-locations.md) | Accepted; exact API remains open | Server, browser, helper and client-required event placement; read for persistent event execution; not: a finalized API. |
| [0009](0009-library-publication.md) | Accepted | Named library exports and generated metadata; read for TypeScript library APIs; not: compiled Tease publication policy. |
| [0010](0010-package-network-policy.md) | Accepted | Restricted package networking and platform-managed media/integrations; read for package network access. |
| [0011](0011-say-string-literals.md) | Accepted | Quote-based single-line/block strings, interpolation and speaker-qualified say; read for strings and text output. |
| [0012](0012-custom-view-capability.md) | Accepted capability; author syntax open | Custom-view modes, surfaces, cleanup and recovery frontiers; read for custom presentation; not: finalized author syntax or API. |
| [0013](0013-set-collection.md) | Accepted | Insertion-ordered unique sets, syntax and operations; read for set behavior; not: assignment syntax. |
| [0014](0014-core-runtime-value-semantics.md) | Accepted | Deep value copies, collection equality and speaker-name fallback; read for copying, identity and empty collection reads. |
| [0015](0015-serializable-runtime-architecture.md) | Accepted | JSON-safe plans/state, checkpoints, stepping and deterministic RNG; read for stop/resume and saved-state changes. |
| [0016](0016-resumable-pending-action-runtime-contract.md) | Accepted | Pending actions, typed completion, identity and deterministic time; read for waiting, settlement and restore. |
| [0017](0017-engine-primitives-and-standard-library-boundary.md) | Accepted | Engine primitives, Standard/package libraries and privileged adapters; read for layer ownership and resumability. |
| [0018](0018-first-standard-library-poc-contract.md) | Accepted | First-POC interactions, Standard prelude, full lowering and say pacing; read for basic interactions and autoplay; not: final library packaging. |
| [0019](0019-resource-limit-governance.md) | Accepted | Limit categories, evidence, ownership and change process; read for adding or changing a bound; not: numeric limit selection. |
| [0020](0020-vue-3-production-browser-ui.md) | Accepted | Vue 3 production UI and its rendering/tooling boundaries; read for browser UI ownership and dependencies. |
| [0021](0021-static-types.md) | Accepted | Static typing, inference, unions, conversions and narrowing; read for type rules and the new-checker transition. |
| [0022](0022-multi-file-scripts.md) | Accepted | Multi-file targets, calls, globals and explicit endings; read for cross-file execution; not: automatic script rotation. |
| [0023](0023-tags-for-scripts-and-images.md) | Accepted | File headers, tagged selection and embedded image tags; read for script/image metadata and selection. |
| [0024](0024-shared-block-variables.md) | Accepted | Shared variables and scope lifetime in timer/media/button blocks; read for block captures; not: shared mutable values. |
| [0025](0025-engine-owned-runtime-sessions.md) | Accepted | Engine-owned session operations, validation and detached results; read for state mutation boundaries; not: browser-versus-server storage. |
| [0026](0026-unified-time-semantics.md) | Accepted | Six temporal types, ISO weeks, exact/calendar arithmetic and explicit units; read for time values; not: scheduling or the other listed open time APIs. |
