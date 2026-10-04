# Runtime

## Player and playground execution adapters

`player/runtime-adapter.ts` is the framework-independent Player adapter shared by the Player and the
playground's action lookup/completion path. It maps validated pending actions and runtime events to Player presentation,
submits typed interactions, pacing/time observations, media load reports, and media progress, projects the Stage and
active media for playback, and uses the canonical runtime checkpoint operations. The Player plays the
projected audio through `player/media-device.ts` and shows the Stage image; browser video playback remains deferred.
`playground/workspace/controller.ts` retains the DOM-free compiler/execution and development-automation workspace
facade. Neither adapter normalizes answers, matches choices, derives canonical transcript text, or retains an
independent action lifecycle.

A blocking `wait` therefore reports `actionRequested` and `waiting`; it is neither a completed timer nor a halted runtime. Action completion, warnings, runtime failures, exit, and plan completion remain technical events.

## Accepted model

ADR 0015 requires the AST to remain compile-time data and the runtime to execute a validated, versioned, JSON-safe instruction plan using explicit versioned state. Checkpoints, event sequence numbers, RNG state, scopes, speakers, loop frames, call frames, temporaries, prepared references, and structured failure information must be serializable without a suspended JavaScript call stack.

ADR 0016 accepts the resumable pending-action contract for waits, timers, choices, input, buttons, media completion, and future typed player capabilities.

## Implemented runtime ownership

Shared serializable action and settlement contracts are owned by
`src/runtime/actions/model.ts`. Pure interaction normalization and matching live in
`actions/interaction.ts`; delay helpers and replay classification remain
action-specific. Canonical completion and time-observation transitions are
implemented in `src/runtime/operations/complete-action.ts` and
`src/runtime/operations/observe-time.ts`, with a small shared operation support
module for validated input capture, result construction, and event-sequence
allocation. `src/runtime/engine.ts` remains the execution facade for
instructions, expressions, `run`, and orchestration. The implemented
`chatPacingGate` reuses this pending-action machinery rather than adding a
second pacing state machine.

## Accepted primitive boundary

ADR 0017 keeps canonical runtime behavior in the engine while moving author-friendly composition into the platform Standard Library when possible.

The engine remains responsible for:

- typed sequenced output and action events;
- foreground and background pending-action identity;
- deterministic time observation and settlement;
- typed completion validation;
- opaque engine-managed references;
- checkpoint, restore, cleanup, and resume equivalence;
- stable speaker/output provenance needed by runtime history;
- validated host/player data and concrete security/resource boundaries.

Candidate Standard Library responsibilities include `say` policy, standard output targets, visible timer presentation,
common input wrappers, validation/retry helpers, and friendly lifecycle APIs. ADR 0018 accepts the first concrete
text/output slice described below; the current compiler/runtime implements that slice through versioned engine state.

## Accepted first Standard Library runtime contract

ADR 0018 selects one generic foreground interaction family for `showButton`, `askText`, `askNumber`, and `choose`,
followed by a separate `say` smart-autoplay slice. The engine/compiler slices, local playground controls, and Vue
reference adapter are implemented. The production cross-origin player/host integration remains separate work.

### Generic foreground interactions

One discriminated pending-action family must carry JSON-safe data equivalent to:

```text
kind: button | text | number | temporal | choice
action identity
owning and continuation instruction positions
scene time when it appeared, and a button's timeout when set
result destination when applicable
expected result type
validated Standard UI payload
choice values and visible texts when applicable
target
optional requesting speaker identity
accessible-name data or localized default key
```

The engine owns action identity, active state, completion validation, transcript-result derivation, result writes, events, settlement replay, checkpoint/restore, and structured rejection. Compiler/Standard Library lowering owns compact syntax and default UI payload.

The selected interactions expose no player cancellation result. Timer interrupts may suspend them, and handler `exit`
discards the interrupted instruction without producing a result; see [Timers and scene time](#timers-and-scene-time).
Wrong-kind, whitespace-only required text, non-finite-number, unknown-option, unknown-visible-choice, ambiguous-choice,
and over-limit completions leave the same action active without mutating its result, transcript, event sequence, RNG, or
continuation.

The compact compiler fully lowers these forms into the versioned plan. Static control text is embedded directly in the interaction instruction. Dynamic control text first captures the requesting speaker, evaluates payload expressions in source order, and stores one prepared UI value; dynamic `choose` batches all option values into one prepared list, next to the value written before each option's `:` (or `null`) in the plan, rather than emitting one interaction-preparation instruction per option. The runtime materializes and validates that prepared UI atomically before publishing the pending action: it expands each list or set option into one button per element, in order, gives every button its value (the written value, a choice object's `value`, or else the option itself), and rejects a choice without buttons or with more buttons than the option-count limit. Buttons may share a value. No Standard Library lookup or suspended JavaScript/TypeScript call survives the compile boundary.

Result-bearing text, number, choice, and valued button instructions require the destination temporary to be absent
when the interaction is requested. Successful completion atomically writes the typed result into that prepared ordinary runtime temporary,
records one nullable single-use `interactionResultHandoff` authority, and advances to the next instruction without
executing it. The handoff contains only the completed action identity, owning and continuation positions, owner call
frame, destination temporary, and canonical result. Snapshot validation checks it independently of the bounded
`lastSettlement` replay data, so persisted data that pairs it with a newer settlement cannot bypass the
value-consistency check before consumption. A canonical plan then either discards the temporary directly, returns or
exits the owning runtime region, or performs one ordinary local consume/transfer instruction followed immediately by
`clearTemporary`. The handoff record is removed after that first instruction succeeds; after a value is copied into an
ordinary binding, prepared argument, assignment, or other runtime destination, no interaction-specific provenance
remains during cleanup or later execution. A second blocking action, a second producer of the destination, a missing or
different cleanup, and an independent control-flow entry into the handoff are invalid inside that short boundary,
because each would let a validated plan reach a state that snapshot validation rejects. The current validator enforces
this through a fixed local shape rather than whole-plan result-liveness analysis; its conservative analysis of which
expression positions count as reading the destination, and its exclusion of branches, loop edges, user-function calls,
and control-flow targets onto the cleanup, are provisional POC policy, not language semantics.

Completion semantics are:

