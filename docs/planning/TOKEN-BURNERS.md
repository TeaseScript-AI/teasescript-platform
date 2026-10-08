# Token burners

Large, optional, well-specified work packages that the Owner can launch when spare weekly agent budget would otherwise
expire, for example during a holiday. Owner direction, 2026-10-08.

- A listed package is not scheduled and does not accept a design by being listed. The Owner launches it.
- Each entry must be specified well enough for an agent to start without new owner decisions: the outcome, its scope
  and exclusions, the authority it depends on, and how it is verified.
- Remove an entry when it is launched, done, or no longer wanted. Release-stage placement stays in
  [`RELEASE-ROADMAP.md`](RELEASE-ROADMAP.md).

## Entries

- **Incremental snapshot and checkpoint persistence**
  - **Outcome:** Persist snapshots and checkpoints as deltas, so per-step persistence cost no longer scales with the
    total retained state of a long session.
  - **Ready when:** The syntax is fixed (Beta) and a design note has chosen the delta format, its validation, and its
    restore-equivalence tests.
  - **Reference:** the roadmap item **Incremental snapshot and checkpoint persistence**.
