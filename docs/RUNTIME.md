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

Candidate Standard Library responsibilities include `say` policy, standard output targets, visible timer presentation, common input wrappers, validation/retry helpers, and friendly lifecycle APIs. Exact primitive names and public APIs remain open. The accepted boundary does not change current runtime code, accepted V30 syntax, or ADR 0016 semantics.

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

Plan, snapshot, and checkpoint formats currently use version 4. They are POC formats rather than permanent public wire-format guarantees.

The current implementation contains the first ADR 0016 slice: compiler-owned blocking `wait`, the `waiting` status, persisted session time, one foreground delay action, an empty validated background-action collection, monotonic action IDs, bounded last-settlement replay, and explicit time observation/completion operations. Browser scheduling and all other action kinds remain out of scope.

## Accepted resumable pending-action model

ADR 0016 accepts this conceptual version-4 snapshot state:

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

A valid `waiting` snapshot contains exactly one foreground delay action. Its creation time is no later than the persisted session coordinate and its deadline is strictly later; a due action is settled only by an explicit time observation and is never silently repaired during restore. Non-waiting states contain none. The first implementation slice includes the background collection in the version-4 schema but requires it to remain empty.

`currentSessionTimeMs` is canonical runtime state. It preserves the nondecreasing session coordinate across checkpoint and restore. A fresh version-4 snapshot receives a validated initial coordinate; deterministic tests may use `0`.

A blocking instruction evaluates its arguments, stores a complete JSON-safe action and continuation, advances to `waiting`, emits `actionRequested`, and stops. A validated completion stores its result and bounded `lastSettlement`, removes the matching action, emits `actionCompleted`, and leaves continuation or handler execution to the next runtime entry call.

`wait 0` is deliberately immediate: its duration expression is still evaluated, but it allocates no action ID, creates no pending action or settlement, and emits neither action event. The next source instruction runs normally; if it was the terminal root instruction, ordinary natural completion emits one `complete` event. In contrast, a positive terminal root wait settles with `actionCompleted`; the following runtime entry consumes the one canonical settled root-end transition and emits the sequenced `complete` event. Re-entering an already halted snapshot emits no further completion event.

A duplicate delivery matching `lastSettlement` returns the same canonical recorded settlement without another write, event, RNG advance, handler, or continuation. A newer settlement replaces the previous record.

Completion lookup always searches the active foreground action and all active background actions first. Only when no active action matches does the runtime compare `lastSettlement`, classify a lower previously issued ID as `staleAction`, or classify an unissued ID as `unknownAction`. This prevents an older long-running background action from being misclassified after a newer action settles.

Timed actions store an absolute deadline derived from `currentSessionTimeMs`. The runtime does not read browser or operating-system clocks directly. The player maps monotonic elapsed deltas onto the session coordinate, schedules wake-ups, and submits validated observations; tests use a fake clock and never sleep in real time.

A time observation updates the snapshot atomically:

```text
effectiveNow = max(snapshot.currentSessionTimeMs, suppliedNow)
snapshot.currentSessionTimeMs = effectiveNow
settle actions due at effectiveNow
```

No checkpoint may contain due-action processing performed against a newer observation while retaining the older session-time value.

The first source-to-runtime slice is blocking `wait`. See ADR 0016 for the state machine, identity lookup, idempotency, time semantics, validation invariants, test matrix, alternatives, and implementation sequence.

Camera stream ownership, media persistence, text-output composition, and chat pacing are adjacent follow-up designs rather than part of the first wait implementation. Current direction and open questions are recorded under accepted ADR 0017 and in [`planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`](planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md).

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

When ADR 0016 is implemented, these entry points must also stop cleanly at `waiting`. Separate validated operations submit time observations and typed action completions; ordinary execution entry points may not bypass the pending action.

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

The earlier proposal for automatic chat pacing at 17 visible characters per second is superseded and is not current implementation guidance. ADR 0017 treats a minimal typed text-output event as an engine concern and author-facing `say` behavior as a Standard Library candidate. Final pacing, output-target, speaker, participant, and conversation-provenance semantics require later decisions.

## Runtime defaults and limits

Current POC defaults and validation limits are:

- instruction-plan format version: `4`;
- runtime-snapshot format version: `4`;
- checkpoint format version: `4`;
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

Under ADR 0016, restore of a valid waiting checkpoint remains waiting and preserves the same action, `currentSessionTimeMs`, settlement, and event identities. Restore does not read time or silently complete a deadline. The player submits an explicit observation after restore; the atomic observation operation persists the nondecreasing effective coordinate before settling due actions.

## Format evolution

Version 4 is the current implemented format. The incompatible waiting status, persisted session-time coordinate, foreground/background action fields, action counter, and settlement record require:

```text
instruction plan version: 4
runtime snapshot version: 4
checkpoint version: 4
```

These numbers describe internal POC JSON schemas, not TeaseScript product releases. Pending-action entries do not receive a redundant nested version field in the first version-4 design.

## API stability boundary

The exported TypeScript compiler, compatibility wrapper, low-level runtime, snapshot, checkpoint, and RNG functions are current POC surfaces used by the repository and tests. Their presence in `src/index.ts` does not by itself establish a permanent third-party API or wire-format compatibility promise. Long-term package API stability and migration policy remain open.

## Remaining runtime work

- maintain the implemented blocking `wait` slice while deferring Standard Library linkage and all other pending-action kinds;
- under accepted ADR 0017, define the minimum background timed-work primitive and pause/resume/stop lifecycle before selecting the public timer API;
- define action-kind-specific input, choice, button, media, timeout, and cancellation contracts while avoiding unnecessary independent state machines;
- define typed text-output targets and stable speaker/participant provenance before final chat-pacing and LLM-context work;
- stable package/plan identity and migration policy;
- Standard Library linkage, generated declarations/editor metadata, versioning, and capability access;
- iframe host commands and response correlation;
- camera stream ownership, media ownership, cleanup, persistence, and recovery;
- time-integrity diagnostics and future server-authoritative scheduling;
- server checkpoint persistence and conflict resolution;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
