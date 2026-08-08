# Current open decisions

This file contains unresolved product, language, runtime, architecture, security, and compatibility choices only.
Accepted decisions belong in accepted ADRs or specifications; current implementation contracts belong in topic
documents; selected gate obligations belong in the POC-to-alpha backlog; concrete execution work belongs in GitHub
issues.

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

- Whether to accept the repository-wide resource-limit governance contract proposed in
  [`decisions/0019-resource-limit-governance.md`](decisions/0019-resource-limit-governance.md).
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
- Browser unavailability, reload, reconnect, device-sleep, and visibility-change time-integrity policy for local timed
  work.
- Optional author-defined recovery points, including rollback scope and treatment of irreversible external effects.

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
[`CODE-EDITOR.md`](CODE-EDITOR.md), [ADR 0010](decisions/0010-package-network-policy.md),
[ADR 0012](decisions/0012-custom-view-capability.md),
[ADR 0016](decisions/0016-resumable-pending-action-runtime-contract.md), and
[ADR 0018](decisions/0018-first-standard-library-poc-contract.md). Selected pre-alpha/alpha design obligations
remain in the [`POC-to-alpha backlog`](planning/POC-TO-ALPHA-BACKLOG.md).

- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and Content Security Policy.
- Action-kind-specific media completion, advanced timeout, cancellation, and recovery policies beyond ADR 0018's
  mandatory basic interactions.
- Background-handler interruption, ordering, cleanup, and foreground-slot interaction after the public timer API is
  decided.
- Stable text-output target handles beyond the first Standard chat target.
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
