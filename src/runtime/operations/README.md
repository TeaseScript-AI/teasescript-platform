# Operations

The host operations on a session's state, and what they share.

- `complete-action.ts`: completing the foreground action with the host's result, and timed-out buttons.
- `continue-capture.ts`: what the host captured when the player continues a restored session.
- `debug-mode.ts`: setting what `debugMode` reads.
- `external-storage-edit.ts`: a debugging tool's edit of one script-storage key.
- `media-lifecycle.ts`: media records, events and waits, stopping media, and developer warnings.
- `media-reports.ts`: the Player's media load results and progress reports.
- `model.ts`: operation results, and the refusal while a random draw is paused.
- `observe-time.ts`: observing time: catching up, due timer and media work, and the timed-work schedule.
- `press-permanent-button.ts`: a click on a permanent button.
- `support.ts`: capture, result, and event-sequence helpers the operations and the engine share.
- `timer-handlers.ts`: starting and returning from expiry, cue, and button blocks.
- `timer-lifecycle.ts`: which queued block may run, timer expiry, overruns, and stopping timers.
- `transfers.ts`: `goto`, transfers, `end`, and the fallback.
- `update-interaction.ts`: editing a pending form without settling it.
