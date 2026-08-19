# ADR 0012 — Custom-view capability

**Status:** Accepted capability; author syntax open

The engine/platform must support:

- a blocking custom view that pauses its caller until it completes with a serializable typed result;
- a non-blocking/asynchronous custom view that returns a runtime handle while ordinary script execution continues;
- typed view events plus update and lifecycle operations through the owning runtime contract;
- deterministic ownership and cleanup.

Blocking versus non-blocking execution and presentation surface are separate concepts, subject to these surface rules:

- a Player-owned custom tool body is always non-blocking; user hide/show changes presentation only and does not end the
  view or its runtime state;
- the central stage supports blocking and non-blocking custom views and is script-controlled rather than user-dismissed;
- a floating non-modal overlay supports both modes; the author chooses whether it is hideable or dismissible;
- a modal overlay is blocking; it is not dismissible by default, while an explicitly dismissible modal defines its
  cancellation result/event;
- a temporary full-Player takeover may be blocking or non-blocking, replaces the complete Standard Player presentation,
  and later returns to the same Standard Player state. It is not dismissible by default, though the author may provide
  an explicit exit/cancel path. A takeover cannot selectively retain arbitrary Standard Player regions; authors who
  need those regions use a smaller custom surface instead.

A custom stage may also use Player/browser fullscreen where permitted; fullscreen and full-Player takeover are distinct.
All forms remain inside the accepted sandboxed Player iframe. Custom tool/stage content is confined to its assigned
surface and cannot escape into structural Player chrome through CSS or `z-index`.

Cancellation and failure are distinct. If custom-view code fails before normal completion, the result is an ordinary
runtime error for both blocking and non-blocking views; there is no separate per-view failure-handler layer. Owner or
session termination ends owned views, cancels view-local pending work/subscriptions, invalidates their handles, and
releases temporary resources according to their owning contracts. Hiding a view is not cleanup.

A blocking modal/takeover moves keyboard focus into the active custom surface and restores focus to a logical Standard
Player target when it ends. A non-modal non-blocking view does not steal focus merely because it appears. Browser Back
is not repurposed as generic custom-view dismissal/navigation.

Canonical runtime/checkpoint state remains serializable; arbitrary custom DOM or JavaScript state is not required to be
checkpoint-restorable. Persistence therefore tracks a **recovery frontier**: the latest point from which the complete
experience is known to be reconstructible. If execution continues through non-restorable custom UI and that UI cannot be
reconstructed after a crash or restore, recovery may roll back to that frontier, losing the custom UI and subsequent
runtime progress. Normal completion that commits a serializable result may establish a new reconstructible frontier.
Custom UI backed entirely by supported reconstructible state may resume normally. A package declaration alone does not
prove arbitrary JavaScript state reconstructible. ADR 0015 checkpoints remain self-contained for engine state and ADR
0016 Standard UI remains reconstructible; the frontier governs whole-experience resume only when custom UI adds
non-restorable presentation state.

Server effects while execution is beyond a recovery frontier follow the durable-effect rules in
[`DATA-AND-API.md`](../DATA-AND-API.md); browser liveness or a package reconstruction claim is not sufficient authority
for persistent external state.

The old syntax using `set result = show custom view ...` and `open ... as handle` is superseded because it conflicts with
V30 language decisions. Exact author syntax, registration/lifecycle API shape, typed input/event/result schemas,
surface-isolation mechanism (including optional Shadow DOM), and reconstructible-state declaration/validation remain
open.
