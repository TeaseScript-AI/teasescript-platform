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
- **Storage edits and adopted rewinds** of a local Player session are the exception: an edit through
  `applyExternalStorageEdit` ([`RUNTIME.md`](RUNTIME.md#script-storage)), or new input to a state Debug's
  [rewind](#rewind) restored, turns the active session into a diagnostic fork in place, without a separate fork object.
  The Player marks the session edited or rewound while debugging, in its own session data rather than the checkpoint,
  keeps the mark with its debug export and restore, and never treats it as normal play.

## Player Debug

The Standard Player's Debug panel is the first Debugger slice. Player Settings' **Debug menu** switch offers it in the
tools menu; the switch is not stored, so every load starts with it off (the development preview's `?dev` starts it on).
Its own **Debug** switch, on whenever the menu is turned on, pauses the Debug features without leaving the panel. The
Debug log lives while the menu is on; the other features run only while both are on, and turning either off stops
auto-skip, ends a jump at its next yield, and drops the value trace with its history. The time controls stand above the
tabs **Now** (first), **Variables**, **Log**, and **Storage**, which appears when the host persists script storage.
**Download debug export…** in the panel opens the [debug export](#debug-export) dialog from any tab, also with Debug off.
[Rewind](#rewind) keeps the session's history while both switches are on.

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
    count. A captured or chosen image has no path. **Set by** names the statement that set the image, or says that
    earlier history is unavailable.
  - **Audio and video** list every active instance with its authored path, Loading, Playing, or Paused, its reported
    playhead, and the statement that started it.
  - A collapsed **Timers** list shows every timer, hidden ones included: blocking or async, display, running, paused, or
    suspended behind a block, remaining time, and the statement that started it.
- **Variables** explains values from the session's [value trace](RUNTIME.md#debug-trace), which runs while Debug is
  on, also with the panel closed; Start and Continue begin its history, and Debug turned on mid-session records from
  then on. **Explain values**, a button beside each script message in the chat while Debug runs, opens the tab on that
  message as **Selected message**, which stays above the recent chat until another is chosen or **Back to recent chat**;
  the message is found by its event, never by its text, and one shown before the current recording began, or whose
  record was dropped, says so. A message whose text changed in place is explained by its latest change, the `.text`
  write with its causes, also when it changes while selected. **Recent chat** lists recorded messages, newest first, 20
  at a time, each once, by the text it shows now; the newest is open until the player opens or closes one. A variable
  that holds a message handle shows the message's current text beside its identity. An open message shows each value it displays (a placeholder that shows one value
  gives way to it, and a variable, argument, or parameter that only passes the message on opens too), and each row
  opens to its own causes, one level at a time, by click, keyboard, or tap. A row names what happened, with
  its value then, its statement, and, for an earlier version of a variable, its value now; a record that appears again
  in the same tree links to its first row. Unknown origins say why (supplied by the host, Not recorded before Debug,
  Restored value, or no longer retained), a dropped cause reads **Expired**, and causes beyond the trace's limit are
  counted. The tab keeps its opened rows, filter, and pages while another tab shows, and computes nothing meanwhile. The collapsed **Background / all live variables** section filters by name and groups live variables by
  globals, file, function or block call, and variables kept for blocks, 20 at a time, each opening to its origin. A
  value set, or a message shown, inside an `if`, `switch`, `while`, or similar branch lists the **Branch condition**
  that took that branch after its other causes, with the condition's value and statement; it opens to the condition's
  own causes.
- **Storage** lists what the script saved in this browser: every key in UTF-16 order, its value's type and a
  short preview, and, once expanded, a list, set, object, or dict's members, 20 at a time, as one flat outline. Text
  stays text: when it has the exact shape of a photo reference, a thumbnail beside it shows the photo this browser
  saved under it, read only once it is in view, or says No saved photo. Each such reference also appears once under
  Photo references with the keys whose values contain it. The tab reads the saved values freshly when it opens, after
  this Player saved, cleared, or imported them, after another tab of this browser changed this script's values, and on
  Refresh. The running session keeps the copy it loaded at Start, apart from its own edits:
  - **Edit**, **Delete**, and **Add a value** open an editor with the value's type (Text, Number, Integer, Yes/no, or
    Advanced: the stored JSON form), checked before it is stored. A value changed meanwhile is reported, not
    overwritten. The edit is stored in this browser first, showing Saving…; only once that succeeded does a running
    session take it through `applyExternalStorageEdit`, so its next `load` returns it while values it already loaded
    stay; when storing fails, nothing changes. While the script's own save waits for the browser, Save is disabled
    ("The script is saving… try again in a moment"). A script save made while the edit is being stored settles first;
    the session then takes the value the browser kept, and when that is the script's, the editor says so. Without a
    running session, the edit is for the next Start. Editing waits while the session waits for Continue, the camera
    opens, or an import or clear runs.
  - The first applied edit marks the session **Edited while debugging** (with the scene time of the first edit and
    the number of edits) in the Player's own session data, which a debug export carries.

### Rewind

While the Debug features run, Debug's rewind (`player/debug-history.ts`) keeps a **point** for every interaction the
session newly presents (`choose`, a button, an ask, or `askImage`), the one shown when Debug is turned on included; an
ask that a timer, media, or permanent-button block suspended and shows again is the same point. A point holds the
validated state as checkpoint JSON, which includes the session's storage view, and the events that led to it, which
rebuild its transcript; the plan is shared, and photos stay in the Player's captured-media store, which keeps every
photo it admitted while it is mounted. The history keeps every point: the newest, up to 32 Mi characters of state JSON,
in memory and the older ones in an IndexedDB database of its own (`teasescript-debug-history-<UUID>`). Without
IndexedDB, or once it fails, the history takes no more points than fit that budget and keeps those it has. Turning
either Debug switch off, a new Start or Continue, importing or clearing this script's saved data, and unmounting the
Player delete the history and its database; an import also ends an inspected state. A page that ended without deleting
its database, for example after a crash or by navigating away, leaves it to the next Player, which deletes it at startup
where the browser lists its databases; one that another open Player still uses is deleted only once that Player is done
with it.

- **Back** restores a point that leads to the state shown as a new generation of the session: its state with its storage
  view, Stage, and media, its transcript, and its marks. The restored state is **inspected**: nothing runs on its own,
  its clock stands, media keep their position without playing, load reports, camera requests, and auto-skip wait, and
  the browser's saved data stay as they are, without the Storage editor or clearing them. The first Back parks the
  session it left; every Back keeps the state it left for **Forward**, which restores it exactly. Back waits while a
  save, a Storage editor change, Start, Continue, import, clear, or camera opening waits for the host or the player.
- **Return** reinstates the parked session as it was, and so does turning Debug off while a state is inspected; time
  spent inspecting is no scene time.
- New input to the inspected state (an answer, a button, a permanent button, or a time skip), or **Resume**, **adopts**
  it as the session before the input is evaluated: the browser's saved data are first replaced by the state's storage
  view, as one replacement through the provider and its captured-media layer, and then the input applies and the
  session runs and saves as any session. The parked session, the states kept for Forward, and the points after the
  adopted state are gone; earlier points stay for a later Back. When the saved data cannot be replaced, for example on
  quota, the state stays inspected, the Player says so, and nothing changes. Rewind does one thing at a time: while a
  step restores a state or a state is being adopted, input to an inspected state, Return, and another step are refused.
- In the chat, Back is each earlier answer's **Back to here**; while a state is inspected, the later messages show grey
  and a bar offers Forward, Resume, and Return to session ([Player
  UI](ui/PLAYER-UI.md#composer-and-foreground-interactions)). Each state's transcript folds only the events that led to
  it, so a message that changes later shows the text it had then, and the grey messages are only those created later,
  with their text in the state Forward restores.
- Every restored state marks the session **Rewound while debugging**, with the scene time of the state the latest
  rewind restored and how many rewinds led to it, which an adopted state keeps. The debug recorder and the value trace
  begin anew at every restored state, so a replay never mixes branches.

## Debug export

A debug export (`<script>-debug.teasedebug.json.gz`, or `.teasedebug.json` where the browser cannot compress) lets a
developer find why a Player session failed. Owner decision: noise, such as whole histories, unrelated media, browser
storage, credentials, or host objects, is never included; useful but personal content (saved values, submitted
answers, session text, photos, and Player/browser details) is a separate choice for each export, off by default and
previewed before download; a selected photo carries its original bytes and links to the call or action that used it.
The technical report, always included, locates the failure without runtime values. Replay data discloses state that
copies saved values, answers, and session text, so it requires all three.

`player/debug-export.ts` owns the format: a versioned JSON document (`format: "teasescript-debug-export"`,
`version: 3`) with the build and its checkpoint, plan, and snapshot revisions; what the host knows of the package
(unknown fields are `null`); the incident (code and one-based source location, or a Player exception's error name);
`editedWhileDebugging`, the Debug storage editor's mark (`firstEditSceneTimeMs` and `editCount`, or `null`), which also
covers edits before the replay anchor, and `rewoundWhileDebugging`, the [rewind](#rewind)'s mark (`restoredSceneTimeMs`
and `rewindCount`, or `null`), both of which `inspect` prints; the selection and omissions; the canonical checkpoint
and its role, `current` or `lastGood`; the replay data; photos; and readable sections. Replay data is the anchor snapshot from an earlier boundary, or the last good checkpoint itself, and
every elementary engine call the Player made since, in order: `run` with its options, `observeTime`, `completeAction`
with the media store's recorded answers, `reportMediaLoad`, `pressPermanentButton`, `recordContinueCapture`, and
`applyExternalStorageEdit` with the edit, and `updateInteraction` with the form edit, each with its plain arguments, outcome, emitted event range, resulting
status, or thrown error name. It adds no plan, snapshot, or checkpoint revision.

In every build, the Player's `player/debug-recorder.ts` records each session from its Start or Continue: the anchor
before its first call and copies of every call's plain arguments and results, beside the session and outside its state.
When the record would outgrow its retention (4,096 calls or 2 Mi characters of argument JSON, diagnostic tuning rather
than a script limit), it starts again from the state before the Player's next call, never dropping a call in between. A
call that fails the session or throws freezes the record, which keeps the state that call reached as the export's
checkpoint, so that later observations, such as on hiding the page, cannot evict or outdate it; a call the recorder
cannot copy, or a media store that throws during a call, marks it incomplete.

The Player assembles an export when its dialog opens ([Player UI](ui/PLAYER-UI.md#session-end-and-failure)), from the
session, the record, and the photos frozen then (`player/debug-export-assembly.ts`), so play may continue meanwhile. The
technical report carries the build and its revisions, the package's storage scope and a SHA-256 of its compiled plan
where the browser can hash, the incident as the session's actual state shows it, the storage editor's and the rewind's
marks, the sequence and kind of the last 256 events, and what the Player itself observed, as Debug's Now view and the notices show it: the
Stage image's status (such as an unresolved path or a failed load), each playing medium's kind, load, and state, and
each notice's kind and level, such as blocked audio. These describe this browser; a replay of the engine calls does not
reproduce them. Saved values add the session's storage view; answers add the recorded interaction completions; session
text adds the last 50 transcript messages, the Stage image's authored path, media sources, notice messages, and the
Debug log while the Debug menu is on, and the events with their content: messages and their changes, the player's own
transcript text, and button labels always, but the details of requests, settlements, warnings, failures, and storage edits, which can hold
saved values, answers, or storage keys, only when saved values and answers are chosen too; replay data adds the
checkpoint of the state a complete record reaches (of the actual state when the record is incomplete), or of its anchor
as the last good state when that state cannot be checkpointed; photos add the chosen originals and their uses (a
recorded image answer or capture, or a saved value); Player and browser details add the presentation settings, screen
geometry, pointer, language, and user agent. Text that looks like a credential, or a rooted, drive, or network file path
or a file URL outside another URL, is replaced in every readable section, and replay data containing it is left out
entirely, since changing it would change the replay; such detection in free text is best effort and cannot prove text
safe, so the export is never called anonymous: the protection is that each category is the player's choice, and the
dialog asks the player to check its preview before sharing.

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
