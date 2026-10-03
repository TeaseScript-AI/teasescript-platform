# Current open decisions

This file contains unresolved product, language, runtime, architecture, security, and compatibility choices only.
Accepted decisions belong in accepted ADRs or specifications; current implementation contracts belong in topic
documents; owner-selected release-stage placement and open roadmap outcomes belong in the release roadmap; concrete
execution work belongs in GitHub issues.

A listed question is not accepted direction. Its linked accepted or current sources constrain the decision without
deciding the remaining choice.

Related active planning is retained in
[`planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md`](planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md) and
[`planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md`](planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md).
Those files are non-authoritative owner-selected direction and do not decide the questions below.

## Runtime hardening and evolution

Current constraints: [`RUNTIME.md`](RUNTIME.md), [`ARCHITECTURE.md`](ARCHITECTURE.md),
[ADR 0015](decisions/0015-serializable-runtime-architecture.md),
[ADR 0016](decisions/0016-resumable-pending-action-runtime-contract.md), and
[ADR 0017](decisions/0017-engine-primitives-and-standard-library-boundary.md).

- Exact package/source identity binding for browser checkpoints and production plan references.
- Migration and compatibility policy across plan, snapshot, checkpoint, engine, Standard Library, and package
  versions.
- Production checkpoint frequency, incremental persistence policy, and evidence-based performance thresholds.
- Representation and optimization policy for large immutable or deep-copied values while preserving accepted value
  semantics.
- Host/global representation for future opaque engine references beyond speakers.
- Server-versus-browser authoritative checkpoint ownership and conflict resolution.
- Engine primitive contracts for deferred layered-scene and camera capabilities beyond the specification §22 playback
  foundation, under ADR 0017.
- Serializable lowering or engine-managed continuation representation for resumable library workflows not covered by
  ADR 0018's full-lowering choice.
- Recovery and missed-event ordering for absolute scheduled events/deadlines, including local/offline versus
  server-backed authority and cross-device persistence.
- Exact recovery-frontier mechanics for non-restorable custom presentation, including checkpoint selection and optional
  advanced reconstruction/snapshot support.
- Exact durable external-effect protocol across recovery boundaries: effect identity, ownership/release authority,
  transactional checkpoint/effect commit, reservation/lease lifecycle, idempotency, and cleanup behavior.
- Optional author-defined recovery points beyond automatic recovery frontiers, including rollback scope and treatment of
  irreversible external effects.

## Language, Standard Library, and modules

Current constraints: [`TEASESCRIPT.md`](TEASESCRIPT.md), [`LIBRARIES.md`](LIBRARIES.md), the
[accepted V30 syntax baseline](specifications/accepted-syntaxes-v30.md),
[ADR 0017](decisions/0017-engine-primitives-and-standard-library-boundary.md), and
[ADR 0018](decisions/0018-first-standard-library-poc-contract.md).

- TypeScript-library import and linkage syntax from `.tease` beyond ADR 0018's automatic first-POC Standard Library
  prelude.
- Final Standard Library packaging, exact identity binding for non-lowered behavior, compatibility, migration,
  capability access, and version-selection rules.
- Declaration/editor-metadata transport for autocomplete, signatures, hover documentation, navigation, and
  diagnostics.
- Advanced Standard Library default-prelude opt-out and replacement policy after the first POC.
- Package-local and published community-library packaging, imports, moderation, compatibility, replacement mappings,
  dependency locks, transitive resolution, cycles, capability propagation, and version conflicts.
- Standard Library string API and signatures beyond the first POC.
- Module metadata, selection, recursion, fallback, cooldown, and history rules.
- Static treatment of contextual `speaker` access when control-flow analysis proves no explicit or default speaker is
  available.

- Compatibility mapping and compact author syntax for invoking the accepted V30 `showButton` timeout and
  elapsed-time behavior.
- Detailed interaction result objects, including the author-facing option that selects them.
- Compatibility mapping, names, and option shapes that expose the accepted V30 parenthesized input/choice options
  and custom compact `choose` field hints without changing their accepted behavior.
