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
`stopTimer` spellings have been removed from that specification. The Owner selected a unified `timer` direction with an
explicit handle for async timers. The examples below record that direction; they are **not executable or accepted source
syntax** until the parser/compiler/runtime and canonical specification change together. This planning does not schedule
compiler work on the Player PR.

The future timer design should build on one foreground delay primitive and one background timed-work primitive.
`wait` remains the simple hidden blocking pause for pacing. A bare `timer` is intended to default to visible and
blocking. A blocking timer does not return a handle because the script continues only after it has finished.
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
callback. The Owner selected methods on that handle for lifecycle control:

```tease
deadline.pause()
deadline.resume()
deadline.stop()
deadline.display = "mystery"
```

`stop` is cancellation; a timer that no longer exists cannot be resumed. Whether an invalid runtime operation is an
error or a warning remains deferred. Display changes may select `visible`, `mystery`, or `hidden`. The Owner selected
`elapsed` and `remaining` as author-facing `duration` properties:

```tease
if deadline.remaining > 10 seconds {
    say "There is still time."
}

if deadline.elapsed >= 2 min {
    say "Two minutes have passed."
}
```

`elapsed` is total active running time since the first start, including all completed repeat rounds; an explicit
`pause()` stops that count. `remaining` concerns only the current round. Browser suspension while an unpaused timer runs
is different from script-requested pause and follows the accepted session-time observation contract. An exact timer
duration can be represented internally in milliseconds; author-facing unit conversion should be typed, not manual.
Duration comparisons must compare values across exact units, so `90 seconds > 1 minute` is true. The comparison
operators already exist, but runtime support for duration values remains to be implemented.

Changing a current round and changing future repeat rounds are distinct operations. The following property names and
assignment forms are Owner-selected direction; they become accepted source syntax when implemented with the canonical
specification:

```tease
deadline.remaining += 10 seconds       // current round only
deadline.remaining -= 10 seconds       // current round only
deadline.remaining = 20 seconds        // set current round
deadline.repeatDuration = 50 seconds   // later repeat rounds only
```

`+=` and `-=` are intended as general TeaseScript assignment operators, not timer-only methods. An adjustment reaching
zero finishes the current round without creating negative remaining time. A repeat resets `remaining` for its next round
but does not reset `elapsed`. The exact behavior of operations on a settled handle and adjustment while paused or at the
expiry boundary remains unsettled.

The eventual accepted change must update the canonical syntax and the parser/compiler/runtime together, with
source-to-runtime coverage. The Player PR may implement presentation and integration that current runtime events
support, but a visual timer fixture is not evidence that authored timer scripts work.

The remaining substantive scheduling question is what an expiry handler may do while an `ask` is pending. A deadline
must be able to make an unanswered prompt expire without leaving two active story paths. Current `ask` functions do not
return `null`; an interrupted assignment has not produced a value. Whether to give `ask` its own deadline option and how
to reject use of a value that was never assigned remain to be designed. Timer handlers run one at a time under V30;
this does not by itself settle their order relative to a pending prompt or another handler that is waiting.

## Time continuity and missed-event barrier

Standard elapsed-time behavior is based on continuous real/logical session time rather than an implicit "active
playtime" clock. A script may build an active-playtime mechanic explicitly if desired. Blocking waits/timers and
asynchronous timers remain distinct behaviors even when they share lower-level timed-action machinery.

Browser unavailability creates a separate execution problem: TeaseScript cannot execute intermediate script events while
the Player is closed or suspended. Logical script time therefore may not advance past the first event that should have
executed while the Player was unavailable. A restore/resume design needs a **missed-event barrier** (or execution
frontier) that resumes through that first missed event instead of jumping wall-clock time over dialogue, branches, or
other script work that never executed. Events already materialized in a later valid checkpoint are not replayed. The
Owner-selected timer restart rule is recorded in `docs/RUNTIME.md`; checkpoint selection, interactions with repeating
and background timers, and server-authoritative time mechanics still need implementation detail.

## Author-defined recovery points

Author-defined recovery points are an advanced feature beyond exact checkpoint resume. A rollback design must define the
treatment of:

- variables, scopes, RNG, call and loop progress, and pending actions;
- transcript, Standard UI, package views, and media;
- completed timers or assignments;
- account writes, history, notifications, and other irreversible external effects.

The design must prevent repeated irreversible effects and distinguish canonical rollback state from reconstructible
UI. It requires a separate accepted decision before implementation.
