# Runtime

## Playground execution helper

`playground/workspace/controller.ts` is the DOM-free adapter shared by the browser controller and development automation routes. It uses `compileSource(...)` and canonical `run`/`stepToEvent` runtime interfaces to create fresh validated snapshots and return JSON-safe diagnostics, events, plan, snapshot, status, and instruction count. It stops on `halted`, `failed`, `waiting`, or the canonical instruction-budget failure.

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
- bounded host/player data and security boundaries.

Candidate Standard Library responsibilities include `say` policy, standard output targets, visible timer presentation,
common input wrappers, validation/retry helpers, and friendly lifecycle APIs. ADR 0018 accepts the first concrete
text/output slice described below; the current compiler/runtime implements that slice through versioned engine state.

## Accepted first Standard Library runtime contract

ADR 0018 selects one generic foreground interaction family for `showButton`, `askText`, `askNumber`, and `choose`,
followed by a separate `say` smart-autoplay slice. Both engine/compiler slices are implemented. Standard Player controls
and browser input wiring remain separate work.

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

The selected interactions are mandatory and non-cancellable. Wrong-kind, whitespace-only required text, non-finite-number, unknown-label, unknown-visible-choice, ambiguous-choice, and over-limit completions leave the same action active without mutating its result, transcript, event sequence, RNG, or continuation.

The compact compiler fully lowers these forms into the versioned plan. Static control text is embedded directly in the interaction instruction. Dynamic control text first captures the requesting speaker, evaluates payload expressions in source order, and stores one prepared UI value; dynamic `choose` batches all option expressions into one prepared list rather than emitting one interaction-preparation instruction per option. The runtime materializes and validates that prepared UI atomically before publishing the pending action. No Standard Library lookup or suspended JavaScript/TypeScript call survives the compile boundary.

Result-bearing text, number, and choice instructions require the destination temporary to be absent when the interaction is requested. Successful completion atomically writes the typed result into that prepared ordinary runtime temporary, records one nullable single-use `interactionResultHandoff` authority, and advances to the next instruction without executing it. The handoff contains only the completed action identity, owning and continuation positions, owner call frame, destination temporary, and canonical result. It remains independent of bounded `lastSettlement` replay data, so a later settlement cannot remove the value-consistency check before consumption. A canonical plan then either discards the temporary directly, returns or exits the owning runtime region, or performs one ordinary local consume/transfer instruction followed immediately by `clearTemporary`. The handoff record is removed after that first instruction succeeds; after a value is copied into an ordinary binding, prepared argument, assignment, or other runtime destination, no interaction-specific provenance remains during cleanup or later execution. No branch, loop edge, second blocking action, arbitrary user-function call, unrelated writer, or independent control-flow target may occur inside that short boundary. The validator enforces this fixed local shape rather than performing whole-plan result-liveness analysis. A result-free button may be the terminal root instruction and uses the existing canonical settled root-end transition.

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
capacity or source targets. Bounded validation first rejects impossible UTF-16 lengths, measures each accepted field
once, and stops encoding after the applicable byte budget fails. Text completion measures the raw host string once;
CRLF/CR-to-LF normalization cannot increase its UTF-8 size. Over-limit data is rejected without truncation, clamping,
or partial state mutation.

Whitespace-only text rejection uses `ecmascript-whitespace-v1`: the ECMAScript `WhiteSpace` and `LineTerminator` classification represented by the engine's Unicode-aware regular expression. The identifier-choice label grammar is the current ASCII TeaseScript identifier form. Choice duplicate detection and completion matching use bounded native sets or one linear option pass.

Successful completion emits the canonical `playerTranscript` event first and `actionCompleted` second. Both receive
monotonic sequences, and the bounded settlement retains both sequences, the canonical result, transcript text,
destination temporary, and owning call-frame identity for duplicate replay. The separate single-use handoff is the
persisted authority for the still-unconsumed destination and is validated independently when `lastSettlement` has
already been replaced. Prepared dynamic UI is checked against its preparation temporaries while those temporaries
remain; after canonical cleanup, snapshot validation does not reconstruct or authenticate the historical dynamic-UI
evaluation, consistent with the general snapshot-history rule below. Delay creation preflights its request plus future
completion sequence; interaction creation preflights its request plus future transcript and completion sequences.
Interaction completion rechecks both required sequences and validates the complete destination mutation before
publishing any write, handoff, settlement, event, or continuation change. Continuation execution remains eligible only
through a later normal runtime entry.

### Standard composer and dynamic choice presentation

The Standard Player application uses one fixed composer. During a foreground interaction it becomes the answer field, receives focus by default, and blocks ordinary free-chat submission. Choice and button controls appear immediately above it.

