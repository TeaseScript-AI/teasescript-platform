# Runtime

## Playground execution helper

`playground/workspace.ts` is the DOM-free adapter shared by the browser controller and development automation routes. It uses the public compiler and canonical `run`/`stepToEvent` runtime interfaces to create fresh validated snapshots and return JSON-safe diagnostics, events, plan, snapshot, status, and instruction count. It stops on `halted`, `failed`, `waiting`, or the canonical instruction-budget failure and does not use the compatibility `Interpreter.execute(...)` route.

A blocking `wait` therefore reports `actionRequested` and `waiting`; it is neither a completed timer nor a halted runtime. Action completion, warnings, runtime failures, exit, and plan completion remain technical events.

## Accepted model

ADR 0015 requires the AST to remain compile-time data and the runtime to execute a validated, versioned, JSON-safe instruction plan using explicit versioned state. Checkpoints, event sequence numbers, RNG state, scopes, speakers, loop frames, call frames, temporaries, prepared references, and structured failure information must be serializable without a suspended JavaScript call stack.

ADR 0016 accepts the resumable pending-action contract for waits, timers, choices, input, buttons, media completion, and future typed player capabilities.

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

Candidate Standard Library responsibilities include `say` policy, standard output targets, visible timer presentation, common input wrappers, validation/retry helpers, and friendly lifecycle APIs. ADR 0018 accepts the first concrete text/output slice described below. The accepted decisions do not by themselves change current runtime code or format constants.

## Accepted first Standard Library runtime contract

ADR 0018 selects one generic foreground interaction family for `showButton`, `askText`, `askNumber`, and `choose`, followed by a separate `say` smart-autoplay slice. The generic runtime family is implemented for manually constructed validated plans; author-facing syntax, Standard Library lowering, Player UI, and smart autoplay remain separate work.

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

Result-bearing text, number, and choice instructions require the destination temporary to be absent on every path that reaches the interaction. Every reachable continuation path must then clear that temporary before natural root completion or discard the active temporary set through `return` or `exit`. Reaching another producer or interaction with the same still-live destination is invalid. The plan validator charges this interaction control-flow analysis against a fixed work budget. A result-free button may be the terminal root instruction and uses the existing canonical settled root-end transition.

Completion semantics are:

- `askText` normalizes `CRLF` and standalone `CR` to `LF`, otherwise preserves submitted text, rejects whitespace-only input, returns `string`, and uses the same normalized text in the player transcript;
- `askNumber` accepts one line of text, trims surrounding whitespace, parses accepted TeaseScript decimal/scientific forms, requires a finite result, canonicalizes negative zero to numeric `0`, returns `number`, and preserves the trimmed submitted text in the transcript;
- an unlabelled `choose` returns visible text;
- a labelled `choose` accepts one exact stored identifier or numeric label and returns `string` or `number` respectively;
- `showButton` has no useful first-slice return value or timeout.

A labelled rendered choice control supplies its selected label to the engine; an unlabelled control supplies its selected visible text. The engine derives the canonical transcript text from the active action. A rendered control never supplies a replacement canonical transcript string.

Interaction limits version 1 uses three shared technical ceilings: `65,536` UTF-8 bytes for any one string, `65,536` UTF-8 bytes across all strings retained by one interaction definition, and `4,096` choice-option entries. Completion text uses the same per-string ceiling. Bounded validation first rejects impossible UTF-16 lengths, measures each accepted field once, and stops encoding further fields after either a per-string or aggregate failure. Text completion measures the raw host string once; CRLF/CR-to-LF normalization cannot increase its UTF-8 size. These values align interaction messages with the existing bounded playground source/message scale while remaining below the `100,000`-value external-data work boundary. They are transport, storage, rendering, and validation safety ceilings, not recommended UI lengths. Over-limit data is rejected without truncation, clamping, or partial state mutation.

Whitespace-only text rejection uses `ecmascript-whitespace-v1`: the ECMAScript `WhiteSpace` and `LineTerminator` classification represented by the engine's Unicode-aware regular expression. The identifier-choice label grammar is the current ASCII TeaseScript identifier form. Choice duplicate detection and completion matching use bounded native sets or one linear option pass.

