# Runtime

## Accepted model

ADR 0015 requires the AST to remain compile-time data and the runtime to execute a validated, versioned, JSON-safe instruction plan using explicit versioned state. Checkpoints, event sequence numbers, RNG state, scopes, speakers, loop frames, call frames, temporaries, prepared references, and structured failure information must be serializable without a suspended JavaScript call stack.

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

Plan, snapshot, and checkpoint formats currently use version 3. They are POC formats rather than permanent public wire-format guarantees.

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

The compatibility result exposes `say` and `exit` events in its `events` array, structured runtime failures in `errors`, and developer warnings in `warnings`.

### Low-level lowering and runtime route

`compileProgram(program)` is a low-level lowering function for a semantically valid AST. It does not replace `validateSemantics()`. As a narrow defensive boundary, it reuses the shared AST-level finite-literal validation and throws `InstructionCompilationError` with `TSC001` before returning a plan containing `NaN`, `Infinity`, or `-Infinity`. Its other defensive lowering checks include `InstructionCompilationError` with `TSC003` when direct invalid input supplies more positional arguments than a function defines.

The low-level runtime entry points are:

- `executeInstruction(...)` for exactly one instruction;
- `stepToEvent(...)` until the next event, halt, or failure;
- `run(...)` until halt, failure, or instruction-budget exhaustion.

Before an instruction is executed, the runtime validates the instruction plan and runtime snapshot. Callers may also invoke `validateInstructionPlan(...)` and `validateRuntimeSnapshot(...)` explicitly. Invalid plan data produces `RuntimeDataError` `TSR100`; invalid snapshot data produces `RuntimeDataError` `TSR101`.

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

## Visible text boundary

Ordinary scalar visible-text conversion accepts strings, finite numbers, booleans, and `null` according to the current implemented subset. When the value is a list, the runtime selects exactly one item and then accepts only a string or finite number. Selected booleans, `null`, objects, sets, ranges, and nested collections fail with structured runtime error `TSR021`; the runtime does not recursively select or stringify them.

## Runtime defaults and limits

Current POC defaults and validation limits are:

- instruction-plan format version: `3`;
- runtime-snapshot format version: `3`;
- checkpoint format version: `3`;
- default maximum call depth: `256`;
- accepted maximum call depth range: `1` through `4096`;
- maximum external runtime-data nesting depth: `128` (`MAX_EXTERNAL_RUNTIME_DATA_DEPTH`);
- maximum external runtime-data validation work: `100,000` visited values (`MAX_EXTERNAL_RUNTIME_DATA_WORK`);
- default `run(...)` and `stepToEvent(...)` instruction budget: `10,000`;
- compatibility `execute(program, options)` instruction budget: `100,000`;
- default playground RNG algorithm: `xorshift32-v1`;
- default playground seed: `0x6d2b79f5`.

A configured instruction budget must be a positive integer. Exhaustion fails deterministically with structured runtime error `TSR037` instead of hanging. Fresh snapshot creation validates the plan, serializable globals, call-depth limit, and RNG seed before returning state.

Externally supplied instruction plans, runtime snapshots, checkpoints, and serializable runtime values pass through an iterative depth-and-work preflight before detailed recursive validation, cloning, freezing, state construction, event emission, or RNG consumption. Depth is counted from the external root at zero, and the work limit applies to each bounded preflight traversal. Exceeding either implementation limit is malformed external runtime data. Public plan and snapshot validators return their existing invalid results, runtime entry points use `TSR100` or `TSR101`, and checkpoint restore/deserialization use `TSK002`. These safety limits do not change any format version.

## Deterministic RNG invariant

The `xorshift32-v1` seed and serialized state must be non-zero unsigned 32-bit integers:

- `createXorShift32State(0)` and fresh runtime creation with seed `0` reject the seed;
- `nextXorShift32(...)` rejects direct malformed state `0`;
- `validateRuntimeSnapshot(...)` rejects a snapshot whose RNG state is `0`;
- checkpoint restore translates that malformed snapshot state into structured `CheckpointError` code `TSK002`;
- valid non-zero seeds retain the existing deterministic sequence and do not change the algorithm or versioned formats.

The zero-state rule prevents the absorbing xorshift32 state in which every future state and output remains zero. It does not change the plan, runtime-snapshot, or checkpoint format version; all remain version 3.

## Checkpoint boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify or persist after every instruction. A production runner may execute many instructions in memory until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

A checkpoint is currently a self-contained plan-and-snapshot bundle. Restore validates the checkpoint, instruction plan, snapshot, format versions, references, function/call progress, RNG state, and other structural invariants before execution resumes.

## API stability boundary

The exported TypeScript compiler, compatibility wrapper, low-level runtime, snapshot, checkpoint, and RNG functions are current POC surfaces used by the repository and tests. Their presence in `src/index.ts` does not by itself establish a permanent third-party API or wire-format compatibility promise. Long-term package API stability and migration policy remain open.

## Remaining runtime work

- stable package/plan identity and migration policy;
- pending-action state for input, waits, timers, and choices;
- iframe host commands and response correlation;
- media ownership, cleanup, and recovery;
- server checkpoint persistence, conflict resolution, and scheduling;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
