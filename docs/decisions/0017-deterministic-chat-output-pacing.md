# ADR 0017 — Deterministic chat-output pacing

**Status:** Proposed  
**Issue:** #67  
**Implementation dependency:** #66

## Context

Accepted V30 syntax permits ordinary command-style output such as:

```tease
say "Kneel."
say as mistressVera "Hold still."
```

The current runtime can emit consecutive `say` events as quickly as execution
proceeds. The player needs deterministic reading space between transcript
messages without turning every message into a general blocking wait.

The owner-selected direction is:

- one `say` delays only a later `say` on the paced transcript channel;
- unrelated assignments, buttons, images, captures, and other instruction kinds
  before that later `say` may continue immediately;
- an author uses ordinary blocking `wait` when every later instruction must
  pause;
- automatic pacing uses the final visible text at 17 pacing units per second;
- `say(..., wait: duration)` overrides the automatic next-message gate;
- `wait: 0` disables the gate established by that message;
- timing reuses ADR 0016 persisted session time, foreground action identity,
  settlement, events, checkpoint, and restore semantics;
- no browser callback, hidden timer, promise, or suspended JavaScript stack is
  canonical runtime state.

ADR 0015 remains authoritative for versioned JSON-safe plans, snapshots,
checkpoints, event identity, and explicit continuation state. ADR 0016 remains
authoritative for nondecreasing `currentSessionTimeMs`, foreground pending
actions, absolute deadlines, action identity, bounded settlement replay,
active-first action lookup, time observation, and event ordering.

This proposal is a post-V30 syntax and runtime decision. It does not change the
accepted V30 specification unless and until the owner accepts this ADR.

## Decision summary

This ADR proposes:

1. Keep existing command-style `say` and `say as` source compatible.
2. Add a call-style `say(...)` form with required `text` and optional `as` and
   `wait` named arguments.
3. Use `wait` as the final and only pacing-override parameter name.
4. Use one paced transcript channel for narrator and speaker output.
5. Measure the final plain runtime text in Unicode code points.
6. Compute automatic delay as `ceil(codePointCount * 1000 / 17)` milliseconds.
7. Persist one transcript availability deadline while no presentation action is
   active.
8. When a later `say` is reached too early, transfer ownership of that deadline
   to one ADR-0016 foreground `presentationDelay` action instead of storing the
   same deadline twice.
9. Materialize the pending message once before waiting so interpolation, random
   visible-list selection, speaker resolution, and the override are not replayed
   after restore.
10. Expose ordinary `actionRequested` and `actionCompleted` events for the
    foreground presentation delay.
11. Keep browser wake-up scheduling and optional visual animations outside
    canonical runtime state.

## Proposed syntax

### Existing command style

The accepted forms remain valid:

```tease
say "Kneel."
say `Good morning, ${player.alias}.`
say message
say greetings

say as mistressVera "Kneel."
say as mistressVera `You will obey ${speaker.title}.`
```

These forms use automatic pacing. Existing source needs no rewrite.

### Call style

The proposed call-style forms are:

```tease
say("Kneel.")

say(
    text: "Kneel."
)

say(
    text: "Kneel.",
    wait: 5 s
)

say(
    as: mistressVera,
    text: "Kneel.",
    wait: 5 s
)
```

Rules:

- one positional argument is accepted and is the `text` expression;
- a positional call may not supply a second argument;
- named and positional arguments may not be mixed, consistent with V30;
- a named call requires exactly one `text` argument;
- `as` is optional and selects one explicit speaker for that message;
- `wait` is optional and controls only the gate established for the next
  transcript `say`;
- named arguments are unique and may appear in any source order; evaluation
  follows normal source order;
- unknown names and duplicate names are compile errors;
- `say("Text", wait: 5 s)` is invalid because it mixes positional and named
  arguments;
- `say("Text", 5 s)` is invalid because the override is deliberately named;
- `delay`, `duration`, `pace`, and `typingSpeed` are not aliases for `wait`;
- the grammar keyword `as` is permitted as an unambiguous named API field under
  the existing V30 named-argument rule.

