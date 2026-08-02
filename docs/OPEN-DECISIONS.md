# Current open decisions

Accepted ADRs and V30 override older descriptive documents. Sets, deep value copying, empty collection behavior, speaker fallback, serializable runtime architecture, serializable loop/call frames, source-order evaluation, prepared references, the current user-function model, the shared resumable pending-action contract, the engine/Standard-Library boundary, and the first Standard Library POC contract are not unimplemented design questions.

ADR 0016 is accepted. It defines persisted nondecreasing session time, foreground/background pending actions, monotonic action IDs, bounded settlement replay, active-first completion lookup, injected time observations, and blocking `wait` as the first implementation slice.

ADR 0017 is accepted. It defines the engine-primitive/public-Standard-Library/package-library boundary, resumability rules, public-versus-privileged separation, deterministic library binding, and parser-owned grammar boundary.

ADR 0018 is accepted. It defines the first Standard Library POC contract for `showButton`, `askText`, `askNumber`, `choose`, and `say` smart autoplay. It accepts the automatic protected prelude, full plan lowering, mandatory foreground interactions, exact first-POC input normalization, choice-label behavior, dynamic non-canonical button/dropdown presentation, bounded interaction-data policy, validated captured pacing settings, and one ADR 0016 `chatPacingGate` lifecycle. The normal Player application has no player-facing pause control; Pause remains developer/debugger tooling.

ADR 0018 is partially implemented. PR #117 implemented and versioned the generic foreground-interaction runtime, typed completion and transcript behavior, and concrete version-1 interaction limits. Author-facing compact syntax, smart-autoplay pacing, Standard Player controls, editor support, and final vertical acceptance remain implementation work rather than open contract decisions.

## Runtime hardening and evolution

- Package/source identity for browser checkpoints and production plan references.
- Migration policy across plan, snapshot, checkpoint, engine, Standard Library, and package versions.
- Production checkpoint frequency, incremental persistence, and performance thresholds.
- Final internal representation and optimization policy for large immutable/deep-copy values.
- Host/global representation for future opaque engine references beyond speakers.
- Complete static type checking and composite equality.
- Server-versus-browser authoritative checkpoint ownership and conflict resolution.
- Concrete implementation and migration details for pending-action schema changes beyond the implemented blocking-`wait` and generic foreground-interaction slices, including populated background actions and prepared pacing output.
- Exact minimal primitive families for background timed work and future media capabilities under ADR 0017.
- Exact serializable lowering or engine-managed continuation representation for resumable library workflows not covered by ADR 0018's full-lowering choice.
- Browser-unavailability, reload, reconnect, device-sleep, and visibility-change time-integrity policy for local timed work. This is not a player-facing pause command.
- Optional author-defined recovery/resume points, including rollback scope for variables, RNG, transcript/view state, pending actions, media, account writes, and other external effects.

Default checkpoint restore should resume the exact validated saved state. Author-defined rollback or restart points are a separate advanced recovery feature and must not silently duplicate irreversible external effects.

The current internal instruction-plan, runtime-snapshot, and checkpoint format revisions are documented in [`RUNTIME.md`](RUNTIME.md). Their schemas remain POC implementation details, not a promise of permanent wire-format compatibility.

## Remaining language and library work

