# ADR 0016 — Resumable pending-action runtime contract

**Status:** Proposed  
**Issue:** #54

## Context

The current runtime can execute, step, halt, fail, checkpoint, restore, and resume deterministic instruction plans, but it has no canonical state for an operation that has started and must wait for elapsed time or a typed external result.

Blocking waits, visible timers, choices, input, buttons, media completion, and future typed player capabilities all need the same basic answers:

- how execution becomes unable to advance;
- what JSON-safe state represents the pending work;
- how the work is identified across checkpoint and restore;
- how time and typed host responses complete it;
- how duplicate, unknown, cancelled, timed-out, and late responses behave;
- how foreground blocking work differs from background actions;
- how validation rejects impossible serialized states before execution.

ADR 0015 remains authoritative: resumable behavior must use explicit versioned state and may not depend on a suspended JavaScript stack, generator, closure, browser timer callback, or module-global mutable state.

This ADR defines the reusable runtime contract. It does not implement syntax, the production player, the cross-origin message protocol, Laravel scheduling, camera lifecycle, or media persistence.

## Decision summary

1. Add runtime status `waiting`.
2. Store at most one foreground blocking action and a separate collection of background actions.
3. Use one discriminated JSON-safe pending-action union rather than unrelated hidden fields per feature.
4. Allocate monotonic runtime action IDs from a persisted safe-integer counter.
5. Persist absolute deadlines on an injected time line; the runtime never reads `Date.now()` or `performance.now()` directly.
6. Complete actions only through validated runtime operations carrying an action ID and typed payload or time observation.
7. Make completion idempotent and reject malformed, unknown, duplicate, stale, early, and wrong-type requests without partially advancing execution.
8. Emit `actionRequested` and `actionCompleted` before executing the continuation.
9. Implement the first vertical slice as a blocking `wait` with fake-clock, checkpoint, JSON round-trip, restore, and deterministic-resume coverage.
10. When the new serialized fields are implemented, increment instruction-plan, runtime-snapshot, and checkpoint formats from version 3 to version 4. Do not add a second nested version number to each action.

## Runtime state model

The target snapshot model is conceptually:

```text
status:
    ready | running | waiting | halted | failed

foregroundAction:
    PendingAction | null

backgroundActions:
    PendingAction[]

nextActionId:
    positive safe integer
```

The exact TypeScript property names are finalized in the implementation PR, but they must preserve these semantics.

### Foreground action

A foreground action blocks normal instruction execution. A valid waiting snapshot contains exactly one foreground action.

```text
status == waiting
if and only if
foregroundAction != null
```

The first implementation slice supports only the foreground action. The `backgroundActions` collection exists in the version-4 schema but must be empty until a later background-action implementation accepts populated entries.

### Background actions

Background actions allow the main execution path to continue and may later enqueue one deterministic handler at a time. Examples include background timers and permanent buttons.

Background actions share identity, time, validation, checkpoint, and typed-completion infrastructure with foreground actions, but they do not share foreground blocking semantics. Their ordering, handler interruption, persistence, repetition, and cleanup rules are implemented in later slices.

## Pending-action model

`PendingAction` is a discriminated JSON-safe union. Planned conceptual kinds include:

```text
delay
timer
choice
textInput
button
mediaCompletion
typedHostRequest
```

Common conceptual data includes:

- action kind;
- stable action ID;
- creation sequence;
- owning instruction position;
- continuation instruction position;
- owning call-frame and scope context where required;
- expected completion type;
- destination temporary or result binding where required;
- reconstructable Standard UI or capability payload;
- cancellation and timeout policy;
- timing data where applicable.

Kind-specific payloads may add options, prompts, validation rules, button text, media identifiers, or typed capability arguments. They may not contain DOM objects, browser handles, functions, class instances, `Date`, `Map`, `Set`, callbacks, or other non-JSON state.

## Instruction and continuation semantics

A blocking instruction performs these steps atomically at one instruction boundary:

