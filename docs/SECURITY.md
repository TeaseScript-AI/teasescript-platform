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
  canonical execution. Live JavaScript input is stabilized into plain data as needed; current capture rejects accessors,
  trap failures, cycles, unsupported prototypes, non-finite numbers, and sparse or otherwise non-canonical arrays before
  detailed use. Captured arrays use an engine-owned prototype isolated from ambient numeric `Array.prototype`
  properties, and density checks require own indexes. Compiler-owned plans use complete inspect-only validation without
  this defensive copy. Defensive capture is correctness/robustness behavior, not by itself a TeaseScript content-capacity
  or security policy, and already validated internal representations do not need external-data capture merely because
  they share a capture or validation helper.
- A resource-based security rejection requires a concrete current cross-principal or protected-resource boundary,
  reachable influence across that boundary, and the consequence being prevented. Self-only local misuse is not
  sufficient. Generic work, node, size, or traversal-depth counters may be useful diagnostics, but they do not reject
  otherwise valid TeaseScript or structurally valid engine data without a separately justified current boundary. Future
  shared/server
  resource controls belong at the actual shared-resource or submission boundary rather than in speculative TeaseScript
  plan/snapshot/checkpoint size limits.
- Keep serializable-set validation and reconstruction linear while preserving insertion order, scalar equality, and the canonical array representation.
- Fresh-runtime global initialization consumes each already captured unique own global property once; it does not rescan previously constructed bindings.
- Detailed instruction-plan validation builds one local instruction-owner/function index. Detailed snapshot validation
  uses one function/region and plan-fact index per plan plus local call-frame argument and temporary maps, and derives
  what a suspended continuation needs from liveness over only the control flow it can reach with its active loops. The
  index and the needs of accepted snapshots' continuations are kept in process only for an immutable plan that complete
  validation registered, and only while that plan lives; any other plan is indexed per operation, and every snapshot is
  still captured and validated in full. Validation work may be measured diagnostically, but structural validity is not
  conditioned on a generic validation-work budget.
- [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md) owns resource-limit classification, coupling evidence, and follow-up routing; this security document owns the trust-boundary behavior.
- Interaction-result handoff validation is a fixed local structural check and does not add another control-flow fixed point, future-writer scan, or settlement-provenance cache.
- Package code has no unrestricted external network access; published media uses platform-managed storage/CDN.
- Future external APIs use platform-managed typed integrations.
- LLM output is untrusted input and may not directly rewrite canonical state or bypass deterministic rules.
- Authored Standard-chat message markup crosses into the Player as validated typed blocks and spans. Angle-bracket HTML
  remains literal text, controlled style values cannot carry arbitrary CSS, and only canonical HTTP(S) targets become
  links. The Player renders this structure without a raw-HTML path and opens links with opener isolation.
- Saved script data moves between browsers only by the player's own hand ([transfer](DATA-AND-API.md#saved-data-transfer)):
  an export stays in the browser until the player downloads or copies it, with no upload, URL, or clipboard read. It is
  neither encrypted nor signed and can contain private photos, which the Player says when exporting.

## Accepted pending-action boundary

ADR 0016 adds these requirements:

- Canonical `currentSessionTimeMs`, pending-action state, IDs, deadlines, continuation positions, expected result types, and `lastSettlement` remain runtime-owned.
- The player may report a typed time observation or typed capability result, but may not mutate arbitrary snapshot fields, directly replace `currentSessionTimeMs`, or select a continuation.
- A time observation, including any media progress reports, is validated and applied atomically: persist `observedSessionTimeMs = max(observedSessionTimeMs, suppliedNow)` and the accepted progress samples, then settle due work toward that horizon as defined in `RUNTIME.md`; a malformed observation changes nothing.
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

The engine, not the caller, normalizes text, parses numbers, resolves choice values/text, and derives player transcript content. Successful completion emits `playerTranscript` before `actionCompleted`; invalid or duplicate attempts emit neither event. Interaction result destinations, speaker IDs, target, ownership, options, settlement results, transcript text, and the single-use result handoff are validated against the immutable plan and current snapshot. A result is atomically committed into a prepared ordinary runtime destination. Until the first canonical consume, transfer, return, discard, or exit succeeds, the nullable handoff retains the canonical value independently of `lastSettlement`; afterward it is removed immediately. `lastSettlement` remains bounded replay data and is not a destination-liveness authority.

Browser permission is the external permission boundary for camera and microphone. First activation requests device
access according to the browser's current permission state; the browser may later revoke access, ask again, or fail.
Other capture use, such as the microphone, is author-controlled after the browser grants access and adds no Player-level
permission or per-use approval. When the package or session has the camera capability, the Player acquires the selected
or default camera immediately after the user presses Start and before ordinary TeaseScript execution begins, so any
browser permission request happens there, and keeps the stream open for the entire running session. Direct capture such
as `takePhoto()` only captures from that open stream: it never opens or reopens the camera, closes it afterwards, or
otherwise reveals the capture moment, and it has no Player indicator, capture flash, per-photo message, preview, stop
control, or per-use approval. Separately, a script's camera view (`showCamera`, [Player UI](ui/PLAYER-UI.md#stage-and-media-presentation))
may show the user a live local preview of that open stream, for example before a photo; it is shown only when the script
asks for it, never captures, and showing or hiding it neither opens nor closes the camera. Native camera indicators stay on while the stream is open, so they do not reveal
individual captures. Normal session teardown, unmount, navigation, and `exit` release the Player-owned camera
resources. For platform-brokered acquisition, the Player owns the underlying browser resources for sandbox isolation,
revocation, and cleanup, but adds no permission prompt, camera or microphone indicator, or stop control of its own;
native browser, OS, and device privacy indicators are sufficient. Complete revocation of package-created derivatives of
raw resources, such as cloned tracks, relies on the sandbox teardown or lifecycle contract (ADR 0017). A captured-media
reference grants access only when the trusted Player media store resolves it within the owning package namespace; a
well-formed string, including one returned by `load`, is ordinary data. A file the player chooses for `askImage(...)`
is external data: the Player identifies the image type from the file's bytes and has the browser decode it before
storing it as session media, and only its reference reaches the runtime. An image request (`askImage(...)`) that
allows the camera may open the camera when it asks, also when the session camera was not opened at Start, so the
browser may ask permission then; it shows its viewfinder while it waits, takes a photo only from the player's shutter
press, and turns a camera it opened itself off again after the answer. Such a camera serves only that request, never
`takePhoto()` or a script's camera view, and a photo reaches the runtime only through "Use this". `takePhoto()` stays
silent and uses only the camera opened at Start. A recording contains exactly the sources the author requests; whether
video includes microphone audio never depends on whether a microphone is already open. How
brokered acquisition and capability authorization are enforced against package code that calls browser capture APIs
directly, which needs a concrete isolation mechanism such as a separate execution realm rather than a wrapper API or
manifest field, remains open, as do capability declaration metadata, device switching, reload and restore, failure
recovery, simultaneous-device policy, captured-media retention, encryption, and persistent collections; see
[`planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md`](planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md).

Exact iframe sandbox flags, CSP, message schemas, capability negotiation, signing, moderation workflows, captured-media privacy policy, and time-integrity policy remain to be specified.
