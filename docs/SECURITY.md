# Security boundaries

## Playground development automation

The constrained playground server has an ephemeral loopback-only development workspace API: `PUT /api/workspace/source`, `GET /api/workspace`, `POST /api/workspace/compile`, `POST /api/workspace/run`, and `GET /api/workspace/result`. It emits no CORS headers, has no filesystem-write route, and preserves the static allowlist. Automation is rejected for non-loopback clients even if the static development listener is configured beyond loopback.

Source requires UTF-8 `text/plain; charset=utf-8` and is limited to 65,536 bytes; request bodies are limited to 66,560 bytes before buffering. This bounds parser/compiler work and accidental tool uploads. Unsupported methods/content types, malformed UTF-8, unsafe paths, and oversized data receive structured errors without stack traces. This is neither a public API nor a production backend.

- Run the complete player and package code in a sandboxed cross-origin iframe, preferably on a separate player origin.
- Keep main-site cookies host-only and unavailable to the player.
- Validate every parent/player message, checkpoint, package manifest, server response, and future integration result.
- Capture external instruction-plan, runtime-snapshot, checkpoint, globals, and serializable-value data into one stable plain-data graph bounded to a nesting depth of `128` and `100,000` visited values. Reject accessors, trap failures, cycles, unsupported prototypes, and over-limit input before recursive validation, cloning, freezing, state construction, execution, event emission, or RNG consumption. Captured arrays use an engine-owned prototype isolated from ambient numeric `Array.prototype` properties, and density checks require own indexes.
- Keep serializable-set validation and reconstruction linear while preserving insertion order, scalar equality, and the canonical array representation.
- Fresh-runtime global initialization consumes each already captured unique own global property once; it does not rescan previously constructed bindings.
- Detailed instruction-plan validation builds one local instruction-owner/function index. Detailed snapshot validation builds one local function/region index, call-frame argument and temporary maps, and reuses suspended-continuation liveness results for each validated active-loop variant. These are operation-local only; no untrusted plan or snapshot data enters a global cache. That independently required fixed-point work, its table allocation, and every cached loop-state variant share a deterministic 1,000,000-unit per-validation allowance. Exhaustion is rejected through runtime-snapshot validation before execution, mutation, event emission, or RNG advancement.
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

The implemented foreground-interaction boundary captures each completion request through the shared stable
external-data graph before inspecting it. The current version-1 implementation rejects strings above `65,536` UTF-8
bytes, actions above `65,536` retained-string UTF-8 bytes, and choices above `4,096` entries. These are current
implementation guards, not justified source, product, UI, security, or end-to-end capacity targets merely because code
and tests enforce them. ADR 0019 requires evidence for both the need for each retained bound and its selected value or
mechanism; a guard that cannot meet that requirement must be removed, replaced, or re-derived. While the guards exist,
plan and snapshot validation stop UTF-8 encoding after the first per-string or aggregate failure, use set-based
duplicate checks and bounded linear matching, and reject unknown persisted interaction fields so hidden data cannot
bypass the byte budget. Over-limit definitions and completions are rejected without truncation or partial mutation.

The engine, not the caller, normalizes text, parses numbers, resolves choice labels/text, and derives player transcript content. Successful completion emits `playerTranscript` before `actionCompleted`; invalid or duplicate attempts emit neither event. Interaction result destinations, speaker IDs, target, ownership, options, settlement results, transcript text, and the single-use result handoff are validated against the immutable plan and current snapshot. A result is atomically committed into a prepared ordinary runtime destination. Until the first canonical consume, transfer, return, discard, or exit succeeds, the nullable handoff retains the canonical value independently of `lastSettlement`; afterward it is removed immediately. `lastSettlement` remains bounded replay data and is not a destination-liveness authority.

Camera permission, long-lived stream ownership, device switching, captured-media retention, encryption, persistent
collections, and player-visible privacy indicators require a separate accepted camera/media design. Selected direction
and open questions are recorded in
[`planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md`](planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md).

Exact iframe sandbox flags, CSP, message schemas, capability negotiation, signing, moderation workflows, camera/media privacy policy, and time-integrity policy remain to be specified.