The conceptual API signature is:

```text
say(text, as: optional speaker, wait: optional duration)
```

Only `text` is available positionally. Optional behavior is named so a duration
cannot be confused with a speaker or future presentation option.

### Meaning of `wait`

`wait` describes the delay after this message before another `say` may emit. It
is not a delay before the current message and it is not a blocking `wait`
statement.

```text
wait omitted  -> automatic next-say gate
wait: value   -> exact author-supplied next-say gate
wait: 0       -> no next-say gate established by this message
```

A `say(..., wait: 0)` that is itself reached while an earlier message gate is
active must still respect that earlier gate. Its zero value only affects the
message after it.

## Duration semantics and validation

The override accepts a `duration` value. Until duration typing is implemented, a
finite bare number is also accepted and means seconds, matching ADR 0016
blocking-wait semantics.

```tease
say(text: "One", wait: 250 ms)
say(text: "Two", wait: 1.5 s)
say(text: "Three", wait: 2 min)
say(text: "Four", wait: 0.5 h)
say(text: "Five", wait: 2) // exactly two seconds
```

Exact elapsed-time units are `ms`, `s`, `min`, and `h`. Calendar durations such
as days or months are not accepted for transcript pacing.

Validation rules:

- a statically provable negative duration is a compile error;
- a statically provable wrong type is a compile error;
- a dynamic wrong type or negative result is a structured runtime failure;
- `NaN`, positive or negative infinity, unsupported magnitude, and deadline
  overflow are rejected;
- a range is not an exact pacing duration and is rejected;
- fractional milliseconds remain valid for an explicit override;
- no arbitrary product maximum is added below the accepted technical numeric
  boundary;
- the message event and its newly established gate form one atomic runtime
  transition: if the next deadline cannot be represented, no `say` event is
  emitted and no partial pacing state is committed.

Diagnostic codes and exact TypeScript type names are implementation details for
the later implementation issue. The static/runtime boundary above is normative.

## One transcript channel

All core transcript `say` output shares one runtime-owned pacing channel:

- narrator output;
- output using the current default speaker;
- `say as` output;
- call-style output using `as:`;
- output before and after a default-speaker change.

A speaker change does not reset, shorten, or create another gate. Speaker name,
avatar, title, style, and Standard UI layout do not contribute pacing units.

All Standard UI variants that render the same runtime transcript observe the
same channel state. A compact view, expanded view, mobile layout, or alternative
visual transcript may not create a different canonical deadline.

The following are excluded unless a later accepted API explicitly maps them to
the transcript `say` event:

- button labels and choice labels;
- popup and system-notification text;
- image captions and media overlays;
- custom-view or package-TypeScript DOM output;
- developer warnings, diagnostics, and runtime errors;
- accessibility-only labels not present in the runtime `say` text;
- typewriter, fade, or other player-only animation timing.

## Final-text measurement

### Measurement boundary

Pacing is calculated from the exact final plain text that the runtime will place
in the `say` event after:

1. normal expression evaluation;
2. interpolation;
3. deterministic visible-list selection;
4. scalar visible-text conversion;
5. any deterministic runtime-owned localization or formatting that changes the
   emitted text.

Source syntax, interpolation delimiters, hidden metadata, speaker presentation,
and markup not present in the final plain event text are not counted. The player
must not use DOM `innerText`, layout, font metrics, wrapping, CSS, or animation
frames to calculate the canonical delay.

The final text and selected speaker are materialized once. Random visible-list
selection consumes the deterministic RNG once even when the message later waits
or is restored from a checkpoint.

### Unicode rule

One pacing unit is one Unicode code point in the final text. A conforming
TypeScript implementation can count this with code-point iteration such as a
`for...of` loop or `Array.from(text).length`.

Consequences are explicit:

