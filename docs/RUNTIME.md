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
kind: button | text | number | choice
action identity
owning and continuation instruction positions
result destination when applicable
expected result type
validated Standard UI payload
choice labels and visible values when applicable
target
optional requesting speaker identity
accessible-name data or localized default key
```

The engine owns action identity, active state, completion validation, transcript-result derivation, result writes, events, settlement replay, checkpoint/restore, and structured rejection. Compiler/Standard Library lowering owns compact syntax and default UI payload.

The selected interactions expose no player cancellation result. Timer interrupts may suspend them, and handler `exit`
discards the interrupted instruction without producing a result; see [Timers and scene time](#timers-and-scene-time).
Wrong-kind, whitespace-only required text, non-finite-number, unknown-label, unknown-visible-choice, ambiguous-choice,
and over-limit completions leave the same action active without mutating its result, transcript, event sequence, RNG, or
continuation.

The compact compiler fully lowers these forms into the versioned plan. Static control text is embedded directly in the interaction instruction. Dynamic control text first captures the requesting speaker, evaluates payload expressions in source order, and stores one prepared UI value; dynamic `choose` batches all option expressions into one prepared list rather than emitting one interaction-preparation instruction per option. The runtime materializes and validates that prepared UI atomically before publishing the pending action. No Standard Library lookup or suspended JavaScript/TypeScript call survives the compile boundary.

Result-bearing text, number, and choice instructions require the destination temporary to be absent when the interaction
is requested. Successful completion atomically writes the typed result into that prepared ordinary runtime temporary,
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
and control-flow targets onto the cleanup, are provisional POC policy, not language semantics. A result-free button may
be the terminal root instruction and uses the existing canonical settled root-end transition.

Completion semantics are:

- `askText` normalizes `CRLF` and standalone `CR` to `LF`, otherwise preserves submitted text, rejects whitespace-only input, returns `string`, and uses the same normalized text in the player transcript;
- `askNumber` accepts one line of text, trims surrounding whitespace, parses accepted TeaseScript decimal/scientific forms, requires a finite result, canonicalizes negative zero to numeric `0`, returns `number`, and preserves the trimmed submitted text in the transcript;
- an unlabelled `choose` returns visible text;
- a labelled `choose` accepts one exact stored identifier or numeric label and returns `string` or `number` respectively;
- `showButton` has no useful first-slice return value or timeout.

A labelled rendered choice control supplies its selected label to the engine; an unlabelled control supplies its selected visible text. The engine derives the canonical transcript text from the active action. A rendered control never supplies a replacement canonical transcript string.

The current runtime keeps three independent interaction resource axes: completion/result/transcript string bytes,
aggregate UTF-8 bytes for one retained interaction definition, and option count. Authored/materialized UI fields have no
independent per-field byte ceiling; each preflights against the remaining definition aggregate. Exact numeric values and
their provisional Owner POC reassessment route live in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md); they are not accepted
capacity or source targets. Bounded validation rejects impossible UTF-16 lengths before encoding and encodes no further
field once the applicable byte budget fails, so encoding work stays bounded by the byte budget rather than by the total
string size. The text-completion limit applies to the raw host string before CRLF/CR-to-LF normalization, which cannot
increase its UTF-8 size. Over-limit data is rejected without truncation, clamping, or partial state mutation.

Whitespace-only text rejection uses `ecmascript-whitespace-v1`: the ECMAScript `WhiteSpace` and `LineTerminator` classification represented by the engine's Unicode-aware regular expression. The identifier-choice label grammar is the current ASCII TeaseScript identifier form. Choice duplicate detection and completion matching use bounded native sets or one linear option pass.

Successful completion emits the canonical `playerTranscript` event first and `actionCompleted` second. Both receive
monotonic sequences, and the bounded settlement retains both sequences, the canonical result, transcript text,
destination temporary, and owning call-frame identity for duplicate replay. The separate single-use handoff, not that
settlement, is the persisted authority for the still-unconsumed destination. Prepared dynamic UI is checked against its
preparation temporaries while those temporaries remain; after canonical cleanup, snapshot validation does not
reconstruct or authenticate the historical dynamic-UI evaluation, consistent with the general snapshot-history rule
below. Delay creation preflights its request plus future completion sequence; interaction creation preflights its
request plus future transcript and completion sequences. Interaction completion rechecks both required sequences and
validates the complete destination mutation before publishing any write, handoff, settlement, event, or continuation
change. Continuation execution remains eligible only through a later normal runtime entry.

### Standard composer and dynamic choice presentation

The Standard Player application uses one fixed composer. During a foreground interaction it remains enabled, becomes the answer field, and receives focus by default. Choice and button controls appear immediately above it. Only a completion valid for the active deterministic interaction advances that interaction; non-matching composer text leaves the same mandatory action active. Future LLM clarification or interpretation is outside this first POC.

Choice buttons may occupy one or two rows. The Player application may render the same choice group as a dropdown when
viewport, text, font, zoom, accessibility, or other layout constraints make buttons impractical. Button-versus-dropdown
presentation is not canonical runtime/checkpoint state and does not change labels, visible text, completion validation,
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
interpolation, string escaping, deterministic list selection, block-string newline normalization/dedent, and one shared
message-markup parse. Formatting delimiters and block markers do not count. Words are maximal non-whitespace sequences;
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

`wait 0` is deliberately immediate: its duration expression is still evaluated, but it allocates no action ID, creates no pending action or settlement, and emits neither action event. The next source instruction runs normally; if it was the terminal root instruction, ordinary natural completion emits one `complete` event. In contrast, a positive terminal root wait settles with `actionCompleted`; the following runtime entry consumes the canonical settled root-end transition and emits the sequenced `complete` event. Re-entering an already halted snapshot emits no further completion event.

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
gates, timer rounds, and media timeline events (see [Stage image and media playback](#stage-image-and-media-playback)).
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
once execution waits or ends. Every settlement records the scene time at which it happened: a time-driven settlement
records its deadline, and a pacing gate that is skipped, consumed, or superseded records the current scene time. A
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
runs once when the block returns. A normal return restores the interrupted action with its original identity;
returning to an interaction first consumes a pacing gate created by the block. `stop()` on an active timer cancels its
unstarted queued blocks; on a finished or stopped timer it is a silent no-op. `exit` inside a block halts the session
and discards the interrupted action. `exit` and script end stop every timer and drop queued blocks. A failed session
clears its foreground action.

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
phase 0, and commits one event per step, so queued cue blocks hold catch-up exactly like timer expiry blocks. An
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

**Cleanup and restore.** `exit` and script end stop all media without events and drop queued blocks; the Stage image
stays. Checkpoints carry the complete media state, including unprocessed samples, and restore does not advance or
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

`compileSource(source, options)` is the normal source compilation route. It:

1. parses source text into a `Program`;
2. runs AST-level validation for parsed non-finite numeric literals;
3. runs semantic validation when parsing and finite-literal checking produced no errors;
4. includes the core runtime built-ins plus configured global and builtin names in validation;
5. lowers the program only when no error diagnostics remain;
6. completely validates and deeply freezes an instruction plan before returning it.

The result separates parser and semantic diagnostics and returns `plan: null` when compilation fails. Runtime entry
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
- values entering globals or returning from builtins are copied and validated as serializable runtime values;
- invalid builtin return values become structured runtime failures, including `TSR013` for invalid values;
- normally declared TeaseScript speakers remain runtime-managed state and continue to use stable serialized speaker IDs.

The low-level `RuntimeCapabilities.random` hook is a compatibility/testing override. Without it, execution advances the serialized `xorshift32-v1` state. An injected random source must return a finite number in the half-open range `[0, 1)`.

The override's own state is external to the runtime snapshot. A checkpoint is therefore not self-contained with respect to an arbitrary injected random source. Canonical checkpoint-equivalence guarantees use the serialized runtime RNG; tests that use the override must explicitly recreate an equivalent deterministic external source.

Future player capabilities must return typed, validated, JSON-safe outcomes correlated to one action ID and obey
any separately justified capability/interaction boundary. Raw DOM exceptions, browser handles, streams, callbacks, and
mutable host objects do not enter the snapshot.

Under ADR 0017, Standard Library and package-library wrappers may call documented typed capabilities, but they do not bypass these boundaries or become alternate owners of canonical action state.

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

## Visible text boundary

Ordinary scalar visible-text conversion accepts strings, finite numbers, booleans, `null`, and elapsed duration values.
Duration formatting is defined in specification
[§35](specifications/accepted-syntaxes-v30.md#35-date-time-durations-and-unix-time). When the value is a list, the
runtime selects exactly one item and then accepts only a string or finite number. Selected booleans, `null`, objects,
sets, ranges, and nested collections fail with structured runtime error `TSR021`; the runtime does not recursively
select or stringify them.

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

A halted snapshot is accepted only at the root completion boundary, including an empty root, or immediately after an `exit` instruction. Halted snapshots must also retain no active call frames, loop frames, temporaries, nested scopes, contextual speaker, or failure state. These checks establish that the serialized state is a possible current runtime state; they do not authenticate its execution history.

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
| Instruction plan | 25 | Script storage: `storageLoad` expressions with lazy defaults and direct typed-initializer checks, and `storageWrite` instructions (`save`; `delete` when the value is `null`). Revision 24: message preparation accepts authored position and alignment only for prose. Media instructions `pacingBarrier`, `showImage`, and `playMedia`; handler regions carry `handler` (`timer` or `media`) and `selfHandle`. Revision 21 added the timer instructions. |
| Runtime snapshot | 27 | An interaction settlement records the `ui` the player answered, and validates against it instead of the prepared temporaries, which a later run of the same instruction may fill anew. Revision 26: the validated, key-sorted `scriptStorage` session view, `scriptStoragePersistent`, and foreground `storageWrite` actions and settlements. Revision 25: captured bubble presentations require null position and alignment; placement is Player-owned. Media state: `stageImage`, background `media` actions, `settledMedia`, `nextMediaId`, foreground `mediaPlayback` waits and settlements, media cue invocations and interrupt frames, barrier-promoted pacing gates, and media handles. Revision 22 added timer state. |
| Checkpoint | 35 | Updated the self-contained bundle for the recorded interaction settlement UI. Revision 34: the script-storage plan and snapshot contracts. Revision 33: prose-only authored placement, bubble presentation validation, and the media plan and snapshot contracts. |

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
- camera stream ownership and persistent media collections, their cleanup, persistence, and recovery;
- time-integrity diagnostics and future server-authoritative scheduling;
- server checkpoint persistence and conflict resolution;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
