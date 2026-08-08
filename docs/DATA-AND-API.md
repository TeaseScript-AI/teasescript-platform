# Data and API boundaries

Laravel owns accounts, forum, catalog, publishing, moderation, persistent state, media metadata, and public platform APIs. PostgreSQL is the primary database.

The player receives only selected validated data across the parent/player and server boundaries. Main-site cookies are host-only and unavailable to the player iframe. Package code may not access forum state, internal site data, or unrestricted external network endpoints.

## Current TypeScript POC surfaces

The repository currently exports several TypeScript layers through `src/index.ts`. These support the POC, repository tests, and the playground; they do not create a second public backend.

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

- `validateInstructionPlan(...)`;
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

Ordinary TeaseScript source is compiled through `compileSource(...)`; the resulting validated instruction plan runs with explicit serializable runtime state. Parser AST data remains available to compiler and authoring tooling, while `compileProgram(...)` is an internal compiler implementation detail rather than a product execution API. `validateInstructionPlan(...)` independently rejects non-JSON-safe plan data.

The explicit plan/snapshot/runtime API is the canonical resumable route for waits, including pending actions, checkpoints, completion, and resumption.

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

Camera and file APIs continue to return engine-managed references rather than browser objects. Package-defined camera
roles, player device aliases, long-lived stream ownership, and persistent media collections remain separate follow-up
designs recorded in
[`planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md`](planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md).

## Stability and future contracts

The current TypeScript exports and internal instruction-plan, runtime-snapshot, and checkpoint formats are POC implementation surfaces. The current numeric revisions are documented in [`RUNTIME.md`](RUNTIME.md). Their current use does not establish permanent third-party API stability, a production wire-format guarantee, or a final Laravel/player protocol.

Implementation of ADR 0016 introduced revision-4 instruction plans and pending-action state. Revision-5 plans and revision-6 runtime snapshots/checkpoints added the generic interaction instruction/action/settlement family and canonical player-transcript event data. Revision-6 plans introduced the local canonical result consume/transfer boundary, and revision-8 runtime snapshots/checkpoints introduced one nullable single-use result handoff that remains authoritative until the first canonical consume, transfer, return, discard, or exit succeeds. That handoff preserves destination/result consistency independently of `lastSettlement`, which remains bounded replay data only. These are historical internal format revisions, not product release numbers.

Exact account, toy, history, global-data, checkpoint storage, host-message, media-persistence, time-integrity, and integration payloads remain open and must be defined as typed contracts before implementation. This document does not resolve their long-term versioning and migration policy.
