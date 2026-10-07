# ADR 0025 — Engine-owned runtime sessions

**Status:** Accepted
**Decision source:** Owner decision, 2026-10-07 (issues #494 and #512)

## Context

Every snapshot-taking runtime operation (`run`, `observeTime`, `completeAction`, and the other host operations) captures
and completely validates the snapshot it receives, because a caller may have changed it, including a snapshot an
earlier operation returned. That keeps external data safe, but each operation then costs time in proportion to the
whole runtime state, also when the operation changes almost nothing: a Player observing time with a few megabytes of
state, or a coverage explorer settling thousands of inputs, spends most of its time capturing state it already had.

## Decision

1. An opaque, engine-owned runtime session keeps the validated immutable plan and the canonical snapshot itself. No
   caller can reach its state: sessions come only from the engine's factories, and the state lives in a private field.
2. Session operations capture and validate only their new input: time observations, action completions, media
   reports, and other host data keep their complete capture and validation rules. Between snapshot boundaries the
   session runs the same deterministic engine on its private state without whole-snapshot capture or validation.
3. Real boundaries keep complete fresh capture and validation of the whole snapshot: creating a session from a
   snapshot or checkpoint, exporting a snapshot or checkpoint, debug export, and later the server. A trusted host that
   keeps a snapshot itself may export it with `exportTrustedSnapshot()` instead, the same JSON as a trusted copy like
   `fork()`'s; the snapshot is captured and validated wherever it crosses a boundary later, so the engine never runs
   data it did not check (approved 2026-10-07 under the Owner's rule for low-risk performance improvements, #512).
4. Results, views, and exports are detached: nothing a session publishes shares a mutable object with its state.
5. A session whose operation throws is finished. The error reaches the caller, and every later call, including
   exports and forks, throws, so state that the operation may have changed in part never becomes visible; callers
   continue from their last export or checkpoint. Invalid arguments are refused before an operation starts and leave
   the session usable. Returned runtime failures, such as an exhausted instruction budget, are not thrown and commit as
   in the snapshot API.
6. `fork()` copies the state through a trusted internal copy and shares the immutable plan.
7. The snapshot-taking API is unchanged. A snapshot a caller passes back, also one an earlier operation returned,
   remains external data; there is no identity-based exemption for it.
8. A session is an ephemeral runner, not a format: plans, snapshots, events, and checkpoints are unchanged, and the same
   plan, starting state, and operations give the same results through either API.

## Consequences

- An ordinary session step costs work in proportion to its input and output, not to the unchanged state.
- Hosts that keep a session (the Player, the coverage explorer) read a small operational view instead of the
  snapshot, and export complete state only at their own boundaries, such as a save, a debug export, or a frontier.
- A host that must show or export the state from before a thrown operation, such as a crash report, keeps it itself:
  its last export or checkpoint, or a recording it can replay.
- `docs/RUNTIME.md#runtime-sessions` holds the executable contract: factories, operations, results, view, boundaries,
  failures, forks, and tracing.

## Alternatives considered

- Deeply frozen returned snapshots with process-local validation evidence: the engine mutates canonical records, so
  every operation would still need a trusted copy plus a deep freeze, which grows with the state, and callers would
  lose in-place editing of returned snapshots.
- Coarser snapshot operations that capture once per batch of host operations: removes part of the cost, but every
  batch and branch still captures the complete state.
- Trusting returned snapshots by identity or a public "trusted" flag: a caller can still edit such a snapshot, so the
  engine would run unvalidated data.
- Caching only schema validation: the dominant cost is capture itself.
- Persistent structural sharing: could make copies cheap, but requires converting every in-place write of the
  engine; it is a much wider change than an owned session.
- Running each operation that executes script code on a trusted copy of the state, which would keep the state from
  before a thrown operation (rejected on 2026-10-07): such an operation can throw after it changed state,
  for example when text grows past what JavaScript can hold or a host callback fails, and no check of comparable cost
  can rule that out beforehand, so every run would again cost time in proportion to the whole state. In those cases a
  retry from the earlier state fails the same way, and hosts keep their own last export or checkpoint.
