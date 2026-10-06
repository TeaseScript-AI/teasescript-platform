# Debugger

The Debugger owns runtime inspection and diagnostic execution independently of editor or Player presentation. The code
editor may embed it, and the Standard Player may expose it as a platform tool. It is hidden by default in ordinary play
but may be deliberately enabled by players or developers; package content cannot disable platform debugging solely to
preserve surprises.

## Inspection

The Debugger should expose the current source file and execution position, variables and values, foreground/background
actions, visible and hidden timers, current media/audio/video state, and provenance that explains selected media or
branches. Exact UI and source mapping remain presentation/tooling work. Value provenance comes from the runtime's opt-in
[debug trace](RUNTIME.md#debug-trace), which owns its recording, identity, history bounds, and restore behavior.

## Execution modes

- **Read-only inspection** observes the canonical session without changing execution.
- **Active debug** runs a disposable fork of a selected session/checkpoint. It may Run, Step, Pause, change variables,
  control deterministic RNG outcomes, exercise branches, and use manual checkpoint/restore. Debug mutations never merge
  back into the canonical session.
- **Storage edits** of a local Player session are the exception: an edit through `applyExternalStorageEdit`
  ([`RUNTIME.md`](RUNTIME.md#script-storage)) turns the active session into a diagnostic fork in place, without a
  separate fork object. The Player marks the session edited while debugging, in its own session data rather than the
  checkpoint, keeps the mark with its debug export and restore, and never treats it as normal play.

## Player Debug

The Standard Player's Debug panel is the first Debugger slice. Player Settings' **Debug menu** switch offers it in the
tools menu; the switch is not stored, so every load starts with it off (the development preview's `?dev` starts it on).
Its own **Debug** switch, on whenever the menu is turned on, pauses the Debug features without leaving the panel. The
Debug log lives while the menu is on; the other features run only while both are on, and turning either off stops
auto-skip and ends a jump at its next yield. The time controls stand above the tabs **Now** (first), **Log**, and
**Storage**, which appears when the host persists script storage.

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
    Displayed, Load failed (the browser cannot load or decode it), or Covered by camera or video; in the development
    preview, Replaced by a preview fixture. Only the Stage's reports for the image element and source it shows now
    count. A captured or chosen image has no path. Which statement set the image is not recorded yet and says so.
  - **Audio and video** list every active instance with its authored path, Loading, Playing, or Paused, its reported
    playhead, and the statement that started it.
  - A collapsed **Timers** list shows every timer, hidden ones included: blocking or async, display, running, paused, or
    suspended behind a block, remaining time, and the statement that started it.
- **Storage** lists what the script saved in this browser, read-only: every key in UTF-16 order, its value's type and a
  short preview, and, once expanded, a list, set, object, or dict's members, 20 at a time, as one flat outline. Text
  stays text: when it has the exact shape of a photo reference, a thumbnail beside it shows the photo this browser
  saved under it, read only once it is in view, or says No saved photo. Each such reference also appears once under
  Photo references with the keys whose values contain it. The tab reads the saved values freshly when it opens, after
  this Player saved, cleared, or imported them, after another tab of this browser changed this script's values, and on
  Refresh. The running session keeps the copy it loaded at Start.

## Debug export

A debug export (`<script>-debug.teasedebug.json.gz`, or `.teasedebug.json` where the browser cannot compress) lets a
developer find why a Player session failed. Owner decision: noise, such as whole histories, unrelated media, browser
storage, credentials, or host objects, is never included; useful but personal content (saved values, submitted
answers, session text, photos, and Player/browser details) is a separate choice for each export, off by default and
previewed before download; a selected photo carries its original bytes and links to the call or action that used it.
The technical report, always included, locates the failure without runtime values. Replay data discloses state that
copies saved values, answers, and session text, so it requires all three.

`player/debug-export.ts` owns the format: a versioned JSON document (`format: "teasescript-debug-export"`,
`version: 2`) with the build and its checkpoint, plan, and snapshot revisions; what the host knows of the package
(unknown fields are `null`); the incident (code and one-based source location, or a Player exception's error name); the
selection and omissions; the canonical checkpoint and its role, `current` or `lastGood`; the replay data; photos; and
readable sections. Replay data is the anchor snapshot from an earlier boundary, or the last good checkpoint itself, and
every elementary engine call the Player made since, in order: `run` with its options, `observeTime`, `completeAction`
with the media store's recorded answers, `reportMediaLoad`, `pressPermanentButton`, `recordContinueCapture`, and
`applyExternalStorageEdit` with the edit, each with its plain arguments, outcome, emitted event range, resulting
status, or thrown error name. It adds no plan, snapshot, or checkpoint revision.

In every build, the Player's `player/debug-recorder.ts` records each session from its Start or Continue: the anchor
before its first call and copies of every call's plain arguments and results, beside the session and outside its state.
When the record would outgrow its retention (4,096 calls or 2 Mi characters of argument JSON, diagnostic tuning rather
than a script limit), it starts again from the state before the Player's next call, never dropping a call in between. A
call that fails the session or throws freezes the record, which keeps the state that call reached as the export's
checkpoint, so that later observations, such as on hiding the page, cannot evict or outdate it; a call the recorder
cannot copy, or a media store that throws during a call, marks it incomplete.

After `npm run build:typescript`, `node tools/debug-export.mjs inspect <file>` summarizes an export without runtime
values (`--values` prints the recorded arguments and readable sections), and `replay <file>` runs the calls again from
the anchor in a worker and compares each result and the final state. It reports a reproduced engine failure (exit 0),
the first divergence with its source location and calls (1), an incomplete export (2), an unsupported version, for
which a checkout of the recorded build is needed (3), an invalid export (4), or a timeout (`--timeout`, default 60 s;
5). Exact replay covers the engine path; browser and device failures are diagnosed from their recorded reports, which
replay substitutes for the devices.

Debugger history may snapshot selected boundaries; this does not imply that production execution persists every internal
instruction. Simulation is debugger tooling when execution uses disposable or test state, not an editor semantic.

## External effects

Active-debug server/account effects use a simulation/test context by default so diagnostic progress cannot become normal
account progress or restrictions. A later explicit integration-test context may exercise real persistence semantics.
Exact enablement and server test-context mechanics remain in [`OPEN-DECISIONS.md`](OPEN-DECISIONS.md).