Successful completion emits the canonical `playerTranscript` event first and `actionCompleted` second. Both receive monotonic sequences, and the bounded settlement retains both sequences, the canonical result, transcript text, destination temporary, and owning call-frame identity for duplicate replay and checkpoint provenance. Delay creation preflights its request plus future completion sequence; interaction creation preflights its request plus future transcript and completion sequences. Interaction completion rechecks both required sequences before writing its destination. Continuation execution remains eligible only through a later normal runtime entry.

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

Skip settles only the pacing gate. It does not skip arbitrary instructions, complete `wait`, cancel an interaction, or create a player transcript message.

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

The selected behavior is fully lowered into the instruction plan. The issue #74 exact library token is not added to plan/checkpoint data, no implicit latest lookup occurs, and no migration is included.

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

Instruction plans use version 5; runtime snapshots and checkpoints use version 6. They are POC formats rather than permanent public wire-format guarantees.

The current implementation contains compiler-owned blocking `wait` and one generic foreground `interaction` instruction/action family for button, text, number, and choice. It retains the `waiting` status, persisted session time, one foreground action, an empty validated background-action collection, monotonic action IDs, bounded last-settlement replay, explicit time observation, and typed completion operations. Browser scheduling, author-facing interaction syntax, Player controls, and background pacing remain out of scope.

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

A valid current `waiting` snapshot contains exactly one foreground delay or interaction action. Delay creation time is no later than the persisted session coordinate and its deadline is strictly later; a due delay is settled only by an explicit time observation. An interaction retains its kind, ownership depths, call-frame identity, destination/result domain, Standard chat target, optional requesting speaker ID, validated UI payload, and request sequence. A waiting result destination must still be absent. A completed interaction settlement keeps the destination and owner identity so validation can bind an unconsumed result to the settlement even after unrelated instructions or while its caller temporaries are suspended by a nested function call. Every persisted interaction instruction, UI/accessibility/option shape, action, and settlement has an exact supported key set. Non-waiting states contain no foreground action. The background collection remains present but must be empty until the separately scoped pacing implementation versions that schema.

`currentSessionTimeMs` is canonical runtime state. It preserves the nondecreasing session coordinate across checkpoint and restore. A fresh snapshot receives a validated initial coordinate; deterministic tests may use `0`.

A blocking instruction evaluates its arguments, stores a complete JSON-safe action and continuation, advances to `waiting`, emits `actionRequested`, and stops. A validated completion stores its result and bounded `lastSettlement`, removes the matching action, emits `actionCompleted`, and leaves continuation or handler execution to the next runtime entry call.

`wait 0` is deliberately immediate: its duration expression is still evaluated, but it allocates no action ID, creates no pending action or settlement, and emits neither action event. The next source instruction runs normally; if it was the terminal root instruction, ordinary natural completion emits one `complete` event. In contrast, a positive terminal root wait settles with `actionCompleted`; the following runtime entry consumes the canonical settled root-end transition and emits the sequenced `complete` event. Re-entering an already halted snapshot emits no further completion event.

A duplicate delivery matching `lastSettlement` returns the same canonical recorded settlement without another write, event, RNG advance, handler, or continuation. A newer settlement replaces the previous record. Each delay settlement retains owning and continuation instruction positions.

Completion lookup always searches the active foreground action and all active background actions first. Only when no active action matches does the runtime compare `lastSettlement`, classify a lower previously issued ID as `staleAction`, or classify an unissued ID as `unknownAction`.

Timed actions store an absolute deadline derived from `currentSessionTimeMs`. The runtime does not read browser or operating-system clocks directly. The player maps monotonic elapsed deltas onto the session coordinate, schedules wake-ups, and submits validated observations; tests use a fake clock and never sleep in real time.

A time observation updates the snapshot atomically:

```text
effectiveNow = max(snapshot.currentSessionTimeMs, suppliedNow)
snapshot.currentSessionTimeMs = effectiveNow
settle actions due at effectiveNow
```

No checkpoint may contain due-action processing performed against a newer observation while retaining the older session-time value.

Blocking `wait` remains the first source-to-runtime slice. The generic interaction runtime is now the second foreground use of ADR 0016, exercised through manual validated plans until its separate parser/compiler issue lands. Smart-autoplay and `chatPacingGate` remain unimplemented.

## Compiler and execution entry points

### Normal source route

`compileSource(source, options)` is the normal source compilation route. It:

1. parses source text into a `Program`;
2. runs shared AST-level validation for parsed non-finite numeric literals;
3. runs semantic validation when parsing and finite-literal checking produced no errors;
4. includes the core runtime built-ins plus configured global and builtin names in validation;
5. lowers the program only when no error diagnostics remain.

