# Security boundaries

## Playground development automation

The constrained playground server has an ephemeral loopback-only development workspace API: `PUT /api/workspace/source`, `GET /api/workspace`, `POST /api/workspace/compile`, `POST /api/workspace/run`, and `GET /api/workspace/result`. It emits no CORS headers, has no filesystem-write route, and preserves the static allowlist. Automation is rejected for non-loopback clients even if the static development listener is configured beyond loopback.

Source requires UTF-8 `text/plain; charset=utf-8`. Source ingestion has no repository-defined byte ceiling; the local
server buffers the upload and rejects malformed UTF-8 before storing it. Compile and run requests accept no body and
reject a non-empty body without buffering the complete payload. Unsupported methods/content types, malformed UTF-8,
and unsafe paths receive structured errors without stack traces. Remaining tooling guards are tracked in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). This is neither a public API nor a production backend.

- Run the complete player and package code in a sandboxed cross-origin iframe, preferably on a separate player origin.
- Keep main-site cookies host-only and unavailable to the player.
- Validate every parent/player message, checkpoint, package manifest, server response, and future integration result.
- Validate instruction plans, runtime snapshots, checkpoints, globals, and serializable values for supported shape,
  format/version, representation domains, references, control flow, and cross-state invariants before they can affect
  canonical execution. Live JavaScript input may first be stabilized into plain data; accessors, trap failures, cycles,
  unsupported prototypes, non-JSON values, invalid array indexes/density, and similar representation failures may be
  rejected when deterministic inspection requires it. This defensive capture is correctness/robustness behavior, not by
  itself a TeaseScript content-capacity or security policy. Compiler-owned or already validated internal
  representations are not reclassified as hostile merely because they share the same capture or validation helper.
- A resource-based security rejection requires a concrete current attacker, a distinct victim or protected platform
  asset, a reachable boundary, and the consequence being prevented. Self-only local misuse is not sufficient. Generic
  work, node, size, or traversal-depth counters may be useful diagnostics, but they do not reject otherwise valid
  TeaseScript or structurally valid engine data without a separately justified current boundary. Future shared/server
  resource controls belong at the actual shared-resource or submission boundary rather than in speculative TeaseScript
  plan/snapshot/checkpoint size limits.
- Keep serializable-set validation and reconstruction linear while preserving insertion order, scalar equality, and the canonical array representation.
- Fresh-runtime global initialization consumes each already captured unique own global property once; it does not rescan previously constructed bindings.
- Detailed instruction-plan validation builds one local instruction-owner/function index. Detailed snapshot validation
  builds one local function/region index, call-frame argument and temporary maps, and reuses suspended-continuation
  liveness results for each validated active-loop variant. These are operation-local only; no caller-supplied plan or
  snapshot data enters a global cache. Validation work may be measured diagnostically, but structural validity is not
  conditioned on a generic validation-work budget.
- [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md) owns resource-limit classification, coupling evidence, and follow-up routing; this security document owns the trust-boundary behavior.
- Interaction-result handoff validation is a fixed local structural check and does not add another control-flow fixed point, future-writer scan, or settlement-provenance cache.
- Package code has no unrestricted external network access; published media uses platform-managed storage/CDN.
- Future external APIs use platform-managed typed integrations.
- LLM output is untrusted input and may not directly rewrite canonical state or bypass deterministic rules.

## Accepted pending-action boundary

ADR 0016 adds these requirements:

- Canonical `currentSessionTimeMs`, pending-action state, IDs, deadlines, continuation positions, expected result types, and `lastSettlement` remain runtime-owned.
- The player may report a typed time observation or typed capability result, but may not mutate arbitrary snapshot fields, directly replace `currentSessionTimeMs`, or select a continuation.
- A time observation is validated and applied atomically: persist `max(currentSessionTimeMs, suppliedNow)` before settling actions due at that effective value.
- Every completion is correlated to one persisted action ID and is validated before any state mutation, result storage, event emission, RNG use, handler, or continuation.
- Completion lookup searches active foreground and background actions before matching `lastSettlement`, classifying an issued inactive ID as stale, or classifying an unissued ID as unknown.
- An older active background action may not be rejected merely because a newer action has already settled.
- Duplicate, unknown, stale, early, late, wrong-kind, and wrong-type requests produce structured outcomes and may not settle an action twice.
- Raw browser exceptions, DOM objects, `MediaStream` objects, file handles, callbacks, and other non-JSON values may not enter runtime state.
- Browser capability failures are translated into bounded typed plain data before crossing the runtime boundary.
- Clock observations are injected and validated. Local wall-clock time is not the sole authority for manipulation-sensitive or server-backed deadlines.
- Time-integrity anomalies are diagnostics, not automatic proof of cheating, until a later policy defines thresholds and script visibility.
- Restored Standard UI is reconstructed from validated canonical action payloads rather than replaying untrusted host state.

The implemented foreground-interaction boundary captures each completion request through the shared stable external-data
graph before inspecting it. The current implementation keeps separate completion/result/transcript string bytes, one
aggregate retained-definition byte budget, and option count as resource axes. Authored/materialized UI fields have no
independent per-field byte policy; each preflights against the remaining definition aggregate. Their current numeric
values are provisional Owner POC policy with the reassessment route recorded in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md), not retained-capacity claims. Validation stops UTF-8 encoding after the
first applicable byte failure, uses set-based duplicate checks and bounded linear matching, and rejects unknown
persisted interaction fields so hidden data cannot bypass current validation. Rejected definitions and completions do not
truncate or partially mutate state.

The engine, not the caller, normalizes text, parses numbers, resolves choice labels/text, and derives player transcript content. Successful completion emits `playerTranscript` before `actionCompleted`; invalid or duplicate attempts emit neither event. Interaction result destinations, speaker IDs, target, ownership, options, settlement results, transcript text, and the single-use result handoff are validated against the immutable plan and current snapshot. A result is atomically committed into a prepared ordinary runtime destination. Until the first canonical consume, transfer, return, discard, or exit succeeds, the nullable handoff retains the canonical value independently of `lastSettlement`; afterward it is removed immediately. `lastSettlement` remains bounded replay data and is not a destination-liveness authority.

Camera permission, long-lived stream ownership, device switching, captured-media retention, encryption, persistent
collections, and player-visible privacy indicators require a separate accepted camera/media design. Selected direction
and open questions are recorded in
[`planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md`](planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md).

Exact iframe sandbox flags, CSP, message schemas, capability negotiation, signing, moderation workflows, camera/media privacy policy, and time-integrity policy remain to be specified.
