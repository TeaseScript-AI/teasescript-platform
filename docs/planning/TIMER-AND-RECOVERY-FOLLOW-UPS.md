# Timer and recovery follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted ADRs and current topic documents control
- **Use when:** Planning public timer handles, browser-unavailability mechanics, or author-defined recovery points
- **Do not use for:** Accepted timer/runtime mechanics, the ADR 0012 recovery frontier, durable-effect rules, current
  runtime status, or developer runtime Pause

`docs/RUNTIME.md`, `docs/LIBRARIES.md`, and ADRs 0016–0018 own accepted/current timer foundations; ADR 0012 and
`docs/DATA-AND-API.md` own accepted custom-view recovery and durable-effect rules. This note retains only adjacent
owner-selected work that is not yet accepted as a detailed contract.

## Timer authoring direction

V30 section 27 accepts `wait` and a visible blocking `timer`. Earlier unapproved `mysteryTimer`, `startTimer`, and
`stopTimer` spellings have been removed from that specification. The Owner is reviewing a unified `timer` form with an
explicit handle. The examples below are a **candidate design, not accepted or executable syntax**. They preserve the
direction and open questions from the timer discussion without scheduling compiler work on the Player PR.

The future timer design should build on one foreground delay primitive and one background timed-work primitive.
`wait` remains the simple hidden blocking pause for pacing. A bare `timer` is intended to default to visible and
blocking.
The timer presentation choices are `visible`, `mystery`, and `hidden`; `async` allows the script to continue while the
timer runs. These sketches cover the resulting six combinations:

```tease
wait 10 s                                      // hidden, blocking
timer 10 s                                     // visible, blocking
timer mystery 10 s                             // mystery, blocking
let a = timer async visible 10 s "Deadline" { expired() }
let b = timer async mystery 10 s "Deadline" { expired() }
let c = timer async hidden 10 s { expired() }
```

The precise order of short-form modifiers and the position of the optional label remain to be reviewed alongside other
TeaseScript commands. A named long form is also desired so optional fields need not be positional:

```tease
let deadline = timer(
    duration: 30 seconds,
    async: true,
    display: "visible",
    label: "Deadline",
    repeat: true,
    persist: true
) {
    expired()
}
```

V30 section 27 retains the accepted `repeat: true` and `persist: true` behavior, including a fresh random draw for
each repeating range and the established cleanup rules. Their placement in the new syntax and interaction with future
pause/resume behavior remain open. An omitted display and execution mode should mean visible and blocking.

### Handle and time values

An asynchronous timer returns a script-visible, typed, opaque handle, separate from the engine's persisted internal
action ID. The handle references validated timer state across checkpoints, rather than retaining a JavaScript object or
callback. Handle methods are the preferred author-facing direction for lifecycle control:

```tease
deadline.pause()
deadline.resume()
deadline.stop()
deadline.display = "mystery"
```

`stop` is cancellation; restart after stop and reads from a stopped handle remain open. Display changes may select
`visible`, `mystery`, or `hidden`. The handle should expose `duration` values for `elapsed` and `remaining`:

```tease
if deadline.remaining > 10 seconds {
    say "There is still time."
}
```

`elapsed` is total active running time since the first start, including all completed repeat rounds; an explicit
`pause()` stops that count. `remaining` concerns only the current round. Browser suspension while an unpaused timer runs
is different from script-requested pause and follows the accepted session-time observation contract. An exact timer
duration can be represented internally in milliseconds; author-facing unit conversion should be typed, not manual.

Changing a current round and changing future repeat rounds are distinct operations. The following property names and
assignment forms are **proposals**, not final syntax:

```tease
deadline.remaining += 10 seconds       // current round only
deadline.remaining -= 10 seconds       // current round only
deadline.remaining = 20 seconds        // set current round
deadline.repeatDuration = 50 seconds   // later repeat rounds only
```

`+=` and `-=` would be general TeaseScript assignment operators, not timer-only methods. An adjustment reaching zero
would finish the current round without creating negative remaining time. A repeat resets `remaining` for its next round
but does not reset `elapsed`. The final runtime contract will define the exact lifecycle and checkpoint behavior.

The eventual accepted change must update the canonical syntax and the parser/compiler/runtime together, with
source-to-runtime coverage. The Player PR may implement presentation and integration that current runtime events
support, but a visual timer fixture is not evidence that authored timer scripts work.

## Time continuity and missed-event barrier

Standard elapsed-time behavior is based on continuous real/logical session time rather than an implicit "active
playtime" clock. A script may build an active-playtime mechanic explicitly if desired. Blocking waits/timers and
asynchronous timers remain distinct behaviors even when they share lower-level timed-action machinery.

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

The design must prevent repeated irreversible effects and distinguish canonical rollback state from reconstructible
UI. It requires a separate accepted decision before implementation.