1. Evaluate all source expressions in normal source order.
2. Validate and materialize the complete pending action.
3. Allocate its action ID.
4. Store the continuation instruction position rather than relying on re-executing the original instruction.
5. Store any result destination needed by the continuation.
6. Set `foregroundAction` and status `waiting`.
7. Emit `actionRequested` after the stored snapshot is already a valid pending state.
8. Stop normal execution.

A valid completion performs these steps atomically:

1. Validate the request, ID, action kind, payload, and timing policy.
2. Store the result where required.
3. Clear the foreground action.
4. Restore status `running`.
5. Emit `actionCompleted`.
6. Return control to the caller without executing the continuation in the same completion mutation.

A subsequent `executeInstruction(...)`, `stepToEvent(...)`, or `run(...)` call executes the continuation. This keeps completion boundaries inspectable and deterministic.

## State transitions

| From | Operation | To | Result |
|---|---|---|---|
| `running` | blocking action created | `waiting` | action stored; `actionRequested` emitted |
| `waiting` | valid completion | `running` | result stored; action cleared; `actionCompleted` emitted |
| `waiting` | checkpoint and restore | `waiting` | same canonical action and IDs remain pending |
| `waiting` | invalid or wrong-type response | `waiting` | structured rejection; no state mutation |
| `waiting` | duplicate completed request | unchanged | idempotent already-settled result; no duplicate event |
| `waiting` | package/session exit | `halted` or failed | pending work cleaned up according to exit policy |
| any valid state | malformed restored data | no execution | structured checkpoint/snapshot rejection |

Cancellation and timeout are action-kind policies rather than one universal script value:

- a delay reaching its deadline completes normally;
- a blocking button timeout may complete with its documented timeout result;
- closing a mandatory picker does not complete the input action;
- an optional browser picker may complete with `null` under its own API contract;
- package exit is cleanup, not an author-visible cancelled input value;
- fatal capability or restore failure is distinct from ordinary cancellation.

## Identity and idempotency

### Allocation

`nextActionId` is a persisted positive JavaScript safe integer. IDs are scoped to one runtime session and never move backwards or become reusable after checkpoint restore.

An operation that would increment `Number.MAX_SAFE_INTEGER` fails before allocating or reusing an identity.

Action IDs are internal runtime/player correlation IDs. They are distinct from future TeaseScript-visible handles returned for background timers, permanent buttons, media resources, or scheduled work.

### Completion outcomes

A completion API returns a structured result that distinguishes at least:

```text
completed
alreadySettled
unknownAction
staleAction
wrongActionKind
invalidPayload
notDue
```

Rules:

- the first valid completion settles exactly once;
- delivery of the same host message again does not produce another result, event, RNG advance, or continuation;
- an ID that was never issued is unknown;
- an older ID that is no longer active is stale or already settled;
- a response for another action kind is rejected;
- a timed action completed before its deadline is `notDue`;
- a late response after timeout or cancellation does not revive the action.

The runtime may keep bounded settlement metadata or otherwise provide equivalent idempotency. It must not permit unbounded growth solely to remember every historical action forever.

## Time model

### Runtime boundary

The deterministic runtime does not call browser or operating-system clock APIs. The player/controller supplies validated time observations, and tests supply a fake clock.

A time observation conceptually contains:

- an observed position on the active player time line;
- its authority or quality when relevant;
- optional integrity/debug metadata supplied by the player.

The runtime validates finite values and rejects observations that cannot be represented safely.

### Timed actions

Timed actions persist an absolute deadline on the injected active-session time line. They may additionally retain their creation time when required for elapsed-time return values or diagnostics.

Persisting only duration remaining is rejected because it loses elapsed sleep, reload, and offline time unless every lifecycle transition first mutates the snapshot. Persisting both remaining time and deadline is rejected as unnecessary duplicate canonical state.

### Nondecreasing effective time

Runtime-observed effective time never moves backwards:

```text
effectiveNow = max(previousEffectiveNow, suppliedNow)
```

A backward local-clock adjustment therefore does not extend an already active wait. A sufficiently advanced authoritative observation may make a deadline due.

Restore itself does not read a clock and has no hidden completion side effect. After restore, the player submits an explicit time observation. The runtime then completes due actions before later normal execution.

### Active browser and future server time

