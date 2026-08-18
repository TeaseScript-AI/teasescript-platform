# Timer and recovery follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted ADRs and current topic documents control
- **Use when:** Planning public timer handles, browser-unavailability semantics, custom-view recovery, or external-effect safety
- **Do not use for:** Replacing accepted ADR 0016/0018 mechanics, current runtime status, or developer runtime Pause

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

## Recovery frontier for custom presentation

Arbitrary custom HTML/CSS/TypeScript, including a game or full-player takeover, is not required to expose enough state
for the platform to reconstruct its JavaScript/DOM state after a crash. The deterministic engine remains authoritative,
but the complete Player experience may temporarily be non-restorable while such a view is active.

Future persistence design should track a **recovery/resume frontier**: the latest point from which the complete experience
is guaranteed reconstructible. If a non-restorable custom view is interrupted, recovery may roll back to that frontier
and lose progress made after it. A custom view whose relevant state is entirely represented in canonical engine/package
state can be reconstructible; optional advanced snapshot/replay mechanisms may improve that later, but static proof of
arbitrary JavaScript recoverability is not required.

## External effects across recovery boundaries

A browser rollback must not forget a durable server-side effect that still constrains the account. Future server-effect
contracts therefore need durable effect IDs plus script/package/session ownership and release authority independent of
whether a custom view claims to be restorable.

Where practical, commit the corresponding recoverable checkpoint/state and external effect in one durable transactional
boundary: failure before commit produces neither; success produces both; a retry with the same effect ID is idempotent.
For an effect that must be active during a non-restorable custom view, prefer a reservation/lease followed by explicit
commit or rollback/cleanup. TTL/keepalive may assist cleanup but cannot be the sole correctness mechanism because browsers
can sleep or remain offline. Exact APIs, transaction boundaries, lease durations, and recovery authority remain future
server/runtime decisions.

## Author-defined recovery points

Author-defined recovery points are an advanced feature beyond exact checkpoint resume. A rollback design must define the
treatment of:

- variables, scopes, RNG, call and loop progress, and pending actions;
- transcript, Standard UI, package views, and media;
- completed timers or assignments;
- account writes, history, notifications, and other irreversible external effects.

The design must prevent repeated irreversible effects and distinguish canonical rollback state from reconstructible UI.
It requires a separate accepted decision before implementation.
