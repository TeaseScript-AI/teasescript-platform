# ADR 0016 — Resumable pending-action runtime contract

**Status:** Proposed  
**Issue:** #54

## Context

The current runtime can execute, step, halt, fail, checkpoint, restore, and resume deterministic instruction plans, but it has no canonical state for work that has started and must wait for elapsed time or a typed player result.

Blocking waits, visible timers, choices, input, buttons, media completion, and future typed player capabilities need one shared answer for:

- execution suspension and continuation;
- JSON-safe pending state;
- identity across checkpoint and restore;
- deterministic time observation;
- typed completion and cancellation;
- duplicate, unknown, stale, early, and late messages;
- foreground blocking versus background concurrency;
- validation and test requirements.

ADR 0015 remains authoritative. Resumable behavior must use explicit versioned state and may not depend on a suspended JavaScript stack, generator, closure, browser timer callback, or module-global mutable state.

This ADR defines the reusable runtime contract. It does not implement syntax, the production player, the cross-origin message envelope, Laravel scheduling, camera lifecycle, or media persistence.

## Decision summary

1. Add runtime status `waiting`.
2. Store at most one foreground blocking action and a separate collection of background actions.
3. Use one discriminated JSON-safe pending-action union instead of unrelated hidden state per feature.
4. Allocate monotonic runtime action IDs from a persisted safe-integer counter.
5. Retain one bounded canonical settlement record so an immediately retried completion receives the same recorded result without unbounded history.
6. Persist absolute deadlines on an injected nondecreasing session time line. The runtime never reads `Date.now()` or `performance.now()` directly.
7. Complete actions only through validated runtime operations carrying an action ID and typed payload or time observation.
8. Emit `actionRequested` and `actionCompleted` before executing the continuation.
9. Implement the first vertical slice as blocking `wait` with fake-clock, checkpoint, JSON round-trip, restore, and deterministic-resume coverage.
10. When implemented, increment instruction-plan, runtime-snapshot, and checkpoint formats from version 3 to version 4. Do not add a redundant nested version field to every action.

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

lastSettlement:
    ActionSettlement | null