Choice buttons may occupy one or two rows. The Player application may render the same choice group as a dropdown when viewport, text, font, zoom, accessibility, or other layout constraints make buttons impractical. Button-versus-dropdown presentation is not canonical runtime/checkpoint state and does not change labels, visible text, completion validation, transcript output, or return values.

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

The measured value is the final emitted text after expression evaluation, interpolation, escapes, deterministic list selection, and source-string newline folding. Words are maximal non-whitespace sequences; visible characters are Unicode code points.

All counts, multiplication, addition, and deadline construction use checked arithmetic. A non-finite, unsafe, unsupported-magnitude, or overflowing result fails before an action ID or partial gate is created. There is no additional product reading-time cap, but ADR 0016 numeric-magnitude and deadline-overflow limits still apply.

The captured settings are deterministic session data. Account changes do not alter an active or restored session. A calculated delay of `0` creates no pacing action or action events.

### Pacing gate as an ADR 0016 action

A positive pacing gate is one pending-action kind conceptually named `chatPacingGate`. It uses ADR 0016 action identity, absolute deadline, active-first lookup, typed completion, bounded `lastSettlement`, event sequencing, checkpoint/restore, and continuation rules. It is not a second hidden pacing state machine.

The first POC has at most one active pacing gate because it has one Standard chat target.

#### Initial message and background gate

A normal or positive-duration `say` evaluates speaker, text, pacing, skip policy, and deterministic text selection once in source order.

When no earlier gate blocks it, one atomic instruction boundary:

1. emits the text-output event;
2. stores a positive `chatPacingGate` in `backgroundActions` with a new action ID, absolute deadline, and skip policy;
3. emits `actionRequested` for that gate;
4. continues unrelated non-blocking execution.

The text-output event precedes `actionRequested`. No checkpoint may contain the emitted text without the positive gate established by the same instruction.

#### A later `say` becomes foreground-blocked

When execution reaches a later normal or positive-duration `say` while the background gate remains active:

1. evaluate and store the later prepared output once, including speaker, final text, pacing, skip policy, and RNG results;
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
or create a player transcript message. The engine-side typed completion path is implemented; primary-click/touch/Space
listeners in the Standard Player remain part of the later Player slice.

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

Player-authored messages do not create gates. No compiler lookahead across branches, calls, or loops is used.

### Skippable gate completion

Effective skip policy comes from explicit `skippable`/`unskippable`, then the effective speaker's `defaultSaySkippable`, then platform default `true`.

A skippable gate may complete through:

- a primary click anywhere in the player iframe viewport, including background or unused space;
- a primary touch activation;
- Space while the focused Standard composer is empty.

A real interactive control has priority and must not also trigger viewport-wide gate completion. Ordinary keys type into the focused composer. Space is normal input when text is already present and does not skip during text composition, a relevant selection, or focus on another interactive control. Unskippable gates reject click, tap, and Space completion.

### Player and developer controls

The normal Player application has no player-facing pause control and ADR 0018 adds no author-facing pause command. Developer mode may expose Pause alongside Run, Step, checkpoint, restore, and debugger controls. Developer pause is tooling and does not establish player-initiated pause semantics.

Browser unavailability, reload, reconnect, device sleep, visibility changes, and server-authoritative deadlines remain separate lifecycle/time-integrity work.

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

The current implementation contains compiler-owned blocking `wait`, the compact `showButton`, `askText`, `askNumber`,
and `choose` forms lowered into one generic foreground `interaction` family, and ADR 0018 `say` pacing lowered into the
`chatPacingGate` pending-action lifecycle. Runtime state retains persisted session time, at most one foreground action,
zero or one background pacing gate, monotonic action IDs, bounded settlement replay, prepared `say` output, explicit
time observation, and typed completion operations. Browser scheduling and Standard Player controls remain out of scope.

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

A valid current `waiting` snapshot contains exactly one foreground delay, interaction, or `chatPacingGate` action.
A foreground delay may coexist with one older background pacing gate; a foreground interaction or pacing gate may not.
Non-waiting states contain no foreground action. `backgroundActions` is empty or contains one validated
`chatPacingGate` with coherent identity, request sequence, deadline, ownership, and creation order.

