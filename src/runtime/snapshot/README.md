# Snapshot

The runtime state: its model, how it is built and copied, how a snapshot from outside the engine is validated, and
checkpoints.

- `state.ts`: the snapshot model: format and version, limits, every snapshot type, and small shared checks.
- `snapshot-construction.ts`: fresh snapshots for a plan, and copies of captured ones.
- `snapshot-validation.ts`: capturing a snapshot from outside the engine and the order of its validation, with the
  checks of the session-wide state.
- `frame-validation.ts`: the call, loop, and continuation invariants.
- `prepared-temporary-validation.ts`: prepared references and the prepared parts of a say.
- `snapshot-validation-analysis.ts`: the plan facts that snapshot validation and the engine read, kept once per plan.
- `record-collection.ts`: dropping records nothing reaches.
- `checkpoint.ts`: checkpoints: creating, serializing, reading, and restoring them.
- `snapshot-tag.ts`: tags that prove this engine exported a snapshot's JSON.
