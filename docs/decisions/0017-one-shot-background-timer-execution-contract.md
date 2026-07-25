# ADR 0017 — One-shot background timer execution contract

**Status:** Proposed  
**Issue:** #68  
**Implementation dependency:** #66

## Context

Accepted V30 syntax includes background timers, returned timer identifiers, `stopTimer(...)`, repeating timers, persistent timers, and timer finish blocks. Accepted ADR 0016 defines the shared persisted session time, foreground/background pending-action split, action identity, settlement, active-first lookup, checkpoint, and deterministic due-ordering foundations.

The first populated `backgroundActions` slice needs a smaller contract than the complete timer family. It must prove that background work can remain active while the main path continues, settle from an explicit time observation, queue an explicit JSON-safe handler, execute handlers one at a time, survive ordinary session checkpoint/restore, and clean up deterministically.

This ADR proposes only a one-shot, non-repeating, session-scoped background timer. It does not implement code and does not change any implemented format constant.

## Decision summary

1. Reuse the accepted V30 source form `let timerId = startTimer duration { ... }` and `stopTimer(timerId)`.
2. Require the assigned canonical declaration form in the first slice; optional discarded-return syntax is deferred.
3. Return an opaque TeaseScript timer handle immediately. The handle identity is distinct from the internal pending-action ID.
4. Use the same exact elapsed duration rules as ADR 0016 blocking waits: bare numbers are seconds; `ms`, `s`, `min`, and `h` are supported; decimals are allowed; randomized ranges are deferred.
5. `startTimer 0` creates a real background action and handle with a deadline equal to `currentSessionTimeMs`. It never executes the handler inline. The next explicit time observation at the same or a later coordinate settles it.
6. Persist active timer actions, a due-handler queue, at most one active timer-handler frame, and the timer-handle allocator as explicit JSON-safe runtime state.
7. `observeTime(...)` settles every due timed action in the accepted global order and queues one invocation per due timer. It executes no handler.
8. Timer handlers have priority over the normal main path on later runtime entries and execute one at a time. A handler may run while the main path has a foreground action pending.
9. Handler completion is a separate inspectable scheduler boundary. A runtime entry starts at most one queued timer handler.
10. A handler may create background actions. It may create a foreground action when the single global foreground slot is free; when the slot is occupied, the foreground-creating instruction yields before argument evaluation until the slot becomes free.
11. `stopTimer(...)` synchronously settles an active timer as stopped, emits the normal `actionCompleted` event, and queues no handler. Repeated or late stops are deterministic no-ops.
12. “Non-persistent” means session-scoped flow lifetime, not loss at checkpoint: active, queued, and executing timer state survives ordinary checkpoint/restore but is cleaned up by the accepted non-persistent flow-transfer and session-ending rules.
13. Handler failure fails the runtime and clears remaining timer work. `exit` or fatal session abort clears all timer actions and handler state.
14. Repeating, persistent, visible, mystery, randomized-range, Laravel, browser wake-up, and continuous-personality timer behavior remains deferred.

## First-slice source contract

### Canonical declaration

The required first-slice syntax is the existing accepted V30 form:

```tease
let timerId = startTimer 30 {
    timeExpired()
}
```

A timer block may contain ordinary supported statements, call normal functions, create another one-shot background timer, stop another active timer, and use `goto` according to the control-transfer rules below.

The first slice does not add an `onFinish` wrapper and does not introduce replacement syntax.

### Stop

The accepted stop form is included because V30 exposes a returned timer identifier specifically for later control:

```tease
stopTimer(timerId)
```

`stopTimer(...)` returns no TeaseScript value.

### Excluded source forms

The first slice does not support:

```tease
// Repeating — deferred
let timerId = startTimer 10 {
    repeat: true
    timeExpired()
}

// Persistent — deferred
let timerId = startTimer 30 {
    persist: true
    timeExpired()
}

// Randomized range — deferred
let timerId = startTimer 5..10 {
    timeExpired()
}
```