Delay creation time is no later than the persisted session coordinate and its deadline is strictly later; a due delay
is settled only by an explicit time observation. An interaction retains its kind, ownership depths, call-frame identity,
destination/result domain, Standard chat target, optional requesting speaker ID, validated UI payload, and request
sequence. A waiting result destination must still be absent. Successful interaction completion commits the canonical
typed value directly into that destination and leaves the snapshot at the local compiler-defined continuation. Snapshot
validation uses the independent single-use `interactionResultHandoff` as the canonical result authority while
execution remains at the immediate commit or one-instruction transfer boundary, even if `lastSettlement` has already
been replaced; after the first canonical consume, transfer, return, discard, or exit succeeds, the record is removed,
and the value becomes ordinary runtime state without an interaction-specific lifecycle. Every persisted interaction
instruction, UI/accessibility/option shape, action, settlement, and snapshot field has an exact supported shape.

`currentSessionTimeMs` is canonical runtime state. It preserves the nondecreasing session coordinate across checkpoint and restore. A fresh snapshot receives a validated initial coordinate; deterministic tests may use `0`.

A blocking instruction evaluates its arguments, stores a complete JSON-safe action and continuation, advances to `waiting`, emits `actionRequested`, and stops. A validated completion stores its result and bounded `lastSettlement`, removes the matching action, emits `actionCompleted`, and leaves continuation or handler execution to the next runtime entry call.

`wait 0` is deliberately immediate: its duration expression is still evaluated, but it allocates no action ID, creates no pending action or settlement, and emits neither action event. The next source instruction runs normally; if it was the terminal root instruction, ordinary natural completion emits one `complete` event. In contrast, a positive terminal root wait settles with `actionCompleted`; the following runtime entry consumes the canonical settled root-end transition and emits the sequenced `complete` event. Re-entering an already halted snapshot emits no further completion event.

A duplicate delivery matching `lastSettlement` returns the same immutable canonical recorded settlement without another write, event, RNG advance, handler, or continuation. `lastSettlement` is bounded replay/idempotency data only: it does not own an expression temporary, prevent destination reuse, or block a later action. A newer settlement may replace it after the interaction result has already been atomically committed; the ordinary runtime value remains valid independently. Each delay settlement retains owning and continuation instruction positions.

Completion lookup always searches the active foreground action and all active background actions first. Only when no active action matches does the runtime compare `lastSettlement`, classify a lower previously issued ID as `staleAction`, or classify an unissued ID as `unknownAction`.

Timed actions store an absolute deadline derived from `currentSessionTimeMs`. The runtime does not read browser or operating-system clocks directly. The player maps monotonic elapsed deltas onto the session coordinate, schedules wake-ups, and submits validated observations; tests use a fake clock and never sleep in real time.

A time observation updates the snapshot atomically:

```text
effectiveNow = max(snapshot.currentSessionTimeMs, suppliedNow)
snapshot.currentSessionTimeMs = effectiveNow
settle actions due at effectiveNow
```

No checkpoint may contain due-action processing performed against a newer observation while retaining the older session-time value.

Blocking `wait` remains the first source-to-runtime slice. The generic interaction runtime is the second foreground use
of ADR 0016. ADR 0018 `say` pacing now adds the first populated background-action slice through `chatPacingGate`,
including background-to-foreground promotion, prepared output, typed/time settlement, `wait` coexistence, interaction
consumption, and checkpoint/restore.

## Compiler and execution entry points

### Normal source route

`compileSource(source, options)` is the normal source compilation route. It:

1. parses source text into a `Program`;
2. runs shared AST-level validation for parsed non-finite numeric literals;
3. runs semantic validation when parsing and finite-literal checking produced no errors;
4. includes the core runtime built-ins plus configured global and builtin names in validation;
5. lowers the program only when no error diagnostics remain.

The result separates parser and semantic diagnostics and returns `plan: null` when compilation fails. A returned plan is checked at the snapshot/runtime boundary or may be checked explicitly with `validateInstructionPlan(...)` before use.

Unexpected native JavaScript exceptions from parsing or compilation propagate unchanged through `compileSource(...)`;
they are not reclassified as TeaseScript capacity failures.

`compileSource(...)` rejects numeric literals such as `1e999` and `-1e999` with error diagnostic `TSC001`. It does not return an instruction plan for those inputs. Large finite values such as `1e308` remain valid. The normal compilation route therefore cannot return a plan containing literal `Infinity`, `-Infinity`, or `NaN`, and instruction-plan validation independently rejects any non-finite number in plan data.

The `TSC001` check is implemented as shared AST-level validation. `compileSource(...)` includes these diagnostics in its parser-diagnostic boundary, while the lower-level `parse(...)` result may still expose the raw JavaScript number produced while parsing. Callers must not treat parsing alone as successful compilation.

### Template interpolation

Template interpolation uses normal TeaseScript expression parsing and supports recursively nested template literals and nested interpolation expressions. The lexer preserves exact source spans and keeps escaped backticks and escaped `${` as literal template text.

