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
2. runs semantic validation when parsing produced no errors;
3. includes the core runtime built-ins plus configured global and builtin names in validation;
4. lowers the program only when no error diagnostics remain.

The result separates parser and semantic diagnostics and returns `plan: null` when compilation fails.

### Direct AST compatibility route

`execute(program, options)` and `Interpreter.execute(program)` are compatibility/testing entry points for callers that already hold a `Program`. They are not an alternative runtime representation: they validate the program, lower it to an instruction plan, create explicit runtime state, and execute that plan.

Configured global and builtin names participate in semantic validation. Semantic errors throw `InterpreterCompilationError` with the structured diagnostics instead of reaching runtime or failing through an incidental JavaScript exception. `InterpreterOptions.random` is required so compatibility execution remains deterministic.

The compatibility result exposes `say` and `exit` events in its `events` array, structured runtime failures in `errors`, and developer warnings in `warnings`.

### Low-level lowering and runtime route

`compileProgram(program)` is a low-level lowering function for a semantically valid AST. It does not replace `validateSemantics()`. Its defensive lowering checks include `InstructionCompilationError` with code `TSC003` when direct invalid input supplies more positional arguments than a function defines.

The low-level runtime entry points are:

- `executeInstruction(...)` for exactly one instruction;
- `stepToEvent(...)` until the next event, halt, or failure;
- `run(...)` until halt, failure, or instruction-budget exhaustion.

These entry points validate the instruction plan and runtime snapshot before execution. Invalid plan data produces `RuntimeDataError` `TSR100`; invalid snapshot data produces `RuntimeDataError` `TSR101`.

## Host values and capabilities

Host and builtin capabilities are explicitly injected and are not serialized into runtime state.

The current boundaries are:

- only explicitly registered own builtin names are callable; inherited JavaScript prototype names do not create capabilities;
- core built-ins retain precedence over injected capabilities with the same names;
- low-level named builtin arguments use an immutable prototype-free record;
- values entering globals or returning from builtins are copied and validated as serializable runtime values;
- invalid builtin return values become structured runtime failures, including `TSR013` for invalid values;
- host `RuntimeSpeaker` values are currently unsupported and are rejected rather than converted into temporary or dangling speaker references;
- normally declared TeaseScript speakers remain runtime-managed state and continue to use stable serialized speaker IDs.

The low-level `RuntimeCapabilities.random` hook is a compatibility/testing override. Without it, execution advances the serialized `xorshift32-v1` state. An injected random source must return a finite number in the half-open range `[0, 1)`.

## Runtime defaults and limits

Current POC defaults and validation limits are:

- instruction-plan format version: `3`;
- runtime-snapshot format version: `3`;
- checkpoint format version: `3`;
- default maximum call depth: `256`;
- accepted maximum call depth range: `1` through `4096`;
- default `run(...)` and `stepToEvent(...)` instruction budget: `10,000`;
- compatibility `execute(program, options)` instruction budget: `100,000`;
- default playground RNG algorithm: `xorshift32-v1`;
- default playground seed: `0x6d2b79f5`.

A configured instruction budget must be a positive integer. Exhaustion fails deterministically with structured runtime error `TSR037` instead of hanging. Fresh snapshot creation validates the plan, serializable globals, call-depth limit, and RNG seed before returning state.

## Checkpoint boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify or persist after every instruction. A production runner may execute many instructions in memory until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

A checkpoint is currently a self-contained plan-and-snapshot bundle. Restore validates the checkpoint, instruction plan, snapshot, format versions, references, function/call progress, and other structural invariants before execution resumes.

## API stability boundary

The exported TypeScript compiler, compatibility wrapper, low-level runtime, snapshot, checkpoint, and RNG functions are current POC surfaces used by the repository and tests. Their presence in `src/index.ts` does not by itself establish a permanent third-party API or wire-format compatibility promise. Long-term package API stability and migration policy remain open.

## Remaining runtime work

- stable package/plan identity and migration policy;
- pending-action state for input, waits, timers, and choices;
- iframe host commands and response correlation;
- media ownership, cleanup, and recovery;
- server checkpoint persistence, conflict resolution, and scheduling;
- performance profiling and safe optimization of snapshot cloning/liveness metadata.