Visible `timer`, `mysteryTimer`, repeating timers, persistent timers, and optional bare `startTimer` syntax without an assigned handle remain timer-family work.

## Duration semantics

The first slice uses exact elapsed time on ADR 0016's persisted session coordinate:

```tease
let a = startTimer 10 { timeExpired() }       // 10 seconds
let b = startTimer 250 ms { timeExpired() }
let c = startTimer 1.5 s { timeExpired() }
let d = startTimer 2 min { timeExpired() }
let e = startTimer 0.5 h { timeExpired() }
```

Rules:

- a bare number means seconds;
- supported units are `ms`, `s`, `min`, and `h`;
- decimal values and fractional milliseconds remain valid runtime numbers;
- a statically provable negative duration is a compile-time error;
- a dynamically produced negative duration is a structured runtime failure;
- non-finite values, unsupported numeric magnitude, and deadline overflow fail before either identity is allocated or any event is emitted;
- range durations, calendar units, and server-backed deadlines are outside this slice.

### Zero duration

`startTimer 0` is different from blocking `wait 0`.

A zero-duration background timer must return a usable handle and preserve asynchronous handler ordering. Timer creation therefore:

1. allocates the timer handle and action ID;
2. stores an active background timer with `deadlineMs == currentSessionTimeMs`;
3. emits `actionRequested`;
4. returns the handle and continues the main path.

It does not settle or run its handler during the creation instruction. The next explicit `observeTime(...)` at the same or a later coordinate settles it normally.

This permits deterministic code such as:

```tease
let timerId = startTimer 0 {
    say "Timer handler"
}

say "Main path first"
```

Until a time observation occurs, the main-path output is allowed to occur first. The player/runtime integration controls when observations are submitted; the runtime does not insert a hidden clock read.

## Identity model

### Internal action ID

Every active timer is one ADR 0016 background action and receives the normal internal `actionId`. It is used for runtime/player correlation, settlement, active-first lookup, and `lastSettlement`.

The action ID is not exposed to TeaseScript.

### Author-visible timer handle

`startTimer` returns an opaque engine-managed timer handle. Conceptually:

```text
TimerHandle {
    kind: "timer"
    handleId: positive safe integer
}
```

The exact TypeScript representation and public type name are implementation details, but these semantics are required:

- timer handles are JSON-safe opaque runtime references;
- ordinary assignment and argument passing preserve the same handle identity;
- a timer handle is not a number, string, action ID, browser handle, or player object;
- only APIs accepting timer handles may consume it;
- a handle from another runtime session is invalid;
- `nextTimerHandleId` is persisted and never moves backwards or reuses an identity after restore.

The timer action stores both `actionId` and `timerHandleId`. They are distinct namespaces and are validated independently.

## Conceptual serialized state

This proposal extends the ADR 0016 conceptual runtime state with timer-specific state when the timer slice is implemented:

```text
nextTimerHandleId:
    positive safe integer

backgroundActions:
    PendingAction[]

queuedTimerHandlers:
    TimerHandlerInvocation[]

activeTimerHandler:
    TimerHandlerFrame | null
```

This PR does not select or change an implemented format number. After issue #66 lands, the timer implementation must determine and document the required schema-version transition instead of silently changing the implemented version-4 shape.

### Active timer action

Conceptually:

```text
BackgroundTimerAction {
    kind: "timer"
    actionId
    creationSequence
    timerHandleId
    deadlineMs
    ownerFlowId
    ownerScriptActivationId
    handlerDefinitionId
    capturedScopeId
}
```

Required meaning:

- `creationSequence` preserves creation order independently from the final action-ID tie-breaker;
- `deadlineMs` uses the same persisted session coordinate as `currentSessionTimeMs`;
- `ownerFlowId` and `ownerScriptActivationId` support non-persistent cleanup;
- `handlerDefinitionId` references a validated compiled handler region;
- `capturedScopeId` is an explicit runtime scope reference, not a JavaScript closure.

The timer keeps its captured lexical scope reachable while the timer is active, queued, or executing. Releasing the last timer/handler reference makes that scope eligible for normal runtime reclamation after complete reachability rules exist.