Unterminated nested content remains structured: `TSL004` reports an unterminated template and `TSL005` reports an unterminated interpolation. A backtick starts a nested template whenever the current interpolation position can begin an expression, including when horizontal whitespace or a physical line ending follows the nested opening backtick. A backtick in a position where an expression cannot start remains the outer-template recovery boundary.

### Canonical source-to-runtime route

Ordinary TeaseScript source is compiled through `compileSource(...)` into a validated instruction plan, then executed with fresh or restored explicit serializable runtime state. AST data and lowering remain compiler and authoring-tool internals, not product execution APIs.

### Low-level runtime route

The compiler internally lowers semantically valid AST data after `compileSource(...)` validation. This internal lowering does not replace semantic validation or create a supported direct-AST product route.

The low-level runtime entry points are:

- `executeInstruction(...)` for exactly one instruction;
- `stepToEvent(...)` until the next event, halt, or failure;
- `run(...)` until halt, failure, or instruction-budget exhaustion.

Each low-level runtime entry validates the instruction plan and runtime snapshot before executing or returning, including when the supplied snapshot is already halted or failed. Callers may also invoke `validateInstructionPlan(...)` and `validateRuntimeSnapshot(...)` explicitly. Invalid plan data produces `RuntimeDataError` `TSR100`; invalid snapshot data produces `RuntimeDataError` `TSR101`.

These entry points stop cleanly at `waiting`. Separate validated operations submit time observations and typed action completions; ordinary execution entry points may not bypass a pending foreground action.

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

Future player capabilities must return typed, bounded, JSON-safe outcomes correlated to one action ID. Raw DOM exceptions, browser handles, streams, callbacks, and mutable host objects do not enter the snapshot.

Under ADR 0017, Standard Library and package-library wrappers may call documented typed capabilities, but they do not bypass these boundaries or become alternate owners of canonical action state.

## Visible text boundary

Ordinary scalar visible-text conversion accepts strings, finite numbers, booleans, and `null` according to the current implemented subset. When the value is a list, the runtime selects exactly one item and then accepts only a string or finite number. Selected booleans, `null`, objects, sets, ranges, and nested collections fail with structured runtime error `TSR021`; the runtime does not recursively select or stringify them.

The earlier proposal for automatic chat pacing at 17 visible characters per second is superseded. ADR 0018 defines the
accepted deterministic first-POC smart-autoplay and pacing-action contract, and the current engine/compiler implements
that contract. Standard Player event wiring remains a separate slice.

## Runtime defaults and limits

Current code contains call-depth, hostile-data capture, detailed-validation, interaction, and instruction-work guards.
Exact numeric implementation values, their current evidence status, and any provisional POC policy/reassessment route
live in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). This document keeps the behavior and safety semantics without
promoting provisional implementation values or product defaults into supported runtime-capacity claims.

The playground RNG algorithm remains `xorshift32-v1` with default seed `0x6d2b79f5`; those deterministic identity
choices are unrelated to resource capacity.

A configured instruction budget must be a positive JavaScript safe integer. Omitting it uses the current product default
tracked in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). Exhaustion fails deterministically with structured runtime error
`TSR037` instead of hanging and leaves the returned snapshot failed rather than resumable through a later `run(...)`.
Fresh snapshot creation validates the plan, serializable globals, call-depth limit, and RNG seed before returning state.

Externally supplied instruction plans, runtime snapshots, globals, and serializable runtime values are captured into
bounded stable plain-data graphs before detailed validation, cloning, freezing, state construction, execution, event
emission, or RNG consumption. Checkpoint restore validates its fixed envelope without invoking accessors, then captures
its plan and snapshot independently through those existing boundaries. Proxy behavior is not retained, and later phases
consume only captured plain data. Depth is counted from each captured root at zero, and the work limit applies to each
bounded capture. Exceeding either implementation limit or failing stable capture is malformed external runtime data.
Public plan and snapshot validators return their existing invalid results, runtime entry points use `TSR100` or `TSR101`,
and checkpoint restore/deserialization use `TSK002`. These safety limits do not change any format version.

Serializable-set validation and rebuilding use linear native membership tracking while retaining the insertion-ordered `items` array as the canonical serialized representation. Scalar equality and duplicate handling are unchanged.

A halted snapshot is accepted only at the root completion boundary, including an empty root, or immediately after an `exit` instruction. Halted snapshots must also retain no active call frames, loop frames, temporaries, nested scopes, contextual speaker, or failure state. These checks establish that the serialized state is a possible current runtime state; they do not authenticate its execution history.