```

The exact TypeScript property names are finalized by the implementation PR, but they must preserve these semantics.

### Foreground action

A foreground action blocks normal instruction execution.

```text
status == waiting
if and only if
foregroundAction != null
```

A valid snapshot never contains two foreground actions.

### Background actions

Background actions allow the main path to continue and may later enqueue deterministic handlers. Examples include background timers and permanent buttons.

They share identity, time, validation, checkpoint, and typed-completion infrastructure with foreground actions, but not foreground blocking semantics.

The first implementation slice includes `backgroundActions` in the version-4 schema but requires it to be empty. Populated entries are accepted only after a later background-action implementation defines ordering, handler interruption, repetition, persistence, and cleanup.

### Last settlement

`lastSettlement` stores only the most recently completed action settlement. It contains enough bounded JSON-safe data to return the canonical recorded outcome when the same completion message is delivered again.

Conceptually it includes:

```text
action ID
action kind
settlement kind
recorded result, when the action produced one
completion event sequence
```

Completing a newer action replaces the previous record. A duplicate for the current `lastSettlement` returns `alreadySettled` plus that recorded settlement. A completion for an older action is `staleAction`.

This gives deterministic retry behavior without retaining an unbounded action history.

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

Kind-specific payloads may add options, prompts, validation rules, button text, media identifiers, or typed capability arguments. They may not contain DOM objects, browser handles, functions, class instances, `Date`, `Map`, `Set`, callbacks, streams, tracks, blobs, or other non-JSON state.

## Instruction and continuation semantics

A blocking instruction performs these steps atomically at one instruction boundary:

1. Evaluate all source expressions in normal source order.
2. Validate and materialize the complete pending action.
3. Allocate its action ID.
4. Store the continuation position instead of relying on re-executing the original instruction.
5. Store any result destination needed by the continuation.
6. Set `foregroundAction` and status `waiting`.
7. Emit `actionRequested` after the snapshot is already a valid pending state.
8. Stop normal execution.

A valid completion performs these steps atomically:

1. Validate the request, ID, action kind, payload, and timing policy.
2. Store the result where required.
3. Create or replace `lastSettlement`.
4. Clear the foreground action.
5. Restore status `running`.
6. Emit `actionCompleted` and record its sequence in the settlement.
7. Return without executing the continuation in the same completion mutation.

A subsequent `executeInstruction(...)`, `stepToEvent(...)`, or `run(...)` call executes the continuation. This keeps completion boundaries inspectable and deterministic.

## State transitions

| From | Operation | To | Result |
|---|---|---|---|
| `running` | blocking action created | `waiting` | action stored; `actionRequested` emitted |
| `waiting` | valid completion | `running` | result and settlement stored; action cleared; `actionCompleted` emitted |
| `waiting` | checkpoint and restore | `waiting` | same canonical action and IDs remain pending |
| `waiting` | invalid or wrong-type response | `waiting` | structured rejection; no state mutation |
| any | duplicate of `lastSettlement` | unchanged | `alreadySettled` with recorded settlement; no duplicate event |
| any | older settled action | unchanged | `staleAction`; no state mutation |
| `waiting` | package/session abort | `halted` or failed | pending work cleaned up according to abort policy |
| any valid state | malformed restored data | no execution | structured checkpoint/snapshot rejection |

Cancellation and timeout remain action-kind policies rather than one universal script value:

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

### Completion results

A completion operation distinguishes at least:

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
- the completion response for `completed` contains the canonical settlement;
- a repeated delivery matching `lastSettlement` returns `alreadySettled` with the same canonical settlement;
- neither repeated delivery produces another result write, event, RNG advance, handler, or continuation;
- an ID that was never issued is `unknownAction`;
- an issued ID older than `lastSettlement` is `staleAction`;
- a response for another action kind is rejected;
- a timed action submitted before its deadline is `notDue`;
- a late response after timeout, cancellation, or replacement does not revive the action.

## Time model

### Runtime boundary

The deterministic runtime does not call browser or operating-system clock APIs. The player/controller supplies validated time observations, and tests supply a fake clock.

A time observation conceptually contains:

- a position on the active session time line;
- its authority or quality when relevant;
- optional integrity/debug metadata supplied by the player.

The runtime validates finite values and rejects observations outside the accepted numeric magnitude or format.

### Stable session coordinate

The canonical persisted coordinate is not raw `performance.now()`, because that origin changes after reload. The player maps monotonic elapsed deltas onto one session coordinate.

Conceptually:

```text
sessionNow = persistedOrServerAnchor + monotonicDeltaSinceAnchor
```

During an active page, monotonic deltas advance the coordinate. At reload, reconnect, restore, visibility return, or another lifecycle boundary, the player obtains or reconstructs a new anchor for the same coordinate, preferably from server-observed time.

Local wall-clock time may be used only as a marked fallback. It is not the sole authority for manipulation-sensitive or server-backed deadlines.

### Timed actions

Timed actions persist one absolute deadline on the injected session coordinate. They may also retain creation time when required for elapsed-time return values or diagnostics.

Persisting only duration remaining is rejected because it loses sleep, reload, and offline time unless every lifecycle transition first mutates the snapshot.

Persisting both remaining time and deadline is rejected as duplicate canonical state that can disagree.

### Nondecreasing effective time

Runtime-observed effective time never moves backwards:

```text
effectiveNow = max(previousEffectiveNow, suppliedNow)
```

A backward clock adjustment therefore does not extend an active wait. A sufficiently advanced trusted observation may make a deadline due.

Restore itself does not read a clock and has no hidden completion side effect. After restore, the player submits an explicit observation. The runtime then settles due actions before later normal execution.

### Active browser and future server time

For an active browser session, the player should use a monotonic browser clock as its primary elapsed source and anchor it to server-observed time at suitable lifecycle or existing communication boundaries.

Time-integrity anomalies may be recorded as typed diagnostics. This ADR does not define an author hook and does not automatically label an anomaly as cheating.

Long-running punishments, assignments, continuous-personality schedules, or other server-backed deadlines are separate from an active in-session wait. Laravel will own those authoritative scheduled moments under a later scheduling contract.

## Wait duration semantics

For the selected blocking-wait direction:

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
- a browser wake-up scheduler may round its requested wake delay upward, but the runtime compares the supplied observation against the canonical deadline;
- `wait 0` completes immediately without allocating an action ID, settlement, or action event;
- a statically provable negative duration is a compile-time error;
- a negative runtime result is a structured runtime failure;
- `NaN`, infinity, unsupported magnitude, and deadline overflow are rejected;
- there is no additional arbitrary product maximum below the technical numeric boundary;
- browser suspension, sleep, reload, and restart count when the next trusted observation shows that the deadline passed.

## Runtime/player responsibility boundary

| Responsibility | Deterministic runtime | Player/controller |
|---|---:|---:|
| Canonical action state, settlement, and IDs | yes | no |
| Validate snapshot/action invariants | yes | may prevalidate messages |
| Evaluate TeaseScript arguments | yes | no |
| Render Standard UI | no | yes |
| Reconstruct UI after restore | exposes canonical payload | yes |
| Observe clocks and maintain anchors | no | yes |
| Schedule browser wake-ups | no | yes |
| Decide whether a deadline is canonically due | yes | reports observation |
| Validate script-level response type and policy | yes | may validate UX input first |
| Mutate arbitrary snapshot fields | no external caller | never |
| Persist checkpoints and acknowledge save | emits/returns state | player/Laravel workflow |
| Translate browser errors into typed outcomes | no raw browser exception | yes |
| Clean up browser resources | requests canonical cleanup | yes |

The future cross-origin protocol must provide typed operations equivalent to:

```text
observeTime
completeAction
cancelAction when policy permits
reportCapabilityOutcome
acknowledgeCheckpointSave
```

This ADR does not fix exact `postMessage` property names, envelopes, or protocol versions.

## Events

Add typed sequenced runtime events conceptually equivalent to:

```text
actionRequested
actionCompleted
```

`actionRequested` is emitted once when the action is first created. It is not replayed after restore. Standard UI reconstructs itself from the restored pending action.

`actionCompleted` is emitted after the result and settlement are stored and before the continuation executes. When the continuation emits visible output, the completion event therefore has the lower sequence number.

Action-kind-specific events may later distinguish timeout, cancellation, media completion, or capability recovery when observable semantics require it. They do not replace the canonical state transition.

## Validation invariants

Validation rejects malformed plan, snapshot, checkpoint, time, settlement, and completion data before execution or partial mutation.

At minimum:

- `waiting` requires exactly one valid foreground action;
- non-`waiting` states require no foreground action;
- the first implementation requires `backgroundActions` to be empty;
- every action ID and counter is a positive safe integer;
- active action IDs are unique;
- `lastSettlement.actionId` is lower than `nextActionId` and does not equal an active action ID;
- settlement kind, result type, and completion sequence are valid;
- referenced instruction positions are valid for the plan;
- continuation and result destinations are compatible with the owning instruction;
- referenced scopes, call frames, temporaries, and prepared references exist and have valid ownership;
- expected result types match action kind and destination;
- deadlines and observed times are finite and valid for the selected representation;
- timeout and cancellation policy is valid for the action kind;
- payloads and settlements are JSON-safe stable plain data within existing depth/work limits;
- unknown fields follow the accepted versioned-schema policy rather than being silently trusted;
- no raw host or browser exception crosses the runtime boundary.

Version-4 validation is added only when implementation begins. Version-3 formats remain governed by their existing validators and contain no pending-action fields.

## Testing contract

Every implemented pending-action kind requires shared state-machine coverage plus kind-specific cases.

### Shared cases

- normal completion;
- checkpoint while pending;
- JSON serialization and deserialization;
- restore remains pending;
- deterministic resume equivalence;
- duplicate delivery returns the same `lastSettlement`;
- replacement of `lastSettlement` by a newer action;
- stale and unknown IDs;
- invalid response type and wrong action kind;
- event sequence and action ID monotonicity after restore;
- malformed action and settlement state;
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
- `wait 0` creates no action or settlement;
- negative runtime duration;
- non-finite, unsupported-magnitude, and overflowing duration/deadline;
- backward time observation does not extend the action;
- remapping a new monotonic origin onto the same session coordinate;
- multiple due background deadlines later use deterministic ordering.

### Deterministic background ordering

When multiple background deadlines are introduced, due actions are ordered by:

1. earliest deadline;
2. creation sequence;
3. action ID as the final tie-breaker.

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
-> settlement and actionCompleted
-> continuation
-> deterministic final events and snapshot
```