### Queued handler invocation

When a timer settles due, its active action is removed and one invocation is appended:

```text
TimerHandlerInvocation {
    timerHandleId
    sourceActionId
    handlerDefinitionId
    capturedScopeId
    ownerFlowId
    deadlineMs
    creationSequence
    actionId
    settlementEventSequence
}
```

The ordering tuple is retained so restore validation can prove queue order:

```text
(deadlineMs, creationSequence, actionId)
```

The invocation contains everything required to start the handler without consulting `lastSettlement`, replaying the timer creation instruction, or retaining a callback.

### Active handler frame

At most one timer handler executes at once:

```text
TimerHandlerFrame {
    invocation
    nextHandlerInstruction
    handlerScopeId
    state: running | waitingForForegroundSlot
}
```

The main execution path remains stored independently while the handler frame is active. Checkpoints preserve the handler's exact next instruction and scope state.

## Creation transition

Timer creation is one atomic instruction-boundary transition:

1. evaluate the duration in normal source order;
2. validate duration and deadline arithmetic;
3. validate the compiled handler reference and captured scope;
4. allocate a distinct timer handle ID and action ID;
5. create the complete background action;
6. bind the opaque handle to the `let` target;
7. emit `actionRequested` for the timer action;
8. continue the main path.

No action or handle ID is consumed when validation fails before allocation. Once allocation begins, action creation, handle binding, counter advancement, and event emission must commit as one valid runtime transition or fail without partial state.

## Time observation and settlement

`observeTime(...)` retains ADR 0016's atomic time update and extends its due processing:

1. validate and persist the nondecreasing effective session time;
2. collect every due timed foreground and background action;
3. sort them globally by:
   1. earliest deadline;
   2. creation sequence;
   3. action ID;
4. settle every due action in that order;
5. for each due background timer:
   - remove the active timer action;
   - create/replace `lastSettlement` with settlement kind `elapsed`;
   - emit `actionCompleted`;
   - append one queued handler invocation containing the completion-event sequence;
6. return without starting a handler or executing normal source instructions.

All due timers settle in one observation. If several timers settle, `lastSettlement` retains only the final settlement, as required by ADR 0016's bounded history. Earlier settlements remain represented by their queued invocations and emitted events; a later duplicate completion delivery for an earlier action is stale rather than `alreadySettled`.

A due foreground timed action participates in the same global ordering. Its completion event is emitted at its sorted position. After the observation returns, queued timer handlers take execution priority over the resumed main continuation.

## Handler scheduling and main-path interaction

The scheduler uses this priority on every later runtime entry:

1. continue an already active timer handler;
2. otherwise activate the first queued timer handler, if any;
3. otherwise, if a foreground action is pending, return/retain `waiting`;
4. otherwise execute the normal main path.

Consequences:

- timer handlers may execute while the main path is blocked by a foreground action;
- due handlers run before a main path that became runnable in the same time observation;
- queued handlers run in their persisted due order;
- the normal main path resumes only after no active or queued timer handler remains;
- no handler executes concurrently with another handler or with a normal main instruction;
- audio, video, player resources, and truly asynchronous host capabilities may continue according to their own contracts, but runtime instruction execution remains single-threaded.

### One handler start per runtime entry

A runtime entry may activate at most one previously queued timer handler. When that handler finishes normally, the entry returns at an inspectable scheduler boundary instead of activating another queued handler or resuming the main path in the same entry.

The exact exported TypeScript result name for this boundary is deferred to implementation, but the boundary itself is required for deterministic stepping, checkpoint tests, and prevention of hidden handler chains inside one call.

A subsequent runtime entry activates the next queued handler. After the queue is empty, a later entry resumes the main path.

### Foreground actions created by handlers

A handler may create foreground and background actions under one global foreground-slot rule:

- background-action creation proceeds normally;
- when no foreground action exists, the handler may create one and later resume from its explicit handler continuation;
- when the main path or current handler already owns a foreground action, a handler instruction that would create another foreground action yields before evaluating any of that instruction's arguments;
- the active handler frame records `waitingForForegroundSlot` and retains the same next instruction;
- after the existing foreground action completes, a later runtime entry retries the instruction exactly once from its untouched pre-evaluation state.