Persisted runtime counters, identities, instruction positions, collection-iteration positions, depths, temporary IDs, warning-deduplication IDs, speaker references, and source-span positions must be JavaScript safe integers in their existing non-negative or positive ranges. Ordinary finite script numbers retain their existing semantics. The allocator counters `nextEventSequence`, `nextScopeId`, `nextSpeakerId`, and `nextCallFrameId` may hold `Number.MAX_SAFE_INTEGER` as stored state, but an operation that would increment such a value is rejected with `RuntimeDataError` `TSR101` before an event sequence or runtime identity is reused.

The accepted `nextActionId` follows the same no-reuse and pre-increment failure rule. `lastSettlement` is bounded to one record. `currentSessionTimeMs` is finite, non-negative, persisted, and subject to the accepted numeric magnitude and external-data limits.

## Deterministic RNG invariant

The `xorshift32-v1` seed and serialized state must be non-zero unsigned 32-bit integers:

- `createXorShift32State(0)` and fresh runtime creation with seed `0` reject the seed;
- `nextXorShift32(...)` rejects direct malformed state `0`;
- `validateRuntimeSnapshot(...)` rejects a snapshot whose RNG state is `0`;
- checkpoint restore translates that malformed snapshot state into structured `CheckpointError` code `TSK002`;
- valid non-zero seeds retain the existing deterministic sequence and do not change the algorithm or versioned formats.

The zero-state rule prevents the absorbing xorshift32 state in which every future state and output remains zero. It does not change the plan, runtime-snapshot, or checkpoint format version.

## Checkpoint boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify or persist after every instruction. A production runner may execute many instructions in memory until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

A checkpoint is currently a self-contained plan-and-snapshot bundle. Restore validates the checkpoint, instruction plan, snapshot, format versions, references, function/call progress, RNG state, and other structural invariants before execution resumes.

Under ADR 0016, restore of a valid waiting checkpoint remains waiting and preserves the same action, `currentSessionTimeMs`, settlement, and event identities. Restore does not read time or silently complete a deadline. The Player application submits an explicit observation after restore; the atomic observation operation persists the nondecreasing effective coordinate before settling due actions.

## Format evolution

The code constants `INSTRUCTION_PLAN_VERSION`, `RUNTIME_SNAPSHOT_VERSION`, and `CHECKPOINT_VERSION` are authoritative for the numeric revisions accepted by the runtime. Accepted ADRs and canonical specifications remain authoritative for format semantics, architecture, and compatibility policy. This table is the single general human-readable summary of the current revisions:

| Format | Current revision | Reason for current revision |
| --- | ---: | --- |
| Instruction plan | 10 | Added source-ordered `say` preparation instructions that capture speaker provenance and final visible text before a pacing call or interaction may suspend. |
| Runtime snapshot | 13 | The #112 pacing schema captures session pacing settings, active/promoted gates, prepared-output lineage, and the single-use terminal-continuation handoff that remains valid when bounded replay data is replaced. |
| Checkpoint | 16 | Updated the self-contained bundle for instruction-plan revision 10 and runtime-snapshot revision 13. |

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

During the POC, only the current revision of each format is supported. Non-current revisions may be rejected explicitly,
obsolete development saves and fixtures may become invalid after an incompatible change, and migration code requires
a separate owner-approved decision. Git history is sufficient for reconstructing exact older schemas. The current
revisions include populated `chatPacingGate` background state, prepared pacing output, captured smart-autoplay
settings, and exact pacing-settlement release lineage.

## API stability boundary

The exported TypeScript source frontend, source compiler, low-level runtime, snapshot, checkpoint, and RNG functions are current POC surfaces used by the repository and tests. Their presence in `src/index.ts` does not by itself establish a permanent third-party API or wire-format compatibility promise. Long-term package API stability and migration policy remain open.

## Remaining runtime work

- preserve blocking `wait`, generic interactions, and `chatPacingGate` while extending later runtime capabilities
  through explicit versioned schema changes;
- under ADR 0017, define the minimum background timed-work primitive and pause/resume/stop lifecycle for timers
  separately from developer runtime pause;
- define action-kind-specific media, advanced timeout, and detailed-result contracts without unnecessary independent state machines;
- define broader text-output targets and involved-speaker/conversation provenance before multi-context LLM work;
- stable package/plan identity and migration policy;
- Standard Library imports, generated declarations/editor metadata transport, versioning, and capability access;
- iframe host commands and response correlation;
- camera stream ownership, media ownership, cleanup, persistence, and recovery;
- time-integrity diagnostics and future server-authoritative scheduling;
- server checkpoint persistence and conflict resolution;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
