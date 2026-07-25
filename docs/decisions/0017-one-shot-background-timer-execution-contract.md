# ADR 0017 — One-shot background timer execution contract

**Status:** Proposed  
**Issue:** #68  
**Implementation dependency:** #66

## Context

Accepted V30 already defines background timer syntax, returned timer identifiers, `stopTimer(...)`, repeating timers, persistent timers, and timer finish blocks. Accepted ADR 0016 defines the shared persisted session time, foreground/background action split, action IDs, bounded settlement state, active-first lookup, deterministic due ordering, and checkpoint-safe execution foundations.

The first populated `backgroundActions` slice must be smaller than the complete timer family. It must prove that a timer can remain active while the main path continues, settle from explicit time observation, queue a JSON-safe handler, execute handlers one at a time, survive ordinary session checkpoint/restore, and clean up deterministically.

This ADR proposes only a one-shot, non-repeating, session-scoped background timer. It does not implement code, modify an implemented schema, or change a format constant.

## Proposed decision summary

1. Reuse the accepted V30 forms `let timerId = startTimer duration { ... }` and `stopTimer(timerId)`.
2. Require the assigned form in the first slice; optional discarded-handle syntax remains deferred.
3. Return an opaque timer handle immediately. It is distinct from the internal ADR 0016 action ID.
4. Use ADR 0016 exact elapsed duration semantics: bare numbers mean seconds; `ms`, `s`, `min`, and `h` are supported; decimals and fractional milliseconds are valid; randomized ranges are deferred.
5. `startTimer 0` creates a real timer and never executes its handler inline. The next explicit time observation at the same or a later session coordinate settles it.
6. Persist active timer actions, a due-handler queue, at most one active timer-handler frame, and the timer-handle allocator as explicit JSON-safe state.
7. One `observeTime(...)` settles every due timed action in global deadline/creation/action order and queues one invocation per due timer. It executes no handler.
8. On later runtime entries, an active or queued timer handler has priority over the normal main path. Handlers run one at a time and may run while the main path has a foreground action pending.
9. A runtime entry activates at most one previously queued handler. Normal handler completion returns at a separate inspectable scheduler boundary.
10. A handler may create background actions. It may create a foreground action when the single global foreground slot is free; otherwise the foreground-creating instruction yields before argument evaluation.
11. Stopping an active timer settles it as stopped, emits the normal `actionCompleted`, and queues no handler. Repeated and late stops are deterministic no-ops.
12. “Non-persistent” means flow- and session-scoped, not lost at checkpoint. Active, queued, and executing timer state survives ordinary checkpoint/restore but is removed by the accepted non-persistent flow-transfer and session-ending rules.
13. An unhandled handler failure fails the complete runtime and clears remaining timer work. `exit` and fatal session abort also clear all timer and handler state.
14. Repeating, persistent, visible, mystery, randomized-range, Laravel, browser wake-up, and continuous-personality timer behavior remains deferred.

Every item remains proposed until explicit owner approval changes this ADR to `Accepted`.

## First-slice source contract

### Canonical declaration

The first slice uses the accepted V30 syntax unchanged:

```tease
let timerId = startTimer 30 {
    timeExpired()
}
```

The block is the finish action. No `onFinish` wrapper is introduced.

A timer handler may contain ordinary supported statements, call normal functions, create another one-shot timer, stop another active timer, and use `goto` subject to the cleanup rules below.

### Stop

The accepted control form is included:

```tease
stopTimer(timerId)
```

`stopTimer(...)` returns no TeaseScript value.

### Deferred source forms

The following accepted timer-family forms are outside the first slice:

```tease
let repeating = startTimer 10 {
    repeat: true
    timeExpired()
}

let persistent = startTimer 30 {
    persist: true
    timeExpired()
}

let randomized = startTimer 5..10 {
    timeExpired()
}
```

Blocking `timer`, `mysteryTimer`, optional discarded-return syntax, repeating timers, persistent timers, and randomized ranges remain later timer-family work.

## Duration semantics

The first slice uses exact elapsed time on ADR 0016's persisted session coordinate:

```tease
let a = startTimer 10 { timeExpired() }
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
- non-finite values, unsupported numeric magnitude, and deadline overflow fail before either identity is allocated or an event is emitted;
- calendar units, range durations, and server-backed deadlines are outside this slice.

### Zero duration

`startTimer 0` differs from blocking `wait 0` because the timer must return a handle and preserve asynchronous handler ordering.

Creation therefore:

1. allocates the timer handle and internal action ID;
2. stores a background timer with `deadlineMs == currentSessionTimeMs`;
3. emits `actionRequested`;
4. returns the handle and continues the main path.

The timer does not settle or execute its handler during its creation instruction. The next explicit `observeTime(...)` at the same or a later coordinate settles it.

```tease
let timerId = startTimer 0 {
    say "Timer handler"
}

say "Main path may run before the next time observation"
```

The runtime performs no hidden clock read to force the zero-duration timer between these statements.

## Identity model

### Internal action ID

Every active timer is an ADR 0016 background action and receives an internal `actionId`. The runtime and player use it for correlation, settlement, active-first lookup, and `lastSettlement`.

The action ID is not exposed to TeaseScript.

### Author-visible timer handle

`startTimer` returns an opaque engine-managed timer handle. Conceptually:

```text
TimerHandle {
    kind: "timer"
    handleId: positive safe integer
}
```

Required semantics:

- the handle is a JSON-safe opaque runtime reference;
- assignment and argument passing preserve handle identity;
- it is not a script number, string, action ID, browser handle, or player object;
- only timer-handle APIs may consume it;
- script code cannot forge one from an ordinary value;
- `nextTimerHandleId` is persisted, monotonic, and never reused after restore.

The timer action stores both `actionId` and `timerHandleId`. The namespaces are distinct and independently validated.

The exact TypeScript representation and cross-session tagging remain implementation details, but host data may not inject a forged timer handle into script state.

## Conceptual serialized state

When implemented, this proposal extends the ADR 0016 runtime state conceptually with:

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

This design PR does not select an implemented format number. After issue #66 establishes the actual version-4 foundation, a later implementation must explicitly document whether the timer additions require another schema-version transition.

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

- `deadlineMs` uses the same coordinate as `currentSessionTimeMs`;
- `creationSequence` preserves accepted tie ordering;
- owner fields support non-persistent flow cleanup;
- `handlerDefinitionId` references a validated compiled handler region;
- `capturedScopeId` is an explicit runtime scope reference, not a closure.

The captured scope remains reachable while the timer is active, queued, or executing.

### Queued handler invocation

Elapsed settlement creates one invocation:

```text
TimerHandlerInvocation {
    timerHandleId
    sourceActionId
    handlerDefinitionId
    capturedScopeId
    ownerFlowId
    deadlineMs
    creationSequence
    settlementEventSequence
}
```

The invocation contains everything required to start the handler without replaying timer creation, consulting `lastSettlement`, or retaining a callback.

The queue is ordered by:

```text
(deadlineMs, creationSequence, sourceActionId)
```

### Active handler frame

At most one timer handler executes:

```text
TimerHandlerFrame {
    invocation
    nextHandlerInstruction
    handlerScopeId
    state: running | waitingForForegroundSlot
}
```

The main execution context remains stored independently. A checkpoint preserves the exact handler instruction and scope state.

## Timer creation transition

Creation is one atomic instruction-boundary transition:

1. evaluate the duration in source order;
2. validate duration and deadline arithmetic;
3. validate the compiled handler reference and captured scope;
4. allocate the timer handle ID and action ID;
5. store the complete background action;
6. bind the opaque handle to the `let` target;
7. emit `actionRequested`;
8. continue the main path.

Validation failure before allocation consumes no identity. Once allocation begins, counter advancement, action storage, handle binding, and event emission must commit as one valid transition or fail without partial state.

## Time observation and settlement

`observeTime(...)` extends ADR 0016 due processing:

1. validate and persist the nondecreasing effective session time;
2. collect every due timed foreground and background action;
3. sort them globally by:
   1. earliest deadline;
   2. creation sequence;
   3. action ID;
4. settle every due action in that order;
5. return without starting a handler or executing a normal source instruction.

For each elapsed background timer, one atomic settlement step:

1. removes the active timer action;
2. allocates the `actionCompleted` event sequence;
3. creates/replaces `lastSettlement` with kind `elapsed` and that sequence;
4. creates and appends the queued invocation with the same sequence;
5. emits `actionCompleted(elapsed)` using that sequence.

No externally observable checkpoint can contain only part of this settlement step.

All due timers settle in one observation. If several settle, `lastSettlement` retains only the final settlement, as required by ADR 0016's bounded history. Earlier settlements remain represented by queued invocations and emitted events; a later duplicate delivery for an earlier action is stale rather than `alreadySettled`.

A due foreground timed action participates in the same global ordering. After the observation returns, queued timer handlers take execution priority over any main continuation made runnable by that observation.

## Handler scheduling and main-path interaction

Every later runtime entry applies this priority:

1. continue `activeTimerHandler`;
2. otherwise activate the first `queuedTimerHandlers` entry;
3. otherwise, if a foreground action exists, return/retain `waiting`;
4. otherwise execute the normal main path.

Consequences:

- a handler may run while the main path remains blocked by a foreground action;
- due handlers run before a main path made runnable by the same observation;
- queued handlers run in persisted due order;
- the normal main path resumes only after no active or queued timer handler remains;
- runtime instructions remain single-threaded: no handler runs concurrently with another handler or with a normal main instruction;
- independently managed media or host resources may continue according to their own contracts.

### One handler activation per runtime entry

A runtime entry activates at most one previously queued handler. When that handler finishes normally, the entry returns at an inspectable scheduler boundary instead of activating the next queued handler or resuming the main path in the same call.

The exact exported TypeScript result name is deferred to implementation, but the boundary is required for deterministic stepping and checkpoint tests.

A later runtime entry activates the next handler. After the queue drains, another entry resumes the main path.

### Actions created by handlers

A handler may create background actions normally.

There remains one global foreground-action slot:

- when free, the handler may create a foreground action and later resume from its explicit handler continuation;
- when occupied, an instruction that would create another foreground action yields before evaluating any argument;
- the active handler records `waitingForForegroundSlot` and keeps the same next instruction;
- after the existing foreground action completes, a later entry evaluates and executes that instruction exactly once.

This avoids a second foreground slot, duplicate side effects, and failure merely because a timer became due during a blocking wait.

## Stop behavior

`stopTimer(handle)` is a synchronous runtime operation over the author-visible handle namespace. It is not a player completion message.

### Active timer

When the handle identifies an active timer:

1. resolve the active timer before inactive/stale classification;
2. remove the timer action;
3. allocate the completion-event sequence;
4. create/replace `lastSettlement` with kind `stopped` and that sequence;
5. emit `actionCompleted(stopped)`;
6. queue no handler;
7. return normally to the caller.

The handle may remain in variables but is inactive.

### Already fired, queued, executing, completed, or stopped

An issued handle with no active timer action is an idempotent no-op:

- it does not cancel a queued or executing handler;
- it does not replace `lastSettlement`;
- it emits no event;
- it does not fail the runtime;
- it returns no value.

This covers repeated stops and stops after elapsed settlement.

A handler may stop another timer that remains active. If the target settled earlier in the same time observation and its handler is queued, the stop is an already-fired no-op.

### Wrong or unknown handle

- another value or handle kind produces the normal structured type/runtime error;
- an unknown or externally forged timer handle is rejected through the appropriate structured runtime or external-data boundary;
- scripts cannot construct a timer handle from a number or string.

## Meaning of non-persistent

For this slice, non-persistent means:

- scoped to the active runtime session and owning script flow;
- preserved by ordinary checkpoint creation, JSON round-trip, restore, page reload, reconnect, tab suspension, and device sleep within that flow;
- not converted to Laravel-scheduled work;
- not retained beyond session termination;
- removed on accepted V30 non-persistent flow transfers: `goto`, script-file `end`, `run`, script-file `call`, and `exit`.

An ordinary user-defined function call is not the script-file `call` command and does not remove a timer.

Checkpoint durability and product-level persistent scheduling are separate concepts.

## Control transfer, completion, and failure

### Normal handler completion

Normal completion:

- clears `activeTimerHandler`;
- releases handler/timer scope ownership when no other runtime reference requires it;
- leaves any handle value inactive;
- returns at the handler-completed scheduler boundary;
- starts no other handler and resumes no main instruction in the same entry.

### `goto` from a handler

Accepted V30 behavior is preserved: `goto` abandons the interrupted main path and does not return.

The transition:

1. validates the target label in the handler's owning script file;
2. clears the active handler and queued handlers owned by the abandoned flow;
3. removes active non-persistent timers owned by that flow without running their handlers;
4. clears foreground work owned by the abandoned flow under normal control-transfer cleanup;
5. moves the main path to the target label with normal scope cleanup;
6. continues from the new flow on a later runtime entry.

Control-transfer cleanup is not ordinary timer settlement and emits no synthetic `actionCompleted` for discarded timers.

### Script-file `end`, `run`, and `call`

When these script-file control commands leave a flow, active timers and queued handlers owned by that flow are removed under the accepted V30 non-persistent rule. Script-file `call` does not preserve a non-persistent timer until return.

Exact cross-file activation identifiers remain an implementation detail.

### Handler failure

An unhandled structured failure in a timer handler fails the complete runtime. The runtime:

- records the handler source location and structured failure;
- clears active and queued handlers, active timer actions, and foreground work;
- executes no later handler or main continuation;
- emits no second `actionCompleted` for the source timer, because that timer settled before handler execution.

### `exit` and fatal abort

`exit` from either execution context terminates the session and clears active timers, queued invocations, active handler state, and foreground work. No discarded handler runs.

A fatal player/session abort also clears runtime-owned timer and handler state as cleanup and emits no synthetic normal completion. The player separately releases wake-ups and external resources.

## Checkpoint and restore

A valid checkpoint may contain:

1. active timer actions;
2. one or more queued handler invocations after elapsed settlement;
3. one active handler at an instruction boundary;
4. an active handler waiting for the foreground slot;
5. any valid combination of those states.

Restore is pure:

- it validates and recreates the exact serialized state;
- it reads no clock and settles no timer;
- it replays no action event;
- it does not restart a queued or active handler from its beginning;
- it preserves action, handle, event, scope, frame, queue, and instruction identities.

Relative to a deadline:

- **before:** the timer remains active until an observation reaches its deadline;
- **exactly at:** restore alone does nothing; an observation at the deadline settles it;
- **after without prior observation:** restore keeps it active; the first later trusted observation settles it;
- **after settlement with a queued handler:** the queue is restored without another completion event;
- **during handler execution:** the exact handler instruction boundary resumes.

Uninterrupted and restored runs must produce identical action events, queue ordering, handler-visible events, final state, and failure behavior for the same observations and external responses.

## Event ordering

The first slice uses only ADR 0016's public action events. It adds no public handler-start or handler-completed event.

### Creation

```text
action and handle stored
-> actionRequested(timer)
-> later main-path events
```

### Elapsed timer

For each due timer in global order:

```text
currentSessionTimeMs already persisted
-> active timer removed
-> completion sequence allocated
-> settlement and queued invocation stored with that sequence
-> actionCompleted(elapsed)
```

After every due action has settled:

```text
observeTime returns
-> later runtime entry starts first handler
-> handler-visible events
-> handler-completed scheduler boundary
```

All completion events from one observation precede every queued-handler visible event.

### Stopped timer

```text
active timer removed
-> completion sequence allocated
-> lastSettlement stored
-> actionCompleted(stopped)
-> stopTimer returns
```

Developer-only tracing may later expose scheduler transitions, but no additional public lifecycle event is accepted here.

## Validation invariants

Validation rejects malformed plan, snapshot, checkpoint, handle, timer action, queue, active handler, settlement, and control-transfer state before partial execution.

At minimum:

- `nextTimerHandleId` is a positive safe integer;
- every active, queued, or executing timer handle ID is positive and lower than the allocator;
- timer handle IDs are unique across active actions, queued invocations, and the active handler;
- internal action IDs remain governed by ADR 0016 and are distinct from timer handles;
- every active timer has kind `timer`, a finite valid deadline, a valid creation sequence, and valid owner/handler/scope references;
- action and handle allocations remain monotonic after restore;
- queued invocations are ordered by deadline, creation sequence, and source action ID;
- queued invocations refer to no active source action;
- no duplicate source action or timer handle appears in the queue;
- at most one active timer handler exists;
- the active invocation is neither queued nor active as a timer action;
- the handler instruction lies inside its compiled handler region;
- captured and handler scopes exist with valid ownership;
- `waitingForForegroundSlot` retains an unconsumed foreground-creating instruction and no partial argument evaluation;
- the global ADR 0016 foreground invariant remains valid while handlers execute;
- stopped timers queue no handler;
- no callback, promise, browser timer, DOM value, generator, function object, or suspended JavaScript stack appears in state;
- all arrays and nested data remain subject to bounded stable capture, depth, sparse-array, and total-work limits;
- unsupported fields follow the versioned schema policy.

## Deterministic test matrix

Implementation requires source-to-runtime, snapshot, checkpoint, validator, and resume-equivalence coverage.

### Creation and duration

- one timer returns an opaque handle, emits `actionRequested`, and lets the main path continue;
- bare seconds, supported units, decimals, fractional milliseconds, and deadline arithmetic;
- zero-duration timer waits for explicit observation;
- negative constant, negative runtime value, non-finite value, unsupported magnitude, and overflow;
- action and handle IDs are distinct, monotonic, checkpointed, and never reused.

### Due ordering

- one due timer settles and queues one handler;
- multiple different deadlines;
- equal deadlines ordered by creation sequence then action ID;
- all due actions settle in one observation;
- foreground and background timed actions share global ordering;
- every completion event precedes queued-handler visible output;
- `lastSettlement` retains the final settlement while earlier handlers remain queued.

### Handler scheduling

- no handler runs inside `observeTime(...)`;
- one queued handler activates per runtime entry;
- handlers run one at a time in queue order;
- the main path resumes only after the queue drains;
- handlers emit output, call normal functions, and create another background timer;
- a handler runs while the main path has a foreground action;
- a handler creates foreground work when the slot is free;
- an occupied foreground slot causes pre-evaluation yield and exactly-once later evaluation.

### Stop

- active stop settles as stopped, emits one completion, and queues no handler;
- repeated stop is a no-op;
- stop after elapsed settlement but before handler start is a no-op;
- stop during or after handler execution is a no-op;
- a handler stops another active timer;
- a handler cannot cancel a timer already settled in the same observation;
- wrong-kind, unknown, and forged handles produce structured rejection without partial mutation.

### Checkpoint and restore

- restore before, exactly at, and after deadline;
- lower observation after restore does not move session time backward;
- restore with a queued handler not started;
- restore at every supported handler instruction boundary;
- restore while waiting for the foreground slot;
- active, queued, and executing state survives JSON round-trip;
- events and handler starts are not replayed;
- uninterrupted and restored execution are completely equivalent.

### Cleanup and failure

- normal handler completion;
- `goto` abandons the interrupted path and cleans old-flow timer state;
- script-file `end`, `run`, and `call` cleanup;
- ordinary function calls do not perform flow cleanup;
- handler failure fails the runtime and clears timer work;
- `exit` clears active, queued, and executing timers;
- fatal abort emits no synthetic completion;
- late action-completion messages follow ADR 0016 active-first/settled/stale/unknown rules.

### External data

- malformed deadlines, handles, owners, scopes, handler references, queue order, and active frames;
- duplicate IDs, source actions, and queue entries;
- sparse, oversized, deeply nested, cyclic, accessor-bearing, and unsupported-prototype data is rejected within bounded work;
- tests inject time and never wait for real seconds.

## Alternatives considered

### Execute zero-duration handler inline

Rejected. It would create hidden reentrancy inside timer creation and differ from all other explicit time-observation settlement.

### Expose the action ID as timer ID

Rejected. ADR 0016 separates internal host/runtime correlation from author-visible resource handles, and an opaque handle prevents script forging with ordinary numbers.

### Settle one due timer per observation

Rejected. The result would depend on tick count and leave work active after the authoritative observation already passed its deadline.

### Execute handlers inside `observeTime(...)`

Rejected. Time observation would then run arbitrary source code, create actions, emit unrelated events, or fail before the host receives its observation result.

### Run handlers concurrently

Rejected. It would require multiple mutable instruction contexts and a general coroutine/event-loop model.

### Delay handlers until foreground waiting finishes

Rejected as the default proposal. A background timer should be able to fire meaningfully during a blocking wait.

### Fail when a handler needs an occupied foreground slot

Rejected. Pre-evaluation yield preserves one foreground slot without surprising failure or duplicate side effects.

### Let `stopTimer` cancel queued or executing handlers

Rejected for the first slice. Elapsed settlement means the timer fired and its handler became independent queued work. Handler cancellation would require its own contract.

### Omit `stopTimer`

Rejected. Accepted V30 returns a timer identifier and explicitly includes `stopTimer(...)`; active cancellation is coherent first-slice behavior.

### Lose non-persistent timers on reload

Rejected. ADR 0015/0016 checkpoint semantics require ordinary session state to survive restore. Non-persistent describes flow/session lifetime.

### Preserve timers across script-file `call`

Rejected because accepted V30 explicitly removes non-persistent timers on `call`. Ordinary function calls remain unaffected.

## Explicitly deferred timer-family behavior

This ADR does not define:

- blocking visible `timer` implementation;
- `mysteryTimer` implementation;
- randomized ranges;
- `repeat: true`, missed repetitions, or per-repeat RNG;
- `persist: true` or ownership beyond the current flow/session;
- timer UI, progress, pause, or player controls;
- handler cancellation after elapsed settlement;
- fairness or quotas beyond existing instruction/data budgets;
- Laravel schedules, continuous-personality jobs, or offline server execution;
- browser wake-up scheduling or final host envelopes;
- cross-device migration;
- generic permanent-button or event-loop infrastructure;
- dedicated public handler lifecycle events;
- optional syntax that discards the timer handle.

The complete timer-family design must reconcile later behavior with accepted V30 and any accepted form of this ADR.

## Dependencies and later implementation

Production implementation may begin only after:

1. issue #66 has merged the blocking-wait/version-4 foundation;
2. this ADR has explicit owner approval and status `Accepted`;
3. the external-data hardening required by issue #65 is present on the implementation base;
4. the implementation documents whether timer handle/queue/frame state requires a version increment beyond the then-current format.

Recommended later implementation order:

1. compile canonical one-shot `startTimer` and handler regions;
2. add opaque handles and active timer actions;
3. add all-due settlement and the persisted queue;
4. add one-at-a-time handler frames and scheduler boundaries;
5. add foreground-slot yielding;
6. add `stopTimer` and flow cleanup;
7. add validator, checkpoint, resume-equivalence, and adversarial tests;
8. update canonical documentation from proposed to implemented behavior only after code and checks pass.

## Owner decisions required

Owner review must approve or revise these linked first-slice choices:

1. assigned canonical `startTimer` form is required;
2. zero-duration timers wait for explicit observation;
3. timer handles are opaque and separate from action IDs;
4. all due timers settle in one observation;
5. queued handlers take priority over the main path and can run during foreground waiting;
6. only one queued handler activates per runtime entry;
7. an occupied foreground slot causes pre-evaluation handler yield;
8. active stop settles as stopped; repeated/late stop is a no-op;
9. elapsed settlement makes the queued handler non-cancellable by `stopTimer`;
10. non-persistent timers survive checkpoint but not accepted flow transfers;
11. handler failure fails the complete runtime;
12. no public handler-start/completed events exist in the first slice.

Until these choices are approved, ADR 0017 remains proposed and must not be treated as implementation authority.