This avoids a second foreground slot, duplicate expression evaluation, and a failure merely because a timer became due during a blocking wait.

## Stop behavior

`stopTimer(handle)` is a synchronous runtime operation using the author-visible handle namespace, not a player completion message.

### Active timer

When the handle identifies an active timer action:

1. resolve the active action before any stale classification;
2. remove the timer action;
3. create/replace `lastSettlement` with settlement kind `stopped`;
4. emit `actionCompleted` with the stopped settlement;
5. queue no handler;
6. continue the caller after `stopTimer(...)`.

The handle remains an opaque value in existing variables but is inactive.

### Already due, queued, executing, completed, or stopped

When the handle is issued in this runtime but no active timer action exists, `stopTimer(...)` is an idempotent no-op:

- it does not cancel a queued or executing handler;
- it does not replace `lastSettlement`;
- it emits no action event;
- it does not fail the runtime;
- it returns normally with no value.

This covers repeated stops, already-fired timers, normally completed handlers, and previously stopped timers.

### Unknown or wrong handle

- A value of another type or handle kind is a normal structured script type/runtime error.
- A syntactically valid timer-handle identity that is not lower than `nextTimerHandleId`, belongs to another runtime, or appears only through malformed external state is rejected as an unknown handle or malformed snapshot at the appropriate validation boundary.
- Scripts cannot forge a timer handle from a number or string.

### Stop from a handler

A timer handler may stop another timer that is still active. If the target timer already settled in the same time observation and its handler is queued, the stop is an already-fired no-op.

## Non-persistent and session-scoped meaning

For this slice, “non-persistent” means:

- the timer is scoped to the current active runtime session and owning script flow;
- it survives ordinary runtime checkpoint creation, JSON serialization, restore, page reload, reconnect, tab suspension, and device sleep within that same flow;
- it does not become Laravel-scheduled work and does not survive the end of the runtime session;
- it is cleaned up on the accepted V30 non-persistent flow transfers: `goto`, script-file `end`, `run`, script-file `call`, and `exit`;
- an ordinary user-defined function call is not the script-file `call` command and does not by itself remove a timer.

Checkpoint persistence and product-level persistent scheduling are therefore different concepts.

## Control transfer and cleanup

### Normal handler completion

On normal completion:

- clear `activeTimerHandler`;
- release its handler scope and timer ownership when no other runtime reference requires them;
- leave the handle as an inactive issued handle;
- return at the handler-completed scheduler boundary;
- start no other handler and resume no main instruction in the same runtime entry.

### `goto` from a timer handler

The accepted V30 behavior is preserved: a `goto` from a timer handler abandons the interrupted main execution path and does not return.

The transition:

1. validates the target label in the handler's owning script file;
2. clears the active handler and all queued timer handlers owned by the abandoned flow;
3. stops all active non-persistent timers owned by that flow without running their handlers;
4. clears any foreground action owned by the abandoned flow according to normal control-transfer cleanup;
5. moves the main execution position to the target label using normal `goto` scope cleanup;
6. continues under the new flow state on a later runtime entry.

Cleanup caused by control transfer is not represented as ordinary timer settlement and emits no `actionCompleted` events for discarded timers.

### Script-file `end`, `run`, and `call`

The accepted V30 non-persistent cleanup rule applies when these script-file control commands are executed by the main path or a handler. Active timers and queued handlers owned by the departing flow are removed. Script-file `call` therefore does not preserve a non-persistent timer until return.

Exact cross-file activation identifiers and migration into later persistent timer behavior remain implementation details.

### Handler failure

An unhandled structured runtime failure in a timer handler fails the complete runtime using the normal failure model. The runtime:

- records the handler source location and structured failure;
- clears the active timer handler, queued timer handlers, background timer actions, and any foreground action;
- executes no later handler or main continuation;
- does not emit a second `actionCompleted` event for the source timer, because that timer already settled before the handler began.