- ordinary BMP characters count as one;
- a supplementary-plane emoji represented by one code point counts as one;
- a flag made from two regional-indicator code points counts as two;
- a base letter plus combining mark counts as two;
- a variation selector counts as one;
- a zero-width joiner counts as one;
- a multi-code-point family emoji counts as all of its component code points;
- spaces, tabs, carriage returns, line feeds, and other whitespace code points
  each count as one;
- a CRLF pair counts as two because both code points are present;
- the empty string counts as zero.

Physical source newlines folded to a space under V30 string rules are already one
space in final text. Explicit `\n` or `\r` escapes become actual code points and
are counted as present.

This rule is intentionally simpler than user-perceived grapheme segmentation.
It avoids a new dependency and avoids browser/Node differences in Unicode data
used by native `Intl.Segmenter`. A later change to grapheme clusters would be an
observable pacing change and requires a new accepted decision plus migration and
cross-environment tests.

### Automatic duration

For `N` code points:

```text
automaticDurationMs = ceil(N * 1000 / 17)
```

The result is an integer number of milliseconds and never shorter than the
17-units-per-second rate. Examples:

```text
0 code points  -> 0 ms
1 code point   -> 59 ms
17 code points -> 1000 ms
18 code points -> 1059 ms
```

The implementation must calculate and validate this without unsafe-integer or
finite-number overflow. Explicit author durations retain their accepted
fractional-millisecond value; the whole-millisecond ceiling applies only to the
automatic calculation. A browser scheduler may wake later than an exact deadline,
but the runtime compares the supplied observation with the canonical deadline.

## Runtime state and deadline ownership

### Compared models

#### Persist only a transcript-channel deadline

A deadline is sufficient between messages, but by itself it cannot represent the
ADR-0016 `waiting` state, action identity, request/completion events, settlement,
or checkpoint-safe continuation once execution reaches a gated `say`. A hidden
special-case wait would duplicate the pending-action model and is rejected.

#### Create only an action when the next gated `say` is reached

The action can represent waiting, but the runtime still needs to remember the
channel availability between the earlier emitted message and the later `say`.
Without persisted channel state, reload or checkpoint restore would forget the
gate. This model alone is insufficient.

#### Persist both the channel deadline and an identical action deadline

This can work with an equality invariant, but it stores two canonical copies of
the same time. Corruption or partial mutation can make them disagree. Naive
duplicate storage is rejected.

### Selected transfer-of-ownership model

The conceptual snapshot adds one field:

```text
transcriptPacingDeadlineMs:
    finite non-negative number | null
```

Its meaning is:

- a number is the canonical earliest session time at which the next transcript
  `say` may emit;
- a fresh snapshot initializes it to `currentSessionTimeMs`;
- `null` is valid only while the foreground action is a
  `presentationDelay`; in that state the action's absolute `deadlineMs` is the
  sole canonical deadline.

Ownership transfers atomically:

```text
channel owns deadline
    -> gated say reached
    -> create presentationDelay with that deadline
    -> set transcriptPacingDeadlineMs to null
    -> action owns deadline
```

When the action completes:

```text
action owns deadline
    -> persist effective currentSessionTimeMs
    -> set transcriptPacingDeadlineMs to currentSessionTimeMs
    -> settle and remove action
    -> continuation later emits prepared say
```

The prepared `say` then replaces the available channel value with its own new
next-message deadline. At no valid boundary do the channel field and action both
store the same canonical deadline.

This field is pacing state, not transcript history. Earlier `say` events and UI
messages remain outside the core snapshot under ADR 0015.

## Prepared message and continuation

When execution reaches a `say`, the runtime evaluates and validates these values
once in normal source order:

- explicit or contextual speaker identity;
- final visible text, including RNG-backed list selection;
- explicit override or automatic duration;
- the new post-emission deadline.

If the existing channel is unavailable, the runtime stores a bounded JSON-safe
prepared-message payload associated with the foreground action and its explicit
continuation. Conceptually it includes:

```text
final text
resolved speaker identity or narrator marker
calculated next-gate duration
source span
continuation/result location required to emit exactly once
```

It contains no callback, DOM node, browser object, promise, closure, class
instance, or suspended call stack.

