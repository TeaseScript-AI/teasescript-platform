# ADR 0012 — Custom-view capability

**Status:** Accepted capability; author syntax open

The engine/platform must support:

- a blocking custom view that returns a serializable result;
- a background custom view that returns a runtime handle;
- update and close operations;
- deterministic ownership and cleanup.

Package presentation may occupy a Player-owned custom tool body, the central stage, a floating non-modal overlay, a
modal overlay, or a temporary full-Player takeover that later returns to the same Standard Player state. A
custom stage may also use Player/browser fullscreen where permitted; fullscreen and full-Player takeover are distinct.
All forms remain inside the accepted sandboxed Player iframe. Custom tool/stage content is confined to its assigned
surface and cannot escape into structural Player chrome through CSS or `z-index`.

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
V30 language decisions. Exact author syntax, registration, typed events/results, focus/navigation behavior, and mapping
of presentation forms to blocking/background action APIs remain open.