Exclude visible timers, ranges, choices, input, buttons, media, browser E2E, Laravel scheduling, and background handlers.

### Slice 2 — second foreground use

Use the same contract for one additional blocking interaction or presentation gate to prove the union is not delay-specific. The exact selected feature is planned separately.

### Slice 3 — one-shot background timer

Permit non-repeating, non-persistent background timer entries and one-at-a-time handler execution. Reuse the clock, ID, settlement, checkpoint, validation, and completion machinery.

### Slice 4 — timer family

Add visible and mystery blocking timers, stopping, repeating timers, persistent timers, cleanup rules, and deterministic ordering as one coherent timer-family implementation.

### Later slices

Choices, text input, buttons, media completion, permanent buttons, custom views, and typed player capabilities reuse the accepted action contract.

## Alternatives considered

### Only one foreground field

Smaller for slice 1, but it would require an immediate schema redesign for accepted background timers. The selected version-4 schema therefore includes the separate background collection while requiring it to be empty initially.

### One collection for foreground and background work

Rejected. It requires an extra foreground pointer, permits more malformed combinations, complicates restore validation, and forces concurrency decisions into the first wait slice.

### One collection plus foreground action ID

Rejected for the same reasons and because it adds avoidable referential invariants.

### Unbounded completed-action history

