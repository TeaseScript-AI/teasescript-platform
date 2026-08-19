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
- Minimal engine primitive families for background timed work and future media capabilities under ADR 0017.
- Serializable lowering or engine-managed continuation representation for resumable library workflows not covered by
  ADR 0018's full-lowering choice.
- Exact checkpoint selection, deadline recalculation, repeating-timer, and server-authoritative-time mechanics needed
  to implement the owner-selected missed-event barrier for browser unavailability/reload/reconnect/device sleep.
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
- Exact button-row/dropdown breakpoints, measurements, and overflow behavior.
- Whether and how to revise the accepted V30 timer API for explicit handles and final pause/resume/stop/restart,
  repetition, persistence, and visible-presentation semantics.

## Player and interactions

Current constraints: [`RUNTIME.md`](RUNTIME.md), [`SECURITY.md`](SECURITY.md),
[`ui/PLAYER-UI.md`](ui/PLAYER-UI.md),
[ADR 0010](decisions/0010-package-network-policy.md),
[ADR 0012](decisions/0012-custom-view-capability.md),
[ADR 0016](decisions/0016-resumable-pending-action-runtime-contract.md), and
[ADR 0018](decisions/0018-first-standard-library-poc-contract.md). Owner-selected release-stage design outcomes
remain in the [`release roadmap`](planning/RELEASE-ROADMAP.md).

- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and Content Security Policy.
- Action-kind-specific media completion, advanced timeout, cancellation, and recovery policies beyond ADR 0018's
  mandatory basic interactions.
- Stable text-output target handles beyond the first Standard chat target.
- Exact author-facing theme schema/registration API and platform dark-theme token values. `ui/PLAYER-UI.md` fixes
  precedence, standalone/light/dark theme semantics, missing-variant fallback, and the no-arbitrary-CSS boundary.
- Exact author-facing data/API form for supported Standard Player per-control base/fill colours. The Player already owns
  derived interaction styling and automatic readable black/white control-label text; syntax, serialization, and which
  Standard control kinds expose the colour input remain unresolved.
- Constrained transcript rich-text/BBCode capability: allowed formatting elements/attributes, sanitization, and how
  accessibility treatment preserves authored colour/formatting semantics while meeting readability needs.
- Remaining Standard Player accessibility policy beyond ADR 0018's accepted accessible-name/input rules, including
  readable scaling/zoom behavior, minimum control sizing, contrast thresholds, and browser/platform responsibility.
- Player UI preference persistence: which panel/tool/theme/media-fit/text-display preferences survive reload or session
  changes and whether restoration is automatic, explicit, or both.
- Exact tuned thresholds/measurements for constraint-driven side-region dock/overlay decisions, compact geometry,
  fixed tool width, stage height, readable conversation bounds, composer growth, and focus-outline thickness.
- Temporary Player status/notification presentation for saved, paused, error, assignment, and similar platform state.
- Exact Standard/runtime API and author syntax for the right-rail control family. `ui/PLAYER-UI.md` fixes the current
  owner-selected value ownership, polling/change-handler model, programmatic update capability, lifecycle, busy-in-place
  behavior, deterministic single-handler scheduling, status/progress role, ordering, user-versus-script provenance, and
  visible-history direction; exact data shapes, persistence binding, API names, and syntax remain unresolved.
- Whether any additional Player-specific control widths, heights, or spacing should later join the already shared
  border/radius/focus/state baseline for TeaseScript UI surfaces.
- Exact custom-view registration/lifecycle API shape, typed input/event/result schemas, surface-isolation mechanism
  (including optional Shadow DOM), and how reconstructible custom state is declared/validated. ADR 0012 fixes execution
  modes, surface constraints, hide/dismiss/end distinctions, failure/cleanup direction, relevant focus/browser-Back
  behavior, sandbox boundary, and recovery-frontier semantics.
- Involved-speaker and conversation metadata for one visible chat with selectively separated future LLM contexts.
- Camera capability declarations, stream ownership, device switching, quality negotiation, restore, privacy
  indicators, and simultaneous-camera policy.
- Camera UI and lifecycle around accepted `askImage(...)` and nullable `takePhoto(...)`, including preview, countdown,
  retake, permission, and restore behavior.
- Motion detection, sampling, camera resource limits, and scene ownership.
- Media layering, concurrent ownership, cleanup, recovery, and resource handles.
- Persistent media identity, labels, timestamps, retrieval, privacy, retention, encryption, export, and quotas.
- Custom-view author syntax within the accepted custom-view capability.
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
