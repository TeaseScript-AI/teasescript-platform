# Current open decisions

Accepted ADRs and V30 override older descriptive documents. Sets, deep value copying, empty collection behavior, speaker fallback, serializable runtime architecture, serializable loop/call frames, source-order evaluation, prepared references, the current user-function model, and the shared resumable pending-action contract are not unimplemented design questions.

ADR 0016 is accepted. It defines persisted nondecreasing session time, foreground/background pending actions, monotonic action IDs, bounded settlement replay, active-first completion lookup, injected time observations, and blocking `wait` as the first implementation slice.

ADR 0017 is proposed for issue #68. Until owner approval, its one-shot background timer execution contract is not accepted architecture or implementation scope.

## Runtime hardening and evolution

- Package/source identity for browser checkpoints and production plan references.
- Migration policy across plan, snapshot, checkpoint, engine, and package versions.
- Production checkpoint frequency, incremental persistence, and performance thresholds.
- Final internal representation and optimization policy for large immutable/deep-copy values.
- Host/global representation for future opaque engine references beyond speakers.
- Complete static type checking and composite equality.
- Server-versus-browser authoritative checkpoint ownership and conflict resolution.
- Concrete implementation and migration details for version-4 pending-action fields, operations, and validators.
- Schema-version impact of timer handles, queued timer handlers, and active timer-handler frames after issue #66 establishes the implemented foundation.

### Compatibility API lifecycle

The current TypeScript surface exposes both the instruction-plan runtime and a compatibility route through `Interpreter`, `execute(program, ...)`, and the host-oriented `RuntimeValue` model.

Decide whether that compatibility surface should:

- remain a supported alpha API;
- remain a temporary testing, migration, or importer adapter without broader feature growth; or
- be deprecated after remaining callers and tests migrate to the instruction-plan runtime.

This decision must define the intended support period, migration expectations, public-export impact, and whether the host-value and serializable-value models remain separate. It should be resolved before a broad refactor that consolidates or removes compatibility-layer types and modules. Until then, the current exports remain implemented POC behavior rather than a permanent alpha commitment.

The exact version-3 schemas are current POC implementation details, not a promise of permanent wire-format compatibility.

## Remaining language and library work

- TypeScript-library import/linkage syntax from `.tease`.
- Exact unit/date/time/datetime/duration implementation.
- Standard Library string methods and detailed API signatures.
- Module metadata, selection, recursion, fallback, cooldown, and history rules.
- Static treatment of contextual `speaker` access when control-flow analysis can prove that no explicit or default speaker is available: compile-time error, warning, or retained runtime failure. Ordinary narrator output such as `say "Hello"` is a separate valid case and does not require a default speaker.
- Exact post-V30 chat-pacing semantics, including `say(..., wait: ...)`, visible-character counting, checkpoint state, and transcript-channel behavior.
- Remaining accepted V30 constructs and APIs outside the current parser/runtime subset.

## Player and interactions

- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and CSP.
- Action-kind-specific choices, input, buttons, media completion, cancellation, timeout, and recovery policies on the accepted shared pending-action contract.
- Owner approval or revision of proposed ADR 0017 choices: canonical assigned `startTimer`, zero-duration observation boundary, opaque timer handle, all-due settlement, one-handler-per-entry scheduling, queued-handler priority, foreground-slot yielding, stop idempotency, and no public handler lifecycle events.
- Background-handler repetition, persistence, range duration, fairness, cancellation after settlement, and timer-family cleanup beyond the proposed first one-shot slice.
- Camera capability declarations, long-lived stream ownership, device switching, quality negotiation, restore, privacy indicators, and optional simultaneous cameras.
- Exact `askImage(...)` preview/countdown/retake behavior and direct nullable `takePhoto(...)` capture behavior.
- Motion detection, sampling, camera resource limits, and scene ownership.
- Media layering, concurrent ownership, cleanup, recovery, and resource handles.
- Persistent media collections, stable identity, author labels, timestamps, newest/previous retrieval, privacy, retention, encryption, export, and quotas.
- Exact custom-view author syntax and lifecycle; capability is accepted, syntax remains open.
- Browser-helper boundary for files, toys, camera, offline behavior, and OS capabilities.
- Time-integrity logging thresholds and whether a future typed anomaly hook becomes script-visible.

See [`decisions/0017-one-shot-background-timer-execution-contract.md`](decisions/0017-one-shot-background-timer-execution-contract.md) for the proposed first-slice choices and explicit timer-family deferrals.

See [`planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`](planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md) for the selected direction and explicitly deferred design questions discussed with ADR 0016.

## Platform and personalities

- Account, toy, history, locks, global-data, and checkpoint storage contracts.
- Persistent scheduler missed-event behavior, quotas, deduplication, concurrency, and execution location.
- Continuous-personality lifecycle, assignments, reports, permissions, statuses, and reconnect behavior.
- Publishing, signing, versioning, moderation, and legacy importer details.

## Proposals, not decisions

- ADR 0017 one-shot background timer execution contract.
- Restricted math.js-backed numeric/unit evaluation.
- WebRTC, Redis, Electron, native apps, Kubernetes, and microservices without a concrete documented need.
