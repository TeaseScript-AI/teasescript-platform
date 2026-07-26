# Data and API boundaries

Laravel owns accounts, forum, catalog, publishing, moderation, persistent state, media metadata, and public platform APIs. PostgreSQL is the primary database.

The player receives only selected validated data across the parent/player and server boundaries. Main-site cookies are host-only and unavailable to the player iframe. Package code may not access forum state, internal site data, or unrestricted external network endpoints.

## Current TypeScript POC surfaces

The repository currently exports several TypeScript layers through `src/index.ts`. These support the POC, repository tests, the playground, and compatibility callers; they do not create a second public backend.

### Source frontend

The source-oriented layer includes:

- `lex(...)`;
- `parse(...)`;
- `validateSemantics(...)`;
- `compileSource(...)`.

`compileSource(...)` is the normal combined route from source text to diagnostics and a compiled instruction plan. It returns no plan when parser, finite-literal, or semantic errors remain. In particular, non-finite numeric literals are reported as exact-span `TSC001`, while large finite literals remain valid. A returned plan is validated when a fresh runtime snapshot is created, when runtime execution begins, or when a caller invokes `validateInstructionPlan(...)` explicitly.

The lower-level `lex(...)` and `parse(...)` functions expose frontend results without promising that the source is compilable. Callers must not substitute parsing alone for the `compileSource(...)` validation boundary.

### Low-level plan and runtime

The lower-level layer includes:

- `compileProgram(...)` and `validateInstructionPlan(...)`;
- `createFreshRuntimeSnapshot(...)` and `validateRuntimeSnapshot(...)`;
- `executeInstruction(...)`, `stepToEvent(...)`, and `run(...)`;
- checkpoint creation, serialization, deserialization, and restore functions;
- versioned RNG state creation and advancement helpers.

The normal composition is:

```text
source
    -> compileSource
    -> compiled instruction plan
    -> fresh or restored validated runtime snapshot
    -> executeInstruction, stepToEvent, or run
```

Low-level functions remain separately exported for tests, tooling, debugging, and controlled integration. Callers that bypass `compileSource(...)` are responsible for composing the documented semantic, plan, snapshot, and checkpoint validation stages. `compileProgram(...)` performs lowering and limited defensive checks; it is not a substitute for semantic validation. It reuses the shared finite-literal AST validation and throws `InstructionCompilationError` with `TSC001` rather than returning a plan containing `NaN`, `Infinity`, or `-Infinity`. `validateInstructionPlan(...)` independently rejects non-JSON-safe plan data.

### Compatibility host boundary

`execute(program, options)` and `Interpreter` form the current direct-AST compatibility/testing boundary. They run shared finite-literal AST validation and semantic validation using configured global and builtin names before lowering. Non-finite literal values and semantic failures are exposed through ordered `InterpreterCompilationError` diagnostics rather than an unstructured runtime crash. Because their current `ExecutionResult` cannot represent a pending execution, a valid compiled plan containing any blocking `wait` is conservatively rejected before runtime state creation with error diagnostic `TSC004` and the first canonical wait span. This temporary behavior covers all program regions, including uncalled functions; it does not make `wait` unsupported in TeaseScript.

The explicit plan/snapshot/runtime API remains the canonical resumable route for waits, including pending actions, checkpoints, completion, and resumption. The compatibility APIs remain unresolved POC surfaces: a future resumable compatibility result or lifecycle decision needs separate owner approval.

Compatibility globals and builtin results cross a serializable-value adapter. Values are copied and validated before entering runtime state. Host `RuntimeSpeaker` objects are not currently supported across this boundary; declared TeaseScript speakers remain runtime-owned values.

Runtime builtins are explicit capabilities. Only own registered properties are callable, core builtins retain precedence, and low-level named arguments use a prototype-free record. These rules prevent inherited JavaScript properties or prototype-mutating names from becoming implicit capabilities.

See [`docs/RUNTIME.md`](RUNTIME.md) for current execution behavior, structured errors, capabilities, compiler/template behavior, RNG invariants, defaults, and limits.

## Accepted pending-action boundary

ADR 0016 defines one canonical runtime-owned contract for waits, timers, choices, input, buttons, media completion, and future typed player capabilities.

The runtime owns:

- persisted `currentSessionTimeMs` and nondecreasing time updates;
- foreground and background action state;
- action and event identities;
- expected response types;
- deadlines and continuation positions;
- bounded `lastSettlement` state;
- active-first action lookup and stale/unknown classification;
- state transitions and idempotency;
- snapshot, checkpoint, time-observation, and completion validation.

The player/controller owns:

- Standard UI rendering and reconstruction;
- browser capability invocation;
- observing browser/server clocks and mapping them onto the runtime session coordinate;
- browser wake-up scheduling;
- translating browser results and exceptions into typed plain-data outcomes;
- checkpoint transport and save acknowledgement;
- browser-resource cleanup requested by canonical runtime transitions.

The future host/player protocol must expose typed operations equivalent to observing time and completing, cancelling, or reporting a capability outcome for one action ID. The host supplies observations but may not directly mutate `currentSessionTimeMs`, arbitrary snapshot fields, or continuation state.

Time observation is one atomic runtime transition: validate the supplied coordinate, persist `max(currentSessionTimeMs, suppliedNow)`, then settle due actions against that stored value.

Completion correlation uses the accepted order:

```text
active foreground/background action
-> matching lastSettlement
-> issued inactive stale action
-> unknown unissued action
```

The exact cross-origin envelope, field names, capability-negotiation schema, reconnect protocol, and save acknowledgement remain open. They are not defined by ADR 0016.

Camera and file APIs continue to return engine-managed references rather than browser objects. Package-defined camera roles, player device aliases, long-lived stream ownership, and persistent media collections remain separate follow-up designs recorded in [`planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`](planning/PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md).

## Stability and future contracts

The current TypeScript exports and version-4 plan, snapshot, and checkpoint formats are POC implementation surfaces. Their current use does not establish permanent third-party API stability, a production wire-format guarantee, or a final Laravel/player protocol.

Implementation of ADR 0016 requires version-4 plan, snapshot, and checkpoint schemas for the waiting status, persisted session-time coordinate, foreground/background action fields, action counter, and bounded settlement record. Version 4 is an internal POC format revision, not a product release number.

Exact account, toy, history, global-data, checkpoint storage, host-message, media-persistence, time-integrity, and integration payloads remain open and must be defined as typed contracts before implementation. This document does not resolve their long-term versioning and migration policy.