- Advanced accessibility override field for Standard UI and custom UI.
- Deterministic speaker-aware typing-indicator syntax, formula, defaults, checkpoint state, and relation to smart
  autoplay.
- Constrained LLM interpretation contract and author-facing options for natural-language numbers and non-exact choice
  answers.
- Generalized elapsed-duration range precision and locale-aware duration presentation beyond the implemented slice.
- Final scheduled-event author syntax and object/handle API under specification §36.

## Editor and authoring

Current constraints: [`CODE-EDITOR.md`](CODE-EDITOR.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), and
[ADR 0020](decisions/0020-vue-3-production-browser-ui.md).

- Final Monaco feature selection, worker loading, code splitting, and production bundle-size policy.
- Final beginner and advanced authoring modes, workspace layout, project/file navigation, and mobile-browser support.
- Whether editor-neutral tooling later gains CLI, LSP, or IDE consumers and the smallest stable adapter boundary they
  require.
- Source storage, version history, Git-backed workflows, collaboration, conflict resolution, and Laravel persistence.
- Final package/import/library linkage and metadata transport; the current Monaco POC does not establish those
  contracts.

## Player and interactions

Current constraints: [`RUNTIME.md`](RUNTIME.md), [`SECURITY.md`](SECURITY.md),
[`ui/PLAYER-UI.md`](ui/PLAYER-UI.md),
[ADR 0010](decisions/0010-package-network-policy.md),
[ADR 0012](decisions/0012-custom-view-capability.md),
[ADR 0016](decisions/0016-resumable-pending-action-runtime-contract.md), and
[ADR 0018](decisions/0018-first-standard-library-poc-contract.md). Owner-selected release-stage design outcomes
remain in the [`release roadmap`](planning/RELEASE-ROADMAP.md).

- Exact Player presentation for absolute deadlines and long/upcoming scheduled events; see specification §36 and
  [`planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md`](planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md).
- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and Content Security Policy.
- Advanced timeout, cancellation, and recovery policies beyond ADR 0018's mandatory basic interactions and the
  media playback contract in [`RUNTIME.md`](RUNTIME.md#stage-image-and-media-playback).
- Stable text-output target handles beyond the first Standard chat target.
- Exact author-facing theme schema/registration API. `ui/PLAYER-UI.md` fixes the default light/dark theme intents,
  precedence, standalone/light/dark theme semantics, missing-variant fallback, and the no-arbitrary-CSS boundary.
- Exact author-facing data/API form for supported Standard Player per-control base/fill colours. The Player already owns
  derived interaction styling and automatic readable black/white control-label text; syntax, serialization, and which
  Standard control kinds expose the colour input remain unresolved.
- Remaining Standard Player accessibility policy beyond ADR 0018's accepted accessible-name/input rules, including
  readable scaling/zoom behavior, minimum control sizing, contrast thresholds, and browser/platform responsibility.
- Player UI preference persistence beyond Player Settings: which panel/tool/theme/media-fit/text-display preferences
  survive reload or session changes, and whether account settings take over or synchronize the browser-local Player
  Settings that `ui/PLAYER-UI.md` already keeps across reloads.
- Exact tuned thresholds/measurements for constraint-driven dock/drawer decisions, compact geometry, per-tool width
  presets, stage/conversation allocation, readable conversation bounds, and composer growth.
- Temporary Player status/notification presentation for saved, paused, error, assignment, and similar platform state.
- Exact developer-facing declaration for a Player-generated Standard tool that combines a title, ordered static
  content, and typed controls such as toggles, numeric/text fields, and selects, including value binding, updates,
  submission, persistence, accessibility metadata, and the boundary with fully custom tools.
- Exact Standard/runtime API, data shapes, persistence binding, names, and author syntax for the owner-resolved
  long-lived control family; runtime semantics are maintained in `RUNTIME.md` and presentation in `ui/PLAYER-UI.md`.
- Exact custom-view registration/lifecycle API, typed input/event/result schemas, author syntax, surface isolation
  (including optional Shadow DOM), and reconstructible-state declaration/validation; ADR 0012 fixes capability
  semantics.
- Involved-speaker and conversation metadata for one visible chat with selectively separated future LLM contexts.
- Camera and microphone capability declaration metadata, device switching, quality negotiation, reload and restore,
  failure recovery, and simultaneous-device policy; the permission and lifecycle model is accepted in
  [`SECURITY.md`](SECURITY.md).
- The isolation mechanism that enforces brokered camera/microphone acquisition and capability authorization against
  package code calling browser capture APIs directly, such as a separate execution realm or trusted code
  transformation; a wrapper API or manifest field alone cannot.
- Camera and file UI around accepted `askImage(...)`, including source selection, preview, countdown, accept/retake,
  denied-permission recovery, and restore behavior; `takePhoto()` has no such UI (`SECURITY.md`).
- The public advanced-TypeScript media surface for arbitrary local image, video, and audio processing, author-facing
  recording APIs and results, how authors request recording composition (it is explicit; see `SECURITY.md`), and
  explicit session-media deletion. The Player capture foundation's shapes are implementation details, not this API;
  ephemeral handles are not restored after reload (ADR 0017).
- Captured-media quotas and reclamation timing; captured media stored on a server. Saved-reference durability is
  accepted in the specification (§33). Before durable checkpoint restore (#469) can restore a checkpoint whose state
  holds unsaved session media after a reload, its design must preserve or explicitly reconcile that media, and a
  restored reference must never silently alias different media.
- Motion detection, sampling, camera resource limits, and scene ownership.
- User control of media playback: whether players may seek, pause, or skip script media, whether authors can allow or
  forbid it per media, and its Player UI. The Player currently offers no media controls; accepted controls would enter
  the runtime as typed host input like script seeks
  ([`RUNTIME.md`](RUNTIME.md#stage-image-and-media-playback)).
- Layered-scene media (backgrounds, overlays, blur, drawings, transitions) and its reconciliation with the Stage image
  model of specification §22.
- Persistent media identity, labels, timestamps, retrieval, privacy, retention, encryption, export, and quotas.
- Exact PWA offline, storage, cache, and update lifecycle under
  [ADR 0001](decisions/0001-browser-first.md): asset/media/data boundaries, persistent-storage requests, offline session
  continuity, navigation fallback, and activation of a downloaded application version without replacing an active
  session mid-run.
- Browser-helper boundary for files, toys, camera, offline behavior, and OS capabilities.
- Time-integrity logging thresholds and whether a future typed anomaly hook is script-visible.

## Debugger and simulation

Current constraints: [`DEBUGGER.md`](DEBUGGER.md), [`RUNTIME.md`](RUNTIME.md), and
[`DATA-AND-API.md`](DATA-AND-API.md).

- Player/developer debugger enablement, authorization, and history marking.
- Server test/simulation namespaces and external-effect behavior for disposable active-debug forks.

## Platform and continuous personalities

Current constraints: [`DATA-AND-API.md`](DATA-AND-API.md),
[`CONTINUOUS-PERSONALITIES.md`](CONTINUOUS-PERSONALITIES.md),
[`LLM-INTEGRATION.md`](LLM-INTEGRATION.md), and [`SECURITY.md`](SECURITY.md).

- Exact platform/API schemas plus persistence and conflict rules for accepted account, toy, history, lock, global-data,
  and checkpoint capabilities.
- Persistent scheduler missed-event behavior, quotas, deduplication, concurrency, and execution location.
- Continuous-personality lifecycle, assignments, reports, permissions, statuses, and reconnect behavior.
- Speaker/personality relationships, dynamic LLM prompt assembly, transcript filtering, memory, summaries, and context
  isolation.
- Publishing, signing, versioning, moderation, and legacy importer contracts.

## Expression evaluation

Current proposal sources: [ADR 0004](decisions/0004-expression-engine.md) and
[`MATH-EXPRESSIONS.md`](MATH-EXPRESSIONS.md).

- Whether to accept a restricted math.js-backed numeric and unit expression evaluator, and its exact validation and
  capability boundary.
