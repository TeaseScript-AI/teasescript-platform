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
- ADR 0016: resumable pending actions with persisted session time, foreground/background separation, monotonic action IDs, bounded settlement replay, active-first completion lookup, injected time observations, and blocking `wait` as the first implementation slice;
- ADR 0017: the accepted boundary between deterministic engine primitives, the public Standard Library, package libraries, and privileged platform adapters.

Direct assignment remains `score = 20`; `set score = 20` remains invalid.

## Accepted engine and Standard Library boundary

ADR 0017 separates the smallest deterministic engine primitives from author-friendly Standard Library APIs:

```text
TeaseScript scripts
    ├── call public Standard Library exports directly
    └── call optional package-library exports
            └── call public Standard Library exports

Public Standard Library
    -> typed engine primitives
    -> deterministic runtime and player boundary
```

The accepted boundary keeps canonical identity, pending actions, time, validation, handles, checkpointing, events, resumable continuations, and security in the engine. Friendly presentation and composition such as `say` policy, common input helpers, and timer presentation are Standard Library candidates when they can be built without weakening those guarantees.

Package libraries may reuse only public, capability-safe Standard Library exports. Privileged platform adapters remain internal and cannot become transitively accessible through imports.

Ordinary TypeScript library code may run synchronously, but may not suspend invisibly across a pending-action or checkpoint boundary. Such workflows must be lowered into explicit serializable instructions or represented by an engine-managed serializable continuation.

A plan/checkpoint must contain lowered library behavior or bind to an exact compatible Standard Library identity/version. Restore against an implicit latest implementation is not allowed.

Generated TypeScript signatures and editor metadata provide the intended path for autocomplete, parameter hints, hover documentation, and diagnostics for ordinary library calls. Libraries must not mutate TeaseScript grammar; special command or block syntax remains an explicit language/compiler decision.

ADR 0017 does not change accepted V30 syntax, ADR 0016 pending-action semantics, or the currently implemented `say` path. Detailed linkage, API, and migration work remains deferred until separately designed and tested.

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

Instruction plans, runtime snapshots, and checkpoints use version 4. The implemented pending-action slice provides compiler-owned blocking `wait` delays with explicit host time observation, one foreground action, JSON-safe checkpoint/restore, and bounded last-settlement replay. Complete static typing and the wider V30 runtime/API surface remain out of scope.

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
- Runtime actions, handles, scopes, loop frames, call frames, temporaries, pending work, session time, settlement state, and resumable library continuations must be explicit and JSON-safe.
- Do not use suspended JavaScript functions, generators, closures, promises, callbacks, or implicit module-global mutable state as resumable execution state.

## Major remaining groups

- units, date, time, datetime, and duration values;
- implementation of the accepted pending-action contract, then action-kind-specific choices, input, waits, timers, buttons, and media completion;
- cross-origin iframe host protocol and validated messaging;
- camera/media lifecycle, resource ownership, persistence, recovery, and custom views;
- implementation planning on the accepted engine/Standard-Library boundary before replacing the timer and chat-pacing proposals;
- TypeScript library linkage, deterministic version binding, generated declarations/editor metadata, public/privileged module separation, Standard Library packaging, and richer module selection;
- package/plan identity and migration policy;
- Laravel persistence, accounts, global data, scheduling, and continuous personalities;
- complete static typing and remaining V30 coverage.