The result separates parser and semantic diagnostics and returns `plan: null` when compilation fails. A returned plan is checked at the snapshot/runtime boundary or may be checked explicitly with `validateInstructionPlan(...)` before use.

`compileSource(...)` rejects numeric literals such as `1e999` and `-1e999` with error diagnostic `TSC001`. It does not return an instruction plan for those inputs. Large finite values such as `1e308` remain valid. The normal compilation route therefore cannot return a plan containing literal `Infinity`, `-Infinity`, or `NaN`, and instruction-plan validation independently rejects any non-finite number in plan data.

The `TSC001` check is implemented as shared AST-level validation. `compileSource(...)` includes these diagnostics in its parser-diagnostic boundary, while the lower-level `parse(...)` result may still expose the raw JavaScript number produced while parsing. Callers must not treat parsing alone as successful compilation.

### Template interpolation

Template interpolation uses normal TeaseScript expression parsing and supports recursively nested template literals and nested interpolation expressions. The lexer preserves exact source spans and keeps escaped backticks and escaped `${` as literal template text.

Unterminated nested content remains structured: `TSL004` reports an unterminated template and `TSL005` reports an unterminated interpolation. A backtick starts a nested template whenever the current interpolation position can begin an expression, including when horizontal whitespace or a physical line ending follows the nested opening backtick. A backtick in a position where an expression cannot start remains the outer-template recovery boundary.

### Direct AST compatibility route

`execute(program, options)` and `Interpreter.execute(program)` are compatibility/testing entry points for callers that already hold a `Program`. They are not an alternative runtime representation: they validate the program, lower it to an instruction plan, create explicit runtime state, and execute that plan.

Before lowering, the compatibility route runs the shared non-finite-literal AST validation and semantic validation with configured global and builtin names. Non-finite literals produce exact-span `TSC001` diagnostics. These diagnostics are ordered before ordinary semantic diagnostics, and any error throws `InterpreterCompilationError` before lowering, runtime-state creation, event emission, or RNG consumption. `InterpreterOptions.random` is required so compatibility execution remains deterministic.

After valid lowering but before a runtime snapshot is created, the compatibility route rejects a plan containing any compiled blocking `wait` instruction with `InterpreterCompilationError` diagnostic `TSC004`: "Blocking `wait` requires the canonical resumable runtime API." The diagnostic uses the first `wait` instruction in canonical plan order. This conservative whole-program rule includes waits in branches, loops, nested blocks, and called or uncalled function bodies; it prevents this result shape from silently returning partial pre-wait output without a pending action or resume operation.

This is a temporary compatibility-boundary behavior, not a statement that blocking `wait` is unsupported. The canonical plan/snapshot/runtime API continues to support waits, pending actions, checkpoints, completion, and resumption. The long-term lifecycle of the compatibility APIs and any resumable compatibility result require a separate owner-approved decision.

The compatibility result exposes `say` and `exit` events in its `events` array, structured runtime failures in `errors`, and developer warnings in `warnings`.

### Low-level lowering and runtime route

`compileProgram(program)` is a low-level lowering function for a semantically valid AST. It does not replace `validateSemantics()`. As a narrow defensive boundary, it reuses the shared AST-level finite-literal validation and throws `InstructionCompilationError` with `TSC001` before returning a plan containing `NaN`, `Infinity`, or `-Infinity`. Its other defensive lowering checks include `InstructionCompilationError` with `TSC003` when direct invalid input supplies more positional arguments than a function defines.

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
- host `RuntimeSpeaker` values are currently unsupported and are rejected rather than converted into temporary or dangling speaker references;
- normally declared TeaseScript speakers remain runtime-managed state and continue to use stable serialized speaker IDs.

The low-level `RuntimeCapabilities.random` hook is a compatibility/testing override. Without it, execution advances the serialized `xorshift32-v1` state. An injected random source must return a finite number in the half-open range `[0, 1)`.

The override's own state is external to the runtime snapshot. A checkpoint is therefore not self-contained with respect to an arbitrary injected random source. Canonical checkpoint-equivalence guarantees use the serialized runtime RNG; tests that use the override must explicitly recreate an equivalent deterministic external source.

