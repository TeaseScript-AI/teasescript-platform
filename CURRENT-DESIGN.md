# Current design

## Product and architecture

- Browser-first community platform with accounts, forum, catalog, editor, and tease player.
- Backend: PHP 8 with Laravel and PostgreSQL.
- Laravel remains the only public backend; a local Node/TypeScript CLI may support development or Laravel-invoked tooling, but no second public Node server is accepted.
- Parser/runtime core: TypeScript compiled to JavaScript.
- `main.tease` is the fixed package entry point.
- Regular content uses `.tease`; advanced reusable programming logic uses real TypeScript in `.ts`.
- The player, engine, Standard Library, package libraries, standard UI, and custom UI eventually run inside a sandboxed cross-origin iframe.
- Use one deterministic engine, one state model, and one save/checkpoint format for finite sessions and long-running personalities.

## TeaseScript authority

`docs/specifications/accepted-syntaxes-v30.md` is the accepted syntax baseline unless a later accepted ADR or explicitly recorded post-V30 decision supersedes a specific point.

Accepted post-V30 decisions relevant to the current runtime include:

- ADR 0013: insertion-ordered `set[...]` collections and `type set` annotations;
- ADR 0014: recursive value-copy semantics for ordinary values and speaker-reference identity behavior;
- ADR 0015: versioned JSON-safe instruction plans, explicit runtime state, checkpoints, deterministic stepping/RNG/events, and no suspended JavaScript call stack.

Direct assignment remains `score = 20`; `set score = 20` remains invalid.

## Implemented POC milestones

### Parser and core language

The implementation includes lexer/parser/AST/diagnostics, semantic validation, literals, expressions, variables, assignments, speakers, output, collections, and accepted copy/error behavior.

### Serializable runtime and playground

The runtime executes validated instruction plans rather than AST nodes. It provides:

- explicit versioned JSON-safe runtime snapshots and self-contained checkpoints;
- instruction and event-boundary stepping;
- typed sequenced events and structured failures;
- deterministic serializable RNG state;
- instruction budgets;
- a standalone repository-backed browser playground.

### Serializable control flow

Comments, ranges, deterministic random built-ins, `else if`, `repeat`, list/set/range `for`, `while`, `break`, and `continue` compile to explicit instructions and JSON-safe loop frames.

### Serializable user-defined functions

The implementation includes:

- top-level function declarations;
- required and trailing-default parameters;
- positional or named calls;
- value, bare, and implicit returns;
- forward and nested calls, direct recursion, and mutual recursion;
- explicit JSON-safe call frames and caller temporaries;
- function-aware scope and loop ownership;
- complete source-order-preserving expression and assignment lowering;
- checkpoint-safe prepared references for assignment targets and mutable collection receivers;
- full suspended-caller temporary liveness validation;
- strict function prologue/region and checkpoint validation;
- centralized enforcement of accepted V30 protected names.

Instruction plans, runtime snapshots, and checkpoints currently use version 3. Complete static typing and the wider V30 runtime/API surface remain out of scope.

## Runtime execution and performance boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify, clone for persistence, or send state to Laravel after every instruction. A production runner may execute many instructions in validated in-memory state until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

POC implementation choices such as full snapshot cloning may later be optimized, provided observable source order, deterministic behavior, copy semantics, and restore behavior remain identical.

## Required design discipline

- AST nodes carry source locations and remain compile-time data.
- The parser does not perform runtime execution.
- Runtime output is represented as typed events, not direct HTML.
- Runtime actions, handles, scopes, loop frames, call frames, temporaries, and pending work that survive pause/resume must be explicit and JSON-safe.
- Do not use suspended JavaScript functions, generators, closures, or implicit module-global mutable state as resumable execution state.

## Major remaining groups

- units, date, time, datetime, and duration values;
- choices, input, waits, timers, and resumable pending actions;
- cross-origin iframe host protocol and validated messaging;
- media lifecycle, resource ownership, and custom views;
- TypeScript library linkage and richer module selection;
- package/plan identity and migration policy;
- Laravel persistence, accounts, global data, scheduling, and continuous personalities;
- complete static typing and remaining V30 coverage.