- TypeScript-library import/linkage syntax from `.tease` beyond ADR 0018's automatic first-POC Standard Library prelude.
- Final Standard Library packaging, compatibility, capability access, exact identity binding for non-lowered behavior, migration, and version-selection rules.
- Generated declaration/editor-metadata transport format for autocomplete, signatures, hover documentation, navigation, and diagnostics.
- Advanced Standard Library default-prelude opt-out and replacement mechanism after the first POC.
- Published community-library and package-local-library packaging, import, moderation, and compatibility rules.
- Explicit Standard Library replacement/override mappings without silent name shadowing.
- Community-library dependency declarations, exact version locks, transitive resolution, cycle handling, moderation, capability propagation, and version conflicts. The first linkage slice should not require community-to-community dependencies.
- Exact unit/date/time/datetime/duration implementation.
- Standard Library string methods and detailed API signatures beyond the first POC.
- Module metadata, selection, recursion, fallback, cooldown, and history rules.
- Static treatment of contextual `speaker` access when control-flow analysis can prove that no explicit or default speaker is available: compile-time error, warning, or retained runtime failure. Ordinary narrator output such as `say "Hello"` is a separate valid case and does not require a default speaker.
- Advanced `showButton` timeout and elapsed-time return.
- Detailed interaction result objects containing elapsed time or metadata, including the exact option name that selects the object return type.
- Advanced parenthesized input/choice forms, richer validation options, and custom compact `choose` field hints.
- Exact advanced accessibility override field for Standard UI and custom UI.
- Deterministic speaker-aware typing-indicator formula, syntax, speaker defaults, checkpoint state, and relation to smart autoplay.
- Constrained LLM interpretation implementation and author-facing options for natural-language numbers and non-exact choice answers.
- Exact button-row/dropdown breakpoints, measurements, overflow behavior, and Player UI testing matrix.
- Final timer author API and lifecycle semantics, including explicit handle syntax, method versus free-function calls, pause, resume, stop, restart-after-stop, repetition, persistence, and visible presentation.
- Remaining accepted V30 constructs and APIs outside the current parser/runtime subset.

## Player and interactions

- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and CSP. ADR 0018 fixes semantic completion payloads but not exact envelope or property names.
- Action-kind-specific media completion, advanced timeout, cancellation, and recovery policies beyond ADR 0018's mandatory basic interactions.
- Background-handler interruption, lifecycle, ordering, cleanup, and foreground-slot interaction after the public timer API is reconsidered.
- Stable text-output target handles beyond the first Standard chat target.
- Exact involved-speaker and conversation metadata needed to support one shared visible chat with selectively separated future LLM contexts. ADR 0018 intentionally starts with `target` and optional `speakerId`; broader collections and a separate conversation identity remain deferred.
- Camera capability declarations, long-lived stream ownership, device switching, quality negotiation, restore, privacy indicators, and optional simultaneous cameras.
- Exact `askImage(...)` preview/countdown/retake behavior and direct nullable `takePhoto(...)` capture behavior.
- Motion detection, sampling, camera resource limits, and scene ownership.
- Media layering, concurrent ownership, cleanup, recovery, and resource handles.
- Persistent media collections, stable identity, author labels, timestamps, newest/previous retrieval, privacy, retention, encryption, export, and quotas.
- Exact custom-view author syntax and lifecycle; capability is accepted, syntax remains open.
- Browser-helper boundary for files, toys, camera, offline behavior, and OS capabilities.
- Time-integrity logging thresholds and whether a future typed anomaly hook becomes script-visible.

See [`decisions/0018-first-standard-library-poc-contract.md`](decisions/0018-first-standard-library-poc-contract.md) for the accepted issue #75 contract. See [`planning/LANGUAGE-LIBRARY-AND-SESSION-DIRECTIONS.md`](planning/LANGUAGE-LIBRARY-AND-SESSION-DIRECTIONS.md) for retained owner-selected directions outside that contract. The older camera/media follow-up remains authoritative for camera, captured-media, and time-integrity planning only where the newer note does not explicitly supersede it. Closed draft PRs #69 and #71 and closed issues #67 and #68 are historical proposals and are not current decisions.

## Platform and personalities

- Account, toy, history, locks, global-data, and checkpoint storage contracts.
- Persistent scheduler missed-event behavior, quotas, deduplication, concurrency, and execution location.
- Continuous-personality lifecycle, assignments, reports, permissions, statuses, and reconnect behavior.
- Speaker/personality relationships, dynamic LLM prompt assembly, transcript filtering, memory, summaries, and context isolation.
- Publishing, signing, versioning, moderation, and legacy importer details.

## Proposals, not decisions

- Restricted math.js-backed numeric/unit evaluation.
- WebRTC, Redis, Electron, native apps, Kubernetes, and microservices without a concrete documented need.
