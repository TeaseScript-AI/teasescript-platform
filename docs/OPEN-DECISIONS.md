# Current open decisions

Accepted ADRs and V30 override older descriptive documents. Sets, deep value copying, empty collection behavior, speaker fallback, serializable runtime architecture, serializable loop/call frames, source-order evaluation, prepared references, the current user-function model, and the shared resumable pending-action contract are not unimplemented design questions.

ADR 0016 is accepted. It defines persisted nondecreasing session time, foreground/background pending actions, monotonic action IDs, bounded settlement replay, active-first completion lookup, injected time observations, and blocking `wait` as the first implementation slice.

Proposed ADR 0017 defines an owner-reviewable engine-primitive/Standard-Library/package-library boundary. It is not accepted and does not yet change V30 syntax or current implementation placement.

## Runtime hardening and evolution

- Package/source identity for browser checkpoints and production plan references.
- Migration policy across plan, snapshot, checkpoint, engine, Standard Library, and package versions.
- Production checkpoint frequency, incremental persistence, and performance thresholds.
- Final internal representation and optimization policy for large immutable/deep-copy values.
- Host/global representation for future opaque engine references beyond speakers.
- Complete static type checking and composite equality.
- Server-versus-browser authoritative checkpoint ownership and conflict resolution.
- Concrete implementation and migration details for version-4 pending-action fields, operations, and validators.
- Exact minimal primitive families for text output, typed interactions, foreground delays, and background timed work after ADR 0017 review.
- Exact serializable lowering or engine-managed continuation representation for resumable library workflows.
- Player-initiated pause semantics: whether active session time freezes, continues, or follows another policy for local timed work.
- Optional author-defined recovery/resume points, including rollback scope for variables, RNG, transcript/view state, pending actions, media, account writes, and other external effects.

Default checkpoint restore should resume the exact validated saved state. Author-defined rollback or restart points are a separate advanced recovery feature and must not silently duplicate irreversible external effects.

### Compatibility API lifecycle

The current TypeScript surface exposes both the instruction-plan runtime and a compatibility route through `Interpreter`, `execute(program, ...)`, and the host-oriented `RuntimeValue` model.

Decide whether that compatibility surface should:

- remain a supported alpha API;
- remain a temporary testing, migration, or importer adapter without broader feature growth; or
- be deprecated after remaining callers and tests migrate to the instruction-plan runtime.

This decision must define the intended support period, migration expectations, public-export impact, and whether the host-value and serializable-value models remain separate. It should be resolved before a broad refactor that consolidates or removes compatibility-layer types and modules. Until then, the current exports remain implemented POC behavior rather than a permanent alpha commitment.

The exact version-3 schemas are current POC implementation details, not a promise of permanent wire-format compatibility.

## Remaining language and library work

- Owner approval or revision of proposed ADR 0017.
- TypeScript-library and Standard Library import/linkage syntax from `.tease`.
- Standard Library packaging, compatibility, capability access, exact identity binding, migration, and version-selection rules.
- Public Standard Library versus privileged platform-adapter module and capability boundaries.
- Generated declaration/editor-metadata format for autocomplete, signatures, hover documentation, navigation, and diagnostics.
- Standard Library default-prelude behavior and the advanced opt-out mechanism.
- Published community-library and package-local-library packaging, import, moderation, and compatibility rules.
- Explicit Standard Library replacement/override mappings without silent name shadowing.
- Community-library dependency declarations, exact version locks, transitive resolution, cycle handling, moderation, capability propagation, and version conflicts. The first linkage slice should not require community-to-community dependencies.
- Exact unit/date/time/datetime/duration implementation.
- Standard Library string methods and detailed API signatures.
- Module metadata, selection, recursion, fallback, cooldown, and history rules.
- Static treatment of contextual `speaker` access when control-flow analysis can prove that no explicit or default speaker is available: compile-time error, warning, or retained runtime failure. Ordinary narrator output such as `say "Hello"` is a separate valid case and does not require a default speaker.
- Final `say` composition after the core/Standard-Library boundary is accepted.
- Exact deterministic **smart autoplay** semantics: how autoplay duration is calculated and how the compiler/runtime identifies the next effective blocking player interaction.
- Explicit `instant` and autoplay overrides, and whether any exact-duration override remains part of `say`.
- Exact API and wording for a separate one-action acknowledgement/continue interaction. This should not become the normal chat pacing default.
- Programmatic accessibility labels for text, number, choice, confirmation, and custom interactions, including localized defaults and optional author overrides that do not create transcript messages.
- Final timer author API and lifecycle semantics, including explicit handle syntax, method versus free-function calls, pause, resume, stop, restart-after-stop, repetition, persistence, and visible presentation.
- Whether accepted command/block syntax lowers directly to core instructions, to public Standard Library exports, or to compiler-owned compositions.
- Remaining accepted V30 constructs and APIs outside the current parser/runtime subset.

## Player and interactions

- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and CSP.
- Action-kind-specific choices, input, buttons, media completion, cancellation, timeout, and recovery policies on the accepted shared pending-action contract.
- Generic typed-interaction primitive boundaries versus Standard Library wrappers such as text, number, choice, confirmation, and image input.
- Background-handler interruption, lifecycle, ordering, cleanup, and foreground-slot interaction after the public timer API is reconsidered.
- Stable text-output target handles and the exact message provenance schema.
- Exact participant/conversation metadata needed to support one shared visible chat with selectively separated future LLM contexts. The current direction starts with `speakerId`, `target`, and unique `participantSpeakerIds`; a separate conversation identity remains deferred.
- Camera capability declarations, long-lived stream ownership, device switching, quality negotiation, restore, privacy indicators, and optional simultaneous cameras.
- Exact `askImage(...)` preview/countdown/retake behavior and direct nullable `takePhoto(...)` capture behavior.
- Motion detection, sampling, camera resource limits, and scene ownership.
- Media layering, concurrent ownership, cleanup, recovery, and resource handles.
- Persistent media collections, stable identity, author labels, timestamps, newest/previous retrieval, privacy, retention, encryption, export, and quotas.
- Exact custom-view author syntax and lifecycle; capability is accepted, syntax remains open.
- Browser-helper boundary for files, toys, camera, offline behavior, and OS capabilities.
- Time-integrity logging thresholds and whether a future typed anomaly hook becomes script-visible.

See [`planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`](planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md) for earlier selected directions and deferred questions discussed with ADR 0016. Closed draft PRs #69 and #71 and closed issues #67 and #68 are historical proposals and are not current decisions.

## Platform and personalities

- Account, toy, history, locks, global-data, and checkpoint storage contracts.
- Persistent scheduler missed-event behavior, quotas, deduplication, concurrency, and execution location.
- Continuous-personality lifecycle, assignments, reports, permissions, statuses, and reconnect behavior.
- Speaker/personality relationships, dynamic LLM prompt assembly, transcript filtering, memory, summaries, and context isolation.
- Publishing, signing, versioning, moderation, and legacy importer details.

## Proposals, not decisions

- Restricted math.js-backed numeric/unit evaluation.
- WebRTC, Redis, Electron, native apps, Kubernetes, and microservices without a concrete documented need.