### `exit`

`exit` from either the main path or a timer handler terminates the complete session. It clears every active timer action, queued invocation, active handler, and foreground action. No discarded timer handler runs.

### Fatal player/session abort

A fatal abort clears runtime-owned pending timer and handler state as cleanup. It does not synthesize normal timer completion events. The host/player must separately release wake-ups and external resources.

## Checkpoint and restore

A checkpoint may contain any of these timer states:

1. active timer actions in `backgroundActions`;
2. one or more due handlers in `queuedTimerHandlers` after their actions settled;
3. one active `TimerHandlerFrame` at an instruction boundary;
4. an active handler waiting for the global foreground slot;
5. any combination allowed by the validation invariants.

Restore is pure:

- it validates and recreates the exact serialized state;
- it does not read a clock;
- it does not settle an active timer;
- it does not replay `actionRequested` or `actionCompleted`;
- it does not restart a queued or active handler from its beginning;
- it preserves all action, handle, event, scope, frame, queue, and instruction identities.

### Relative to the deadline

- **Before deadline:** restore keeps the timer active; a later observation below the deadline leaves it active.
- **Exactly at deadline:** restore alone keeps it active; an explicit observation at the deadline settles it.
- **After deadline without a prior observation:** restore keeps it active; the first later trusted observation settles it.
- **After settlement with a queued handler:** restore preserves the queue and does not emit completion again.
- **During handler execution:** restore resumes at the exact handler instruction boundary.

The uninterrupted and restored runs must produce identical action events, handler ordering, visible events, final state, and failure behavior for the same supplied observations and external responses.

## Event ordering

The first slice requires only the accepted ADR 0016 action events. It does not add public handler-start or handler-completed events.

### Creation

```text
action stored and handle bound
-> actionRequested(timer)
-> later main-path events
```

`creationSequence` is persisted before or with `actionRequested`. The event exposes the internal action correlation data required by the player, not a forgeable TeaseScript handle value.

### Elapsed timer

```text
currentSessionTimeMs persisted
-> timer removed
-> handler invocation queued
-> lastSettlement stored
-> actionCompleted(elapsed)
-> observeTime returns
-> later runtime entry starts handler
-> handler visible events
-> handler-completed scheduler boundary
```

For multiple due timers, each `actionCompleted` is emitted in global due order. Handler visible events occur only after all due settlements in that observation.

### Stopped timer

```text
timer removed
-> lastSettlement stored
-> actionCompleted(stopped)
-> stopTimer returns
```

No handler lifecycle event is emitted in this slice. Developer-only tracing may later expose scheduler transitions without changing script-visible semantics, but that is not accepted here.

## Validation invariants

Validation rejects malformed plan, snapshot, checkpoint, timer handle, timer action, handler queue, active handler, settlement, and control-transfer state before partial execution.

At minimum:

- `nextTimerHandleId` is a positive safe integer;
- every timer handle ID in active, queued, or executing state is positive and lower than `nextTimerHandleId`;
- timer handle IDs are unique across active timer actions, queued invocations, and the active handler;
- internal action IDs remain governed by ADR 0016 and are distinct from timer handle IDs;
- every active timer action has kind `timer`, a finite valid deadline, a valid creation sequence, and valid owner, handler, and scope references;
- every timer action ID and handle allocation is unique and monotonic after restore;
- queued handler invocations are ordered by `(deadlineMs, creationSequence, actionId)`;
- a queued invocation refers to an action that is no longer active;
- the queue contains no duplicate source action or timer handle;
- at most one `activeTimerHandler` exists;
- an active handler's invocation is not also queued or active as a timer action;
- `nextHandlerInstruction` lies within the referenced handler definition;
- handler scopes and captured scopes exist and have valid ownership;
- `waitingForForegroundSlot` retains an unconsumed foreground-creating instruction and no partially evaluated argument state;
- the global ADR 0016 foreground-action invariant remains valid while a handler executes;
- a stopped timer queues no handler;
- no callback, promise, DOM value, browser timer, generator, function object, or suspended JavaScript stack appears in serialized state;
- all arrays and nested state remain subject to bounded stable capture, depth, and total-work limits;
- unsupported extra fields follow the versioned-schema policy rather than being trusted.

