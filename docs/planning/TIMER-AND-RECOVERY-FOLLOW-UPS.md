# Timer and recovery follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted ADRs and current topic documents control
- **Use when:** Planning public timer handles or author-defined recovery points
- **Do not use for:** ADR 0018, current runtime status, browser time-integrity policy, or developer runtime Pause

`docs/RUNTIME.md`, `docs/LIBRARIES.md`, and ADRs 0016–0018 own accepted and current timer foundations. This note retains
only adjacent owner-selected work that is not yet accepted as a detailed contract.

## Timer handles

Future timer design should build on one foreground delay primitive and one explicit background timed-work primitive.
Visible countdowns, mystery presentation, repetition, persistence, and author-friendly wrappers belong above those
primitives where possible.

Pause, resume, and stop operations should target an explicit timer handle. An omitted argument meaning “the only active
timer” is not selected because branches, input, calls, and background work can make that interpretation ambiguous.
Methods on a handle and standalone functions remain alternatives until the accepted type and library-linkage model makes
one clearly simpler.

The detailed contract must still define handle identity, checkpoint behavior, cleanup, stop and restart semantics,
repetition, persistence, error results, and Standard UI presentation. Timer lifecycle operations are distinct from
developer-mode runtime Pause.

## Recovery points

Author-defined recovery points are an advanced feature beyond exact checkpoint resume. A rollback design must define the
treatment of:

- variables, scopes, RNG, call and loop progress, and pending actions;
- transcript, Standard UI, package views, and media;
- completed timers or assignments;
- account writes, history, notifications, and other irreversible external effects.

The design must prevent repeated irreversible effects and distinguish canonical rollback state from reconstructible UI.
It requires a separate accepted decision before implementation.