For an active browser session, the player should use a monotonic browser clock as its primary elapsed-time source and periodically or at lifecycle boundaries anchor it to server-observed time when available.

Local wall-clock time is not trusted as the sole authority for work that must survive manipulation, reload, device sleep, or restart. Time-integrity anomalies may be logged as typed debug information, but this ADR does not define an author hook or automatically label an anomaly as cheating.

Long-running punishments, assignments, continuous-personality schedules, or other server-backed deadlines are separate from an active in-session wait. Laravel will own those authoritative scheduled moments under a later scheduling contract.

### Wait duration semantics

For the accepted blocking wait direction:

```tease
wait 10      // exactly 10 seconds
wait 250 ms
wait 1.5 s
wait 2 min
wait 0.5 h
```

Rules:

- a bare number means seconds;
- exact elapsed-time units for blocking waits are `ms`, `s`, `min`, and `h`;
- decimal durations are accepted;
- fractionally valued milliseconds remain valid runtime numbers;
- a browser wake-up scheduler may round its requested wake-up delay upward, but the runtime compares the supplied observation against the canonical deadline;
- `wait 0` completes immediately without allocating an action ID or emitting action events;
- a statically provable negative duration is a compile-time error;
- a negative runtime result is a structured runtime failure;
- `NaN`, infinity, and deadline overflow are rejected;
- there is no additional arbitrary product maximum below the technical finite/safe representation boundary;
- browser suspension, sleep, reload, and restart count as elapsed time when the next trusted observation shows that the deadline passed.

## Runtime/player responsibility boundary

| Responsibility | Deterministic runtime | Player/controller |
|---|---:|---:|
| Canonical action state and IDs | yes | no |
| Validate snapshot/action invariants | yes | may prevalidate messages |
| Evaluate TeaseScript arguments | yes | no |
| Render Standard UI | no | yes |
| Reconstruct UI after restore | exposes canonical payload | yes |
| Observe clocks | no | yes |
| Schedule browser wake-ups | no | yes |
| Decide whether deadline is canonically due | yes | reports observation |
| Validate script-level response type and action policy | yes | may validate UX input first |
| Mutate arbitrary snapshot fields | no external caller | never |
| Persist checkpoints and acknowledge save | emits/returns state | player/Laravel workflow |
| Translate browser errors into typed outcomes | no raw browser exception | yes |
| Cleanup browser resources | requests canonical cleanup | yes |

The future cross-origin protocol must provide typed operations equivalent to:

```text
observeTime
completeAction
cancelAction when policy permits
reportCapabilityOutcome
acknowledgeCheckpointSave
```

This ADR does not fix exact `postMessage` property names or envelope versions.

## Events

Add typed sequenced runtime events conceptually equivalent to:

```text
actionRequested
actionCompleted
```

`actionRequested` is emitted once when the action is first created. It is not replayed after restore. The Standard UI reconstructs itself from the restored pending action.

`actionCompleted` is emitted after the result is stored and before the continuation executes. When the continuation emits visible output, the completion event therefore has the lower sequence number.

Action-kind-specific events may later distinguish timeout, cancellation, media completion, or capability recovery when their observable semantics require it. They do not replace the canonical state transition.

## Validation invariants

Validation must reject malformed plan, snapshot, checkpoint, and completion data before execution or partial mutation.

At minimum:

- `waiting` requires exactly one valid foreground action;
- non-`waiting` states require no foreground action;
- the first implementation requires `backgroundActions` to be an empty array;
- every action ID and counter is a positive safe integer;
- action IDs are unique across active foreground and background entries;
- referenced instruction positions are valid for the plan;
- continuation and result destinations are compatible with the owning instruction;
- referenced scopes, call frames, temporaries, and prepared references exist and have valid ownership;
- expected result types match action kind and destination;
- deadlines and observed times are finite and valid for the selected time representation;
- timeout and cancellation policy is valid for the action kind;
- payloads are JSON-safe stable plain data within existing depth/work limits;
- unknown fields follow the accepted versioned schema policy rather than being silently trusted;
- no raw host or browser exception crosses the runtime boundary.

Version-4 validation is added only when implementation begins. Version-3 formats remain valid only under their current version-3 validators and contain no pending-action fields.