## Deterministic test matrix

Implementation requires focused source-to-runtime, snapshot, checkpoint, validator, and resume-equivalence tests.

### Creation and continuation

- one timer is created, returns an opaque handle, emits `actionRequested`, and the main path continues;
- duration units, decimals, fractional milliseconds, and deadline arithmetic;
- zero-duration timer remains asynchronous until explicit observation;
- negative constant, negative runtime value, non-finite value, unsupported magnitude, and overflow;
- action ID and timer handle ID are distinct, monotonic, checkpointed, and not reused.

### Due ordering and observation

- one due timer settles and queues one handler;
- multiple timers with different deadlines;
- equal deadlines ordered by creation sequence and then action ID;
- all due timers settle in one observation;
- all `actionCompleted` events precede every queued-handler visible event;
- a foreground timed action and background timers due in the same observation use the global ordering;
- `lastSettlement` ends as the final settlement while earlier handlers remain queued.

### Handler scheduling

- main execution is interrupted only after `observeTime(...)` returns;
- one queued handler starts per runtime entry;
- handlers execute one at a time in queue order;
- main execution resumes only after the queue drains;
- a handler emits visible output;
- a handler calls a normal function;
- a handler creates another background timer;
- a handler runs while the main path has a foreground action pending;
- a handler creates a foreground action when the slot is free;
- a handler yields before argument evaluation when the foreground slot is occupied, then resumes exactly once after it becomes free.

### Stop

- active timer stop settles as `stopped`, emits one `actionCompleted`, and queues no handler;
- repeated stop is a no-op;
- stop after elapsed settlement but before handler start is a no-op;
- stop during or after handler execution is a no-op;
- stop from another handler cancels a later active timer;
- stop cannot cancel another timer that already settled in the same observation;
- wrong-kind and unknown handles are structured failures/rejections without partial mutation.

### Checkpoint and restore

- restore before, exactly at, and after a deadline;
- restore with active timer and lower time observation;
- restore after settlement with queued handler not yet started;
- restore during handler execution at every supported instruction boundary;
- restore while handler waits for the foreground slot;
- active, queued, and executing timer state survives JSON round-trip;
- no event or handler start is replayed;
- uninterrupted and restored execution are completely equivalent.

### Flow and failure cleanup

- normal handler completion;
- `goto` from handler abandons the interrupted path and cleans old-flow timer state;
- script-file `end`, `run`, and `call` cleanup;
- ordinary function calls do not perform script-flow cleanup;
- handler structured failure fails the runtime and clears timer work;
- `exit` clears all active, queued, and executing timers;
- fatal abort cleanup emits no synthetic normal completion;
- late action completion messages follow ADR 0016 active-first, settled, stale, and unknown rules.

### External-data validation

- malformed timer action, deadline, owner, scope, handler definition, handle, queue order, and active frame;
- duplicate action IDs, handle IDs, source actions, and queue entries;
- sparse, excessively large, deep, cyclic, accessor-bearing, and unsupported-prototype data is rejected within bounded work;
- no test waits for real time; all time is injected deterministically.

## Alternatives considered

### Execute zero-duration handler inline

Rejected. It would make `startTimer 0` behave like a hidden function call, expose reentrancy inside the creation instruction, and differ from all other timer settlement through explicit time observation.

### Use the internal action ID as the script timer ID

Rejected. ADR 0016 explicitly separates host/runtime action correlation from author-visible resource handles. An opaque handle also prevents scripts from forging action messages with ordinary numbers.

### Settle only one due timer per observation

Rejected. It makes the result depend on the number of host ticks and can leave already-observed due work artificially active. Settling all due actions atomically preserves one authoritative time observation.

### Execute handlers inside `observeTime(...)`

Rejected. Clock observation would then run arbitrary script code, emit unrelated events, create actions, or fail before the host receives the completed observation result. Settlement and handler execution remain separate boundaries.