Rejected. It makes long-running snapshots grow indefinitely. One persisted `lastSettlement` provides deterministic immediate retry; older deliveries become stale.

### No persisted settlement

Rejected. After a completion response is lost, a retry could not learn whether the action settled or what result was recorded.

### Duration remaining

Rejected because sleep, reload, and restore cannot be represented correctly without mutating state at every lifecycle transition.

### Absolute deadline plus remaining duration

Rejected as duplicate canonical time state that can disagree.

### Runtime polling

Rejected as the primary model. The player may submit explicit ticks or wake observations, but the runtime does not own an interval or browser timer. Tests directly inject deterministic observations.

### Separate state fields per feature

Rejected. Waits, choices, input, buttons, timers, and host requests would otherwise acquire incompatible IDs, restore behavior, event ordering, and validation.

### Choice or input as first slice

Rejected. A wait exercises suspension, deadline persistence, restore, host observation, and deterministic completion with the smallest UI and payload surface.

## Consequences

- Pending work becomes inspectable, checkpointable, idempotent, and testable.
- The player can reconstruct Standard UI and wake-up scheduling without replaying instructions.
- Foreground and background semantics remain explicit rather than hidden in one generic collection.
- Duplicate completion retries are deterministic while snapshot growth remains bounded.
- Version-4 formats will be incompatible with current version-3 POC objects, which is acceptable because no permanent wire-format promise exists.
- The first implementation remains narrow, but the schema reserves the accepted foreground/background separation.
- Camera resource lifetime, media persistence, chat-output pacing, package capability declarations, and time-integrity hooks require separate designs and are tracked outside this ADR.
