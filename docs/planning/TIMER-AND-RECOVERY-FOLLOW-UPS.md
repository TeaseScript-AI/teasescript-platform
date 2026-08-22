# Timer and recovery follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted ADRs and current topic documents control
- **Use when:** Planning public timer handles, browser-unavailability mechanics, or author-defined recovery points
- **Do not use for:** Accepted timer/runtime mechanics, the ADR 0012 recovery frontier, durable-effect rules, current
  runtime status, or developer runtime Pause

`docs/RUNTIME.md`, `docs/LIBRARIES.md`, and ADRs 0016–0018 own accepted/current timer foundations; ADR 0012 and
`docs/DATA-AND-API.md` own accepted custom-view recovery and durable-effect rules. This note retains only adjacent
owner-selected work that is not yet accepted as a detailed contract.

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

## Time continuity and missed-event barrier

Standard elapsed-time behavior is based on continuous real/logical session time rather than an implicit "active playtime"
clock. A script may build an active-playtime mechanic explicitly if desired. Blocking waits/timers and asynchronous
timers remain distinct behaviors even when they share lower-level timed-action machinery.

Browser unavailability creates a separate execution problem: TeaseScript cannot execute intermediate script events while
the Player is closed or suspended. Logical script time therefore may not advance past the first event that should have
executed while the Player was unavailable. A restore/resume design needs a **missed-event barrier** (or execution
frontier) that resumes through that first missed event instead of jumping wall-clock time over dialogue, branches, or
other script work that never executed. Events already materialized in a later valid checkpoint are not replayed. Exact
checkpoint selection, deadline recalculation, repeating-timer behavior, and server-authoritative time policy require a
later accepted runtime decision.

## Author-defined recovery points

Author-defined recovery points are an advanced feature beyond exact checkpoint resume. A rollback design must define the
treatment of:

- variables, scopes, RNG, call and loop progress, and pending actions;
- transcript, Standard UI, package views, and media;
- completed timers or assignments;
- account writes, history, notifications, and other irreversible external effects.

The design must prevent repeated irreversible effects and distinguish canonical rollback state from reconstructible UI.
It requires a separate accepted decision before implementation.