Completion stores or exposes the prepared payload to the explicit continuation
before removing the action. The later continuation emits that exact message. It
does not re-run interpolation, reselect a list item, re-resolve the speaker, or
re-evaluate `wait`.

The exact compiler instruction split and temporary field names are deferred to
the implementation issue. The observable once-only evaluation and emission rule
is not deferred.

## Runtime transitions and event ordering

### Immediate message

When the channel is available at `currentSessionTimeMs`:

1. evaluate and materialize the message once;
2. calculate and validate its next-gate duration and absolute deadline;
3. persist `transcriptPacingDeadlineMs` to that deadline;
4. emit one sequenced `say` event;
5. continue normal execution according to the selected runtime entry point.

The fresh session's first `say` is therefore immediately eligible.

An explicit `wait: 0` or automatic zero duration persists the current session
time as the channel deadline. It allocates no action ID, settlement, or action
event for the next message when that next message is reached at the same effective
time.

### Gated message

When a `say` is reached before the channel deadline:

1. evaluate and materialize the pending message once;
2. validate the prepared payload and future next-gate duration;
3. atomically transfer the existing channel deadline to a foreground
   `presentationDelay` action;
4. allocate the action ID and store its explicit continuation;
5. set status to `waiting`;
6. emit ordinary `actionRequested` after the snapshot is valid;
7. emit no `say` event for the pending message;
8. stop normal execution.

Unrelated instructions placed between the earlier emitted `say` and this later
`say` have already executed without delay. Instructions after the gated `say`
wait because execution has reached the statement whose emission cannot yet
complete. An author who wants all instructions immediately after the earlier
message to wait places an ordinary blocking `wait` there instead.

### Time observation and completion

ADR 0016 time observation remains authoritative:

```text
effectiveNow = max(currentSessionTimeMs, suppliedNow)
currentSessionTimeMs = effectiveNow
```

If the presentation deadline is not due, the action remains unchanged and no
event is emitted. When it is due:

1. restore the channel-owned value to `effectiveNow`;
2. store the canonical settlement and make the prepared continuation eligible;
3. remove the action and restore status `running`;
4. emit one sequenced `actionCompleted`;
5. return without emitting the message in the same completion mutation.

The next ordinary runtime entry executes the continuation, emits the prepared
`say`, and establishes that message's next deadline. Event order is therefore:

```text
earlier say
unrelated events, when produced
presentation actionRequested
presentation actionCompleted
later say
```

All event sequence numbers and action IDs remain monotonic and are never reused
after restore.

### Runtime entry points

- `executeInstruction(...)` executes one planned boundary and may return a
  `say` or `actionRequested` event.
- `stepToEvent(...)` stops at the first visible event. After an initial `say`, a
  later call may execute unrelated instructions before stopping at the gated
  message's `actionRequested`.
- `run(...)` may continue through an immediately emitted `say` and unrelated
  instructions, but stops when the gated `say` changes status to `waiting`.
- the time-observation operation may emit `actionCompleted` but never executes
  the prepared `say` continuation in the same mutation;
- a subsequent `executeInstruction(...)`, `stepToEvent(...)`, or `run(...)`
  emits the prepared message.

## Checkpoint and restore

A checkpoint may be taken in three pacing-relevant states:

1. after an emitted `say`, while the channel owns a future deadline;
2. while a later prepared `say` is waiting in a `presentationDelay` action;
3. after `actionCompleted` but before the prepared continuation emits.

Restore validates and preserves the exact state. It does not:

- replay an earlier `say`;
- replay `actionRequested`;
- read a clock;
- re-evaluate text, speaker, RNG selection, or override;
- settle a due deadline;
- emit the prepared later message.

After restore, the player submits an explicit time observation. A lower supplied
value cannot lower `currentSessionTimeMs` or extend the channel/action deadline.
Uninterrupted and JSON-round-tripped restored execution must produce identical
runtime events, event sequences, action IDs, selected text, speaker identity,
and final snapshot.

