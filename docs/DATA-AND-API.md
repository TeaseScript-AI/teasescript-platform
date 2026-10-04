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
- `compileProject(...)` and `compileSource(...)`.

`compileProject(...)` is the normal combined route from the `.tease` files of a package to diagnostics and one compiled
instruction plan; `compileSource(...)` does the same for a single source as `main.tease`. It
returns no plan when parser, finite-literal, semantic, lowering, or compiled-plan validation errors remain. In
particular, non-finite numeric literals are reported as exact-span `TSC001`, while recognized native host-stack
exhaustion is reported across the complete source as `TSC007`. The latter contains an environment-specific failure; it
does not establish a TeaseScript nesting limit. A returned plan is already fully validated and deeply immutable, so
runtime entry points can reuse that identity; `validateInstructionPlan(...)` remains the explicit boundary for other
plan data.

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

Ordinary TeaseScript source is compiled through `compileSource(...)`; the resulting validated instruction plan runs
with explicit serializable runtime state. Parser AST data remains available to compiler and authoring tooling, but
there is no supported caller-constructed AST compilation route. `validateInstructionPlan(...)` independently rejects
non-JSON-safe plan data.

The explicit plan/snapshot/runtime API is the canonical resumable route for waits, including pending actions, checkpoints, completion, and resumption.

Runtime builtins are explicit capabilities. Only own registered properties are callable, core builtins retain precedence, and low-level named arguments use a prototype-free record. These rules prevent inherited JavaScript properties or prototype-mutating names from becoming implicit capabilities.

See [`docs/RUNTIME.md`](RUNTIME.md) for current execution behavior, structured errors, capabilities, compiler/template behavior, RNG invariants, defaults, and limits.

## Accepted pending-action boundary

ADR 0016 defines one canonical runtime-owned contract for waits, timers, choices, input, buttons, media completion, and future typed player capabilities.

The runtime owns:

- the persisted observation horizon (`observedSessionTimeMs`), scene time (`currentSessionTimeMs`), and nondecreasing
  time updates;
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

Time observation is one atomic runtime transition: validate the supplied coordinate, persist `max(observedSessionTimeMs, suppliedNow)` as the observed time, then, unless the session has failed, settle due work in order while `currentSessionTimeMs` advances toward it; see [`RUNTIME.md`](RUNTIME.md#timers-and-scene-time).

Completion correlation uses the accepted order:

```text
active foreground/background action
-> suspended foreground action: suspendedAction
-> matching lastSettlement
-> issued inactive stale action
-> unknown unissued action
```

The exact cross-origin envelope, field names, capability-negotiation schema, reconnect protocol, and save acknowledgement remain open. They are not defined by ADR 0016.

Camera and file APIs continue to return engine-managed references rather than browser objects. Package-defined camera
roles, player device aliases, captured-media recovery after reload or restore, and persistent media collections remain
separate follow-up designs; the camera and microphone permission and ownership model is in [`SECURITY.md`](SECURITY.md).
Follow-ups are recorded in
[`planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md`](planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md).

## Player session persistence modes

Browser-local persistence is a permanent product capability, not a disposable POC convenience. An accountless player
may keep supported session/runtime state locally. A signed-in player may also choose local-only storage for privacy;
signing in does not by itself require sensitive Player/session state to be uploaded. Server-backed persistence remains
the complementary mode for capabilities such as cross-device continuation.

Both modes use the same canonical engine/checkpoint model. Storage location does not create a second runtime or save
format. Production preferences will select local-only versus server-backed behavior through typed platform contracts;
the exact records, encryption, retention, synchronization, conflict, and migration policy remain open.

### Script storage in the browser

The Player persists TeaseScript `save`/`load`/`delete` values ([§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys))
through a host-owned, asynchronous `ScriptStorageProvider` for one storage scope (`player/script-storage.ts`); the
runtime boundary is [Runtime script storage](RUNTIME.md#script-storage). The host chooses a stable, opaque scope per
script and player. Before each Start the Player loads the scope; during the session it persists every pending write
through the provider and then reports it to the runtime, which keeps the previous value when the write failed. When
loading fails, for example because the browser denies storage, the session plays session-local and nothing is kept for
a later run. Script storage is separate from checkpoint persistence (#469).

The browser-local provider keeps one local-storage item per key, named `player-storage:` plus the JSON array
`[scope, key]`, holding `{ v: 1, value }`; it validates items as external input and skips unreadable ones. Providers
treat values as ordinary TeaseScript values and never interpret them, for example as media references; a layer such
as durable captured media wraps a provider instead. Clearing a scope removes only that script's stored values.
Storage quotas are not enforced yet; all writes pass through the provider, so quota policy can be added there.

Ordinary Player use does not expose arbitrary manual checkpoint/restore points as a rewind mechanism. The runtime/Player
creates and restores supported checkpoints according to the session lifecycle. Developer/debug tooling may expose
manual checkpoint and restore operations because those runs are explicitly diagnostic rather than ordinary canonical
play.

For custom UI, [ADR 0012](decisions/0012-custom-view-capability.md) defines the recovery frontier: the latest point from
which the complete experience is reconstructible. Persisted server effects beyond that frontier use durable effect IDs
and server authority; repeating the same effect ID is idempotent. Where practical, effect receipt and advancing recovery
state commit atomically. An effect that must exist only temporarily while non-restorable UI is active uses a
reservation/lease followed by commit or rollback; TTL/keepalive cleanup is not the correctness mechanism. Exact records
and APIs remain open.

## Stability and future contracts

The current TypeScript exports and internal instruction-plan, runtime-snapshot, and checkpoint formats are POC implementation surfaces. The current numeric revisions are documented in [`RUNTIME.md`](RUNTIME.md). Their current use does not establish permanent third-party API stability, a production wire-format guarantee, or a final Laravel/player protocol.

Implementation of ADR 0016 introduced revision-4 instruction plans and pending-action state. Revision-5 plans and revision-6 runtime snapshots/checkpoints added the generic interaction instruction/action/settlement family and canonical player-transcript event data. Revision-6 plans introduced the local canonical result consume/transfer boundary, and revision-8 runtime snapshots/checkpoints introduced one nullable single-use result handoff that remains authoritative until the first canonical consume, transfer, return, discard, or exit succeeds. That handoff preserves destination/result consistency independently of `lastSettlement`, which remains bounded replay data only. These are historical internal format revisions, not product release numbers.

Exact account, toy, history, global-data, checkpoint storage, host-message, media-persistence, time-integrity, and integration payloads remain open and must be defined as typed contracts before implementation. This document does not resolve their long-term versioning and migration policy.
