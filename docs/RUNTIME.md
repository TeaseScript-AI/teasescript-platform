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

The Player runs each session on one [runtime session](#runtime-sessions). A `PlayerRuntimeSession` is one publication
of it: `state` holds the view, projections, active calls, and date and time presentation it shows, and
`playerRuntimeSnapshot` exports the complete state only where one is kept, such as a restore point, a debug export, a
rewind point, or a saved-data adoption. An operation goes through a publication that shows the current state; once an
operation changed the state, one made from an earlier publication throws. When an operation throws, the error reaches
the Player, and the next use rebuilds the state of the latest publication from the calls the session's [debug
recorder](DEBUGGER.md#debug-export) logged, so play continues from the state the Player showed. An operation's events
reach the transcript only once the run that follows it has finished, so the transcript stays as shown too.

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
kind: button | text | number | temporal | image | choice | form
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

A basic ask's question is an ordinary prepared `say` that the compiler places before its interaction: after the requesting speaker, `prepareSaySpeaker` and `prepareSayContextualSpeaker` capture the same speaker, `prepareSayText` with `field: true` captures the question, then the `prefill:` and `hint:` operands are evaluated in written order, the `say` runs, and the interaction opens. The question's `say` follows ordinary pacing, staging, and checkpoint rules, and the interaction that follows consumes its pacing gate. A pending field, a refused answer, an interrupt, or a restore never says the question again; a question known as static text with a static field becomes a literal `say` before a static interaction.

A `choose` with `prefill:` is always prepared: its prefill is evaluated after the options, into a temporary of its own.
When the choice opens, the first button whose value equals it is the UI's `preselected` position; `null` preselects
none, and a value that no button has preselects none and reports developer warning `TSW017`. The temporary keeps the
value, so a restored pending choice finds the same button again.

`askBoolean` lowers to a `choice` of two buttons, `{ text: yesText, value: true }` and `{ text: noText, value: false }`,
with `"Yes"` and `"No"` as the default texts, and its `prefill:` as the choice's, marked `booleanPrefill`: `null` or
blank text preselects none, and any other value that is not `true` or `false` fails with `TSR052` as the choice would
open, instead of warning. A literal `true` or `false` is a static `preselected` of 0 or 1. With static texts and a static positional question, or none, it is a static choice, after a
literal `say` of the question when there is one. Otherwise, also with a question named `message:`, like a
[form](#forms) it evaluates its question and named arguments once, in written order, into one request temporary, says
the question from it, and prepares the two choice objects from it.

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
- `askDate`, `askTime`, and `askDateTime` are a `temporal` interaction whose UI carries `temporalKind` (`date`, `time`, or `datetime`): the answer is trimmed strict ISO text ([V30 §35](specifications/accepted-syntaxes-v30.md#35-date-time-and-durations)), a local time that the player's zone skips is valid, and anything else is rejected with "That is wrong. I asked for a date." (a time, a date and time). The result is the `date`, `time`, or `datetime` value; the transcript shows it in the presentation in force at completion, as `say` would, and a prefill fills in its ISO text;
- `askImage(...)` is an `image` interaction whose answer is an image the trusted host stored; see
  [Image input](#image-input);
- a form is a `form` interaction whose fields the player edits before submitting; see [Forms](#forms);
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

#### `instant`, `0 s`, and `wait`

When `say ..., 0 s` or `say ..., instant` executes while a pacing gate remains active as background work, one atomic transition settles the old gate with `supersededByInstantOutput`, emits `actionCompleted`, emits the current text-output event, and creates no new gate.

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
wait 1 s
say as mistress "Two"
```

the actual separation is the longer of the remaining `say` gate and the explicit one-second wait. The durations are not automatically added, so a `wait` shorter than the gate adds no time unless the player skips the message; the compiler warns about one it can measure ([V30 §27](specifications/accepted-syntaxes-v30.md#27-timers), `TSV060`).

#### Media pacing barrier

Main-story media presentation waits for the previous message like a following `say`. The compiler emits a
`pacingBarrier` instruction before `showImage`, `hideImage`, `playAudio`, `playVideo`, and `stopAudio`, and before a
statement-level media handle operation (`h.pause()`, `h.resume()`, `h.stop()`, or an assignment to `h.position`,
`h.remaining`, or `h.volume`). The receiver is evaluated once, before the barrier, and the operation uses that value; the barrier waits
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
- explicit loop frames for ranges and loops: a `for` frame holds its source as the loop started and its position; for
  `for key, value` (`valueVariable`), the dict itself, whose entry at the position gives the key and a copy of the
  value in a fresh iteration scope; restore validation requires each loop of a call context to stand in deeper scopes
  than the loop around it;
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

The current runtime implements blocking `wait`/`timer`, asynchronous timers, permanent buttons, compact foreground
interactions, ADR 0018 `say` pacing, and the Stage image and audio/video playback state. Timer lifecycle, interrupts,
and Player clock recovery are defined under [Timers and scene time](#timers-and-scene-time); permanent buttons under
[Permanent buttons](#permanent-buttons); media under [Stage image and media playback](#stage-image-and-media-playback);
script storage under [Script storage](#script-storage).

Runtime state retains persisted scene time, at most one active foreground action, background timers, media, and
permanent buttons and at most one pacing gate, the Stage image, monotonic identities, bounded settlement replay, prepared output, and explicit
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
`mediaPlayback`, or `storageWrite` wait. Non-waiting states contain no active foreground action. `backgroundActions` may contain timer,
media, and permanent button actions and at most one pacing gate. A background pacing gate may coexist with a foreground delay or storage write; it is consumed before a foreground
interaction and cannot coexist with a foreground pacing gate.

The shared timer and media interrupt state may retain one inert suspended foreground delay, interaction, or media
wait. Its ownership, settlement, and restore rules are defined under [Timers and scene time](#timers-and-scene-time)
and [Stage image and media playback](#stage-image-and-media-playback).

Blocking `wait` and `timer` use the foreground-delay path. `wait` is hidden; `timer` carries `visible`, `mystery`, or
`hidden` display and an evaluated label. Durations follow specification
[§27](specifications/accepted-syntaxes-v30.md#27-timers). A range is drawn once, in whole units of its unit, when the
delay starts, and restore preserves the draw.

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

`wait 0 s` is deliberately immediate: its duration expression is still evaluated, but it allocates no action ID, creates no pending action or settlement, and emits neither action event. The next source instruction runs normally. A positive wait settles with `actionCompleted`, and the following runtime entry continues at the next instruction. Re-entering an already halted snapshot emits no further event.

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

### Shared block variables

Timer, media, and button blocks share the variables of the code that creates them
([§14](specifications/accepted-syntaxes-v30.md#variables-in-timer-media-and-button-blocks),
[ADR 0024](decisions/0024-shared-block-variables.md)). The compiler lists, on `startTimer`, `showPermanentButton`, and
`playMedia`, the names of the function, loop, and block variables that the resource's blocks, or blocks they create,
use from the creating code (`captures`, in order of first use; for media the union over its blocks). Creating the
resource resolves each name, after its operands and before anything is published, in the scopes of the running code
down to its function or activation root, then among the variables the running block shares, into `{ name, scopeId }`.
The timer, media, or button record keeps this list as `captures`; each queued block and the block's function frame
copy it; an ordinary function frame has none. A block looks a name up in its own scopes, then in its `captures`, then
in its activation root and the globals. Each block is a handler region of its own: plan validation refuses a function
that more than one timer, media, or button block uses, also within one statement.

Each scope exists once: on the stack while its code runs, otherwise in `retainedScopes`. A scope that a list names is
marked `shared: true` from then on. Leaving a block, loop iteration, or function, and a transfer that discards them,
retains a marked scope that a live timer, media, button, or queued block still names, with only the bindings those lists
name; a running block names only scopes below its own, and leaving an unmarked scope checks nothing. A retained scope of
this kind drops a binding once no live list names it, and is dropped itself once nothing names it: when a block returns,
a resource settles or is removed, or a transfer runs.
Settled timer and media records drop the list. `exit` clears everything. Prepared references keep addressing a scope
by its ID wherever it is.

Restore validation requires every list to name, in order, the plan's `captures` of its block's instruction, a queued or
running block to carry its resource's list where the resource's record keeps one (see [Stage image and media
playback](#stage-image-and-media-playback) for settled media), every scope that a live list names to be a non-root scope
that holds the name and is marked (for a running block one below its own scopes), and every retained non-root scope to
be named by a live list.

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

The development Player (`?dev`, see [`player/README.md`](../player/README.md#development-only-behavior)) can jump
scene time forward without an engine mode. A jump first observes the time that really elapsed, then submits one
ordinary observation at each next timed event up to its target: the earliest Player deadline or media timeline event,
with running loaded media reported as playing on at 1× from their last sample. Rounds of a repeating timer without an
expiry block and passes of repeating media without cues run nothing, so they are passed within one observation, as
silent catch-up passes them; such media stop a jump only at their end. Blocks, timeouts, and continuations
therefore run in scene-time order, and a block's change to playback or its `save`, `delete`, or `takePhoto()` applies
before later events; the jump waits while such a host answer is pending. The Player then seeks its media elements to
the reported playhead and rebases its clock on the new observed time. A session with jumps is an ordinary session:
`getAbsoluteDateTime()` differences and elapsed results include the jumped time, and checkpoints record no jump.

A blocking `timer` is a foreground `delay` like `wait`, with its presentation (`visible`, `mystery`, or `hidden`) and
evaluated label. An asynchronous timer is a background action of kind `timer`: it allocates an action ID and emits
`actionRequested` when started and `actionCompleted` when it finishes naturally or through `stop()`; script-end and
`exit` cleanup stop remaining timers without individual completion events. No Player completion can target
it, so its settlement is not retained as `lastSettlement`. The action holds the timer record: state, presentation,
label, repeat configuration, current-round length, and either its deadline (running) or remaining time (paused), plus
accumulated elapsed time. A finished or stopped timer moves to `settledTimers` with only what a handle still reads (its
state, presentation, label, `repeatDuration`, and elapsed time) and whether it persists, which a transfer needs for its
queued blocks. `settledTimers` keeps only the records that an opaque handle (`{ kind: "timerHandle", timerId }`) or a
queued or running expiry block of the timer still reaches.
Every public operation drops the others before it returns, with the search and cost bound described for settled media
([Stage image and media playback](#stage-image-and-media-playback)). `nextTimerId` allocates handle IDs.

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
is the exception: it is accepted at the current scene time (see [Script storage](#script-storage)), as is a debugging tool's
storage edit. The Player then runs the engine
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
settlement each, and drops their queued blocks and those of its finished non-persistent timers. A `call` stops
nothing; persistent timers and their queued blocks stay. A failed session clears its foreground action.

Restore validation requires at most one active or settled record per issued timer ID and one for every handle and every
queued or running expiry block, accepts settled records that nothing reaches, and requires queued blocks to belong to
their timer (for a settled timer, whose record no longer names its block, to the block of a timer statement that could
have started it, in one activation with one list of shared variables), an active timer to hold a range only when its
duration is not written as a number or duration and has the range's unit after it, at most one interrupt frame, and
suspended actions to be consistent with the interrupted context.

## Permanent buttons

Author-facing behavior is defined in specification
[§28](specifications/accepted-syntaxes-v30.md#28-permanent-buttons). A shown button is a background action of kind
`permanentButton` ([ADR 0016](decisions/0016-resumable-pending-action-runtime-contract.md)): `showPermanentButton`
evaluates its text as a button label, allocates an action ID and a button ID (`nextPermanentButtonId`), emits
`actionRequested`, and continues; as a value it gives the handle `{ kind: "permanentButtonHandle", buttonId }`. The
action holds the button record: `buttonId`, `text`, `persist`, its block's parameterless handler region
(`handler: "button"`), and the root of the activation that showed it (`rootScopeId`), in which the block runs. Shown
buttons keep creation order. `removePermanentButton`, and a transfer that leaves the activation of a non-persistent
button as it stops a non-persistent timer, settle the action with an `actionCompleted` `removed` settlement that is not
retained as `lastSettlement` and drop its queued click; removing a removed button does nothing. `exit` clears every
button without events.

The Player clicks a button with `pressPermanentButton(plan, snapshot, buttonId)`; `completeAction` cannot target it. A
click is host input at the observed time while the session waits. It is `executionPending` while the script runs,
scene time is behind the observed time, or a due block can run; `busy` while the button's click is queued or its block
runs; `removedButton` for an issued ID that is no longer shown; `unknownButton` for an unissued one; and
`invalidPayload` for a malformed ID or a failed session. These change nothing. A `pressed` click publishes
`permanentButtonPressed` and joins the end of `pendingTimerHandlers` due at the current scene time
(`{ buttonId, handlerFunctionId, rootScopeId, dueAtMs, count: 1 }`). It then starts like a timer expiry block, under the
interrupt, suspension, return, `goto`, and `exit` rules of [Timers and scene time](#timers-and-scene-time); its
interrupt frame records `buttonId`. The block of a button removed meanwhile finishes. `permanentButtonProjection`
gives the shown buttons in creation order with `buttonId`, `text`, and `busy`.

Restore validation requires each button action to match its `showPermanentButton` instruction (block and `persist`)
and an activation root of that block's file, button IDs to be issued and to ascend in creation order, handles to refer
to issued IDs, a click to be queued at most once, only for a shown button whose block does not run, and a running
button block to belong to its button while that is shown.

## Stage image and media playback

Author-facing behavior is defined in specification
[§22](specifications/accepted-syntaxes-v30.md#22-stage-image-audio-and-video). This section defines the runtime
contract that Players and hosts rely on.

**State.** `stageImage` holds the persistent Stage image reference or `null`. Each play creates a background `media`
action (ADR 0016 identity, request event, creation time) holding a media record; the script-visible handle
`{ kind: "mediaHandle", mediaId }` refers to that record. Finished and stopped media move to `settledMedia` with only
what a handle still reads: the source, state, duration, volume, and the position and elapsed time where playback ended.
`settledMedia` keeps only the records that something can still read: a handle in the roots that snapshot validation
checks for runtime identities ([Message handles](#message-handles)), or a queued or running cue block of the media,
which sees its own handle. Before it returns, every public operation drops the other records, as it does for messages;
no handle to such media can appear again, so where an operation boundary falls does not change the state. The search
walks the roots side by side and stops once it has reached every record, so its work grows with how far it must walk in
root order to reach the last kept record, not with the values after it: a record whose only handle comes after many
unrelated roots, or lies deep in a large value, costs that walk on every operation, as message records do. `nextMediaId`
issues IDs. A media settlement publishes `actionCompleted` and, like a timer settlement, is not retained as
`lastSettlement`. At most one video is active; a new video, `showImage`, or `hideImage` stops it.

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
costs only latency. A Player may extrapolate for display, such as a progress bar, but reports only measured progress; only a development
time jump (see [Timers and scene time](#timers-and-scene-time)) reports 1× progress, after which the Player seeks its
elements to it. Every canonical timeline change starts a new segment
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
equals `terminalProgressMs` exactly, also for fractional ranges.
As for timers, catch-up pauses whenever the script or a cue block can execute, so both behave as if every sample had
arrived on time, and every media settlement records the scene time at which it happened.

**Script operations.** Handle reads use the progress interpolated at current scene time, capped at the next
uncommitted arrival. Before `pause()`, `resume()`, `stop()`, a seek, or a Stage replacement changes a segment, the
media's events due strictly before current scene time are committed; events due exactly now keep their global
catch-up order. While paused, an already-reached arrival at a range end or repeat-duration limit still commits and can
wrap or finish; other uncommitted cues at the pause position wait until playback proceeds. After a seek, a pass that
the seek completed is committed at once, also while paused, where the next pass stays paused. `stop()` and replacement
drop the media's queued, not yet started cue blocks. A `stopAudio` instruction applies `stop()` to every active audio
record in media ID order, which is start order, and leaves video alone. Author-visible seek,
lifecycle, cue, and handle behavior is defined in specification §22.

**Cue blocks.** Cue, compact, and `finish` blocks compile to parameterless handler regions (`handler: "media"`),
optionally with a self-handle name bound on entry to the media's handle. Their invocations share the timer expiry
queue and interrupt machinery above; interrupt frames record `mediaId` instead of `timerId`.

**Cleanup and restore.** `exit` stops all media without events and drops queued blocks; the Stage image stays. A `goto`
leaves media and their queued cue blocks running. Checkpoints carry the complete media state, including unprocessed
samples, and restore does not advance or rewrite it. Restore validation requires at most one active or settled record
per issued media ID and one for every handle, accepts settled records that nothing reaches, and requires queued and
running cue blocks to belong to their media's own blocks (for settled media, whose record no longer lists them, to the
blocks of one play with one activation root and its variables), at most one active video, waits to refer to their active
media, each active media's total playback to agree with its segment anchor, whose first sample does not lie after
current scene time, and each committed cursor to be one the runtime produces: at the origin of a pass, where pending
start cues wait, or exactly the arrival that the runtime's own next-arrival step commits from the preceding arrival
point. For active media that have played only since loading, start cues and queued cue invocations must also agree with
that playback: a start cue is pending until reported playback moves past it, and a cue cannot be queued more often than
playback reached it. Later segments follow controls whose history is not retained, and distinct cue points whose segment
progress is identical in double precision, which needs extreme source ranges, cannot be told apart. Cross-device handoff
is not part of this contract.

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
position begins a nested string. In a single-line string, so does a quote inside a bracket, parenthesis, or brace that
the interpolation opened when two more quotes follow on its line, such as the label of a command in a list or the text
of a `say` in a block. Any other quote remains the outer string's recovery boundary.

### Canonical source-to-runtime route

Ordinary TeaseScript source is compiled through `compileSource(...)` into a validated instruction plan, then executed with fresh or restored explicit serializable runtime state. AST data and lowering remain compiler and authoring-tool internals, not product execution APIs.

### Low-level runtime route

The compiler internally lowers semantically valid parser-owned AST data after `compileSource(...)` validation. This
internal lowering does not replace semantic validation or expose a supported caller-constructed AST compilation route.

The low-level runtime entry points are:

- `executeInstruction(...)` for exactly one instruction;
- `stepToEvent(...)` until the next event, halt, or failure;
- `run(...)` until halt, failure, or instruction-budget exhaustion.

Each of these snapshot-taking entries validates the instruction plan and the supplied runtime snapshot before executing
or returning, including when the supplied snapshot is already halted or failed. Callers may also invoke
`validateInstructionPlan(...)` and `validateRuntimeSnapshot(...)` explicitly. Invalid plan data produces
`RuntimeDataError` `TSR100`; invalid snapshot data produces `RuntimeDataError` `TSR101`. A [runtime
session](#runtime-sessions) runs the same engine on state that it owns.

Normal main-path execution stops at `waiting`; validated operations submit time observations and typed completions.
An eligible queued timer handler may preempt a pending foreground action other than a storage write at runtime entry
under [Timers and scene time](#timers-and-scene-time).

### Runtime sessions

Owner decision, 2026-10-07 ([ADR 0025](decisions/0025-engine-owned-runtime-sessions.md)): an engine-owned session
(`src/runtime/session.ts`) keeps the validated immutable plan and the canonical snapshot itself, so that an ordinary
step does work in proportion to its input and output rather than to the unchanged state. The snapshot-taking
operations stay as they are.

- **Creation.** `createRuntimeSession(plan, snapshot)` captures and completely validates both like a snapshot-taking
  entry (`TSR100`, `TSR101`); `createFreshRuntimeSession(plan, freshOptions)` creates the state that
  `createFreshRuntimeSnapshot` would; `restoreRuntimeSession(checkpoint)` and `deserializeRuntimeSession(json)` restore
  as `restoreCheckpoint` and `deserializeCheckpoint` do; and `createTaggedRuntimeSession(plan, tagged)` restores a
  tagged export (Boundaries). The last `options` argument may give `capabilities`, which every operation of the session
  and of its forks uses, and `randomControl` ([Controlled randomness](#controlled-randomness)), which `setRandomControl`
  changes. Sessions come only from these factories and `fork()`; the state lives in a private field, and `session.plan`
  is the validated, deeply frozen plan.
- **Operations.** `run`, `stepToEvent`, `executeInstruction`, `observeTime`, `completeAction`, `updateInteraction`,
  `reportMediaLoad`, `pressPermanentButton`, `recordContinueCapture`, `applyExternalStorageEdit`, `setDebugMode`, and
  `resumeRandomDraw` take the arguments and options of the snapshot API without plan, snapshot, capabilities, and
  `randomControl`, and run the same engine on the session's
  state. Host requests, observations, and capability results keep their complete capture and validation; the state
  itself is not captured or validated again. An operation started while another operation of the same session runs, such
  as from a builtin, throws `RuntimeSessionError`; through a builtin that becomes the usual `TSR012` failure.
- **Results.** An operation returns `events`, `instructionsExecuted`, `instructionTrace` when requested, `outcome`
  where the snapshot API has one, and `randomChoices` and `randomRefusal` when it has them, as deeply frozen copies that
  share nothing with the session's state. `view()` returns the operational state a host acts on, also detached and
  frozen: `status`, `failure`, `nextInstruction`, both session times, `runnable` (whether `run` executes something
  now), `foregroundAction`, `backgroundActions`, `suspendedAction`, the foreground action of the path a running block
  interrupted, `cameraView`, `queuedBlocks`, how many timer, media, and button blocks are queued, `debugMode`,
  `randomDraw`, the draw execution is paused at or `null`, and `forcedRandomChoices`. `stageProjection()`, `mediaPlaybackProjection()`, and
  `permanentButtonProjection()` give what the functions of those names give for a snapshot, also detached and frozen.
  `callReturnInstructions()` gives where each active call continues when it returns, outermost first, in work
  proportional to the call depth. For a debugger, `callStack()` gives each active call's kind, function, call site,
  return position, scope depth, and the kind of block that interrupted it, also in work proportional to the call depth;
  `variablePreviews()` gives the globals, scopes, and kept scopes with bounded previews of their values, and the current
  text of each message with a handle, in work proportional to the number of variables and those texts, not to the size
  of the values; and `temporalPresentation()` gives the date and time presentation in force. `inspect()` returns `inspectRuntimeState`'s detached debugger inspection after capturing and validating the
  whole state. Storage and other script data are read from an export.
- **Boundaries.** `exportSnapshot()` and `exportCheckpoint()` capture and completely validate the state and return plain
  data that later operations do not change; importing it again crosses the external-data boundary. For trusted hosts
  only, `exportTrustedSnapshot()` returns the same JSON as `exportSnapshot()`, copied without capture or validation,
  which shares nothing with the session: for a host that keeps the snapshot itself, such as a search frontier. It is not
  a boundary; the snapshot is captured and validated wherever it crosses one later, such as `createRuntimeSession`.
  `exportTaggedSnapshot()` returns that JSON, written without capture or validation, with a `tag`, SipHash-2-4 of the
  JSON's UTF-16 code units under a random 128-bit key that the process keeps for the session's plan object and never
  exposes. `createTaggedRuntimeSession(plan, tagged)` runs the JSON without capture or validation only when the tag
  proves that a session of that same plan object exported it in this process; it captures and completely validates any
  other input, such as changed JSON, a changed tag, another plan, or another process's export. Either way the state is
  the one `createRuntimeSession(plan, JSON.parse(json))` gives.
- **Failures.** A structured runtime failure, such as `TSR037`, commits the failed state as in the snapshot API. An
  operation that throws, such as `TSR101` when an event sequence runs out or a host callback's error, ends the session:
  the error reaches the caller, and every later call, including `view`, the exports, and `fork`, throws
  `RuntimeSessionError` with that error as its `cause`, because the operation may have changed part of the state. The
  caller continues from its last export or checkpoint. Malformed options, an invalid `instructionBudget`, a
  `capturedMedia` without `holds`, and malformed session `capabilities`, such as a builtin that is not a function, throw
  before anything runs and leave the session usable; the session reads each option once, so the value it checks is the
  value it uses. A typed refusal, such as `invalidPayload`, changes nothing the script can read. Like every operation,
  it drops the message, media, and timer records that nothing reaches, which only an imported snapshot can hold.
- **Forks.** `fork()` returns an independent session with a trusted copy of the state, which keeps the property order
  and therefore the checkpoint bytes, and shares only the immutable plan and deeply frozen temporal contexts. It keeps
  each of the parent's capabilities, `builtins` and `random`, that its options do not give, and the parent's random
  control unless its options give `randomControl`; an injected `random` source stays external state that a fork does
  not copy.
- **Traces.** A host passes the same `RuntimeDebugContext` to a session's successive operations as to successive
  snapshot results; an operation on another session, such as a fork, starts an `attach` epoch.

The same plan, starting state, and operations give the same results, events, outcomes, and checkpoint bytes through a
session as through the snapshot API, including across `exportCheckpoint` and restore. A session adds no plan,
snapshot, or checkpoint field.

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

The low-level `RuntimeCapabilities.random` hook is a compatibility/testing override. Without it, execution advances the serialized `xorshift32-v1` state. An injected random source must return a finite number in the half-open range `[0, 1)`. It does not cover glob destinations and timer rounds, which always use the serialized state, and [controlled randomness](#controlled-randomness) refuses it.

The override's own state is external to the runtime snapshot. A checkpoint is therefore not self-contained with respect to an arbitrary injected random source. Canonical checkpoint-equivalence guarantees use the serialized runtime RNG; tests that use the override must explicitly recreate an equivalent deterministic external source.

Future player capabilities must return typed, validated, JSON-safe outcomes correlated to one action ID and obey
any separately justified capability/interaction boundary. Raw DOM exceptions, browser handles, streams, callbacks, and
mutable host objects do not enter the snapshot.

Under ADR 0017, Standard Library and package-library wrappers may call documented typed capabilities, but they do not bypass these boundaries or become alternate owners of canonical action state.

## Controlled randomness

Owner decision, 2026-10-07 (#512): a host may decide the outcome of a random draw: leave it natural, choose another
outcome the draw can produce, or pause the engine at it (`src/runtime/random-control.ts`). It is opt-in host control,
not language; without it every draw is natural and costs one more check.

- **Draws.** A draw is one random operation as the script sees it: `random()`, `chance`, `randomInteger`, list and set
  `.random`, the element `${...}` selects from a list, a tagged image or script pick, `randomWeighted`, `randomNormal`,
  `randomBeta`, `randomPert`, a `shuffle()` of two or more items, a timer's ranged duration and each next round of a
  repeating ranged timer, and a glob destination of `goto`, `call`, or the fallback at `end`. Its `kind` is the debug
  trace's operation name; its `site` is `path:line:column` in its file, counted from 1 (a timer round uses its timer's
  duration, a glob its statement), and `listRandomSites(plan)` lists every site with its kinds and `endLine` and
  `endColumn`, where the draw's source ends, exclusive, so a host can mark it; a site with several kinds ends where its
  first one does. Its `drawId` is the generator state before it: one execution path never meets an ID twice, and a
  restored or forked session meets the same draw with the same ID.
- **Natural first.** The engine samples the natural result first, with exactly the generator steps it always takes; a
  chosen outcome replaces only the result. The generator advances as for the natural draw, so later draws stay the
  same until the chosen outcome changes what runs.
- **Control.** `randomControl: { filter?, decide? }` is a session option and an option of the snapshot API's `run`,
  `stepToEvent`, `executeInstruction`, `observeTime`, `reportMediaLoad`, and `resumeRandomDraw`. `filter.sites` and
  `filter.kinds` select the draws the host decides, both when both are given; an absent list matches every draw and an
  empty one none. Other draws are natural. An unknown site or kind, or control together with an injected
  `capabilities.random`, throws before anything runs. `decide(draw)` answers a selected draw at once with
  `{ kind: "natural" }`, `{ kind: "choose", outcome }`, or `{ kind: "suspend" }`; without it every selected draw pauses.
  It gets a deeply frozen draw view and must not call the session. An exception from it, or from reading the decision it
  returns, ends the operation as a `RandomDecisionError` with that cause, also at a built-in draw such as `random()`,
  where other host exceptions become script failures. The engine reads a chosen outcome's `kind` and the field that kind
  holds once, into a copy, checks and uses only that copy, and counts the outcome's own keys only after the copy passes.
  An outcome the draw cannot produce pauses the draw instead, and the result's `randomRefusal` says why.
- **Outcomes.** A draw view holds `drawId`, `site`, `kind`, its `support`, and its `natural` result, as outcomes, not
  generator numbers. The support is one of: `unit`, `[0, 1)`; `chance` with its percent, where 0 gives only `false` and
  100 only `true`; `integer`, `min` through `max`, also a timer's seconds; `candidates`, chosen by index, where equal
  values stay distinct; `weighted`, where weight 0 cannot be chosen; `normal`, any finite number, only the mean at
  spread 0; `beta`, `[0, 1]`; `pert`, `[min, max]`; or `order`, a new order as old indexes. An outcome is
  `{ kind: "number", value }`, `{ kind: "boolean", value }`, `{ kind: "index", index }`, or `{ kind: "order", order }`.
  A natural `randomNormal` that overflows keeps its `TSR036`, which a chosen finite value replaces.
- **Inputs.** An accepted chosen outcome, also one equal to the natural result, is a host input: the result lists it in
  `randomChoices` as `{ drawId, site, kind, outcome }`, the snapshot counts it in `randomControl.forcedChoices`, and
  its debug-trace record says `forced`. A natural resolution leaves nothing behind: a run that pauses at every draw and
  resolves each naturally reaches the same events and state as a run without control. The same operations with
  `replayRandomChoices(receipts, pauseAt)` as their control, which chooses each receipt's outcome at its `drawId`,
  pauses at `pauseAt`, and leaves every other draw natural, reach the same state as the original run.
- **Pause.** A paused draw undoes the unit it belongs to, its instruction or a ranged timer round during catch-up, and
  the snapshot keeps `randomControl.pending`: the draw, the operation it interrupted with its instruction budget, the
  outcomes chosen for earlier draws of the unit, and what the host builtins the unit already called returned. The state
  is the one before the unit, so its instruction has not run yet. `view().randomDraw` and `pendingRandomDraw(snapshot)`
  give the draw. Meanwhile `run`, `stepToEvent`, and `executeInstruction` execute nothing, `runnable` is false, and every
  other host operation refuses with `{ kind: "randomDrawPending", drawId }` and changes nothing; reads, exports, and
  `fork` stay available.
- **Resume.** `resumeRandomDraw({ drawId, outcome })`, with `"natural"` or a chosen outcome, refuses a request that does
  not fit the paused draw with `noPendingDraw`, `staleDraw`, or `invalidOutcome`, which change nothing. Otherwise it
  executes the unit again from its start: its earlier draws take their recorded outcomes without asking the host, its
  builtins return their recorded results without being called, so a restored session need not register them, and the
  paused draw takes the resolution. The interrupted operation then finishes within its own budget: `run` runs on,
  `stepToEvent` stops at its event, `executeInstruction` stops after its instruction and catch-up, and catch-up
  continues to the observed time. The outcome is `{ kind: "resolved", forced }`. A paused draw resumes on the session
  generator, so this throws with an injected `capabilities.random`.
- **Exploring.** A host branches by forking a session at a paused draw and resolving the draw differently on each
  fork. `randomDrawAlternatives(draw, limit = 16)` gives the outcomes to try besides the natural result, which
  `"natural"` tries without recording an input: a finite support in order up to `limit`, otherwise representative
  values, such as both ends and the middle of a large range or the mean and one and three spreads either side for
  `randomNormal`. Its `complete` says whether the natural result and the alternatives are every outcome the draw can
  produce.
- **Undoing a unit.** The engine restores the generator, the event sequence, scene time, and the loop frames, and drops
  the unit's events and trace records. A unit that can change other state before one of its draws keeps a copy of the
  state while control can pause: an instruction with a list, set, dict, timer, or media method, `removePermanentButton`,
  or a `timer.remaining` assignment followed by a draw; an `end` that leaves its activation before drawing a glob
  fallback; and the return from a timer, media, or button block, whose catch-up may draw.
- **Restore.** Validation checks a pending draw's support and outcomes, its site among the plan's sites, its natural
  result sampled again from its `drawId`, and a continuation that fits the state. If executing the unit again does not
  reach the draw as recorded, at its site and with its natural result, which only data the engine did not make can
  cause, the call throws `TSR101`.

## Date and time context

Date and time values ([§35](specifications/accepted-syntaxes-v30.md#35-date-time-and-durations)) need the
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
- `namedZones`, left out when empty: the rules, like `zone`, of zones the script names with `zone:`
  ([ADR 0026 §9](decisions/0026-unified-time-semantics.md#9-anchored-conversion-and-explicit-time-zones), pending owner
  acceptance), each under the name as the script writes it. The plan lists those zones in `timeZones`, without `UTC`,
  whose rules are built in, and a context may hold only zones the plan lists. A conversion through a listed zone whose
  rules the context lacks fails with `TSR063` when it runs.

`captureTemporalContext(timeZone, locale, namedZones?)` builds the context from the host's `Intl` data. Zone offsets are
sampled daily and each change located by bisection, so two changes less than a day apart that cancel each other out are
not seen. Fresh-session creation rejects a malformed context with `RangeError`; restore validates it like other snapshot
state. Without a context a session uses UTC and locale-neutral text such as `2026-10-04 18:30`.

Each capture records a context, the UTC wall clock (or `null` when the host supplied none), its boundary scene time,
and the session's next event sequence when it was recorded. Session start records the first capture at
`initialSessionTimeMs`. When the player continues a restored session, the host calls
`recordContinueCapture(plan, snapshot, { wallClockMs, temporalContext? })`, which executes nothing, and then runs the
session before the scene clock resumes; this recorded input takes effect at the saved `observedSessionTimeMs`, and a
new context may be omitted to keep the earlier one. Restore itself records nothing.

- Execution at scene time `t` uses the last capture whose boundary is not later than `t`, so saved catch-up before the
  boundary keeps the earlier capture and execution from the boundary on uses the new one.
- `getAbsoluteDateTime()` is the capture's wall clock plus the scene time since its boundary, rounded to whole
  milliseconds; it never goes backwards within one capture. `getDate()`, `getTime()`, and `getDateTime()` read that moment through the
  capture's zone. Without a clock they fail with `TSR064`.
- Interaction buttons keep the presentation they were shown with: validation derives them again with the capture in
  force at the interaction's `createdAtMs` among those recorded before its request event, and rejects a snapshot that
  no longer has that capture.
- A capture replaces the previous one only when nothing happened in between. Recording a capture drops captures no
  open interaction, current execution, or saved catch-up can use any more.

The Player resolves the host's account setting, else the browser's zone and language, captures the rules of the plan's
`timeZones` that the browser knows, and then reads `Date.now()`, when Start creates a session and again at Continue. The
compiler accepts only zone names that its host's `Intl` data knows, and the Player compiles in the browser that captures
them.

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

Each `storageLoad` carries `type`, the type its `load` reads the stored value as, or `null` for a load the compiler
cannot type ([ADR 0021 §6](decisions/0021-static-types.md)). A stored value that does not fit it is ignored for that
load: developer warning `TSW016` at the load, then the default; the entry stays in the view.
`InstructionPlan.storageTypes` lists, unique and in key order, the type that every typed load of a storage key written
as a string literal accepts; every non-null saved value under such a key, also through a computed key, must fit it, or
the `save` fails with `TSR058`, after `TSR055` for a value that cannot be stored. Host storage and debugging edits may
hold any storable value; each load decides whether it fits.

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
data; reconciliation belongs to #469 and is not implemented here. Later durable-store changes do not update a session's
view by themselves. Replacing the durable store, as a saved-data import does
([transfer](DATA-AND-API.md#saved-data-transfer)), never changes it: the Player ends a session in progress first, and
the next fresh session loads the replaced values.

A debugging tool changes the view only through `applyExternalStorageEdit(plan, snapshot, { key, value })`
([DEBUGGER.md](DEBUGGER.md#player-debug)): a host input, not author syntax. The request is captured as external data
and must be exactly `{ key, value }` with a string key, any string, and a value that `validateScriptStorageEntries`
accepts, or `null` to remove the key; otherwise the outcome is `invalidEdit`. An ended or failed session refuses it
(`invalidState`), and so does a pending `storageWrite` (`storageWritePending`): the host acknowledges that write with
`completeAction` first, runs nothing, and then edits, so the edit follows the write and precedes any further script
code. An accepted edit applies at the current instruction boundary, also while scene time is behind the observed time
or a block is due; this is a deliberate debugging exception to observed-time input ordering, so a due block that has
not run yet reads the edited value. It writes a copy of the value into the view, emits one `scriptStorageEdited`
event (`key`, `operation` `set` or `delete`, and the current and observed scene times; the value stays in the recorded
input), executes no instruction, and changes nothing else: values already loaded into variables, temporaries, or
prepared results keep what they loaded. The edited view is ordinary checkpoint state, so restore reproduces it without
applying the edit again; replaying the recorded input from an earlier anchor reaches the same state. It adds no plan,
snapshot, or checkpoint revision.

## Debug mode

The protected `debugMode` ([V30 §38](specifications/accepted-syntaxes-v30.md#debug-mode)) lowers to the plan leaf
`{ kind: "debugMode" }`, which reads the snapshot's `debugMode` boolean at evaluation, never a compile-time constant.
`FreshRuntimeOptions.debugMode` gives it at Start (default `false`); `setDebugMode(plan, snapshot, enabled)`, a host
input like a storage edit, changes it at the current instruction boundary. It executes no instruction, emits no event,
and changes nothing else; setting the value it has changes nothing. A value that is not a boolean is refused
(`invalidRequest`), and an ended or failed session refuses it (`invalidState`). The field is checkpoint state, so restore
reproduces it, and replaying the recorded input from an earlier anchor reaches the same state. In the
[value trace](#debug-trace) a read has no recorded origin.

## Camera capture

`takePhoto()` implements specification
[§33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references). It is a reserved
call, not a builtin: hosts cannot inject or override it, it takes only an optional `tags:` list (`TSV020` otherwise;
[§41](specifications/accepted-syntaxes-v30.md#image-tags) gives its validation and catalog rules), it is not a value
(`TSV028`), and it cannot run in a parameter default (`TSV032`). It lowers to a `capture` instruction whose result is handed off
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

## Image input

`askImage(...)` implements the image input of specification
[§20](specifications/accepted-syntaxes-v30.md#image-input). It is a reserved call like `takePhoto()`: not a builtin
(`TSV028` as a value, `TSV032` in a parameter default). It takes its message, the question, first, positionally or as
`message:`, then `hint:`, `allowCamera:` and `allowFile:` (both `true` by default) and `types:` and `mime:`, non-empty
lists of extensions
such as `".png"` and image MIME types such as `"image/png"`; `invalidMessage:` and `invalidLlmInstruction:` are not
supported yet (`TSV022`). The compiler checks written values (`TSV043`, also for both sources written `false`).
Computed arguments are evaluated once, in source order, into one prepared request that the runtime checks when the
request opens: a source or filter value it cannot use, or both sources off, fails with `TSR052`, and the question and
hint must be showable text like an input hint. Like a basic ask, it says its question, read from the prepared request
with `prepareSayText` and `field: true`, after the arguments and before the request opens. Plan validation rejects an
unlowered call.

It is a mandatory `image` interaction with result domain `string`. Its UI carries `question`, `hint`, `allowCamera`,
`allowFile`, `types`, and `mime` (`null` without a filter); the Player shows the question on the camera viewfinder and
the hint as the composer's help; while it waits, its request temporary keeps that request, so restore
checks the pending action against it. The host answers through `completeAction`:

```text
{ actionId, actionKind: "interaction", interactionKind: "image", payload: { kind: "image", reference } }
```

The reference is accepted only when `ActionCompletionOptions.capturedMedia.holds(reference, "image")` vouches for it;
any other answer leaves the request waiting, and there is no cancellation result. The host applies `types` and
`mime` before it stores an image; the engine sees only the reference. The result is the reference, the player
transcript shows `Image`, and like other interactions the request may be interrupted by a timer expiry block,
survives checkpoint and restore, and replays a repeated completion as `alreadySettled`. The Player stores a chosen
image or a photo taken for the request as session media with the lifecycle of a `takePhoto()` photo; see
[Player UI](ui/PLAYER-UI.md#foreground-interaction-presentation) for its file and camera routes.

The Player opens the session camera after Start when the trusted host grants the camera capability, answers each capture
once from that open stream, and delivers the answer until the runtime settles it. Captured photos are session media; a
save stores the photos its value references durably before the value is persisted
(`player/captured-media-persistence.ts`); when that fails, the host acknowledges the `storageWrite` as `failed`, so the
previous value is kept as for any failed persistent write. Media no saved value references, nor a session the Player
keeps for a reload ([Session start](ui/PLAYER-UI.md#session-start-and-user-activation)), is reclaimed
opportunistically when a Player opens while no Player of the same scope is live in any tab (Web Locks) and the saved
values can be read completely; without Web Locks it is not reclaimed, and while a Player lives nothing is deleted. The
technical playground has no camera and answers a pending capture as `unconfigured` when execution continues.

## Forms

A form is the `form` interaction of [V30 §20](specifications/accepted-syntaxes-v30.md#forms): one pending action whose
fields the player edits until submitting. It is always prepared: after the requesting speaker, `askForm` evaluates its
question and named arguments once, in written order, into one request temporary (`message`, `fields`, an object or
dict, and optional `hint`, `submit`, and `outro`), says the question from it like a basic ask, and opens the form.
`askBooleans`, an ask in both forms like `askForm`, lowers the same way with its `message`, `texts`, `defaults` (its
`prefill:` list), and `cancel` as the request and the `booleanList` shape; plan validation rejects an unlowered
`askBooleans` call. The prepared UI carries the result `shape`: `object` with the `numericKinds` of named fields, `dict`
with one `numericKind` or `null`, `booleanList`, or `unknown` when the compiler cannot tell whether `fields` is an object
or a dict, as for an untyped parameter: such a form opens with the shape of the value, without number kinds or answer
types. A runtime number does not record whether it is an `integer` or a `number`, so the compiler supplies the
kind for a field whose number gives its kind; a field without one needs `type:`. The shape also carries the answer type
the compiler gave each named field (`answers`), or every dict field (`answer`, `null` for any), as a type plan; when the
form opens, each field's possible answers (a toggle's states, each cycle option, a value of a typed field's kind, and
`null` for an optional one) must fit it, or the form fails with `TSR058` naming the field. A computed descriptor may hold
properties its type does not show, so this check keeps every answer within the type the script relies on; restore
repeats it. When the form opens, the runtime builds
and checks every field in order (an invalid one fails, mostly with `TSR052`, and the message names it), and the request
temporary then holds the canonical definition, so restore checks the pending form against it. As it opens, the asking
speaker says the fields' descriptions and the outro in one `say` event with prose presentation, a line
`<label> — <description>` per described field and the outro as the last paragraph, before `actionRequested`; a
description is text shown as `say` shows it, and nothing is said without either. The compiler's type check gives the
result its type: a property per field, typed by the field's start or written descriptor, or for a dict of fields a dict
of the answer type its values give every field, or of the generic answer union when that kind is not known.

The action's UI is the definition: `shape`, `fields`, `hint`, `submit`, and `cancel` (a button, or `null` when the
form must be submitted). A field has a unique `id` (the property
name or dict key; `askBooleans` numbers its fields `0`, `1`, ...), a `text` label, a `kind` (`boolean`, `cycle`,
`integer`, `number`, `text`, `date`, `time`, or `datetime`), and an optional `background`. A toggle has `options`,
`null` or one `false` and one `true` choice option; a cycle has non-null `options` of one type; a typed field has
`optional`, `min`, `max` (numbers only), and `hint`. The action's `form` holds the answers: `values`, per field a
toggle's boolean, a cycle's option index, or a typed value or `null`, and `editor`, the field being edited with its raw
text, or `null`. Raw text such as `-` or `1e` is a valid draft, not an answer.

`updateInteraction` edits the foreground form without settling it:

```text
{ actionId, actionKind: "interaction", interactionKind: "form", update }
update: { kind: "select", fieldId, optionIndex }  // a toggle (false at 0, true at 1 without options) or cycle option
      | { kind: "edit", fieldId }                  // open a typed field with its value as text
      | { kind: "draft", fieldId, text }           // the text of the field being edited
      | { kind: "commit", fieldId }                // check the text; blank unsets an optional field
      | { kind: "clear", fieldId }                 // unset an optional field
      | { kind: "dismiss", fieldId }               // drop the text being edited
```

Every edit is absolute, so a repeat changes nothing and returns `unchanged`. Opening, selecting, or clearing another
field first commits the text being edited; invalid text, also blank text for a required field, refuses the edit. A
refused or malformed edit returns `invalidPayload` with a message and changes nothing. An edit keeps the
action, its continuation, and its destination; it publishes no event, records no settlement, uses no randomness, and
does not run the script. The Player sends the composer's text as `draft` shortly after typing pauses and before any
other edit of the form, so a checkpoint keeps the text being typed. A suspended form returns `suspendedAction`; otherwise the outcomes are those of
`completeAction`. Focus, caret, and other browser state stay outside canonical
state.

`completeAction` with `payload: { kind: "submit" }` commits the text being edited, requires a value for every required
field, and settles with the answers in field order: an object of properties, a dict of entries, or a list of booleans,
with `null` for an optional field without a value. The transcript is the plain text of the summary of every field
([V30](specifications/accepted-syntaxes-v30.md#forms)), with a date or time answer in the player's presentation at
completion, as a date or time ask's line is; answers too long for one transcript line are refused. The text is built
from the form's state, which tells cycle options with the same value apart. The settlement records that too, as
`shownOptions`: for each field the position of the option a cycle showed, else `null`, and `null` as a whole for a form
that returned `null`. The Player rebuilds the per-line summary from the settlement's definition, result, and shown
options. A refusal leaves the form open.
The settlement records the definition, and validation checks its result and shown options against it (each shown
option has its field's answer as value) and its transcript as text, since a later capture may change the presentation;
the result handoff is checked against the plan's shape.
A form with `timeout` and `onTimeout` carries its limit in its UI as `timeout: { milliseconds, onTimeout }` and as the
action's `timeoutMs`; like a button's timeout, reaching `createdAtMs + timeoutMs` is a time settlement (`timedOut`,
no transcript) whose result is the answers as they stand, without the draft, or `null`.
`completeAction` with `payload: { kind: "cancel" }` cancels a form that has a cancel button, also while text that is
not an answer is being edited: it drops every edit and settles with `null` and the cancel button's text as the
transcript.

## Camera view

`showCamera [stage]`, `hideCamera`, and camera view handles implement specification
[§22](specifications/accepted-syntaxes-v30.md#camera-view). `showCamera` lowers to a `showCamera` instruction with its
`placement` and, used as a value, a destination temporary for the handle; `hideCamera` lowers to `hideCamera`. Both, and
a `placement` write, follow a pacing barrier like the Stage image. Executing them changes `RuntimeSnapshot.cameraView`
at once: the instruction never waits for the host, and the runtime does not know whether a camera exists. The snapshot
keeps one record for the default camera from the first `showCamera` on, so handles stay readable after `hideCamera`;
`exit` sets it hidden. A handle is `{ kind: "cameraView" }`; snapshot validation requires the record wherever a handle
is held. The Player shows the view whenever the restored or current snapshot says so and it has an open session camera.

## Message handles

A `say` used as a value ([V30 §37](specifications/accepted-syntaxes-v30.md#updatable-messages)) lowers to a `say`
instruction with a `destinationTemporary`: it puts a message handle there once its message is shown.
Direct output and instant output that supersedes a pacing gate show it at once. Output staged behind an earlier gate
gives no handle and creates no record until the gate releases it; its prepared output keeps the markup source of its
text as `sourceText` meanwhile, which snapshot validation requires exactly for a result-bearing `say` and checks against
the prepared content with the one markup parser. A handle is `{ kind: "messageHandle", messageId }`, the sequence of the
message's `say` event. Every copy names the same message, `==` compares that identity, and `say` shows the handle as
`<message N>`; it has no scalar text. Like other runtime identities, host values, built-in results, and stored values
cannot hold one, and `save` refuses one with `TSR055`.

`RuntimeSnapshot.liveMessages` holds `{ messageId, sourceText }` in ascending ID order: the markup source of the current
text of each message that a handle in the state reaches through the roots snapshot validation checks for runtime
identities (scopes, retained scopes, globals, speaker properties, `for` sources, temporaries, and each call frame's saved
temporaries and supplied arguments). Before it returns, every public operation drops the records no handle reaches; a
handle to such a message cannot appear again, so where an operation boundary falls does not change the state. Snapshot
validation requires unique positive IDs below `nextEventSequence`, text sources, and a record for every handle; a record
no handle reaches is accepted and dropped by the next operation. Restore emits, sweeps, and observes nothing.

Reading `.text` returns the source. Assigning it takes text (`TSR050` otherwise); another property fails with `TSR003`
or, read, `TSR017`, and a handle without a record with `TSR053`, all before anything changes. The same text again
changes nothing. Different text is parsed whole, emitted as a `messageUpdated` event (`messageId`, parsed `content`,
visible `text`, and the write's `span`), and becomes the record. No pacing gate starts, ends, or moves. The debug trace
keys a message's text by its ID and indexes each change as the output record of its event; `recentMessages` lists the
messages it has records of most recently, each once by its latest record. A reference prepared through `.text` keeps
the text read then, as for a text variable.

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
scopes of the running function or root, then for a timer, media, or button block among the variables it shares
([Shared block variables](#shared-block-variables)), then, unless the running function or block is global, in the root
of the activation it runs for, and then among the globals. Start values are evaluated without random selection: a list of
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
[§35](specifications/accepted-syntaxes-v30.md#35-date-time-and-durations): dates and times use the session's
captured presentation, and an `absoluteDateTime` shows its local date and time in the captured zone (see
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
- Button labels, ask questions, input hints, and the `text` of a choice object reject a list with `TSR021`, timer labels
  with `TSR050`, and speaker names and titles with `TSR030`; a list the compiler can see there is compile error
  `TSV040`, and another value they cannot show `TSV042`. Materializing an interaction draws no RNG.
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
The failure points at the innermost loop of the running call when execution runs inside one, and otherwise, as while a
waiting session catches up timer blocks, at the next instruction. Fresh snapshot creation validates the plan,
serializable globals, script storage, call-depth limit, and RNG seed before returning state.

Live externally supplied instruction plans, runtime snapshots, globals, script storage, and serializable runtime values
are captured into stable plain-data graphs before detailed validation, freezing, state construction, execution, event
emission, or RNG consumption. Capture rejects accessors, failed traps, cycles, unsupported prototypes, non-finite
values, and non-canonical arrays without imposing a generic graph-work or nesting ceiling. Compiler-owned plans are
validated directly. Runtime entry points reuse an exact immutable plan graph, and the facts that snapshot validation
derives from that plan alone, after complete validation has established process-local evidence for that graph; compiler
output and plans returned from capture or checkpoint restore can retain this evidence across calls. A caller-owned plan
without that evidence is captured and validated at every entry. Snapshot-taking operations always freshly capture and
completely validate their supplied snapshots, including mutable snapshots returned by an earlier operation and snapshots
whose status is halted or failed. Engine-owned sessions capture and completely validate imported snapshots at creation
or restore; between those boundaries their operations run on private canonical state without repeating whole-snapshot
capture or validation, while host requests, observations, values, and capability results keep their complete capture and
validation ([Runtime sessions](#runtime-sessions)). Runtime and checkpoint operations also reuse a plan already captured
and validated by that operation when validating the snapshot, and checkpoint data freshly produced by `JSON.parse(...)`
goes directly through complete structural validation. Checkpoint restore validates its envelope, plan, snapshot, and
their consistency before execution resumes. A generic capture depth/work or detailed-validation counter alone does not
make otherwise structurally valid data malformed. Malformed or inconsistent plan and snapshot data still produces the
existing public invalid results, `TSR100`, `TSR101`, or `TSK002`. The compact user-function call representation and its
format consequences are described under [Format evolution](#format-evolution).

Serializable-set validation and rebuilding use linear native membership tracking while retaining the insertion-ordered `items` array as the canonical serialized representation. Scalar equality and duplicate handling are unchanged.

A session halts only through `exit`: a halted snapshot is accepted only immediately after an `exit` instruction. Halted snapshots must also retain no active call frames, loop frames, temporaries, nested scopes, contextual speaker, or failure state. These checks establish that the serialized state is a possible current runtime state; they do not authenticate its execution history.

Persisted runtime counters, identities, instruction positions, collection-iteration positions, depths, temporary IDs, warning-deduplication IDs, speaker references, and source-span positions must be JavaScript safe integers in their existing non-negative or positive ranges. Ordinary finite script numbers retain their existing semantics. The allocator counters `nextEventSequence`, `nextScopeId`, `nextSpeakerId`, and `nextCallFrameId` may hold `Number.MAX_SAFE_INTEGER` as stored state, but an operation that would increment such a value is rejected with `RuntimeDataError` `TSR101` before an event sequence or runtime identity is reused.

The accepted `nextActionId` follows the same no-reuse and pre-increment failure rule. `lastSettlement` is bounded to
one record. `currentSessionTimeMs` is finite, non-negative, persisted, and subject to its accepted representation and
deadline-arithmetic domains.

## Runtime errors

A runtime failure (`RuntimeErrorInfo`) has a `code`, a `message`, and the `span` of the failing source. Owner decision,
2026-10-09: like a compiler diagnostic, a message says what went wrong and why, naming the real operand or value, and
what to do about it, in whole sentences without semicolons. It quotes source in single quotes, as in `'total / count'`,
and shows a long value only as a bounded preview. It uses only names and values the engine has already evaluated. The
engine source owns the exact text, and a failure that a checkpoint or debug export already recorded keeps its message. A code marked _defect_ means
that the plan, the engine's state, or the host is wrong rather than the script: continue from an earlier checkpoint or
restart, and report the failure with its debug export.

| Code | What failed | What to do |
| --- | --- | --- |
| `TSR001` | A global, speaker, variable, or parameter is set up twice in one scope. _Defect._ | Report it. |
| `TSR002` | An assignment names no variable. _Defect._ | Report it. |
| `TSR003` | An assignment to a property that the value or handle does not allow. | Assign a property the message names. |
| `TSR004` | An index on a set, which has no positions. | Copy it into a list with `toList()`, or test with `contains(...)`. |
| `TSR005` | An index assignment on a value that is not a list or dict. | Assign to a list element or a dict entry. |
| `TSR006` | An unknown name. _Defect._ | Report it. |
| `TSR007` | An object or speaker with the same property twice. _Defect._ | Report it. |
| `TSR008` | An index on a value that is not a list or dict, or on a list that the same statement replaced. | Index only lists and dicts, and make such a change in a separate statement. |
| `TSR009` | An operator that cannot combine its operands, such as values of different kinds, a calendar duration ordered against or divided by a duration or one of another family, a date or a date and time moved by a duration, or a calendar duration divided by zero. | Check or convert the operand the message names. |
| `TSR010` | A named argument given twice. _Defect._ | Report it. |
| `TSR011` | A call of a built-in function the host does not provide, or, in a plan compiled before `TSV019` rejected it, of a name that is not a function, such as `(x)()`. | Call a function by its name. |
| `TSR012` | A host built-in failed. | Check the values the script passes, or report a host failure with a debug export. |
| `TSR013` | A host built-in returned a value a script cannot hold. | Report it to the host. |
| `TSR014` | A call of something that is not a function or a method, such as `items[0]()`, in a plan compiled before `TSV019` rejected it. | Call a function by its name. |
| `TSR015` | Named arguments where a call takes only positional ones. | Remove the names. |
| `TSR016` | A method the value does not have. | Use a method the message names. |
| `TSR017` | A property the value does not have. | Use a property the message names. |
| `TSR018` | Too few elements: an empty collection, or fewer values than a statistic needs. | Check the length first. |
| `TSR019` | A random selection from an empty list or set. | Check that it has an element first. |
| `TSR020` | The host's random source returned a number outside the range from 0 (inclusive) to 1 (exclusive). | Report it to the host. |
| `TSR021` | A value that cannot be shown as text, such as a dict or a list inside a list. | Select an element or a property. |
| `TSR022` | A speaker whose `displayName` is empty. | Give it a name, or leave `displayName` out. |
| `TSR023` | A speaker that the session does not have. _Defect._ | Report it. |
| `TSR024` | A list index or text position that is not a whole number. | Round it with `floor(...)`, `round(...)`, or `ceil(...)`, or convert numeric text with `toInteger(...)`. |
| `TSR025` | A list index or text position outside the valid range, a text end before its start, or a list element that a statement changes but that the same statement removed. | Check it against `length`, and an end against its start, first. |
| `TSR026` | A condition or an `and`, `or`, or `not` operand that is not true or false. | Compare explicitly, as in `x != 0`. |
| `TSR027` | An arithmetic operand or range bound that is not a number. | Check for null, or convert numeric text with `toNumber(...)`. |
| `TSR028` | Too many or too few arguments, or arguments in the wrong form. | Write the call as the message shows. |
| `TSR030` | A speaker property shown in output that is not text. | Set the property to text. |
| `TSR031` | A value from the host with a cycle or another shape a script value cannot have. | Report it to the host. |
| `TSR033` | Leaving the root scope. _Defect._ | Report it. |
| `TSR034` | An assignment that replaces a speaker. | Change the speaker's properties instead. |
| `TSR035` | An operation the engine does not support for its operands, such as `in` without a range. _Defect._ | Report it. |
| `TSR036` | Arithmetic without a finite result: division or remainder by zero, a number or duration too large, a math function outside its domain, or a regression whose points all have the same x. | Check that the divisor is not 0, use smaller values, or pass values the function accepts. |
| `TSR037` | The instruction budget of one run is used up, usually by a loop that neither waits nor ends. | Add a wait, or check the loop's condition. |
| `TSR039` | A numeric argument outside its range, such as `chance(150)` or a negative weight. | Pass a value in the range the message gives. |
| `TSR040` | `randomInteger(...)` without a range. | Pass a range such as `1..=6`. |
| `TSR041` | A random selection from an empty range. | Use a range that holds at least one number. |
| `TSR042` | Loop state that does not match the plan. _Defect._ | Report it. |
| `TSR043` | A `repeat` count that is not a whole number of at least 0, or that is too large to count exactly. | Round, check, or reduce the count first. |
| `TSR044` | A `for` loop over a value it cannot go through, or a `for` with two variables over something other than a dict. | Loop over a list, set, dict, or range, and use two variables only for a dict. |
| `TSR045` | A range of a loop, a timer duration, or `randomInteger(...)` whose bounds are not safe whole numbers. | Use smaller whole-number bounds. |
| `TSR046` | A missing temporary value. _Defect._ | Report it. |
| `TSR047` | Calls nested deeper than the call-depth limit. | End the recursion sooner. |
| `TSR048` | Inconsistent parameter state. _Defect._ | Report it. |
| `TSR049` | A required parameter without a value. _Defect._ | Report it. |
| `TSR050` | A command or handle property with a value it cannot use, such as a wait, timer, media, or `showButton` duration, a `say` pacing, a timer label or display, a media volume, a camera placement, a message's text, or a speaker property such as `defaultSaySkippable`. | Use a value the message names. |
| `TSR051` | A runtime ID or event counter that is used up, or a function instruction outside a call. | Restart the session and report it. |
| `TSR052` | An interaction whose choices, form fields, prefill, image filters, or total text prevent it from opening, or a malformed prepared request. | Correct what the message names, or report a malformed request. |
| `TSR053` | A dict entry that a statement changes but that the same statement removed, or a handle or prepared reference whose state is malformed. | Make the change in a separate statement, or report a malformed state. |
| `TSR054` | A storage key that is not text. | Write the key as text. |
| `TSR055` | A `save` of a value that exists only in this session: a timer, media, or message handle, a speaker, a camera view, or a permanent button. | Save plain data, and recreate the session value after loading. |
| `TSR057` | A count or text argument that a text method or `take(...)` cannot use, such as a negative count or empty text. | Pass the kind of value the message names. |
| `TSR058` | A value that does not fit the type of its receiving place, such as a typed variable, parameter, result, form field, or conversion. | Convert or check the value, or declare a type that includes it. |
| `TSR059` | A built-in argument of the wrong kind. | Pass the kind the message names. |
| `TSR060` | A collection operation whose elements or argument have the wrong kind, or whose elements lack the property it reads. | Make the elements one kind the operation takes, or name a property they have. |
| `TSR061` | A dict without the key that is read. | Check with `contains(...)` first, or use `get(key, default: value)`. |
| `TSR062` | A dict key that is not text. | Write the key as text. |
| `TSR063` | A date or time that cannot be computed or shown, such as a year outside the supported range, a local time or month end that `disambiguation: "reject"` or `overflow: "reject"` refuses, or a conversion through a zone whose rules the host did not record. | Use a date and time in the range the message gives, or one the option accepts. |
| `TSR064` | The current time, when the host supplied no clock. | Run the script in a host with a clock. |
| `TSR065` | A calendar duration where a duration is needed. | Use a duration, such as `24 h` or `1 day`. |
| `TSR066` | A file ended without a calling file to return to. | Use `exit` where the session should finish. |
| `TSR067` | A start value that selects at random. | Select at random once the story runs. |
| `TSR069` | A `goto`, `call`, or `fallback` target that does not exist. | Name an existing file or label. |
| `TSR070` | A variable read before its `let` ran. | Give the variable a value before it is used. |
| `TSR080` | A tag's number compared with something other than a number. | Compare it with a number. |
| `TSR081` | A tag query option that is not a list of tag names. | Pass tag names, such as `"bedroom"`. |
| `TSR082` | No file or image has the tags of a query. | Relax the query, or add files with those tags. |
| `TSR083` | `takePhoto(tags:)` with something other than tags, or with two numbers for one tag. | Pass tags such as `"bedroom"` or `"punishment: 4"`, with one number per tag. |
| `TSR084` | A text longer than the maximum text length. | Build a shorter text. |
| `TSR100` | Instruction-plan data that fails validation. | Compile the script again. |
| `TSR101` | Runtime-snapshot data that fails validation, or a runtime counter that cannot advance. | Restore a valid checkpoint or start a new session. |

## Deterministic RNG invariant

The `xorshift32-v1` seed and serialized state must be non-zero unsigned 32-bit integers:

- `createXorShift32State(0)` and fresh runtime creation with seed `0` reject the seed;
- `nextXorShift32(...)` rejects direct malformed state `0`;
- `validateRuntimeSnapshot(...)` rejects a snapshot whose RNG state is `0`;
- checkpoint restore translates that malformed snapshot state into structured `CheckpointError` code `TSK002`;
- a valid non-zero seed produces the deterministic sequence of the versioned `xorshift32-v1` algorithm; a deliberate
  algorithm change uses a new algorithm version (ADR 0015) instead of changing the sequence under that identifier.

The zero-state rule prevents the absorbing xorshift32 state in which every future state and output remains zero. It does not change the plan, runtime-snapshot, or checkpoint format version.

## Debug trace

`RuntimeDebugContext` (`src/runtime/debug-trace.ts`) is an opt-in, host-owned record of why values have the values
they have. A host passes the same context as `debugTrace` to each operation on a session's successive results: in the
options of `run`, `stepToEvent`, `executeInstruction`, `runValidatedState`, `completeAction`, `observeTime`,
`reportMediaLoad`, `pressPermanentButton`, `recordContinueCapture`, `applyExternalStorageEdit`, `setDebugMode`, and
`updateInteraction`, and of the matching [runtime session](#runtime-sessions) methods. A Player session
carries it as `debugTrace`, like its debug recorder: `createPlayerRuntimeSession` and `restorePlayerRuntimeSession`
take it, `withPlayerRuntimeDebugTrace` turns it on or off, and every session operation passes it on. The trace is not
part of plans, snapshots, events, checkpoints, restore points, or recorded calls and changes no format: an operation
returns the same snapshot, events, random state, and checkpoint with or without it, and without it records nothing.

- **Observation only.** Records take values that execution computed anyway. The trace never evaluates an expression
  again, draws a random number, or reads storage. A recording failure stops the trace, which `status()` reports; it
  never reaches the script's execution.
- **Records.** Each has an ID, kind, target, source location from the plan's spans, scene time, value preview,
  dependencies, and detail. They cover declarations; assignments, including to a property, index, or dict key and
  compound ones, as a new version of the whole variable; collection methods that change their receiver; arguments,
  supplied and defaulted parameters, and returns; loop sources and loop variables; intermediate values the compiled
  code keeps; accepted answers and button timeouts, only on settlement, so refused and repeated reports record
  nothing; loads, with whether the key was stored and whether a default ran; storage writes, a persistent one once the
  host reports it stored, and a debugging tool's storage edits, which have no causes; random draws, with operation, choices, range, draw numbers, generator state before and
  after, and whether the host chose the outcome (one record for all draws of a shuffle; no state for an injected random
  source); the text of each `${...}`;
  each `say` message, by its event sequence; each change of a message's text, as the output record of its update event;
  and Stage image changes.
- **Identity.** A dependency names the record of the version actually read. Variables are keyed by scope ID and name,
  globals apart, so recursion, same-named variables, prepared references, and variables that blocks share keep their
  real target; temporaries by call frame and temporary ID; arguments by call frame and parameter; storage by key. The
  properties of a speaker, timer, media, message, permanent button, or the camera view, and the tagged photos, are state keyed by
  its identity, so every name for it reads the same versions. A property read takes the newest change that sets that
  property: its assignment, a timer or media method for the timed properties, or a declaration or `showCamera` for
  all of it. A change does not depend on the version it replaces, except that each tagged photo joins the earlier
  ones. A compiled copy of one value shares that value's record.
- **Staging.** Records made while a `say` or a speaker declaration is staged commit or vanish with it, and they and the
  stage's rollback bookkeeping count toward the bounds meanwhile. A message that waits behind pacing keeps its text's causes until it is shown.
- **Bounds.** At most 8,192 records or 8 MiB of accounted data (`RUNTIME_DEBUG_TRACE_LIMITS`), which drops the oldest
  records with their index entries, a record larger than the budget at once; a dependency on a dropped record reads as
  not retained. Previews and labels stop at 1,024 characters while they are written, a longer storage key is not
  indexed, and a record keeps at most 32 dependencies and counts the others as omitted.
  These are debugger tuning values, not language limits.
- **Epochs.** `reset("start")` and `reset("restore")` begin a new epoch and drop every record. So does an operation
  whose plan or input snapshot is not the context's last result: its origin is `start` for a fresh snapshot, otherwise
  `attach`. A value read without a recorded origin gets an `unrecorded` record: `external` after Start (a host value),
  `beforeDebug` after attaching, `restored` after a restore, and `unavailable` once older records were dropped.
  `status()` reports the epoch, its origin, its draws, the generator state it began with (the seed after Start), and
  the sequence of its first event, so that a host can tell a message shown before the epoch from one whose record was
  dropped.
- **Queries.** `record(id)` gives a detached JSON-safe view; `outputRecord(eventSequence)`, `outputs(limit)`,
  `variableRecord(scopeId | "global", name)`, `storageRecord(key)`, and `stageImageRecord()` give record IDs.
- **Branch decisions.** A variable write, `return` value, storage write, message, or Stage image names in `control`
  the innermost branch decision of the same call on whose taken side it happened: an `if`, `else if`, or `else`, a
  `switch` case or `default`, a `while` round, the right side of an `and` or `or` that a pausing operand compiles to
  instructions, or a `load` default. A `decision` record holds the condition's value and causes and names the decision
  it was made inside of; it is recorded when a write first names it, so a decision that governs no write leaves no
  record. Code of another call, such as a called function or a timer or button block, names its own decisions only. A
  decision is kept while execution is on its taken side, at most 256 at once, the newest; one dropped beyond that,
  such as an early case of a long chain of unmatched cases, leaves its later writes, and the decisions it enclosed,
  without a link to it, never with another's.

## Instruction trace

A development and testing aid, such as a coverage explorer: `run`, `stepToEvent`, `executeInstruction`,
`runValidatedState`, `stepValidatedStateToEvent`, and the session methods of those names take the option
`instructionTrace: true`, and their result then also holds `instructionTrace` (`RuntimeInstructionTrace`), what that
call executed. Both lists are in ascending order and hold each entry once, so the plan bounds their size.

- `instructions`: the plan index of every instruction the call executed, including one that failed. Starting a timer,
  media, or permanent-button block executes none; the block's own instructions follow.
- `branches`: `[instruction, next]`, the successor taken by an instruction that chooses it at run time:
  - `jumpIfFalse`, the condition of an `if`, `else if`, or `switch` case, the right side of an `and` or `or` that a
    pausing operand compiles to instructions, or a `load` default: `instruction + 1` when the condition was true,
    otherwise its `target`;
  - `loopStart`, which runs before each round of a `repeat`, `for`, or `while`: `instruction + 1` for a round, its
    `target` when the loop ends;
  - `transfer`, a `goto` or `call` naming a file or a `call label`, and `end`: where execution continued, such as the
    file a glob or computed target picked, the fallback, or the instruction after the `call` that `end` returns to.

The other operations execute no instruction: they settle actions, set where execution continues, or queue blocks, which
the next run or step executes and traces. The trace is not part of snapshots, events, or checkpoints and changes no
format: a call returns the same snapshot, events, and random state with or without it, and without it the result has
no `instructionTrace`. For a source location, `plan.instructions[index].span` holds the zero-based line `sl` and column
`sc` and the offsets `so` and `eo` in its file: `plan.files[instruction.file]` for a `declareGlobal` or
`declareSpeaker`, otherwise the file whose `startInstruction <= index < endInstruction`.

## Checkpoint boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify or persist after every instruction. A production runner may execute many instructions in memory until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

A checkpoint is currently a self-contained plan-and-snapshot bundle. Restore validates the checkpoint, instruction plan, snapshot, format versions, references, function/call progress, RNG state, and other structural invariants before execution resumes.

Under ADR 0016, restore of a valid waiting checkpoint remains waiting and preserves the same action, `currentSessionTimeMs`, settlement, and event identities. Restore does not read time or silently complete a deadline. After the restored-session activation gate, the Player application submits an explicit observation; the atomic observation operation persists the nondecreasing effective coordinate before settling due actions.

Without host builtins or a random source, as the Player runs it, execution reads no clock, randomness, or host state
outside the snapshot and the arguments of each operation, except a media store's answer whether it holds a
captured-media reference. Running the same operations with the same arguments
and store answers from a restored snapshot therefore reaches the same state and events; a debug export's replay relies
on this ([`DEBUGGER.md`](DEBUGGER.md#debug-export)). The Player records its operations beside the session, outside
runtime state, and recording never changes them.

## Format evolution

The code constants `INSTRUCTION_PLAN_VERSION`, `RUNTIME_SNAPSHOT_VERSION`, and `CHECKPOINT_VERSION` are authoritative for the numeric revisions accepted by the runtime. Accepted ADRs and canonical specifications remain authoritative for format semantics, architecture, and compatibility policy. This table is the single general human-readable summary of the current revisions:

| Format | Current revision | Reason for current revision |
| --- | ---: | --- |
| Instruction plan | 80 | Named time zones (#512, ADR 0026 §9): a plan lists in `timeZones` the zones its script names with `zone:`, which the host records. Revision 79: Timers in parameter defaults (#512): a parameter-default region may hold a `startTimer`, which previously failed plan validation. Revision 78: Explicit time units (#512, ADR 0026 §8): the `unit` expression turns the number its `operand` evaluates to into a duration in its `unit`, as in `count s`, or with `calendar: true` into a calendar duration, as in `count calendar days`. A number or a range without a unit given as a time, to `wait`, a timer, `say` pacing, a `showButton` or `askForm` timeout, or a media position, is now a runtime error; previously it counted seconds. A `wait` or timer with a `unit` takes a range counted in whole units of it; previously only a timer with `unit: "s"` took one. Revision 77: Exact days and calendar durations (#512, ADR 0026): a `duration` leaf holds only `milliseconds`, a `calendarDuration` leaf holds `months`, `days`, and `milliseconds`, `calendarDuration` is a type-check name and a choice value, and `wait` and timer units include `d` and `w`. Revision 76: absoluteDateTime (#512, ADR 0026): the type name `timestamp` and the constant value tag `timestamp` are now `absoluteDateTime`. Revision 75: Unknown form fields (#512): a prepared form's `shape` may be `unknown`, when the compiler cannot tell whether `fields` is an object or a dict, which previously failed plan validation. Revision 74: Block functions (#512): a function is the block of at most one timer, media, or button block, within a statement and across statements, which plan validation previously accepted. Revision 73: Preselected buttons (#512): a choice UI may carry `preselected`, the position of the button its `prefill:` preselects, and a prepared choice a `prefillTemporary`, and for `askBoolean` `booleanPrefill`, which previously failed plan validation. Revision 72: Stopping all audio (#512): the `stopAudio` instruction. Revision 71: Load types (#512): a `storageLoad` carries `type`, which it checks the stored value against, and a plan carries `storageTypes`, which saved values under a key with a type must fit. Revision 70: Debug mode (#512): the `debugMode` expression leaf, which reads the session's Debug state. Revision 69: Exponentials, logarithms, angles, and random distributions (#512): the built-ins `exp`, `ln`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `randomNormal`, `randomBeta`, and `randomPert`, which previously failed with `TSR011`. Revision 68: Message handles (#512): a `say` may carry `destinationTemporary`, where it puts the handle of its message once shown, and the `messageHandle` type-check name. Revision 67: Numeric and list functions (#512): the built-ins `abs`, `sign`, `sqrt`, `pow`, `mod`, `clamp`, `sum`, `average`, `median`, `percentile`, `stddev`, `linearRegression`, `predict`, and `randomWeighted`, which previously failed with `TSR011`; `round` with `decimals:`, `min` and `max` of one list, and the list methods `take` and `takeLast`, which previously failed with `TSR028` and `TSR016`. Revision 66: Form time limits (#512): a form request may carry `timeout` and `onTimeout`, which previously failed with `TSR052`. Revision 65: `askBooleans` (#512): plan validation rejects an unlowered `askBooleans` call, which lowers to a `booleanList` form. Revision 64: Form cancellation (#512): a form request may carry `cancel`, which previously failed with `TSR052`. Revision 63: Form source (#512): a form request may carry `outro` and its field descriptors `description`, which the form says as prose when it opens, where such a plan previously failed with `TSR052`; a form shape carries the checked answer types, `answers` for an object and `answer` for a dict, which the form verifies when it opens. Revision 62: Forms (#512): an interaction may be `form`, with the `form` result domain, always prepared from one `requestTemporary` and a result `shape` (`object` with field `numericKinds`, `dict` with one `numericKind` or `null`, or `booleanList`). Revision 61: Shared block variables (#627): `startTimer`, `showPermanentButton`, and `playMedia` carry `captures`, the names of the variables their blocks share with the creating code, empty without blocks. Revision 60: Dict pair loops (#627): a `for` `loopStart` may carry `valueVariable`, which differs from `variable`, to go through a dict's keys and values. Revision 59: Image questions (#627): `askImage` says its question like a basic ask, takes `hint:`, and its image UI carries `question` beside `hint`. Revision 58: Ask questions (#627): a basic ask's question is a prepared `say` before its interaction; `prepareSayText` may carry `field: true`, which converts the text as an input field does, so a list fails with `TSR021` instead of showing as notation. Revision 57: Image input (#604): an interaction may be `image` (`askImage`), its UI carrying `hint`, `allowCamera`, `allowFile`, `types`, and `mime`, or prepared from one `requestTemporary` holding the written arguments; plan validation rejects an unlowered `askImage` call. Revision 56: Empty default answers (#618): a `default:` that is `null` or blank text when its field opens prefills nothing, where it previously failed with `TSR052`. Revision 55: Permanent buttons (#610): `showPermanentButton` instructions with `text`, `persist`, a `button` handler region, and an optional `destinationTemporary` for the identifier; handler regions may be `button`, and the `permanentButton` type-check name. Revision 54: Joining (#606): `+` joins two texts or two lists, which previously failed with `TSR027`, and the list method `addAll` may carry a `typeCheck` for each added element. Revision 53: Camera views (#602): `showCamera` instructions with a `placement` (`window` or `stage`) and an optional `destinationTemporary` for the view handle, `hideCamera` instructions, the `camera` type-check name, and pacing barriers whose receiver may be a camera view. Revision 52: Script tags (#572): each plan file carries `tags`, its header tags in canonical name order, or `null` for a file of declarations only, which no script query picks or lists; a `tagQuery` may search `scripts`, with an optional `from` path or glob, giving script references in path order. Revision 51: Photo tags (#572): a `capture` instruction carries `tags`, an expression read before the capture is requested, or `null`. Revision 50: Script references (#570): a transfer or fallback destination may be computed, `{ value }`, whose expression evaluates to a script reference; the `script` built-in, and the `script` type for type checks and tests. Revision 49: Globs (#570): a transfer or fallback destination may be `{ pick }`, the files a glob picks from. Revision 48: File transfers (#570): a `transfer` instruction goes to or calls a file's entry or label, or calls a label of its own file; `setFallback` sets or clears the fallback; each file lists its `entryInstruction`. Revision 47: Camera capture: the `capture` instruction for `takePhoto()`, and rejection of an unlowered `takePhoto` call. Revision 46: Globals (#570): `declareGlobal` instructions and `declareSpeaker` instructions, both with the `file` of their source, form a startup prefix at the start of `main.tease`, and `setDeclaredSpeakerProperty` is removed; function definitions record `global`, and an instruction may call a global function of another file. Revision 45: Tags (#572): a plan has an `images` catalog of package image paths in path order, each with its tags in name order (a canonical name and a finite number or `null`), and a `tagQuery` expression (`showImage tagged`, `findImages`) of postfix steps over operands that are evaluated once, in order, before any image is matched. Revision 44: Labels and endings (#570): each file lists its `labels`, and its root region closes with an `end` instruction; `goto` (to a label of its file) and `end` instructions; a root jump stays inside its region. Revision 43: Projects (#570): a plan lists its `files`, each with a path, source span, and a block of a root region followed by its functions and handlers; this table replaces the plan-level `sourceSpan` and `rootEndInstruction`, and an instruction may only refer to functions of its own file. Revision 42: Any set member (owner decision on #568): a set literal, set `add`, and `toSet` take any value a list takes, so a plan that failed with `TSR032` now runs. Revision 41: Durations as set members (owner-accepted 2026-10-04): static set and choice values may hold durations. Revision 40: Date and time input: an interaction may be `temporal`, with UI, static or prepared, that carries `temporalKind` (`date`, `time`, or `datetime`) and an optional ISO `prefill`, and the `temporal` result domain. Revision 39: Calendar durations: a duration literal plan may carry whole `months` and `days`, present only when they are not zero. Revision 38: Dicts: a `dict` expression carries ordered entries, each a key and a value expression, a type may be `dict` with a value type, and a dict `get` call may check its `default:`. Revision 37: Date and time values: static choice values may be dates, times, datetimes, and timestamps, and types include `timestamp`. Revision 36: Type tests: a `typeTest` expression (`value is T` or `value is not T`) carries a recursive type and is evaluated with the matcher of the runtime type checks. A type may be `never`, which no value fits, so a list of it holds only the empty list. Revision 35: the `min` and `max` built-ins. Revision 34: the list methods `sort` and `shuffle`, and `intersection`, `union`, and `difference` on lists and sets. Revision 33: text operations (`length` and text methods), list `join`, and the conversion and rounding built-ins. Revision 32: `askInteger`: number interaction UI, static or prepared, may carry `integer: true`. Revision 31: the binary operator `in`, a number-in-range test that `switch` range cases compile to. Revision 30: runtime type checks: `declareBinding`, `assign`, `bindDefaultParameter`, and `returnValue` instructions, function-call arguments, and list or set `add` calls may carry a `typeCheck` with a recursive type and the receiving place, checked for values the compiler cannot know; `storageLoad` no longer carries its own expected type. Revision 29: `showButton` timeout and elapsed time: a button used as a value has the `duration` result domain and a destination, and a prepared button may carry a `timeoutTemporary`. Revision 28: list text and choices: `say` shows any value, with lists, sets, and objects in literal notation, only `${...}` interpolation selects a list element, and text fields reject lists; a prepared `choose` keeps its evaluated options and the value written before each `:` (or `null`), static choice UI carries typed values, and choice results use the `choice` domain. Revision 27: structural `==` for objects, lists, sets, and ranges (previously `TSR029`); the list method `removeAt`; `removeAt`, `removeFirst`, and `removeLast` return the removed element, and `removeFirst`/`removeLast` on an empty list fail (previously no-ops). Revision 26: text and number interaction UI may carry a `prefill` default answer, or its `prefillTemporary` when computed. Revision 25: script storage: `storageLoad` expressions with lazy defaults and direct typed-initializer checks, and `storageWrite` instructions (`save`; `delete` when the value is `null`). Revision 24: message preparation accepts authored position and alignment only for prose. Media instructions `pacingBarrier`, `showImage`, and `playMedia`; handler regions carry `handler` (`timer` or `media`) and `selfHandle`. Revision 21 added the timer instructions. |
| Runtime snapshot | 73 | Named time zones (#512, ADR 0026 §9): a temporal capture's context may hold `namedZones`, the rules of zones the script names. Revision 72: Lost prepared references (#512): an attached prepared reference that keeps `capturedRoot` may lead nowhere from its variable, as one through a dict's `keys` or `values` does once the dict is emptied, and is detached at its next use, also as a call receiver or the base of a later preparation. Previously validation refused it, and such a receiver failed instead of using the copy. Revision 71: Prepared references without a root copy (#512): an attached prepared reference keeps `capturedRoot` only where the plan keeps one: where a call in its preparation follows the read of its root, where its path or the path it extends goes through a dict's `keys` or `values`, and for a reference that a later preparation keeping one extends. Every other attached reference omits it and resolves through its variable alone. Validation requires the field exactly there and on every detached reference; previously every reference carried a copy of its root. Revision 70: Shown form options (#512): a form settlement carries `shownOptions`, for each field the position of the option a cycle showed, else `null`, or `null` for a form that returned `null`; each shown option must have its field's answer as value. Revision 69: Nested loops (#512): a loop frame stands in deeper scopes than the loop frame around it in its call context, which validation previously did not require. Revision 68: Explicit time units (#512): an active timer's `range` carries the `unit` it counts, which must be its instruction's `unit`, and a paused draw may stand at a wait or timer duration whose instruction has a `unit`. A shown button's timeout temporary holds a duration. Previously a range counted seconds, only with `unit: "s"`, and validation also accepted a number of seconds or a range without a unit. Revision 67: Duration unit words (#512, ADR 0026): validation derives the button text of a pending choice whose option is a duration from the value again, and that text now writes unit words in full, such as `1 minute 30 seconds`. Revision 66: Calendar durations (#512, ADR 0026): a `duration` value holds only `milliseconds`, and a `calendarDuration` value holds `months`, `days`, and `milliseconds`. Revision 65: absoluteDateTime (#512, ADR 0026): the value tag `timestamp` is now `absoluteDateTime`. Revision 64: Settled timer records (#512): a `settledTimers` record keeps only what its handle reads and whether it persists: `timerId`, `state`, `display`, `label`, `persist`, `repeatDurationMs`, and `elapsedMs`. Revision 63: Settled media records (#512): a `settledMedia` record keeps only what its handle reads, `mediaId`, `source`, `state`, `durationMs`, `volume`, `positionMs`, and `elapsedMs`. Revision 62: Timer ranges (#512): an active timer whose `startTimer` duration is written as a number or duration may not hold a `range`. Revision 61: Preselected buttons (#512): a choice action's UI may carry `preselected`, which validation checks against the prefill temporary of a prepared choice. Revision 60: Settled timers (#512): `settledTimers` keeps only the records a handle or a queued or running expiry block reaches, so an issued timer ID may have no record. Revision 59: Settled media (#512): `settledMedia` keeps only the records a handle or a queued or running cue block reaches, so an issued media ID may have no record. Revision 58: Controlled randomness (#512): `randomControl`, `null` or the count of chosen outcomes and a paused draw with what resuming it needs; catch-up may stand paused at a draw. Revision 57: Debug mode (#512): the `debugMode` boolean, which the host sets. Revision 56: Message handles (#512): runtime values may be message handles (`{ kind: "messageHandle", messageId }`), `liveMessages` holds the current markup source of each message a handle reaches, and the prepared output of a result-bearing `say` keeps its `sourceText`. Revision 55: Form time limits (#512): form UI carries `timeout`, `{ milliseconds, onTimeout }` or `null`; a form action may have `timeoutMs`, and a form settlement may be `timedOut`, without transcript. Revision 54: Form cancellation (#512): form UI, pending or recorded in a settlement, carries `cancel`, a button or `null`, and a cancelled form settles with `null`. Revision 53: Forms (#512): a pending `form` interaction carries its definition as UI and its answers as `form` (`values` and `editor`), and its request temporary holds the canonical definition; a form settlement and result handoff hold an object, dict, or list of answers. Revision 52: Shared block variables (#627): timer, media, and button records, queued blocks, and function frames carry `captures`, `{ name, scopeId }` entries; a block, loop, or function scope that a list has named carries `shared: true`, and `retainedScopes` may hold such scopes while a live list names them. Revision 51: Dict pair loops (#627): a `for` loop frame may carry `valueVariable`, matching its `loopStart`, and then holds a dict as its source; a frame without it holds a list, set, or range. Revision 50: Image questions (#627): image interaction UI, pending or recorded in a settlement, carries `question` beside `hint`, and the request temporary of an open image request holds the hint as `hint`. Revision 49: Image input (#604): a pending `image` interaction, whose request temporary holds its canonical request, and image settlements whose result is an admitted image reference with the transcript `Image`. Revision 48: Empty default answers (#618): the prefill temporary of an open text, number, or temporal interaction holds `null` when its UI has no prefill, and the recorded UI of a settled field with a default may have no prefill. Revision 47: Permanent buttons (#610): background `permanentButton` actions and their `removed` settlements, `nextPermanentButtonId`, permanent button handles (`{ kind: "permanentButtonHandle", buttonId }`), and clicks in the interrupt queue and interrupt frames, which record `buttonId`. Revision 46: Camera views (#602): `cameraView` holds the default camera's view, `{ placement, shown }`, or `null` before the first `showCamera`; runtime values may be camera view handles (`{ kind: "cameraView" }`), which need the view; a halted session shows no view, and the startup prefix has none. Revision 45: Photo tags (#572): a pending `capture` action carries its validated `tags` in canonical name order, or `null` exactly when its instruction has none, and `capturedImages` lists the photos taken with tags, each a unique captured reference with canonical tags, in capture order. Revision 44: Script references (#570): a runtime value may be a script reference, `{ kind: "script", path, label }`, and every scope records `entry`, where a root's activation started. Revision 43: Globs (#570): the fallback may be a glob destination. Revision 42: File activations (#570): a scope names the file of an activation root; call frames are `function` or `file` frames; function frames, timers and media with blocks, and queued blocks name their activation root; `retainedScopes` and `fallback` are new. Revision 41: Foreground `capture` actions and their replayable settlements, and capture results in the canonical result handoff, which records its `actionKind`. Revision 40: Globals (#570): a `globals` list holds the host's globals, then the script's globals and speakers, which no longer live in the root scope; a prepared reference may have a global as its root; a failure carries the `path` of its source; global functions of every file and their blocks may run. Revision 39: Endings (#570): `terminalContinuationHandoff` is gone, a halted snapshot stands after an `exit`, and a position names an instruction of the plan. Revision 38: Any set member (owner decision on #568): a set may hold any value a list may hold, unique by structural `==`; a prepared reference no longer steps into a set by position, because a set member is read as a copy. Revision 37: Durations as set members (owner-accepted 2026-10-04): a set may hold durations, keyed by their months, days, and milliseconds. Revision 36: Temporal interaction UI, active or recorded in a settlement, carries `temporalKind` and an optional ISO prefill; a temporal settlement result is a date, time, or datetime of that kind. Revision 35: Calendar durations: a duration value may carry whole `months` and `days`, present only when they are not zero. Revision 34: Date and time captures: `temporalContext` became `temporalCaptures`, each with a boundary scene time, an event sequence, an optional wall clock, and a context, recorded at start and by `recordContinueCapture`. Revision 33: Dicts: a runtime value may be a `dict` of ordered `{ key, value }` entries with unique text keys, and a prepared reference path may step through a dict `key`. Revision 32: Date and time values: runtime values, set members, and choice values may be dates, times, datetimes, and timestamps; the session records its captured `temporalContext`. Revision 31: Number interaction UI, active or recorded in a settlement, may carry `integer: true`, which requires a whole-number answer and prefill. Revision 30: interaction actions record `createdAtMs` and a button's `timeoutMs`; an interaction settlement may be `timedOut`, without transcript sequence or text, and a button result is a non-negative elapsed duration. Revision 29: choice actions and settlements carry each button's typed value, a choice result may be any choice value including `null` or a duration, and a choice control completes by button position. Revision 28: text and number interaction UI, active or recorded in a settlement, may carry a validated `prefill`. Revision 27: an interaction settlement records the `ui` the player answered, and validates against it instead of the prepared temporaries, which a later run of the same instruction may fill anew. Revision 26: the validated, key-sorted `scriptStorage` session view, `scriptStoragePersistent`, and foreground `storageWrite` actions and settlements. Revision 25: captured bubble presentations require null position and alignment; placement is Player-owned. Media state: `stageImage`, background `media` actions, `settledMedia`, `nextMediaId`, foreground `mediaPlayback` waits and settlements, media cue invocations and interrupt frames, barrier-promoted pacing gates, and media handles. Revision 22 added timer state. |
| Checkpoint | 102 | The named-time-zone plan and snapshot contracts. Revision 101: the lost-prepared-reference snapshot contract. Revision 100: the root-copy-free prepared-reference snapshot contract. Revision 99: the shown-form-option snapshot contract. Revision 98: the nested-loop snapshot contract. Revision 97: the parameter-default-timer plan contract. Revision 96: the explicit-time-unit plan and snapshot contracts. Revision 95: the duration-unit-words snapshot contract. Revision 94: the calendar-duration plan and snapshot contracts. Revision 93: the absoluteDateTime plan and snapshot contracts. Revision 92: the unknown-form-fields plan contract. Revision 91: the settled-timer-record snapshot contract. Revision 90: the settled-media-record snapshot contract. Revision 89: the block-function plan contract. Revision 88: the timer-range snapshot contract. Revision 87: the preselected-button plan and snapshot contracts. Revision 86: the stop-all-audio plan contract. Revision 85: the settled-timer snapshot contract. Revision 84: the settled-media snapshot contract. Revision 83: the typed-storage-key plan contract. Revision 82: the controlled-randomness snapshot contract. Revision 81: the debug-mode plan and snapshot contracts. Revision 80: the exponential, angle, and random-distribution plan contract. Revision 79: the message-handle plan and snapshot contracts. Revision 78: the numeric- and list-function plan contract. Revision 77: the form-time-limit plan and snapshot contracts. Revision 76: the `askBooleans` plan contract. Revision 75: the form-cancellation plan and snapshot contracts. Revision 74: the form-source plan contract. Revision 73: the form plan and snapshot contracts. Revision 72: the shared-block-variable plan and snapshot contracts. Revision 71: the dict-pair-loop plan and snapshot contracts. Revision 70: the image-question plan and snapshot contracts. Revision 69: the ask-question plan contract. Revision 68: the image-input plan and snapshot contracts. Revision 67: the empty-default-answer plan and snapshot contracts. Revision 66: the permanent button plan and snapshot contracts. Revision 65: the joining plan contract. Revision 64: the camera view plan and snapshot contracts. Revision 63: the script-tag plan contract. Revision 62: the photo-tag plan and snapshot contracts. Revision 61: updated the self-contained bundle for the script-reference plan and snapshot contracts. Revision 60: the glob plan and snapshot contracts. Revision 59: the file transfer plan and activation snapshot contracts. Revision 58: updated the self-contained bundle for the capture plan and snapshot contracts. Revision 57: the globals plan and snapshot contracts. Revision 56: the image catalog and tag query plan contract. Revision 55: updated the self-contained bundle for the label and ending plan and snapshot contracts. Revision 54: the project plan contract. Revision 53: the any-set-member plan and snapshot contracts. Revision 52: the duration set-member plan and snapshot contracts. Revision 51: the date and time input plan and snapshot contracts. Revision 50: the calendar duration plan and snapshot contracts. Revision 49: the date and time capture snapshot contract. Revision 48: the dict plan and snapshot contracts. Revision 47: the date and time plan and snapshot contracts. Revision 46: the type-test plan contract. Revision 45: the `min` and `max` plan contract. Revision 44: the list-sort and set-operation plan contract. Revision 43: the text-operation and built-in plan contract. Revision 42: the `askInteger` plan and snapshot contracts. Revision 41: the `in` plan operator. Revision 40: the runtime-type-check plan contract. Revision 39: the `showButton` timeout plan and snapshot contracts. Revision 38: the list-text and choice plan and snapshot contracts. Revision 37: the structural-equality and list-removal plan contract. Revision 36: interaction prefills. Revision 35: the recorded interaction settlement UI. Revision 34: the script-storage plan and snapshot contracts. Revision 33: prose-only authored placement, bubble presentation validation, and the media plan and snapshot contracts. |

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
