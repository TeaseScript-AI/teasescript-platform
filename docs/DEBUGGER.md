# Debugger

The Debugger owns runtime inspection and diagnostic execution independently of editor or Player presentation. The code
editor may embed it, and the Standard Player may expose it as a platform tool. It is hidden by default in ordinary play
but may be deliberately enabled by players or developers; package content cannot disable platform debugging solely to
preserve surprises.

## Inspection

The Debugger should expose the current source file and execution position, variables and values, foreground/background
actions, visible and hidden timers, current media/audio/video state, and provenance that explains selected media or
branches. Exact UI and source mapping remain presentation/tooling work.

## Execution modes

- **Read-only inspection** observes the canonical session without changing execution.
- **Active debug** runs a disposable fork of a selected session/checkpoint. It may Run, Step, Pause, change variables,
  control deterministic RNG outcomes, exercise branches, and use manual checkpoint/restore. Debug mutations never merge
  back into the canonical session.

## Player Debug

The Standard Player's Debug panel is the first Debugger slice. Player Settings' **Debug menu** switch offers it in the
tools menu; the switch is not stored, so every load starts with it off (the development preview's `?dev` starts it on).
Its own **Debug** switch, on whenever the menu is turned on, pauses the Debug features without leaving the panel. The
Debug log lives while the menu is on; the other features run only while both are on, and turning either off stops
auto-skip and ends a jump at its next yield. The time controls stand above the tabs **Now** (first), **Log**, and
**Storage**, which appears when a host supplies the saved-data overview and editor.

- **Time controls** (Skip event, +10 s, +1 min, Auto-skip) advance the canonical session's own scene time through
  ordinary observations ([`RUNTIME.md`](RUNTIME.md#timers-and-scene-time)). They are read-only inspection with
  accelerated time, not an active-debug fork, and change no script semantics.
- **Countdowns** show the deadline of the current foreground wait from canonical state: an authored `wait` (a blocking
  `timer` stays a timer), a presented `showButton` with a timeout, or chat pacing while no other foreground action owns
  progress or input. An action suspended behind a running timer, media, or permanent-button block does not count; that
  block's own foreground work does. Seconds round up against the Player's display estimate of scene time. An elapsed
  deadline whose action has not settled reads **Wait elapsed · waiting for script**; the line ends when its action
  settles or loses the foreground, and does not show before Start or Continue or after the session ends.
- **Now** shows where the session is, derived on demand from canonical state and the Stage's own load reports. Paths
  are package paths relative to the entry script's folder, with every subfolder, and lines are one-based:
  - **Next** is the execution cursor; **Waiting at** is the statement whose foreground action the script waits for,
    named by kind (wait, timer, button, pacing, and so on). A collapsed **Call chain** lists the active functions,
    called files, and timer, media cue, or permanent-button blocks, innermost first, each with its call site or the
    position it interrupted.
  - The **Stage image** shows its authored path and state: Hidden, Unresolved path (the host has no file for it), Loading,
    Displayed, Load failed (the browser cannot load or decode it), or Covered by camera or video. Only the Stage's
    reports for the image element and source it shows now count. A captured or chosen image has no path. Which
    statement set the image is not recorded yet and says so.
  - **Audio and video** list every active instance with its authored path, Loading, Playing, or Paused, its reported
    playhead, and the statement that started it.
  - A collapsed **Timers** list shows every timer, hidden ones included: blocking or async, display, running, paused, or
    suspended behind a block, remaining time, and the statement that started it.

Debugger history may snapshot selected boundaries; this does not imply that production execution persists every internal
instruction. Simulation is debugger tooling when execution uses disposable or test state, not an editor semantic.

## External effects

Active-debug server/account effects use a simulation/test context by default so diagnostic progress cannot become normal
account progress or restrictions. A later explicit integration-test context may exercise real persistence semantics.
Exact enablement and server test-context mechanics remain in [`OPEN-DECISIONS.md`](OPEN-DECISIONS.md).
