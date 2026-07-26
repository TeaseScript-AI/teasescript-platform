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
- ADR 0014: recursive value-copy semantics for ordinary values, scalar-only sets, empty collection errors, and speaker display-name fallback behavior;
- ADR 0015: versioned JSON-safe instruction plans, explicit runtime state, checkpoints, deterministic stepping/RNG/events, and no suspended JavaScript call stack;
- ADR 0016: resumable pending actions with persisted session time, foreground/background separation, monotonic action IDs, bounded settlement replay, active-first completion lookup, injected time observations, and blocking `wait` as the first implementation slice.

Direct assignment remains `score = 20`; `set score = 20` remains invalid.

## Proposed engine and Standard Library boundary

Proposed ADR 0017 separates the smallest deterministic engine primitives from author-friendly Standard Library APIs:

```text
TeaseScript scripts
    -> package libraries
    -> platform Standard Library
    -> typed engine primitives
    -> deterministic runtime and player boundary
```

The proposal keeps canonical identity, pending actions, time, validation, handles, checkpointing, events, and security in the engine. Friendly presentation and composition such as `say` policy, common input helpers, and timer presentation should be Standard Library candidates when they can be built without weakening those guarantees.

Package libraries should be able to reuse Standard Library exports. Generated TypeScript signatures and editor metadata should provide autocomplete, parameter hints, hover documentation, and diagnostics for ordinary library calls. Libraries must not mutate TeaseScript grammar; special command or block syntax remains an explicit language/compiler decision.

This direction remains proposed. It does not change the accepted V30 syntax, ADR 0016 pending-action semantics, or the currently implemented `say` path until the owner accepts ADR 0017 and a tested library-linkage plan exists.

## Implemented POC milestones

### Parser and core language

The implementation includes lexer/parser/AST/diagnostics, semantic validation, literals, expressions, variables, assignments, speakers, output, collections, and accepted copy/error behavior. Template interpolation supports nested template literals and recursive interpolation with exact source spans and structured recovery diagnostics. Shared AST-level validation rejects non-finite numeric literals through the normal `compileSource(...)` boundary and the direct `Program` compatibility boundary before an instruction plan is returned or executed.

### Serializable runtime and playground

The runtime executes validated instruction plans rather than AST nodes. It provides:

- explicit versioned JSON-safe runtime snapshots and self-contained checkpoints;
- instruction and event-boundary stepping;
- typed sequenced events and structured failures;
- deterministic serializable `xorshift32-v1` state with a non-zero seed/state invariant;
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

### Implemented foundation hardening

The current implementation also:

- validates direct `Program` compatibility execution before lowering, including shared `TSC001` rejection of non-finite numeric literal values;
- applies a narrow defensive `compileProgram(...)` guard so direct lowering cannot return a plan containing `NaN`, `Infinity`, or `-Infinity`;
- rejects host `RuntimeSpeaker` values at the current compatibility boundary rather than creating dangling references;
- requires explicit own-property builtin registration and stores low-level named builtin arguments in a prototype-free record;
- restricts automatic visible-list text selection to strings and finite numbers after one item is selected;
- rejects malformed zero `xorshift32-v1` seed, direct state, runtime snapshot state, and restored checkpoint state.

Instruction plans, runtime snapshots, and checkpoints currently use version 3. Complete static typing and the wider V30 runtime/API surface remain out of scope.

## Accepted pending-action direction

ADR 0016 accepts:

- runtime status `waiting`;
- exactly one foreground blocking action;
- a separate background-action collection;
- persisted finite non-negative `currentSessionTimeMs` so nondecreasing time survives checkpoint and restore;
- monotonic persisted action identities;
- one bounded `lastSettlement` record for deterministic immediate retry;
- active foreground/background lookup before `alreadySettled`, `staleAction`, or `unknownAction` classification;
- absolute deadlines on the persisted injected session coordinate;
- typed completion operations and `actionRequested`/`actionCompleted` events;
- blocking `wait` as the first source-to-runtime implementation slice;
- version-4 internal plan, snapshot, and checkpoint schemas when the new fields are implemented.

The first slice does not implement camera/media lifecycle, chat pacing, the production host protocol, or Laravel scheduling. Selected camera, media-persistence, time-integrity, and chat-pacing directions are recorded as explicit follow-up design work in [`docs/planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`](docs/planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md).

## Runtime execution and performance boundary

Runtime state must be serializable at every instruction boundary, but normal execution does not need to stringify, clone for persistence, or send state to Laravel after every instruction. A production runner may execute many instructions in validated in-memory state until an event, wait, input, timer, explicit save point, page lifecycle boundary, or configured checkpoint interval.

POC implementation choices such as full snapshot cloning may later be optimized, provided observable source order, deterministic behavior, copy semantics, and restore behavior remain identical.

## Required design discipline

- AST nodes carry source locations and remain compile-time data.
- The parser does not perform runtime execution.
- Runtime output is represented as typed events, not direct HTML.
- Runtime actions, handles, scopes, loop frames, call frames, temporaries, pending work, session time, and settlement state that survive pause/resume must be explicit and JSON-safe.
- Do not use suspended JavaScript functions, generators, closures, or implicit module-global mutable state as resumable execution state.

## Major remaining groups

- units, date, time, datetime, and duration values;
- implementation of the accepted pending-action contract, then action-kind-specific choices, input, waits, timers, buttons, and media completion;
- cross-origin iframe host protocol and validated messaging;
- camera/media lifecycle, resource ownership, persistence, recovery, and custom views;
- owner review of the proposed engine/Standard-Library boundary before replacing the timer and chat-pacing proposals;
- TypeScript library linkage, generated declarations/editor metadata, Standard Library packaging, and richer module selection;
- package/plan identity and migration policy;
- Laravel persistence, accounts, global data, scheduling, and continuous personalities;
- complete static typing and remaining V30 coverage.