The player transcript remains UI state outside the core runtime snapshot. The
player is responsible for restoring previously displayed transcript content by
its own accepted UI/session persistence boundary; the runtime only guarantees
that already emitted messages are not emitted again.

## Validation invariants

Version-4 pacing validation, when implemented, must reject at least:

- a missing, non-finite, negative, unsupported-magnitude, or overflowing channel
  deadline;
- `transcriptPacingDeadlineMs == null` without an active foreground
  `presentationDelay`;
- a `presentationDelay` while the channel field still contains a number;
- a presentation deadline on another time coordinate;
- an action deadline earlier than its valid creation coordinate;
- an invalid or unrepresentable calculated next-gate duration;
- a malformed or non-JSON-safe prepared message;
- an unresolved or invalid speaker reference;
- a continuation that can replay, skip, or emit the message twice;
- a prepared payload whose owning instruction, call frame, scope, or temporary
  no longer exists;
- an invalid status/action combination;
- duplicate or reused action/event identities;
- raw host, DOM, callback, timer, promise, or browser state.

External plan, snapshot, checkpoint, time, action, and settlement data remain
subject to the existing bounded stable-capture, nesting, and work limits.

## Required tests

The implementation issue must add deterministic source-to-runtime, state-machine,
validator, checkpoint, and resume-equivalence tests. Tests use explicit time
observations or a fake clock and never sleep in real time.

### Syntax and validation

- existing `say expression` remains accepted;
- existing `say as speaker expression` remains accepted;
- positional `say(text)` is accepted;
- named `text`, `as`, and `wait` forms are accepted;
- positional and named arguments cannot mix;
- second positional argument, duplicate names, unknown names, and missing text
  are rejected;
- bare numeric override means seconds;
- exact elapsed units and fractional milliseconds are accepted;
- static and dynamic wrong, negative, non-finite, range, unsupported-magnitude,
  and overflowing durations follow the specified boundary.

### Pacing behavior

- two consecutive automatic `say` statements;
- `say`, several unrelated instructions, then another `say`;
- an ordinary blocking `wait` contrasted with the transcript-only gate;
- explicit override shorter and longer than automatic pacing;
- explicit `wait: 0` and an automatically empty message;
- `wait: 0` still respecting a gate established by the previous message;
- exact-deadline eligibility and a wake observation after the deadline;
- narrator, default speaker, explicit `say as`, named `as:`, and speaker changes
  sharing one channel;
- Standard UI variants observing the same canonical channel;
- excluded output APIs not reading or modifying transcript pacing state.

### Final-text calculation

- interpolation is counted after final conversion;
- an eligible visible list is selected exactly once and the selected text is
  counted;
- empty text;
- spaces, tabs, explicit line feeds, carriage returns, and CRLF;
- physical source-newline folding;
- BMP text and supplementary code points;
- flags, combining sequences, variation selectors, zero-width joiners, and
  multi-code-point emoji;
- hidden metadata or future markup excluded from final plain text;
- automatic whole-millisecond ceiling at 0, 1, 17, and 18 code points;
- explicit fractional milliseconds retained unchanged.

### Events, checkpoints, and identity

- first eligible `say` emits before its deadline is used by a later message;
- gated message emits `actionRequested` and no premature `say`;
- early observation leaves the action pending;
- due observation emits `actionCompleted` before the later `say`;
- checkpoint while the channel owns a deadline;
- checkpoint while the later `say` is gated;
- checkpoint after completion and before continuation;
- restore never replays the earlier message or request event;
- lower time observation after restore cannot move time backwards;
- action ID and event sequence monotonicity;
- duplicate completion returns the same bounded settlement without another
  event or message;
- malformed ownership-transfer states are rejected;
- uninterrupted and restored execution are completely equivalent;
- no real-time sleeping, browser timer, or hidden callback is used.

## Alternatives considered

### Make every `say` a blocking wait

Rejected. It delays captures, buttons, images, assignments, and all other later
instructions even when only transcript spacing is desired. Authors already have
ordinary blocking `wait` for that behavior.