### Allow concurrent handlers

Rejected. It would require multiple mutable instruction contexts, conflict resolution, and a general coroutine/event-loop model. One explicit handler frame preserves deterministic single-threaded execution.

### Delay all timer handlers until the foreground action completes

Rejected. A background timer must be able to fire meaningfully during a blocking wait. The handler may execute while the main foreground action remains pending.

### Fail when a handler encounters an occupied foreground slot

Rejected. The timer may legitimately become due during a blocking wait. Yielding before argument evaluation preserves one foreground slot without surprising failure or duplicated side effects.

### Let `stopTimer` cancel queued or executing handlers

Rejected for the first slice. Once elapsed settlement occurred, the timer fired and its handler became independent queued runtime work. Later cancellation semantics, if desired, require a separate accepted handler-cancellation design.

### Omit `stopTimer` from the first slice

Rejected. V30's canonical one-shot background form returns an identifier and explicitly defines `stopTimer(...)`. Including active cancellation avoids implementing a handle that has no first-slice control purpose.

### Treat non-persistent as lost on reload

Rejected. ADR 0015 and ADR 0016 require ordinary session checkpoint/restore to preserve runtime state. Non-persistent describes flow/session lifetime, not checkpoint durability.

### Preserve non-persistent timers across script-file `call`

Rejected because accepted V30 explicitly removes non-persistent timers on `call`. Ordinary user-defined function calls remain unaffected.

## Explicitly deferred timer-family behavior

This ADR does not define:

- blocking visible `timer` implementation;
- `mysteryTimer` implementation;
- randomized range durations;
- `repeat: true`, repetition counters, missed repetitions, or per-repeat RNG;
- `persist: true` and ownership beyond the current flow/session;
- timer display, countdown, progress, pause, or player controls;
- handler cancellation after elapsed settlement;
- fairness or quotas for an unbounded stream of newly created timers beyond existing runtime budgets and validation limits;
- Laravel schedules, continuous-personality jobs, or offline server execution;
- browser wake-up scheduling or final host message envelopes;
- cross-device migration;
- generic permanent-button or event-loop infrastructure;
- dedicated public handler-start or handler-completed events;
- optional source syntax that discards the returned timer handle.

The complete timer-family design must reconcile these features with this proposal and accepted V30 rather than silently changing the first-slice behavior.

## Implementation sequence and dependencies

A later production implementation may begin only after:

1. issue #66 has merged the blocking-wait/version-4 pending-action foundation;
2. this ADR has received explicit owner approval and changed from `Proposed` to `Accepted`;
3. the bounded external-data hardening required by issue #65 is present on the implementation base;
4. the implementation has documented whether the additional timer queue/handle/frame state requires a schema-version increment beyond the then-current implemented format.

Recommended implementation order:

1. compile the canonical one-shot `startTimer` and handler region;
2. add opaque timer handles and active timer actions;
3. add all-due settlement and persisted handler queue;
4. add one-at-a-time handler frames and scheduler boundaries;
5. add foreground-slot yielding;
6. add `stopTimer` and flow cleanup;
7. add validator, checkpoint, resume-equivalence, and adversarial tests;
8. update current documentation from proposed to implemented behavior only after code and checks pass.

## Owner-review status

No production decision is accepted by this document while its status is `Proposed`.

Owner review should confirm or revise these first-slice choices as one coherent contract:

- canonical assigned `startTimer` form;
- zero-duration timer waits for explicit observation;
- opaque timer handle separate from action ID;
- all due timers settle in one observation;
- one queued handler starts per later runtime entry;
- queued handlers take priority over the main path, including while the main path waits;
- occupied foreground slot causes pre-evaluation handler yield;
- active `stopTimer` settles as stopped, while late/repeated stop is a no-op;
- non-persistent timers survive checkpoint but not accepted flow transfers;
- no dedicated public handler lifecycle events in the first slice.

Until owner approval, these remain proposed choices and implementation must not begin from this ADR alone.