- `askText` normalizes `CRLF` and standalone `CR` to `LF`, otherwise preserves submitted text, rejects whitespace-only input, returns `string`, and uses the same normalized text in the player transcript;
- `askNumber` accepts one line of text, trims surrounding whitespace, parses accepted TeaseScript decimal/scientific forms, requires a finite result, canonicalizes negative zero to numeric `0`, returns `number`, and preserves the trimmed submitted text in the transcript;
- `askInteger` is a `number` interaction whose UI carries `integer: true`: it accepts one line with only an optional sign and digits within the safe integer range, rejects anything else with "That is wrong. I asked for a whole number.", and requires a whole-number prefill;
- `askDate`, `askTime`, and `askDateTime` are a `temporal` interaction whose UI carries `temporalKind` (`date`, `time`, or `datetime`): the answer is trimmed strict ISO text ([V30 §35](specifications/accepted-syntaxes-v30.md#35-date-time-durations-and-timestamps)), a local time that the player's zone skips is valid, and anything else is rejected with "That is wrong. I asked for a date." (a time, a date and time). The result is the `date`, `time`, or `datetime` value; the transcript shows it in the presentation in force at completion, as `say` would, and a default answer prefills its ISO text;
- `choose` returns the value of the selected button: a value written before `:` (an identifier is a `string`, a
  numeric literal a number), a choice object's `value` (or its `text` when it has none), or otherwise the option
  itself with its own type, which may be text, a number, a boolean, `null`, or a duration;
- `showButton` used as a value returns the scene time since the button appeared as a `duration`; used as a statement
  it has no result. Its optional timeout, converted to milliseconds when the button appears, must be finite and
  positive with a representable deadline at `appeared + timeout`; otherwise the instruction fails with `TSR050` before
  the button appears. Reaching the deadline is a time settlement, below: the settlement kind is `timedOut`, it
  publishes `actionCompleted` without a `playerTranscript` event, and its result is exactly the timeout. A click that
  arrives later returns `alreadySettled` with that settlement.

A rendered choice control supplies the position of its button (`{ kind: "selectedOption", optionIndex }`), because several buttons may return the same value. The engine derives the returned value and the canonical transcript text from the active action. A rendered control never supplies a replacement canonical transcript string.

The current runtime keeps three independent interaction resource axes: completion/result/transcript string bytes,
aggregate UTF-8 bytes for one retained interaction definition, and option count. Authored/materialized UI fields have no
independent per-field byte ceiling; each preflights against the remaining definition aggregate. Exact numeric values and
their provisional Owner POC reassessment route live in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md); they are not accepted
capacity or source targets. Bounded validation rejects impossible UTF-16 lengths before encoding and encodes no further
field once the applicable byte budget fails, so encoding work stays bounded by the byte budget rather than by the total
string size. A choice value that is text other than its button text counts toward the definition aggregate as well. The
text-completion limit applies to the raw host string before CRLF/CR-to-LF normalization, which cannot increase its
UTF-8 size. Over-limit data is rejected without truncation, clamping, or partial state mutation.

Whitespace-only text rejection uses `ecmascript-whitespace-v1`: the ECMAScript `WhiteSpace` and `LineTerminator` classification represented by the engine's Unicode-aware regular expression. The grammar of an identifier choice value is the current ASCII TeaseScript identifier form. Choice completion matching uses one linear option pass.

Successful completion emits the canonical `playerTranscript` event first and `actionCompleted` second. Both receive
monotonic sequences, and the bounded settlement retains both sequences, the canonical result, transcript text,
destination temporary, owning call-frame identity, and the UI the player answered, for duplicate replay. The separate
single-use handoff, not that settlement, is the persisted authority for the still-unconsumed destination. A pending
action's prepared dynamic UI is checked against its preparation temporaries; for `choose`, the captured option values are
expanded again and must give the same buttons. A retained settlement is checked against
its recorded UI and the plan instead, because cleanup clears those temporaries and a later run of the same instruction
prepares them anew; for `choose` options that all have written values, the buttons must return those values in
written order. Snapshot validation does not authenticate the historical dynamic-UI evaluation itself: a recorded
UI and transcript edited together consistently are accepted, in line with the general snapshot-history rule below. Delay creation preflights its request plus future completion sequence; interaction creation preflights its
request plus future transcript and completion sequences. Interaction completion rechecks both required sequences and
validates the complete destination mutation before publishing any write, handoff, settlement, event, or continuation
change. Continuation execution remains eligible only through a later normal runtime entry.

### Standard composer and dynamic choice presentation

The Standard Player application uses one fixed composer. During a foreground interaction it remains enabled, becomes the answer field, and receives focus by default. Choice and button controls appear immediately above it. Only a completion valid for the active deterministic interaction advances that interaction; non-matching composer text leaves the same mandatory action active. Future LLM clarification or interpretation is outside this first POC.

Choice buttons may occupy one or two rows. The Player application may render the same choice group as a dropdown when
viewport, text, font, zoom, accessibility, or other layout constraints make buttons impractical. Button-versus-dropdown
presentation is not canonical runtime/checkpoint state and does not change values, visible text, completion validation,
transcript output, or return values. Exact unambiguous visible option text may activate `choose`. The one-option
`showButton` completes through its rendered control or composer submission of its exact, non-empty visible label;
other text and Space with the empty focused composer do not activate it.

Field hints, control labels, requesting-speaker metadata, localized validation feedback, and accessibility labels are not duplicate speaker transcript messages.

### Minimal first-POC provenance

The first POC uses one Standard chat target but retains an explicit validated target identity in output and interaction data. `speakerId` is optional: a declared/current/default speaker uses its stable ID, while narrator/system output has no invented speaker.

A broader involved-speaker collection and separate conversation identity remain deferred.

### Smart-autoplay session settings

A fresh session captures:

```text
baseDelayMs
delayPerWordMs
delayPerCharacterMs
```

Each value is a non-negative JavaScript safe integer representing whole milliseconds. Missing values use platform defaults; a present invalid, fractional, negative, non-finite, or unsafe value causes a structured session-configuration error rather than silent clamping or fallback.

Platform defaults are:

```text
baseDelayMs = 1500
delayPerWordMs = 300
delayPerCharacterMs = 30
```

The smart delay is:

```text
delayMs =
    baseDelayMs +
    max(
        wordCount * delayPerWordMs,
        visibleCharacterCount * delayPerCharacterMs
    )
```

The measured value is the visible text from the final message-markup representation after expression evaluation,
interpolation, string escaping, deterministic list selection, list, set, and object notation, block-string newline
normalization/dedent, and one shared message-markup parse. Formatting delimiters and block markers do not count. Words are maximal non-whitespace sequences;
visible characters are Unicode code points. The authored markup grammar and flattening rules are defined in
[`specifications/message-markup.md`](specifications/message-markup.md).

All counts, multiplication, addition, and deadline construction use checked arithmetic. A non-finite, unsafe, unsupported-magnitude, or overflowing result fails before an action ID or partial gate is created. There is no additional product reading-time cap, but ADR 0016 numeric-magnitude and deadline-overflow limits still apply.

The captured settings are deterministic session data. Account changes do not alter an active or restored session. A calculated delay of `0` creates no pacing action or action events.

### Pacing gate as an ADR 0016 action

A positive pacing gate is one pending-action kind conceptually named `chatPacingGate`. It uses ADR 0016 action identity, absolute deadline, active-first lookup, typed completion, bounded `lastSettlement`, event sequencing, checkpoint/restore, and continuation rules. It is not a second hidden pacing state machine.

The first POC has at most one active pacing gate because it has one Standard chat target.

#### Initial message and background gate

A normal or positive-duration `say` evaluates speaker, authored text, pacing, skip policy, and deterministic text
selection once in source order. It then parses the final authored string once into structured message content and its
canonical visible text. The emitted `say` event carries both representations.

When no earlier gate blocks it, one atomic instruction boundary:

1. emits the text-output event;
2. stores a positive `chatPacingGate` in `backgroundActions` with a new action ID, absolute deadline, and skip policy;
3. emits `actionRequested` for that gate;
4. continues unrelated non-blocking execution.

The text-output event precedes `actionRequested`. No checkpoint may contain the emitted text without the positive gate established by the same instruction.

#### A later `say` becomes foreground-blocked

When execution reaches a later normal or positive-duration `say` while the background gate remains active:

1. evaluate and store the later prepared output once, including speaker, structured message content, canonical visible
   text, pacing, skip policy, and RNG results;
2. atomically move the same gate from `backgroundActions` to `foregroundAction` without changing its action ID or deadline;
3. attach the prepared-output continuation;
4. set status to `waiting` and stop normal execution.

The move emits no second `actionRequested`. The accepted invariant remains:

```text
status == waiting
if and only if
foregroundAction != null
```

Settlement emits `actionCompleted` before continuation. A later normal runtime entry emits the prepared text exactly once and creates its next positive gate when applicable. Prepared text and RNG results are not reevaluated after waiting or restore.

These two `say` transitions are one immediately reachable runtime behavior for ordinary multi-message source. A
runtime that creates a positive background gate must also implement the accepted later-`say` promotion/prepared-output
path; no supported intermediate behavior may ignore, auto-settle, or reschedule that later `say` under temporary
semantics.

#### Time and player completion

`observeTime(...)` may settle a due pacing gate while it is background work or the foreground action blocking prepared output. It uses the persisted `currentSessionTimeMs` and absolute-deadline semantics shared with `wait`.

When one time observation settles multiple timed actions, deterministic ordering is:

1. ascending `deadlineMs`;
2. ascending action ID for equal deadlines.

Each settlement emits its own sequenced `actionCompleted`. Continuations do not execute inside the observation mutation.

A primary click, touch activation, or eligible Space key submits a typed completion for the active pacing-gate action ID:

- a skippable gate settles normally;
- an unskippable gate rejects the attempt without state mutation;
- active foreground/background lookup occurs before settled, stale, or unknown classification;
- a duplicate matching current `lastSettlement` returns `alreadySettled` without another event, output, RNG change, or continuation;
- a foreground skip makes prepared output eligible only for a later runtime entry.

Skip settles only the pacing gate. It does not skip arbitrary instructions, complete `wait`, cancel an interaction,
or create a player transcript message. The playground Player routes primary pointer/touch input and eligible composer
Space through this engine completion path. Interactive controls consume their own activation first and therefore cannot
also trigger pacing skip.

#### Consumption by a foreground interaction

When `showButton`, `askText`, `askNumber`, or `choose` is reached while a pacing gate remains active as background work, one atomic transition:

1. settles the pacing gate with typed settlement `consumedByForegroundInteraction`;
2. removes it from `backgroundActions` and updates bounded `lastSettlement`;
3. emits `actionCompleted` for the gate;
4. creates the new interaction as the sole `foregroundAction`;
5. sets status to `waiting`;
6. emits `actionRequested` for the interaction.

Event order is:

```text
actionCompleted(chatPacingGate)
actionRequested(interaction)
```

No checkpoint may expose an intermediate state with neither the old gate nor the new interaction.

#### `instant`, `0`, and `wait`

When `say ..., 0` or `say ..., instant` executes while a pacing gate remains active as background work, one atomic transition settles the old gate with `supersededByInstantOutput`, emits `actionCompleted`, emits the current text-output event, and creates no new gate.

If a gate is already the foreground action blocking prepared output, ordinary execution cannot reach another `say`; time or a permitted player completion must settle that foreground gate first.

`wait` does not consume a pacing gate. A valid future snapshot may contain:

```text
foregroundAction: delay
backgroundActions: [chatPacingGate]
status: waiting
```

A time observation may settle either or both according to deadline and action-ID ordering. The continuation after the foreground delay runs only during a later runtime entry.

For:

```tease
say as mistress "One"
wait 1
say as mistress "Two"
```

the actual separation is the longer of the remaining `say` gate and the explicit one-second wait. The durations are not automatically added.

#### Media pacing barrier

Main-story media presentation waits for the previous message like a following `say`. The compiler emits a
`pacingBarrier` instruction before `showImage`, `hideImage`, `playAudio`, and `playVideo`, and before a statement-level
media handle operation (`h.pause()`, `h.resume()`, `h.stop()`, or an assignment to `h.position`, `h.remaining`, or
`h.volume`). The receiver is evaluated once, before the barrier, and the operation uses that value; the barrier waits
only when it is a media handle. When a background
pacing gate is active, the barrier moves that gate, with its identity, deadline, and skip policy unchanged, into the
foreground without prepared output and keeps `nextInstruction` at the barrier. Time or skip settlement leaves
`nextInstruction` there, so the barrier runs again during a later runtime entry and then advances; the media statement
evaluates its operands only after the wait. The settlement records `releasedPreparedOutputInstruction: null` and opens
no prepared-output commit window, so queued interrupt blocks may run first. While a timer expiry block or media cue
block, or a function it calls, runs, barriers never wait. `wait` and `timer` keep overlapping pacing.

Player-authored messages do not create gates. No compiler lookahead across branches, calls, or loops is used.

Message presentation follows the accepted [speaker inheritance and override contract](specifications/accepted-syntaxes-v30.md#message-presentation-defaults-and-overrides).
The runtime resolves mode/style into `MessagePresentation` while preparing output, preserves that data through pacing
promotion and checkpoints, and emits it with the canonical `say` event. The Player adapter forwards these values; the
Player renders them under the observable contract in [Player UI](ui/PLAYER-UI.md). Invalid colour values fall
back without a new warning policy; general diagnostic/recovery design is tracked separately in #427.

### Skippable gate completion

Effective skip policy comes from explicit `skippable`/`unskippable`, then the effective speaker's `defaultSaySkippable`, then platform default `true`.

A skippable gate may complete through:

- a primary click or tap on Player background or other unused Player space;
- Space while the focused Standard composer is empty.

A real interactive control has priority and must not also trigger viewport-wide gate completion. Ordinary keys type into the focused composer. Space is normal input when text is already present and does not skip during text composition, a relevant selection, or focus on another interactive control. Unskippable gates reject click, tap, and Space completion.

### Player and developer controls

The normal Player application has no player-facing pause control and ADR 0018 adds no author-facing pause command. Developer mode may expose Pause alongside Run, Step, checkpoint, restore, and debugger controls. Developer pause is tooling and does not establish player-initiated pause semantics.

Visibility changes are not a Player pause, and a closed Player's absence does not consume scene time; see
[Timers and scene time](#timers-and-scene-time).

### Checkpoint and event requirements

Implementation must preserve ADR 0015 and ADR 0016:

- plans, prepared output, pending interaction data, captured pacing settings, deadlines, and skip policy are JSON-safe;
- source expressions and deterministic RNG choices are not reevaluated after waiting or restore;
- restore reads no clock and silently completes nothing;
- the Player application submits explicit time observations and typed completions;
- action/output events remain typed and sequenced;
- duplicate delivery is idempotent through bounded settlement replay;
- settlement and continuation remain separate inspectable runtime boundaries;
- every required plan, snapshot, and checkpoint schema change is explicitly versioned before implementation merge.

The selected behavior is fully lowered into the instruction plan. No package or library identity lookup is added to plan/checkpoint data, restore does not select an implicit latest implementation, and no migration is included.

## Current runtime

The implementation includes:

- semantic validation and compiled instruction plans;
- explicit runtime snapshots and self-contained checkpoints;
- deterministic `xorshift32-v1` state for the playground;
- typed sequenced events;
- instruction and event-boundary stepping with instruction budgets;
- explicit loop frames for ranges and loops;
- explicit function definitions, parameter prologues, calls, serializable call frames, returns, and recursion;
- labels, `goto`, `call`, `end`, and `fallback` within and across files, under [Files and
  activations](#files-and-activations): a `goto` leaves every function, block, loop, and interrupt frame of its
  activation, abandons an interrupted action, and continues at a label or a file's entry; a top-level `let` that runs
  again sets its existing variable. Plan validation accepts a label only where the code that follows needs no open
  block, active loop, or temporary from before it;
- explicit endings: the compiler closes each file's root region with an `end`, so a session halts only through `exit`;
  `end` without a calling file or a fallback fails with `TSR066`;
- checkpoint restore inside loops, calls, defaults, and across RNG/event boundaries;
- source-order-preserving temporaries and checkpoint-safe prepared references;
- full suspended-caller live-temporary validation;
- defensive validation of function regions, parameter progress, call stacks, and prepared-reference state;
- standalone playground and constrained development server.

The current internal instruction-plan, runtime-snapshot, and checkpoint format revisions are listed under [Format evolution](#format-evolution). They are POC formats rather than permanent public wire-format guarantees.

The current runtime implements blocking `wait`/`timer`, asynchronous timers, compact foreground interactions,
ADR 0018 `say` pacing, and the Stage image and audio/video playback state. Timer lifecycle, interrupts, and Player
clock recovery are defined under [Timers and scene time](#timers-and-scene-time); media under
[Stage image and media playback](#stage-image-and-media-playback); script storage under
[Script storage](#script-storage).

Runtime state retains persisted scene time, at most one active foreground action, background timers and media and at
most one pacing gate, the Stage image, monotonic identities, bounded settlement replay, prepared output, and explicit
time/completion operations. The Player reconstructs presentation from canonical state. Production cross-origin host wiring,
server time integrity, and server persistence remain deferred.

## Owner-resolved future runtime semantics

These owner decisions are independent of final Player visual tuning but are not implemented capability or accepted
author-facing syntax. Exact schemas and APIs remain future work.

### Long-lived Standard controls

The later long-lived Standard control family uses these runtime semantics independently of final Player presentation:

- a stateful toggle/select owns one authoritative serializable control value; script polling and programmatic updates
  use that same value rather than an automatically synchronized second ordinary variable;
- an accepted user value change commits before an optional handler runs, and a handler failure is an ordinary runtime
  error rather than a rollback of the committed value;
- status/progress items are non-interactive output state that may be updated or removed;
- control handlers run one at a time at deterministic runtime boundaries and may use ordinary blocking TeaseScript
  behavior; the interrupted script path does not execute in parallel, while existing audio/video continues unless the
  handler explicitly changes it;
- queued control events are revalidated before execution; an event from a removed, disabled/inert, or otherwise
  invalidated originating control is stale and is discarded rather than executed; and
- canonical event/history provenance distinguishes user control actions from programmatic control updates. Visible
  transcript/history presentation is Player-owned.

Controls persist until explicit removal or owning-lifecycle cleanup. Exact action/schema representation, persistence
binding, Standard Library API names, author syntax, and Player busy/history presentation remain open or owned elsewhere.
This section does not supersede accepted V30 permanent-button syntax or presentation semantics; any conflict with that
accepted language baseline requires an accepted syntax/ADR update.

## Accepted resumable pending-action model

ADR 0016 accepts this conceptual snapshot state:

```text
status:
    ready | running | waiting | halted | failed

currentSessionTimeMs:
    finite non-negative number

foregroundAction:
    PendingAction | null

backgroundActions:
    PendingAction[]

nextActionId:
    positive safe integer

lastSettlement:
    ActionSettlement | null
```

A valid current `waiting` snapshot contains exactly one active foreground delay, interaction, `chatPacingGate`,
`mediaPlayback`, or `storageWrite` wait. Non-waiting states contain no active foreground action. `backgroundActions` may contain timer
and media actions and at most one pacing gate. A background pacing gate may coexist with a foreground delay or storage write; it is consumed before a foreground
interaction and cannot coexist with a foreground pacing gate.

The shared timer and media interrupt state may retain one inert suspended foreground delay, interaction, or media
wait. Its ownership, settlement, and restore rules are defined under [Timers and scene time](#timers-and-scene-time)
and [Stage image and media playback](#stage-image-and-media-playback).

Blocking `wait` and `timer` use the foreground-delay path. `wait` is hidden; `timer` carries `visible`, `mystery`, or
`hidden` display and an evaluated label. Durations follow specification
[§27](specifications/accepted-syntaxes-v30.md#27-timers). A whole-second range is drawn once when the delay starts and
restore preserves the draw.

Delay timing is validated on the persisted scene coordinate. Due and suspended delays follow the ordering and
interrupt rules under [Timers and scene time](#timers-and-scene-time). Players present visible and mystery delays.

An interaction retains its kind, ownership depths, call-frame identity,
destination/result domain, Standard chat target, optional requesting speaker ID, validated UI payload, and request
sequence. A waiting result destination must still be absent. Successful interaction completion commits the canonical
typed value directly into that destination and leaves the snapshot at the local compiler-defined continuation. Snapshot
validation uses the independent single-use `interactionResultHandoff` as the canonical result authority while
execution remains at the immediate commit or one-instruction transfer boundary, even if `lastSettlement` has already
been replaced; after the first canonical consume, transfer, return, discard, or exit succeeds, the record is removed,
and the value becomes ordinary runtime state without an interaction-specific lifecycle. Every persisted interaction
instruction, UI/accessibility/option shape, action, settlement, and snapshot field has an exact supported shape.

`currentSessionTimeMs` is canonical runtime state. It preserves the nondecreasing session coordinate across checkpoint and restore. A fresh snapshot receives a validated initial coordinate; deterministic tests may use `0`.

A blocking instruction evaluates its arguments, stores a complete JSON-safe action and continuation, advances to
`waiting`, emits `actionRequested`, and stops. A validated replayable completion stores its result and bounded
`lastSettlement`, removes the matching action, emits `actionCompleted`, and leaves continuation or handler execution to
the next runtime entry. Timer lifecycle transitions and suspended-delay settlements emit completion events without
replacing `lastSettlement`; see [Timers and scene time](#timers-and-scene-time).

`wait 0` is deliberately immediate: its duration expression is still evaluated, but it allocates no action ID, creates no pending action or settlement, and emits neither action event. The next source instruction runs normally. A positive wait settles with `actionCompleted`, and the following runtime entry continues at the next instruction. Re-entering an already halted snapshot emits no further event.

A duplicate delivery matching `lastSettlement` returns the same immutable canonical recorded settlement without another
write, event, RNG advance, handler, or continuation. `lastSettlement` is bounded replay/idempotency data only: it does
not own an expression temporary, prevent destination reuse, or block a later action. A newer replayable settlement may
replace it after the interaction result has already been atomically committed; the ordinary runtime value remains valid
independently. Each delay settlement retains owning and continuation instruction positions.

Completion lookup checks active foreground/background actions and suspended foreground identity before settlement
replay or stale/unknown classification. A completion targeting an interrupted action returns `suspendedAction`
without mutation. Otherwise, an inactive ID matching `lastSettlement` is `alreadySettled`, an issued inactive ID is
`staleAction`, and an unissued ID is `unknownAction`.

Running countdown actions store an absolute deadline on the scene-time coordinate; paused timers retain remaining
round time instead. Media playback uses progress observations instead; see
[Stage image and media playback](#stage-image-and-media-playback). The runtime does not read browser or operating-system clocks directly. The player maps monotonic elapsed
deltas onto the session coordinate, schedules wake-ups, and submits validated observations; tests use a fake clock and
never sleep in real time.

A snapshot carries two coordinates: `observedSessionTimeMs`, the latest observed time, and `currentSessionTimeMs`, the
scene time at which execution stands. A time observation updates the snapshot atomically:

```text
snapshot.observedSessionTimeMs = max(snapshot.observedSessionTimeMs, suppliedNow)
unless the session has failed:
  settle due work in (scene time, phase, action ID) order, advancing currentSessionTimeMs toward observedSessionTimeMs
```

Scene time stands behind the observed time only while the script, a timer expiry block, or a media cue
block can execute; once execution
waits or ends, catch-up continues and both coordinates are equal again. A failed session is terminal: later
observations record the observed time but settle nothing and leave scene time unchanged. Catch-up is defined under
[Timers and scene time](#timers-and-scene-time). No checkpoint may contain due-action processing performed against a
newer time than its `currentSessionTimeMs`; a checkpoint taken while catch-up is held keeps both coordinates and the
pending work.

Blocking `wait` and `timer`, foreground interactions, pacing gates, and asynchronous timers share ADR 0016 action,
identity, observation, event, and checkpoint infrastructure. Their timer-specific composition is defined below.

## Files and activations

ADR 0022 and V30 §29 define transfers between files. Each entry into a file is an activation with its own top-level
variables in a root scope; the root names its file (`file`) and where the activation started (`entry`: the file's entry
or one of its labels, which a `goto` to a label keeps), and every other scope has `file: null` and `entry: null`. The
base activation's root is `frames[0]`.

- `call` pushes a file call frame (`kind: "file"`) onto the one ordered call stack, with the caller's temporaries, its
  scope and loop depths, and the position after the `call`; the called activation's root is the scope at its
  `scopeBaseDepth`. `end` ends the innermost activation, also from one of its functions or blocks, and returns there.
  Without a file call, `end` continues at the snapshot's `fallback` (a file and its entry or label, or `null`) as a
  fresh activation, or fails with `TSR066`.
- A `goto` naming a file, `call` of a label, and the fallback replace or add an activation with a fresh root; a `goto`
  to a label keeps the activation it runs in. A glob destination (`{ pick: [...] }`) draws one of its files from the
  session random generator each time it runs, a glob fallback each time it is used. A goto leaves the functions, blocks, loops, and temporaries above its
  activation's root; when that activation is lower on the stack, the file calls above it go too.
- A computed destination (`{ value }`) evaluates to a script reference (`{ kind: "script", path, label }`, `label`
  `null` for the file's top) each time it runs, and is resolved by path and label against the plan's files. A value
  that is not a reference fails with `TSR058`; a missing file or label, or a `goto` or fallback to a file whose root
  region holds nothing after its entry but its closing `end`, fails with `TSR069`. A computed `fallback` stores the resolved file and target.
- Reading or assigning a top-level variable of the file whose `let` has not run in the activation fails with `TSR070`,
  which names the label at the root's `entry` unless the activation started at the file's entry.
- A function frame (`kind: "function"`) records `rootScopeId`, the root of the activation it runs for: its caller's,
  or for an expiry, cue, or finish block the one that started the timer or media. Timers record that root as
  `rootScopeId`, media with blocks as `handlerRootScopeId`, and queued blocks as `rootScopeId`. A root that leaves the
  stack stays in `retainedScopes` while such a block can still run, and is dropped at the next transfer after that; a
  `goto` from such a block brings its activation back in place of the innermost one.
- A transfer that leaves an activation removes its non-persistent timers, as [Timers and scene
  time](#timers-and-scene-time) describes; `exit` also clears activations, retained roots, and the fallback.

Restore validation checks that roots stand exactly at the bottom and above each file call, that a file's entry is the
start of its root region, that each file call returns after a `call`, that each loop belongs to the call context that
runs it (so a recursive call runs its own instance of a loop) and is active exactly where that context stands in its
body, that each function frame, and each timer, media, and queued block with a block to run, names an
existing activation root of that function's or block's file, that every position lies in the region of the code
running there, that each root's `entry` is its file's entry or one of its labels, and that the fallback is the
destination of one of the plan's `fallback` statements or, when the plan has a computed `fallback`, a label of a file
or the entry of a file that runs something. Script references elsewhere in the state are checked for their shape only.

## Timers and scene time

Timers and `wait` measure Player-executed scene time on the persisted session coordinate. The engine never reads a
clock. A live Player maps a monotonic clock onto the session coordinate and submits explicit observations at the
next deadline, before input continues the script, when the page's visibility changes, and on `pagehide`. Callbacks
are only observation opportunities, so a throttled background callback catches up rather than losing elapsed time,
and visibility changes never pause time. When restored execution resumes, the Player rebases its clock on the saved
`observedSessionTimeMs`: new observations are `savedObservedSessionTimeMs + monotonicDeltaSinceResume`, while held
catch-up continues from the saved `currentSessionTimeMs`. After a page reload, the explicit Continue of
[Session start and user activation](ui/PLAYER-UI.md#session-start-and-user-activation) precedes that resumption, so
waiting for Continue does not consume scene or playback time. The gap while no Player ran, including a device handoff,
therefore does not consume timer time; a timer continues with its saved remaining time. Extreme platform suspension without any lifecycle opportunity is not covered. Absolute
wall-clock deadlines belong to future scheduled events, not to timers.
Presentation refresh cadence does not impose a minimum timer duration.

A blocking `timer` is a foreground `delay` like `wait`, with its presentation (`visible`, `mystery`, or `hidden`) and
evaluated label. An asynchronous timer is a background action of kind `timer`: it allocates an action ID and emits
`actionRequested` when started and `actionCompleted` when it finishes naturally or through `stop()`; script-end and
`exit` cleanup stop remaining timers without individual completion events. No Player completion can target
it, so its settlement is not retained as `lastSettlement`. The action holds the timer record: state, presentation,
label, repeat configuration, current-round length, and either its deadline (running) or remaining time (paused), plus
accumulated elapsed time. A finished or stopped record moves to `settledTimers` so its opaque handle
(`{ kind: "timerHandle", timerId }`) stays readable; `nextTimerId` allocates handle IDs.

`observeTime` processes due work globally by `(scene time, phase, action ID)`: foreground and suspended delays, pacing
gates, the timeout of the presented button, timer rounds, and media timeline events (see [Stage image and media playback](#stage-image-and-media-playback)).
A round that expires naturally ends at its deadline and a repeating timer starts its next round there, drawing a
repeating range from the session RNG; `remaining` reaching zero ends the round at the current scene time, as does
pausing a round that is already due while its expiry waits behind a running block. An expired round with an expiry block
is queued in `pendingTimerHandlers` in due order; consecutive expiries of one timer share an entry with a count. A
fixed-length repeating timer computes each round's deadline from an anchor as
`anchor + (anchoredRounds + 1) * repeatDuration` instead of accumulating it, so every observation schedule yields the
same deadlines. Silent rounds of a handler-free timer settle as if each expired on time; the current implementation
skips them arithmetically up to the next other due work instead of expiring them one by one. Rounds shorter than the
deadline's numeric resolution may end at the same time; an anchored timer finishes only when its round index is
exhausted or its next deadline leaves the session range. A script change to the current round (`pause`, `resume`,
`remaining`, or `repeatDuration`) starts a new anchor at the next full round. Observations after a runtime failure
record the observed time but settle no further work.

An observation records `observedSessionTimeMs`; `currentSessionTimeMs` is the scene time at which execution stands.
Due work settles one deadline at a time, advancing scene time to each. Whenever the script or an expiry block can
execute, catch-up pauses with scene time at the moment that work became due: the script continues after a `wait` or
pacing gate at its deadline, a block starts at its expiry's deadline, and catch-up continues toward the observed time
once execution waits or ends. Every delay, pacing-gate, timer, and media settlement records the scene time at which it
happened: a time-driven settlement records its deadline, and a pacing gate that is skipped, consumed, or superseded
records the current scene time. A
late observation therefore gives the same output, events, and snapshot as observing every deadline on time: a block
can `stop()` a later timer before it expires, and a timer it starts orders by its own deadline.

Time reaches waits and timers only through `observeTime`; a Player cannot complete them. Host input (an interaction
answer or a pacing skip) happens at the observed time, so `completeAction` returns `executionPending` without changing
anything while scene time is behind the observed time or a due expiry block can run. A storage write acknowledgement
is the exception: it is accepted at the current scene time (see [Script storage](#script-storage)). The Player then runs the engine
and retries with the same action ID; if a block ended or replaced that action, the retry reports it as no longer
active. A failed session accepts no host input: such a request is `invalidPayload`, and Players schedule no further
observation for it.

Expiry blocks compile to parameterless handler regions. A runtime entry starts the first queued block before
executing the next instruction, including from `waiting`, unless a block is already running, a single-instruction
commit window is open (released prepared `say` output, an interaction result handoff, or a settled terminal action),
or a foreground pacing gate holds the chat. The block runs in an interrupt call frame that saves the interrupted
position, temporaries, scope and loop depth, and the interrupted foreground delay or interaction. The interrupt
frame may exceed `maxCallDepth` by one because it is not an author call. Expiry blocks run within the normal per-entry
instruction budget, so extreme catch-up of handler-bearing rounds can exhaust it.

The suspended foreground action is inert: a completion for it returns `suspendedAction` without mutation. A suspended
delay settles in due-work order and publishes `actionCompleted`, without replacing `lastSettlement`; its continuation
runs once when the block returns. A suspended button's timeout does not settle while the block runs; when the block
returns after the deadline, the restored button times out at once, at the current scene time, with the timeout as its
result. A normal return restores the interrupted action with its original identity;
returning to an interaction first consumes a pacing gate created by the block. `stop()` on an active timer cancels its
unstarted queued blocks; on a finished or stopped timer it is a silent no-op. `exit` inside a block halts the session
and discards the interrupted action. A `goto` inside a block, or in a function it calls, also discards the interrupted
action, without a settlement, and continues at its label. `exit` stops every timer and drops queued blocks. A timer
records the root of the activation that started it (`rootScopeId`); a transfer that leaves an activation (a `goto` from
it, its `end`, or a block's `goto` that abandons it) stops that activation's non-persistent timers, with a `stopped`
settlement each, and drops their queued blocks. A `call` stops nothing; persistent timers and their queued blocks
stay. A failed session clears its foreground action.

Restore validation requires every issued timer ID to have exactly one active or settled record, handles to refer
to issued IDs, queued blocks to belong to their timer, at most one interrupt frame, and suspended actions to be
consistent with the interrupted context.

## Stage image and media playback

Author-facing behavior is defined in specification
[§22](specifications/accepted-syntaxes-v30.md#22-stage-image-audio-and-video). This section defines the runtime
contract that Players and hosts rely on.

**State.** `stageImage` holds the persistent Stage image reference or `null`. Each play creates a background `media`
action (ADR 0016 identity, request event, creation time) holding a media record; the script-visible handle
`{ kind: "mediaHandle", mediaId }` refers to that record. Finished and stopped records move to `settledMedia` so
handles stay readable; `nextMediaId` issues IDs. A media settlement publishes `actionCompleted` and, like a timer
settlement, is not retained as `lastSettlement`. At most one video is active; a new video, `showImage`, or `hideImage`
stops it.

**Waiting and load.** A play first waits in a foreground `mediaPlayback` action: an async play until the Player's load
report, a blocking play until the media finishes, stops, or fails. The wait settles through runtime work, never
through `completeAction`; its settlement is retained like a delay's, it may be a terminal action, and an interrupt
block may suspend it. A `null` file plays nothing and creates no wait. The Player reports the initial load result of
each active unloaded media with `reportMediaLoad(plan, snapshot, mediaId, report)`: `{ kind: "loaded", durationMs }`
records the source duration and starts the first playback segment when the effective range is non-empty; an empty
range reports `TSW013` and stops without cues or `finish`, keeping the duration readable. `{ kind: "failed",
message? }` reports `TSW013`, stops the media without cues or `finish`, and releases any wait; its handle reads `null`
for `duration` and `remaining`. Like host input, a load result applies at the observed time: while scene time is
behind it or a due block can run, the report is `executionPending` without changing anything, and the Player runs the
engine and retries. Reports for loaded or settled media are `ignored`, unissued IDs are `unknownMedia`, and malformed
input is `invalidReport`. The runtime defines no load timeout and no post-load playback failure; a Player
that gives up before loading reports `failed`.

**Progress observations.** Playback progress enters only through validated observations:
`observeTime(plan, snapshot, nowMs, [{ mediaId, segment, progressMs }])`, where `progressMs` is the active playback
time of the current segment, excluding stalls and pauses. Each accepted report becomes a sample `(nowMs, progressMs)`;
samples must increase in time and must not decrease in progress, and reports for another segment or unknown, settled,
or unloaded media are ignored, as are reports with non-increasing times or decreasing progress; a malformed report
batch rejects the whole observation as `invalidObservation`. A running media without a report in an observation has
made no known progress, so
Players report every running media on every observation. The engine interpolates only between reported samples and
never extrapolates past the latest one: a gap between reports usually means buffering, a throttled or suspended
background tab, or blocked playback, so assumed progress could fire cues for content that never played, and a
committed cue cannot be withdrawn. A late report instead places each crossing at its canonical scene time, so waiting
costs only latency. A Player may extrapolate for display, such as a progress bar, but reports only measured progress. Every canonical timeline change starts a new segment
anchored at `(scene time, 0)`: load, pause, resume from pause, seek, stop, and Stage replacement; lifecycle no-ops and
volume changes do not. A Player acknowledges a new segment by reporting progress `0` when it applies it.

**Timeline events.** The engine owns passes, repeat limits, cue order, and settlement. Between samples, progress is
interpolated linearly using the exact values of the reported samples. Nonzero-progress arrivals are due at their exact
crossing rounded up to a whole millisecond, so an observation at that time has always reported them; progress zero is
reached at the segment anchor's exact time. When playback proceeds beyond a sampled position, its departure uses the
exact time of the last equal-progress sample (the right edge of a stall); otherwise it uses the rounded-up crossing.
Progress read at a scene time rounds to the nearest whole millisecond, with halves up, including at sample points; an
arrival due by that time is reached exactly. The next event is
either an arrival — the next cue point, the end of the pass, or the end of a repeat duration — due when reported
progress reaches it, or a departure — the cues at a start position after load, seek, or a pass wrap — due when
playback proceeds from that position (the right edge of a stall there). `processDueWork` orders media events with
delays, pacing gates, and timers by `(scene time, phase, action ID)`, where departures have phase 1 and all other work
phase 0, and commits one event per step, so queued cue blocks hold catch-up exactly like timer expiry blocks. Pass
ends of repeating media without cues in their active range produce nothing observable; like silent timer rounds, they
settle as if each was committed on time, and the implementation skips them arithmetically up to the next other due
work. An
arrival queues every cue exactly at its point in source order and, at the end of the range, completes the pass
atomically: the next pass restarts at `startAt` with its start cues pending, or the media finishes and queues `finish`.
A repeat duration that ends mid-pass queues the cues reached there, then finishes. Every event's segment progress is
calculated from the segment's anchor — its start position, completed passes, and total playback — rather than
accumulated, so the same events produce the same values however the Player's samples are spaced, and the final arrival
equals `terminalProgressMs` exactly, also for fractional ranges. Finished media keep only the sample at their finish.
As for timers, catch-up pauses whenever the script or a cue block can execute, so both behave as if every sample had
arrived on time, and every media settlement records the scene time at which it happened.

**Script operations.** Handle reads use the progress interpolated at current scene time, capped at the next
uncommitted arrival. Before `pause()`, `resume()`, `stop()`, a seek, or a Stage replacement changes a segment, the
media's events due strictly before current scene time are committed; events due exactly now keep their global
catch-up order. While paused, an already-reached arrival at a range end or repeat-duration limit still commits and can
wrap or finish; other uncommitted cues at the pause position wait until playback proceeds. After a seek, a pass that
the seek completed is committed at once, also while paused, where the next pass stays paused. `stop()` and replacement
drop the media's queued, not yet started cue blocks. Author-visible seek,
lifecycle, cue, and handle behavior is defined in specification §22.

**Cue blocks.** Cue, compact, and `finish` blocks compile to parameterless handler regions (`handler: "media"`),
optionally with a self-handle name bound on entry to the media's handle. Their invocations share the timer expiry
queue and interrupt machinery above; interrupt frames record `mediaId` instead of `timerId`.

**Cleanup and restore.** `exit` stops all media without events and drops queued blocks; the Stage image stays. A `goto`
leaves media and their queued cue blocks running. Checkpoints carry the complete media state, including unprocessed samples, and restore does not advance or
rewrite it. Restore validation requires issued media IDs to have exactly one active or settled record, handles to refer
to issued IDs, queued and running cue blocks to belong to their media's own blocks, at most one active video,
waits to refer to their active media, each media's total playback to agree with its segment anchor, whose first
sample does not lie after current scene time, and each committed cursor to be one the runtime produces: at the origin
of a pass, where pending start cues wait, or exactly the arrival that the runtime's own next-arrival step commits from
the preceding arrival point. For media that have played only since loading, start cues and queued cue invocations must
also agree with that playback: a start cue is pending until reported playback moves past it, and a cue cannot be
queued more often than playback reached it. Later segments follow controls whose history is not retained, and
distinct cue points whose segment progress is identical in double precision, which needs extreme source ranges,
cannot be told apart. Cross-device handoff is not part of this contract.

**Player projection.** `mediaPlaybackProjection(snapshot)` exposes each active media's identity, source, `loaded`,
state, `segment`, active range, `volume`, `playheadMs` (the source position that the reported progress reaches),
`reportedProgressMs`, and `terminalProgressMs` (segment progress at which playback ends; `null` before loading or when
repeating indefinitely); `stageProjection(snapshot)` gives the Stage image and active video. The Player reports the load
result of unloaded media and keeps paused media silent. For running media, on a new segment it repositions to
`playheadMs` (rewinding any overshoot), reports progress `0`, plays and wraps the range natively until
`terminalProgressMs`, and keeps counting progress across wraps. A restored running media continues from `playheadMs`
and `reportedProgressMs` after Continue. Browser `ended` or `timeupdate` callbacks are observation opportunities, not
settlement. Reported progress is the natural playback of the current segment only: the Player never seeks, pauses,
or skips a media on its own, and a browser-forced pause or buffering appears as a stall. Any future user control of
media playback enters the runtime as typed host input and changes segments like the script's own controls; it is an
open decision in [`OPEN-DECISIONS.md`](OPEN-DECISIONS.md).

## Compiler and execution entry points

### Normal source route

`compileProject(files, options)` is the normal source compilation route for a package of `.tease` files, and
`compileSource(source, options)` compiles one source as the `main.tease` of a one-file project. The file list must name
`main.tease` once and give every file a unique package-root path that separates folders with `/` and names a `.tease`
file; other paths are `TSC009` diagnostics. For each file, the compiler:

1. parses source text into a `Program`;
2. runs AST-level validation for parsed non-finite numeric literals;
3. runs semantic validation when parsing and finite-literal checking produced no errors, with the globals, global
   functions, and speakers of every parsed file;
4. includes the core runtime built-ins plus configured global and builtin names in validation;
5. checks types once no file has an error, for all files together;
6. lowers the program only when no error diagnostics remain in any file;
7. completely validates and deeply freezes an instruction plan before returning it.

Each file has its own top-level names and functions; globals, global functions, and speakers belong to the whole
project (see [Globals, global functions, and speakers](#globals-global-functions-and-speakers)). The plan holds all files: `main.tease` first, then the others by
path, each a block of its root region followed by its functions and handlers, and a session starts at the top of
`main.tease`. The result separates parser and semantic diagnostics per file, gives every project diagnostic the path of
its file, and returns `plan: null` when compilation fails. Runtime entry
points reuse the identity of a returned validated immutable plan. Other plan data remains subject to the complete
`validateInstructionPlan(...)` boundary, which accepts only the fields that the current plan version defines for each
plan object and rejects any other field as malformed `TSC002` data. The plan schema evolves through a new plan version
rather than through silently accepted fields.

Recognized native JavaScript stack exhaustion during parsing or compilation returns error diagnostic `TSC007` across
the complete source rather than escaping from `compileSource(...)`. This contains a host failure without defining a
TeaseScript source-depth limit; unrelated native exceptions propagate unchanged. Current evidence and remaining
host-dependent recursive paths are recorded in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md).

`compileSource(...)` rejects numeric literals such as `1e999` and `-1e999` with error diagnostic `TSC001`. It does not return an instruction plan for those inputs. Large finite values such as `1e308` remain valid. The normal compilation route therefore cannot return a plan containing literal `Infinity`, `-Infinity`, or `NaN`, and instruction-plan validation independently rejects any non-finite number in plan data.

`compileSource(...)` performs the `TSC001` AST-level validation once and includes the diagnostics in its
parser-diagnostic boundary. The lower-level `parse(...)` result may still expose the raw JavaScript number produced
while parsing, so callers must not treat parsing alone as successful compilation.

### String interpolation

Both single-line and block strings use normal TeaseScript expression parsing for interpolation and support recursively
nested strings and interpolation expressions. The lexer preserves exact source spans and keeps escaped quotes and
escaped `${` as literal string text. Block physical LF and CRLF endings normalize to `\n`; the accepted syntax
specification defines dedent.

Unterminated nested content remains structured: `TSL003` reports an unterminated single-line string, `TSL004` reports
an unterminated block string, and `TSL005` reports an unterminated interpolation. A quote at a valid expression-start
position begins a nested string. A quote that cannot begin an expression remains the outer string's recovery boundary.

### Canonical source-to-runtime route

Ordinary TeaseScript source is compiled through `compileSource(...)` into a validated instruction plan, then executed with fresh or restored explicit serializable runtime state. AST data and lowering remain compiler and authoring-tool internals, not product execution APIs.

### Low-level runtime route

The compiler internally lowers semantically valid parser-owned AST data after `compileSource(...)` validation. This
internal lowering does not replace semantic validation or expose a supported caller-constructed AST compilation route.

The low-level runtime entry points are:

- `executeInstruction(...)` for exactly one instruction;
- `stepToEvent(...)` until the next event, halt, or failure;
- `run(...)` until halt, failure, or instruction-budget exhaustion.

Each low-level runtime entry validates the instruction plan and runtime snapshot before executing or returning, including when the supplied snapshot is already halted or failed. Callers may also invoke `validateInstructionPlan(...)` and `validateRuntimeSnapshot(...)` explicitly. Invalid plan data produces `RuntimeDataError` `TSR100`; invalid snapshot data produces `RuntimeDataError` `TSR101`.

Normal main-path execution stops at `waiting`; validated operations submit time observations and typed completions.
An eligible queued timer handler may preempt a pending foreground action other than a storage write at runtime entry
under [Timers and scene time](#timers-and-scene-time).

## Host values and capabilities

Host and builtin capabilities are explicitly injected and are not serialized into runtime state.

The current boundaries are:

- only explicitly registered own builtin names are callable; inherited JavaScript prototype names do not create capabilities;
- core built-ins retain precedence over injected capabilities with the same names;
- low-level named builtin arguments use an immutable prototype-free record and duplicate detection uses own properties;
- values entering globals or returning from builtins are copied and validated as serializable runtime values, and may
  not contain timer handles, media handles, or speaker references, which only the runtime creates;
- invalid builtin return values become structured runtime failures, including `TSR013` for invalid values;
- normally declared TeaseScript speakers remain runtime-managed state and continue to use stable serialized speaker IDs.

The low-level `RuntimeCapabilities.random` hook is a compatibility/testing override. Without it, execution advances the serialized `xorshift32-v1` state. An injected random source must return a finite number in the half-open range `[0, 1)`.

The override's own state is external to the runtime snapshot. A checkpoint is therefore not self-contained with respect to an arbitrary injected random source. Canonical checkpoint-equivalence guarantees use the serialized runtime RNG; tests that use the override must explicitly recreate an equivalent deterministic external source.

Future player capabilities must return typed, validated, JSON-safe outcomes correlated to one action ID and obey
any separately justified capability/interaction boundary. Raw DOM exceptions, browser handles, streams, callbacks, and
mutable host objects do not enter the snapshot.

Under ADR 0017, Standard Library and package-library wrappers may call documented typed capabilities, but they do not bypass these boundaries or become alternate owners of canonical action state.

## Date and time context

Date and time values ([§35](specifications/accepted-syntaxes-v30.md#35-date-time-durations-and-timestamps)) need the
player's time zone, presentation, and wall clock, but the engine reads no clock and no host time-zone or locale data.
A fresh session takes them as data in `FreshRuntimeOptions.temporalContext` and `wallClockMs`, and records them in
`RuntimeSnapshot.temporalCaptures`, so restore and replay compute the same times and text on every host. A context
holds:

- `zone`: the IANA name, the offset at the start of 1970, and the offset transitions up to 2100, each located to the
  second. Converting a moment outside 1970 through 2099 fails with `TSR063` instead of guessing the rules.
- `presentation`: templates for numeric dates, times, and both, with and without seconds, using the placeholders
  `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}`, and `{dayPeriod}`; whether day, month, and hour are
  padded; the hour cycle (`h11`, `h12`, `h23`, or `h24`); and the two day-period markers. Digits are Latin and the
  calendar Gregorian.

`captureTemporalContext(timeZone, locale)` builds the context from the host's `Intl` data. Zone offsets are sampled
daily and each change located by bisection, so two changes less than a day apart that cancel each other out are not
seen. Fresh-session creation rejects a malformed context with `RangeError`; restore validates it like other snapshot
state. Without a context a session uses UTC and locale-neutral text such as `2026-10-04 18:30`.

Each capture records a context, the UTC wall clock (or `null` when the host supplied none), its boundary scene time,
and the session's next event sequence when it was recorded. Session start records the first capture at
`initialSessionTimeMs`. When the player continues a restored session, the host calls
`recordContinueCapture(plan, snapshot, { wallClockMs, temporalContext? })`, which executes nothing, and then runs the
session before the scene clock resumes; this recorded input takes effect at the saved `observedSessionTimeMs`, and a
new context may be omitted to keep the earlier one. Restore itself records nothing.

- Execution at scene time `t` uses the last capture whose boundary is not later than `t`, so saved catch-up before the
  boundary keeps the earlier capture and execution from the boundary on uses the new one.
- `getTimestamp()` is the capture's wall clock plus the scene time since its boundary, rounded to whole milliseconds; it
  never goes backwards within one capture. `getDate()`, `getTime()`, and `getDateTime()` read that moment through the
  capture's zone. Without a clock they fail with `TSR064`.
- Interaction buttons keep the presentation they were shown with: validation derives them again with the capture in
  force at the interaction's `createdAtMs` among those recorded before its request event, and rejects a snapshot that
  no longer has that capture.
- A capture replaces the previous one only when nothing happened in between. Recording a capture drops captures no
  open interaction, current execution, or saved catch-up can use any more.

The Player resolves the host's account setting, else the browser's zone and language, and then reads `Date.now()`,
when Start creates a session and again at Continue.

## Script storage

The engine implements `save`, `load`, and `delete` under specification
[§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys).
`RuntimeSnapshot.scriptStorage` is the session's view of host-loaded script storage, represented by
`RuntimeScriptStorageEntrySnapshot[]` entries with `{ key: string, value: SerializableRuntimeValue }` sorted by key in
UTF-16 code-unit order. The host supplies the initial view, in any order, through optional
`FreshRuntimeOptions.scriptStorage`. The view is part of every checkpoint, rather than the durable backing store
itself. Fresh-session creation and snapshot/checkpoint restore validate the entry array, string keys, key uniqueness,
and recursively storable values under §25; top-level values cannot be `null`, and a restored view must be sorted.
Invalid fresh-session storage input throws `TypeError`; malformed snapshot/checkpoint storage uses the existing
structured validation errors. Storage values, loaded values, and action payloads are independent copies.

`FreshRuntimeOptions.persistentScriptStorage` (default `false`, retained as `scriptStoragePersistent`) selects the
write path:

- **Session-local:** `save` and `delete` change the view at once; no action or warning is produced.
- **Persistent:** each `save` and `delete` creates a foreground `storageWrite` action
  (`{ key, value }`, `value: null` removing the key) and emits `actionRequested`; the view does not change yet. The
  host persists the write and completes the action through `completeAction` with `actionKind: "storageWrite"` and
  payload `{ kind: "stored" }` or `{ kind: "failed" }`. Only `stored` changes the view; `failed` keeps the previous
  value or absence and emits developer warning `TSW014`. The settlement records `outcome` and `key`, is retained for
  replay like other foreground settlements, and the script continues at the next instruction. The host persists only
  writes requested by actions it completes; retained event history and restored snapshots never repeat a write.

A pending write is not interruptible. A timer expiry or media cue block that becomes due waits for it: scene-time
catch-up holds at the block's due time, the completion is accepted at that scene time, and the block then runs at its
due time before catch-up continues. A pending write survives checkpoint and restore like other foreground actions.

Restoring an older checkpoint carries its older storage view. A later read-modify-write can overwrite newer durable
data; reconciliation belongs to #469 and is not implemented here.

## Camera capture

`takePhoto()` implements specification
[§33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references). It is a reserved
call, not a builtin: hosts cannot inject or override it, it takes no arguments (`TSV020`), it is not a value (`TSV028`),
and it cannot run in a parameter default (`TSV032`). It lowers to a `capture` instruction whose result is handed off
through a temporary like an interaction result; plan validation rejects an unlowered `takePhoto` call.

Executing it creates a foreground `capture` action and waits. The host answers through `completeAction`:

```text
{ actionId, actionKind: "capture", payload: { kind: "captured", media: { kind: "image", reference } } }
{ actionId, actionKind: "capture", payload: { kind: "unavailable", reason } }
```

`reason` is `unconfigured`, `denied`, `notFound`, `busy`, `unsupported`, `revoked`, or `failed`. A captured reference is
accepted only when the trusted host's `ActionCompletionOptions.capturedMedia.holds(reference, "image")` vouches for it,
so a well-formed string from anywhere else never becomes a captured photo; the engine does not inspect the reference's
private spelling. An unavailable camera yields `null` and one `TSW015` developer warning, and the script continues.
A settled capture is retained as `lastSettlement`, so a repeated completion replays as `alreadySettled`. Captures are
not interrupted: a due timer expiry block runs once the capture settles. They emit no transcript.

The Player opens the session camera after Start when the trusted host grants the camera capability, answers each capture
once from that open stream, and delivers the answer until the runtime settles it. Captured photos are session media; a
save stores the photos its value references durably before the value is persisted
(`player/captured-media-persistence.ts`); when that fails, the host acknowledges the `storageWrite` as `failed`, so the
previous value is kept as for any failed persistent write. Media no saved value references is reclaimed
opportunistically when a Player opens while no Player of the same scope is live in any tab (Web Locks) and the saved
values can be read completely; without Web Locks it is not reclaimed, and while a Player lives nothing is deleted. The
technical playground has no camera and answers a pending capture as `unconfigured` when execution continues.

## Globals, global functions, and speakers

The compiler implements globals, global functions, and always-global speakers under ADR 0022 §3 and §6 and
specification [§11](specifications/accepted-syntaxes-v30.md#global-functions) and
[§12](specifications/accepted-syntaxes-v30.md#global-variables). Their names are checked across all files, and the
types of all files share one environment in the checking order of ADR 0021 rule 6.

The start values of all globals and speakers form a startup prefix at the beginning of the root region of `main.tease`:
one `declareGlobal` (with an optional runtime `typeCheck`) or `declareSpeaker` instruction each, in session-start order,
each with the index of the `file` whose source its locations refer to. The declarations themselves emit nothing, except
a `global` with `default:`, which assigns its value where it stands. Plan validation accepts these instructions only as
that prefix, each name once, with start values of the accepted kinds (no calls other than `script(...)`, no temporaries,
and no globals set up later), and no label, `goto`, jump, or call return leads back into it. Function definitions record whether they are `global`, which a timer or media block is
exactly when the code that registers it is. An instruction may call a function of another file only when it is global,
and a global function or block calls only global functions.

`RuntimeSnapshot.globals` holds the session's globals as `{ name, value }` bindings: first the host's
`FreshRuntimeOptions.globals` in their order, with the existing capture, value-copy, and runtime-identity rules, then
the script's globals and speakers as the startup prefix sets them up; a speaker's global holds its speaker reference.
Fresh-session creation rejects a host global with the name of a script global or speaker. A name is looked up in the
scopes of the running function or root, then, unless the running function or block is global, in the root of the
activation it runs for, and then among the globals. Start values are evaluated without random selection: a list of
unknown type reaching `.random` or `${...}` there fails with `TSR067`. A bare-label `goto` in a global function or its
blocks is a transfer to that label of the function's file, which it enters afresh. A file's entry, also `main.tease`'s,
follows the startup prefix, so no transfer runs the start values again.

Snapshot validation requires exactly the host globals followed by the script globals and speakers before the next
instruction while the prefix runs, and all of them after it, with no scope binding of a global's name and a speaker
registry of exactly the set-up speakers. While the prefix runs, a snapshot holds nothing else: no call, loop,
temporary, action, timer, media, queued block, settlement, prepared output, top-level variable, default speaker, or
Stage image, and none of their identities allocated; after it, no saved instruction position lies inside it. Restore
never runs a start value again. A snapshot may refer to the
instructions, functions, and blocks of `main.tease` and to global functions of any file with their blocks; any other
file's code is malformed until `goto` and `call` can enter it. A runtime failure, in the snapshot's `failure` and the
`runtimeFailure` event, carries the `path` of the file whose source its span is in.

## Visible text boundary

Ordinary scalar visible-text conversion accepts strings, finite numbers, booleans, `null`, durations, and date and time
values. Duration formatting and date and time presentation are defined in specification
[§35](specifications/accepted-syntaxes-v30.md#35-date-time-durations-and-timestamps): dates and times use the session's
captured presentation, and a timestamp shows its local date and time in the captured zone (see
[Date and time context](#date-and-time-context)). Prepared output is never formatted again after restore. List text
follows
[§16](specifications/accepted-syntaxes-v30.md#lists-in-text):

- `${...}` interpolation checks that every element is a scalar visible-text value, then selects exactly one element
  with the session RNG. An empty list fails with `TSR019` and any other element with `TSR021`, both before any RNG
  draw. A dict fails with `TSR021`, which names the fix ([§40](specifications/accepted-syntaxes-v30.md#40-dictionaries)).
- `say` shows any other value in code-like notation, written iteratively so that deep nesting does not recurse
  natively. A timer or media handle shows the state the snapshot holds when `say` evaluates its value, so the text is
  deterministic and the same after checkpoint resume. The engine escapes the notation with `escapeMarkup`, so the
  ordinary markup parse leaves it literal.
- Button labels, input hints, and the `text` of a choice object reject a list with `TSR021`, timer labels with
  `TSR050`, and speaker names and titles with `TSR030`; a list the compiler can see there is compile error `TSV040`,
  and another value they cannot show `TSV042`. Materializing an interaction draws no RNG.
- `list.join(...)` and `toString(...)` apply the scalar conversion to each element or to the value, without selecting
  from lists; another element fails `join` with `TSR021`, and another value fails `toString` with `TSR058`.

The earlier proposal for automatic chat pacing at 17 visible characters per second is superseded. ADR 0018 defines the
accepted deterministic first-POC smart-autoplay and pacing-action contract. The current engine/compiler and playground
Player POC implement that contract; production host lifecycle and cross-origin wiring remain separate.

## Runtime defaults and limits

Current runtime policy still includes separately governed call-depth, interaction, and instruction-work behavior.
Exact numeric implementation values, evidence status, and change routes live in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). This document keeps the behavior and safety semantics without promoting
provisional values or product defaults into supported runtime-capacity claims. Generic capture/traversal depth or work
and detailed-validation work are not TeaseScript acceptance limits merely because runtime validation or stable capture
observes those dimensions.

The playground RNG algorithm remains `xorshift32-v1` with default seed `0x6d2b79f5`; those deterministic identity
choices are unrelated to resource capacity.

A configured instruction budget must be a positive JavaScript safe integer. Omitting it uses the current product default
tracked in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). Exhaustion fails deterministically with structured runtime error
`TSR037` instead of hanging and leaves the returned snapshot failed rather than resumable through a later `run(...)`.
Fresh snapshot creation validates the plan, serializable globals, script storage, call-depth limit, and RNG seed before
returning state.

Live externally supplied instruction plans, runtime snapshots, globals, script storage, and serializable runtime values are captured
into stable plain-data graphs before detailed validation, freezing, state construction, execution, event emission, or
RNG consumption. Capture rejects accessors, failed traps, cycles, unsupported prototypes, non-finite values, and
non-canonical arrays without imposing a generic graph-work or nesting ceiling. Compiler-owned plans are validated
directly. Runtime entry points reuse an exact immutable plan graph after complete validation has established
process-local evidence for that graph; compiler output and plans returned from capture or checkpoint restore can retain
this evidence across calls. A caller-owned plan without that evidence is captured and validated at every entry, while
caller-controlled snapshots are always freshly captured and validated, including for halted and failed entries. Runtime
and checkpoint operations also reuse a plan already captured and validated by that operation when validating the
snapshot, and checkpoint data freshly produced by `JSON.parse(...)` goes directly through complete structural
validation. Checkpoint restore validates its envelope, plan, snapshot, and their consistency before execution resumes.
A generic capture depth/work or detailed-validation counter alone does not make otherwise structurally valid data
malformed. Malformed or inconsistent plan and snapshot data still produces the existing public invalid results,
`TSR100`, `TSR101`, or `TSK002`. The compact user-function call representation and its format consequences are described
under [Format evolution](#format-evolution).

Serializable-set validation and rebuilding use linear native membership tracking while retaining the insertion-ordered `items` array as the canonical serialized representation. Scalar equality and duplicate handling are unchanged.

A session halts only through `exit`: a halted snapshot is accepted only immediately after an `exit` instruction. Halted snapshots must also retain no active call frames, loop frames, temporaries, nested scopes, contextual speaker, or failure state. These checks establish that the serialized state is a possible current runtime state; they do not authenticate its execution history.

Persisted runtime counters, identities, instruction positions, collection-iteration positions, depths, temporary IDs, warning-deduplication IDs, speaker references, and source-span positions must be JavaScript safe integers in their existing non-negative or positive ranges. Ordinary finite script numbers retain their existing semantics. The allocator counters `nextEventSequence`, `nextScopeId`, `nextSpeakerId`, and `nextCallFrameId` may hold `Number.MAX_SAFE_INTEGER` as stored state, but an operation that would increment such a value is rejected with `RuntimeDataError` `TSR101` before an event sequence or runtime identity is reused.

The accepted `nextActionId` follows the same no-reuse and pre-increment failure rule. `lastSettlement` is bounded to
one record. `currentSessionTimeMs` is finite, non-negative, persisted, and subject to its accepted representation and
deadline-arithmetic domains.

## Deterministic RNG invariant

The `xorshift32-v1` seed and serialized state must be non-zero unsigned 32-bit integers:

- `createXorShift32State(0)` and fresh runtime creation with seed `0` reject the seed;
- `nextXorShift32(...)` rejects direct malformed state `0`;
- `validateRuntimeSnapshot(...)` rejects a snapshot whose RNG state is `0`;
- checkpoint restore translates that malformed snapshot state into structured `CheckpointError` code `TSK002`;
- a valid non-zero seed produces the deterministic sequence of the versioned `xorshift32-v1` algorithm; a deliberate
  algorithm change uses a new algorithm version (ADR 0015) instead of changing the sequence under that identifier.

The zero-state rule prevents the absorbing xorshift32 state in which every future state and output remains zero. It does not change the plan, runtime-snapshot, or checkpoint format version.

## Checkpoint boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify or persist after every instruction. A production runner may execute many instructions in memory until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

A checkpoint is currently a self-contained plan-and-snapshot bundle. Restore validates the checkpoint, instruction plan, snapshot, format versions, references, function/call progress, RNG state, and other structural invariants before execution resumes.

Under ADR 0016, restore of a valid waiting checkpoint remains waiting and preserves the same action, `currentSessionTimeMs`, settlement, and event identities. Restore does not read time or silently complete a deadline. After the restored-session activation gate, the Player application submits an explicit observation; the atomic observation operation persists the nondecreasing effective coordinate before settling due actions.

## Format evolution

The code constants `INSTRUCTION_PLAN_VERSION`, `RUNTIME_SNAPSHOT_VERSION`, and `CHECKPOINT_VERSION` are authoritative for the numeric revisions accepted by the runtime. Accepted ADRs and canonical specifications remain authoritative for format semantics, architecture, and compatibility policy. This table is the single general human-readable summary of the current revisions:

| Format | Current revision | Reason for current revision |
| --- | ---: | --- |
| Instruction plan | 50 | Script references (#570): a transfer or fallback destination may be computed, `{ value }`, whose expression evaluates to a script reference; the `script` built-in, and the `script` type for type checks and tests. Revision 49: Globs (#570): a transfer or fallback destination may be `{ pick }`, the files a glob picks from. Revision 48: File transfers (#570): a `transfer` instruction goes to or calls a file's entry or label, or calls a label of its own file; `setFallback` sets or clears the fallback; each file lists its `entryInstruction`. Revision 47: Camera capture: the `capture` instruction for `takePhoto()`, and rejection of an unlowered `takePhoto` call. Revision 46: Globals (#570): `declareGlobal` instructions and `declareSpeaker` instructions, both with the `file` of their source, form a startup prefix at the start of `main.tease`, and `setDeclaredSpeakerProperty` is removed; function definitions record `global`, and an instruction may call a global function of another file. Revision 45: Tags (#572): a plan has an `images` catalog of package image paths in path order, each with its tags in name order (a canonical name and a finite number or `null`), and a `tagQuery` expression (`showImage tagged`, `findImages`) of postfix steps over operands that are evaluated once, in order, before any image is matched. Revision 44: Labels and endings (#570): each file lists its `labels`, and its root region closes with an `end` instruction; `goto` (to a label of its file) and `end` instructions; a root jump stays inside its region. Revision 43: Projects (#570): a plan lists its `files`, each with a path, source span, and a block of a root region followed by its functions and handlers; this table replaces the plan-level `sourceSpan` and `rootEndInstruction`, and an instruction may only refer to functions of its own file. Revision 42: Any set member (owner decision on #568): a set literal, set `add`, and `toSet` take any value a list takes, so a plan that failed with `TSR032` now runs. Revision 41: Durations as set members (owner-accepted 2026-10-04): static set and choice values may hold durations. Revision 40: Date and time input: an interaction may be `temporal`, with UI, static or prepared, that carries `temporalKind` (`date`, `time`, or `datetime`) and an optional ISO `prefill`, and the `temporal` result domain. Revision 39: Calendar durations: a duration literal plan may carry whole `months` and `days`, present only when they are not zero. Revision 38: Dicts: a `dict` expression carries ordered entries, each a key and a value expression, a type may be `dict` with a value type, and a dict `get` call may check its `default:`. Revision 37: Date and time values: static choice values may be dates, times, datetimes, and timestamps, and types include `timestamp`. Revision 36: Type tests: a `typeTest` expression (`value is T` or `value is not T`) carries a recursive type and is evaluated with the matcher of the runtime type checks. A type may be `never`, which no value fits, so a list of it holds only the empty list. Revision 35: the `min` and `max` built-ins. Revision 34: the list methods `sort` and `shuffle`, and `intersection`, `union`, and `difference` on lists and sets. Revision 33: text operations (`length` and text methods), list `join`, and the conversion and rounding built-ins. Revision 32: `askInteger`: number interaction UI, static or prepared, may carry `integer: true`. Revision 31: the binary operator `in`, a number-in-range test that `switch` range cases compile to. Revision 30: runtime type checks: `declareBinding`, `assign`, `bindDefaultParameter`, and `returnValue` instructions, function-call arguments, and list or set `add` calls may carry a `typeCheck` with a recursive type and the receiving place, checked for values the compiler cannot know; `storageLoad` no longer carries its own expected type. Revision 29: `showButton` timeout and elapsed time: a button used as a value has the `duration` result domain and a destination, and a prepared button may carry a `timeoutTemporary`. Revision 28: list text and choices: `say` shows any value, with lists, sets, and objects in literal notation, only `${...}` interpolation selects a list element, and text fields reject lists; a prepared `choose` keeps its evaluated options and the value written before each `:` (or `null`), static choice UI carries typed values, and choice results use the `choice` domain. Revision 27: structural `==` for objects, lists, sets, and ranges (previously `TSR029`); the list method `removeAt`; `removeAt`, `removeFirst`, and `removeLast` return the removed element, and `removeFirst`/`removeLast` on an empty list fail (previously no-ops). Revision 26: text and number interaction UI may carry a `prefill` default answer, or its `prefillTemporary` when computed. Revision 25: script storage: `storageLoad` expressions with lazy defaults and direct typed-initializer checks, and `storageWrite` instructions (`save`; `delete` when the value is `null`). Revision 24: message preparation accepts authored position and alignment only for prose. Media instructions `pacingBarrier`, `showImage`, and `playMedia`; handler regions carry `handler` (`timer` or `media`) and `selfHandle`. Revision 21 added the timer instructions. |
| Runtime snapshot | 44 | Script references (#570): a runtime value may be a script reference, `{ kind: "script", path, label }`, and every scope records `entry`, where a root's activation started. Revision 43: Globs (#570): the fallback may be a glob destination. Revision 42: File activations (#570): a scope names the file of an activation root; call frames are `function` or `file` frames; function frames, timers and media with blocks, and queued blocks name their activation root; `retainedScopes` and `fallback` are new. Revision 41: Foreground `capture` actions and their replayable settlements, and capture results in the canonical result handoff, which records its `actionKind`. Revision 40: Globals (#570): a `globals` list holds the host's globals, then the script's globals and speakers, which no longer live in the root scope; a prepared reference may have a global as its root; a failure carries the `path` of its source; global functions of every file and their blocks may run. Revision 39: Endings (#570): `terminalContinuationHandoff` is gone, a halted snapshot stands after an `exit`, and a position names an instruction of the plan. Revision 38: Any set member (owner decision on #568): a set may hold any value a list may hold, unique by structural `==`; a prepared reference no longer steps into a set by position, because a set member is read as a copy. Revision 37: Durations as set members (owner-accepted 2026-10-04): a set may hold durations, keyed by their months, days, and milliseconds. Revision 36: Temporal interaction UI, active or recorded in a settlement, carries `temporalKind` and an optional ISO prefill; a temporal settlement result is a date, time, or datetime of that kind. Revision 35: Calendar durations: a duration value may carry whole `months` and `days`, present only when they are not zero. Revision 34: Date and time captures: `temporalContext` became `temporalCaptures`, each with a boundary scene time, an event sequence, an optional wall clock, and a context, recorded at start and by `recordContinueCapture`. Revision 33: Dicts: a runtime value may be a `dict` of ordered `{ key, value }` entries with unique text keys, and a prepared reference path may step through a dict `key`. Revision 32: Date and time values: runtime values, set members, and choice values may be dates, times, datetimes, and timestamps; the session records its captured `temporalContext`. Revision 31: Number interaction UI, active or recorded in a settlement, may carry `integer: true`, which requires a whole-number answer and prefill. Revision 30: interaction actions record `createdAtMs` and a button's `timeoutMs`; an interaction settlement may be `timedOut`, without transcript sequence or text, and a button result is a non-negative elapsed duration. Revision 29: choice actions and settlements carry each button's typed value, a choice result may be any choice value including `null` or a duration, and a choice control completes by button position. Revision 28: text and number interaction UI, active or recorded in a settlement, may carry a validated `prefill`. Revision 27: an interaction settlement records the `ui` the player answered, and validates against it instead of the prepared temporaries, which a later run of the same instruction may fill anew. Revision 26: the validated, key-sorted `scriptStorage` session view, `scriptStoragePersistent`, and foreground `storageWrite` actions and settlements. Revision 25: captured bubble presentations require null position and alignment; placement is Player-owned. Media state: `stageImage`, background `media` actions, `settledMedia`, `nextMediaId`, foreground `mediaPlayback` waits and settlements, media cue invocations and interrupt frames, barrier-promoted pacing gates, and media handles. Revision 22 added timer state. |
| Checkpoint | 61 | Updated the self-contained bundle for the script-reference plan and snapshot contracts. Revision 60: the glob plan and snapshot contracts. Revision 59: the file transfer plan and activation snapshot contracts. Revision 58: updated the self-contained bundle for the capture plan and snapshot contracts. Revision 57: the globals plan and snapshot contracts. Revision 56: the image catalog and tag query plan contract. Revision 55: updated the self-contained bundle for the label and ending plan and snapshot contracts. Revision 54: the project plan contract. Revision 53: the any-set-member plan and snapshot contracts. Revision 52: the duration set-member plan and snapshot contracts. Revision 51: the date and time input plan and snapshot contracts. Revision 50: the calendar duration plan and snapshot contracts. Revision 49: the date and time capture snapshot contract. Revision 48: the dict plan and snapshot contracts. Revision 47: the date and time plan and snapshot contracts. Revision 46: the type-test plan contract. Revision 45: the `min` and `max` plan contract. Revision 44: the list-sort and set-operation plan contract. Revision 43: the text-operation and built-in plan contract. Revision 42: the `askInteger` plan and snapshot contracts. Revision 41: the `in` plan operator. Revision 40: the runtime-type-check plan contract. Revision 39: the `showButton` timeout plan and snapshot contracts. Revision 38: the list-text and choice plan and snapshot contracts. Revision 37: the structural-equality and list-removal plan contract. Revision 36: interaction prefills. Revision 35: the recorded interaction settlement UI. Revision 34: the script-storage plan and snapshot contracts. Revision 33: prose-only authored placement, bubble presentation validation, and the media plan and snapshot contracts. |

Keep current numeric revisions only in this table. Other general documentation must link to this section instead of repeating the moving numbers; retain numeric revisions elsewhere only when they describe a clearly historical contract change or a separate independently versioned identifier.

These numbers are internal POC format revisions, not TeaseScript product releases, public wire-format promises, or backward-compatibility commitments. A changed number in code does not by itself create a new accepted architecture or compatibility policy. Pending-action entries do not receive redundant nested version fields.

Increase a revision when the accepted serialized contract changes incompatibly, including when a required field is added or removed, a field type or meaning changes, new invariants reject previously accepted data, restore behavior changes for the same stored data, or older data must be rejected for correctness or safety. Do not increase a revision for internal refactoring, code movement, renaming, performance work, reorganized tests, clearer diagnostics, documentation-only corrections, or a bug fix that restores already documented behavior while preserving the accepted meaning and validity of stored data. A bug fix does require a bump when previously accepted data changes meaning, becomes unsafe, must be rejected, or would resume differently.

The checkpoint revision represents the complete accepted checkpoint bundle:

| Incompatible change | Revisions to increase |
| --- | --- |
| Instruction-plan contract only | instruction plan and checkpoint |
| Runtime-snapshot contract only | runtime snapshot and checkpoint |
| Checkpoint envelope only | checkpoint |
| Internal implementation only | none |

Instruction-plan and runtime-snapshot revisions remain independent and do not need matching numbers. No nested duplicate version fields, hidden sub-format registry, migration chain, or generated documentation synchronization is introduced.

Current POC status: only the current revision of each format is supported and no migration exists. A non-current
revision is rejected explicitly as unsupported rather than read as current, so obsolete development saves and fixtures
may become invalid after an incompatible change. Adding migration requires a separate owner-approved decision. Git
history is sufficient for reconstructing exact older schemas. The current revisions include populated `chatPacingGate`
background state, prepared pacing output, captured smart-autoplay settings, exact pacing-settlement release lineage, and
validated prepared message markup with canonical visible text.

## API stability boundary

The exported TypeScript source frontend, source compiler, low-level runtime, snapshot, checkpoint, and RNG functions are current POC surfaces used by the repository and tests. Their presence in `src/index.ts` does not by itself establish a permanent third-party API or wire-format compatibility promise. Long-term package API stability and migration policy remain open.

## Remaining runtime work

- preserve the implemented timer, interaction, and pacing contracts while extending later runtime capabilities
  through explicit versioned schema changes;
- define advanced timeout and detailed-result contracts without unnecessary independent state machines;
- define broader text-output targets and involved-speaker/conversation provenance before multi-context LLM work;
- stable package/plan identity and migration policy;
- Standard Library imports, generated declarations/editor metadata transport, versioning, and capability access;
- iframe host commands and response correlation;
- captured-media recovery after reload or restore and persistent media collections, their cleanup and persistence
  (camera and microphone ownership is in [`SECURITY.md`](SECURITY.md));
- time-integrity diagnostics and future server-authoritative scheduling;
- server checkpoint persistence and conflict resolution;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
