# Security boundaries

- Run the complete player and package code in a sandboxed cross-origin iframe, preferably on a separate player origin.
- Keep main-site cookies host-only and unavailable to the player.
- Validate every parent/player message, checkpoint, package manifest, server response, and future integration result.
- Capture external instruction-plan, runtime-snapshot, checkpoint, globals, and serializable-value data into one stable plain-data graph bounded to a nesting depth of `128` and `100,000` visited values. Reject accessors, trap failures, cycles, unsupported prototypes, and over-limit input before recursive validation, cloning, freezing, state construction, execution, event emission, or RNG consumption.
- Keep serializable-set validation and reconstruction linear while preserving insertion order, scalar equality, and the canonical array representation.
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

Camera permission, long-lived stream ownership, device switching, captured-media retention, encryption, persistent collections, and player-visible privacy indicators require a separate accepted camera/media design. Selected direction and open questions are recorded in [`planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`](planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md).

Exact iframe sandbox flags, CSP, message schemas, capability negotiation, signing, moderation workflows, camera/media privacy policy, and time-integrity policy remain to be specified.