Future player capabilities must return typed, bounded, JSON-safe outcomes correlated to one action ID. Raw DOM exceptions, browser handles, streams, callbacks, and mutable host objects do not enter the snapshot.

Under ADR 0017, Standard Library and package-library wrappers may call documented typed capabilities, but they do not bypass these boundaries or become alternate owners of canonical action state.

## Visible text boundary

Ordinary scalar visible-text conversion accepts strings, finite numbers, booleans, and `null` according to the current implemented subset. When the value is a list, the runtime selects exactly one item and then accepts only a string or finite number. Selected booleans, `null`, objects, sets, ranges, and nested collections fail with structured runtime error `TSR021`; the runtime does not recursively select or stringify them.

The earlier proposal for automatic chat pacing at 17 visible characters per second is superseded. ADR 0018 now defines the accepted deterministic first-POC smart-autoplay and pacing-action contract. That contract remains unimplemented until the required versioned runtime changes land.

## Runtime defaults and limits

Current POC defaults and validation limits are:

- instruction-plan format version: `4`;
- runtime-snapshot format version: `5`;
- checkpoint format version: `5`;
- default maximum call depth: `256`;
- accepted maximum call depth range: `1` through `4096`;
- maximum external runtime-data nesting depth: `128` (`MAX_EXTERNAL_RUNTIME_DATA_DEPTH`);
- maximum external runtime-data validation work: `100,000` visited values (`MAX_EXTERNAL_RUNTIME_DATA_WORK`);
- default `run(...)` and `stepToEvent(...)` instruction budget: `10,000`;
- compatibility `execute(program, options)` instruction budget: `100,000`;
- default playground RNG algorithm: `xorshift32-v1`;
- default playground seed: `0x6d2b79f5`.

A configured instruction budget must be a positive integer. Exhaustion fails deterministically with structured runtime error `TSR037` instead of hanging. Fresh snapshot creation validates the plan, serializable globals, call-depth limit, and RNG seed before returning state.

Externally supplied instruction plans, runtime snapshots, checkpoints, globals, and serializable runtime values are captured into one bounded stable plain-data graph before detailed validation, cloning, freezing, state construction, execution, event emission, or RNG consumption. Enumerable accessors are rejected without invocation, proxy behavior is not retained, and later phases consume only the captured graph. Depth is counted from the external root at zero, and the work limit applies to each bounded capture. Exceeding either implementation limit or failing stable capture is malformed external runtime data. Public plan and snapshot validators return their existing invalid results, runtime entry points use `TSR100` or `TSR101`, and checkpoint restore/deserialization use `TSK002`. These safety limits do not change any format version.

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

The current formats use version 5 instruction plans and version 6 runtime snapshots/checkpoints. These versions add the generic interaction instruction/action/settlement family and canonical player-transcript event data while retaining delay provenance:

```text
instruction plan version: 5
runtime snapshot version: 6
checkpoint version: 6
```

These numbers describe internal POC JSON schemas, not TeaseScript product releases. Pending-action entries do not receive a redundant nested version field.

No migration is provided; older incompatible objects are rejected through the existing structured boundaries. Populated background actions, prepared pacing output, or captured smart-autoplay settings require their own later explicit format changes.

## API stability boundary

The exported TypeScript compiler, compatibility wrapper, low-level runtime, snapshot, checkpoint, and RNG functions are current POC surfaces used by the repository and tests. Their presence in `src/index.ts` does not by itself establish a permanent third-party API or wire-format compatibility promise. Long-term package API stability and migration policy remain open.

## Remaining runtime work

- preserve blocking `wait` and the implemented generic interaction family while adding later ADR 0018 slices only through explicit versioned schema changes;
- implement `chatPacingGate` through ADR 0016 background/foreground action state, checked captured settings, prepared output, and exact event ordering;
- under ADR 0017, define the minimum background timed-work primitive and pause/resume/stop lifecycle for timers separately from developer runtime pause;
- define action-kind-specific media, advanced timeout, and detailed-result contracts without unnecessary independent state machines;
- define broader text-output targets and involved-speaker/conversation provenance before multi-context LLM work;
- stable package/plan identity and migration policy;
- Standard Library imports, generated declarations/editor metadata transport, versioning, and capability access;
- iframe host commands and response correlation;
- camera stream ownership, media ownership, cleanup, persistence, and recovery;
- time-integrity diagnostics and future server-authoritative scheduling;
- server checkpoint persistence and conflict resolution;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