### Pace only in the player

Rejected as the canonical model. A player-only timeout is not checkpoint state,
can be lost on reload, can diverge between Standard UI variants, and cannot
provide deterministic runtime ordering or resume equivalence.

### Schedule a hidden browser timer after every message

Rejected. Browser timers may be useful wake-up hints, but callback identity and
remaining delay are not canonical state. The runtime accepts explicit time
observations against persisted deadlines.

### Allocate an action for every emitted message

Rejected. The first message does not wait for anything. Allocating a foreground
or background action after every message adds IDs, settlements, and events when
no gated `say` is present.

### Separate channel per speaker

Rejected. Speaker changes would permit messages to bypass one another, Standard
UI ordering would depend on speaker identity, and the state would grow with
speaker count. One transcript has one pacing channel.

### UTF-16 code units

Rejected. It is easy to obtain with JavaScript `.length` but counts a single
supplementary Unicode code point as two. Code-point iteration is nearly as simple
and produces a more stable author-facing rule.

### Extended grapheme clusters through `Intl.Segmenter`

Not selected. Grapheme clusters better approximate perceived characters, but
native segmentation depends on runtime Unicode data and browser support/version.
That weakens cross-environment determinism unless the implementation pins and
tests an exact segmentation algorithm.

### Add a grapheme dependency

Not selected for this slice. A dependency would add code size, updates,
maintenance, supply-chain review, and security surface. The code-point rule uses
standard language behavior and needs no dependency. A future owner-approved
change must compare maintained libraries, Unicode version pinning, bundle impact,
security history, and migration behavior.

### Store both channel and action deadline

Rejected as duplicate canonical state. The transfer-of-ownership model retains
one deadline at every valid boundary.

## Dependency and implementation sequence

Design work may be reviewed in parallel with issue #66, but implementation may
start only after:

1. issue #66 has merged the version-4 pending-action foundation and blocking
   `wait` slice; and
2. this ADR has been explicitly accepted by the owner.

Chat pacing is then the proposed second foreground use of ADR 0016. It does not
include blocking-wait implementation, timers, camera/media work, the final
cross-origin host protocol, or browser E2E framework selection.

## Owner decisions required before acceptance

The owner must explicitly approve or revise:

1. the call-style API, especially named `as:` and the rejection of a second
   positional argument;
2. Unicode code-point counting rather than extended grapheme clusters;
3. ordinary public `actionRequested` and `actionCompleted` events for the
   otherwise non-visible presentation delay;
4. the transfer-of-deadline-ownership state model.

Until that approval, this ADR remains Proposed and no production syntax,
runtime, checkpoint, player, or format change is authorized.

## Explicitly deferred details

The following remain implementation or later-design details:

- exact parser AST node and instruction names;
- exact TypeScript snapshot/action property names, provided the ownership and
  validation semantics remain unchanged;
- diagnostic code allocation and final message wording;
- final cross-origin host message envelopes and capability negotiation;
- player wake-up implementation and lifecycle scheduling;
- transcript persistence outside the core runtime snapshot;
- typewriter, fade, or other visual animation;
- future localization pipeline design;
- browser E2E framework selection;
- any later migration from code points to pinned grapheme segmentation.

## Consequences

- Existing command-style source remains valid but gains deterministic pacing
  once this proposal is accepted and implemented.
- Unrelated work before a later gated `say` remains immediate.
- A gated message becomes explicit, inspectable, checkpoint-safe foreground
  state instead of a hidden timer.
- Final text and RNG selection are evaluated exactly once.
- One transcript channel gives stable ordering across narrator, speakers, and UI
  variants.
- Unicode code-point counting is simple and dependency-free but may pace complex
  emoji more slowly than a grapheme-cluster rule.
- Action events make the timing boundary externally observable and preserve ADR
  0016 ordering and idempotency.
- The runtime snapshot gains pacing state only with the version-4 implementation;
  current version-3 formats and code remain unchanged by this documentation PR.
