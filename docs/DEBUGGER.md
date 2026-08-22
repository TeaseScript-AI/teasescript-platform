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

Debugger history may snapshot selected boundaries; this does not imply that production execution persists every internal
instruction. Simulation is debugger tooling when execution uses disposable or test state, not an editor semantic.

## External effects

Active-debug server/account effects use a simulation/test context by default so diagnostic progress cannot become normal
account progress or restrictions. A later explicit integration-test context may exercise real persistence semantics.
Exact enablement and server test-context mechanics remain in [`OPEN-DECISIONS.md`](OPEN-DECISIONS.md).