## Testing contract

Every implemented pending-action kind requires shared state-machine coverage plus kind-specific cases.

### Shared cases

- normal completion;
- checkpoint while pending;
- JSON serialization and deserialization;
- restore remains pending;
- deterministic resume equivalence;
- invalid response type;
- unknown ID;
- duplicate delivery;
- stale and late delivery;
- event sequence and action ID monotonicity after restore;
- malformed serialized action state;
- invalid status/action combinations;
- bounded external-data validation;
- no raw host exception;
- no real-time sleep in tests.

### Timed-action cases

- restore before deadline;
- restore exactly at deadline;
- restore after deadline;
- fractional-millisecond deadline;
- browser wake-up later than the exact deadline;
- `wait 0` creates no action;
- negative runtime duration;
- non-finite and overflowing duration/deadline;
- backward time observation does not extend the action;
- multiple due background deadlines later use deterministic ordering.

### Deterministic ordering

When multiple background deadlines are introduced, due actions are ordered by:

1. earliest deadline;
2. creation sequence;
3. action ID as a final tie-breaker.

Handlers run one at a time.

## Implementation sequence

### Slice 1 — blocking wait

Implement one complete source-to-runtime path:

```text
wait source syntax
-> validated duration
-> delay instruction
-> foreground action
-> waiting snapshot
-> checkpoint and JSON round trip
-> restore remains waiting
-> fake time observation reaches deadline
-> actionCompleted
-> continuation
-> deterministic final events and snapshot
```

Exclude visible timers, ranges, choices, input, buttons, media, browser E2E, Laravel scheduling, and background handlers.

### Slice 2 — foreground schema consolidation

Use the same contract for one additional blocking interaction or presentation gate to prove the union is not delay-specific. The exact selected feature is planned separately.

### Slice 3 — one-shot background timer

Permit one or more non-repeating, non-persistent background timer entries and one-at-a-time handler execution. Reuse the same clock, ID, checkpoint, validation, and completion machinery.

### Slice 4 — timer family

Add visible and mystery blocking timers, stopping, repeating timers, persistent timers, cleanup rules, and deterministic ordering as one coherent timer-family implementation rather than unrelated mechanisms.

### Later slices

Choices, text input, buttons, media completion, permanent buttons, custom views, and typed player capabilities reuse the accepted action contract.

## Alternatives considered

### One foreground field only

This is the smallest first implementation but would require a schema rename or migration almost immediately for accepted background timers. The chosen schema therefore includes the separate background collection from version 4 while requiring it to remain empty during slice 1.

### One collection for foreground and background work

Rejected. It requires an extra foreground pointer and more malformed combinations, makes restore validation harder, and forces concurrency decisions into the first wait slice.

### One collection plus foreground action ID

Rejected for the same reason and because it introduces avoidable referential invariants.

### Duration remaining

Rejected because sleep, reload, and restore cannot be represented correctly without mutating state at every lifecycle transition.

### Absolute deadline plus remaining duration

Rejected as duplicate canonical time state that can disagree.

### Runtime polling

Rejected as the primary model. The player may submit explicit ticks or wake-up observations, but the runtime does not own an interval or browser timer. Tests directly inject deterministic observations.

### Separate state fields per feature

Rejected. Waits, choices, input, buttons, timers, and host requests would otherwise acquire incompatible IDs, restore behavior, event ordering, and validation.

### Choice or input as first slice

Rejected. A wait exercises suspension, deadline persistence, restore, host observation, and deterministic completion with the smallest UI and payload surface.

## Consequences

- Pending work becomes inspectable, checkpointable, and testable.
- The player may reconstruct Standard UI and wake-up scheduling without replaying instructions.
- Foreground and background semantics remain explicit rather than hidden in one generic collection.
- Version-4 formats will be incompatible with current version-3 POC objects, which is acceptable because no permanent wire-format promise exists.
- The first implementation remains narrow, but the schema intentionally reserves the accepted foreground/background separation.
- Camera resource lifetime, media persistence, chat-output pacing, package capability declarations, and time-integrity hooks require separate designs and are tracked outside this ADR.
