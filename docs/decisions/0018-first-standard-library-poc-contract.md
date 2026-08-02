# ADR 0018 — First Standard Library POC contract

**Status:** Accepted  
**Issue:** #75

## Context

ADR 0017 accepts the boundary between deterministic engine primitives, the public Platform Standard Library, package libraries, and privileged platform adapters. ADR 0016 accepts one shared resumable pending-action model. Issue #66 implemented its first vertical slice as compiler-owned blocking `wait`. Issue #74 implemented exact opaque library identities and deterministic TypeScript metadata tooling, but deliberately did not add `.tease` linkage, runtime library execution, Standard Library APIs, or checkpoint library data.

The next POC needs one implementation contract for ordinary chat output and basic foreground interactions. It must not introduce separate state machines, suspended TypeScript calls, an implicit latest library, a final package format, or a second runtime model.

The owner explicitly extended the issue discussion to decide that the normal Player application has no player-facing pause control. This does not decide browser-unavailability, reload, reconnect, device-sleep, or server-authoritative time policy.

This ADR was accepted as documentation and design. Its generic foreground-interaction runtime is now partially implemented. The implementation uses an owner-approved short canonical result handoff: completion atomically commits a typed result into prepared ordinary runtime state and records one nullable single-use authority until the first canonical consume, transfer, return, discard, or exit instruction succeeds. The record is then removed immediately, while bounded `lastSettlement` remains replay data only. This implementation choice preserves the ADR's typed completion, event ordering, checkpoint, restore, and later-normal-entry requirements without restoring a long-lived lifecycle or whole-plan liveness analysis.

## Decision summary

1. The first blocking Standard Library implementation slice is `showButton`, `askText`, `askNumber`, and `choose`.
2. All four helpers use one generic typed foreground-interaction primitive.
3. `say` plus deterministic smart autoplay is the next implementation slice after those interactions.
4. Compiler-owned `wait` remains a core path and is not wrapped by the Standard Library in this POC.
5. Camera, files, media, background timers, persistence, custom UI, and LLM interpretation are excluded.
6. The Platform Standard Library is an automatic default prelude. Its selected names are directly callable, protected from ordinary script shadowing, and cannot be disabled or replaced in the first POC.
7. The selected resumable Standard Library behavior is fully lowered into versioned JSON-safe plan instructions. Restore never resolves against an implicit latest library.
8. The first POC uses one Standard chat target with stable optional speaker provenance. Broader involved-speaker and conversation identity remain deferred.
9. `askText`, `askNumber`, `choose`, and `showButton` are mandatory foreground interactions. They cannot be cancelled and do not return `null`.
10. Interaction definitions and completions are bounded, typed, JSON-safe data. Over-limit data is rejected deterministically without truncation or partial state mutation.
11. The Standard Player application uses one focused chat composer for typed answers. Choice controls may render as buttons or a dropdown without changing semantics.
12. Valid answers and choice/button activations become player-authored transcript messages.
13. `say` uses account-configured smart autoplay by default, supports exact seconds, `0`, and `instant`, and supports speaker defaults plus per-message `skippable` or `unskippable` overrides.
14. Every positive pacing gate is one ADR 0016 pending action. It begins as background work and may become the foreground action when it blocks a prepared later `say`.
15. A skippable pacing gate may be completed by a primary click or tap inside the player iframe viewport, or by Space while the focused composer is empty. Skip completes only the pacing gate.
16. The normal Player application has no player-facing pause control. Developer mode may provide Run, Step, Pause, checkpoint, and debugger controls.
17. A later deterministic speaker-aware typing indicator is desired but excluded from this POC.

## Scope and sequencing

Implementation is split into two ordered slices.

### Slice A — basic foreground interactions

```text
showButton
askText
askNumber
choose
```

This slice establishes the generic interaction action, bounded completion validation, checkpoint/restore behavior, Standard UI reconstruction, transcript integration, and compact source forms.

### Slice B — `say` and smart autoplay

This slice composes author-facing pacing policy above minimal typed text output while preserving current visible output, speaker behavior, source evaluation order, deterministic RNG use, and checkpoint behavior.

The two slices share this contract but should remain separate implementation issues and pull requests when they can be reviewed independently.

## Standard Library availability and name ownership

The first POC Platform Standard Library is available without an explicit import. Ordinary `.tease` scripts call the selected names directly.

The selected Standard Library names are protected from ordinary declarations and accidental shadowing. Importing an unrelated package library may not silently replace them.

The first POC does not support:

- disabling the default Standard Library prelude;
- replacing Standard Library exports;
- package-local or published community-library import syntax;
- namespaces for the selected Standard Library names;
- community-library-to-community-library dependencies;
- a final manifest, lockfile, semver, or package identity format.

Those remain explicit later decisions. Alternatives must eventually be configured visibly rather than obtained through name collisions.

## Deterministic lowering and binding

All selected first-POC behavior is fully lowered during compilation into versioned JSON-safe engine instructions and data. No ordinary TypeScript call remains suspended while waiting for time or player input.

Consequences:

- a fresh session compiles against the then-current compatible compiler and Standard Library behavior;
- an existing session continues with its original immutable compiled plan;
- a running or restored session does not update when the compiler or Standard Library later changes;
- account pacing settings captured for the session do not change during that session;
- the current self-contained POC checkpoint retains its exact plan and snapshot;
- restore rejects a missing, malformed, incompatible, or non-matching plan through the existing structured plan/checkpoint boundary;
- no checkpoint migration is supported by this POC;
- issue #74's opaque library token and metadata shapes are not placed in plan/checkpoint data and do not become a permanent package format through this decision.

Later synchronous utility libraries may use exact runtime library binding where appropriate. That does not change the full-lowering choice for these resumable first-POC helpers.

## Source forms

### Speaker modifier

The selected interaction forms support an optional requesting speaker:

```tease
let answer = askText as mistress "Enter text"
let amount = askNumber as mistress "Enter a number"
let choice = choose as mistress yes: "Yes", no: "No"
showButton as mistress "Ready"
```

Without `as`, the form uses the current contextual or default speaker. When no speaker is available, narrator/system provenance is represented without inventing a speaker.

The speaker identifies who requested the answer or acknowledgement. Control text is not automatically emitted as a speaker chat message.

### `askText`

```tease
let answer = askText
let answer = askText "Type here"
let answer = askText as mistress
let answer = askText as mistress "Type here"
```

The optional text is Standard UI field text or a hint. It is not a transcript question. The ordinary pattern is:

```tease
say as mistress "Tell me your name."
let name = askText as mistress "Type your name"
```

Omitting the hint uses a localized Standard UI default. An explicit empty string requests no visible hint while the control still receives an accessible name.

Completion rules:

- normalize `CRLF` and standalone `CR` line endings to `LF`;
- otherwise preserve the submitted text exactly;
- do not automatically trim leading or trailing whitespace;
- do not change case or apply Unicode normalization;
- reject input consisting only of whitespace according to the engine's versioned whitespace classification;
- return the normalized `string` and use that same normalized text for the player-authored transcript message.

### `askNumber`

```tease
let amount = askNumber
let amount = askNumber "Enter a number"
let amount = askNumber as mistress
let amount = askNumber as mistress "Enter a number"
```

Completion rules:

- input is submitted as text and must contain no line break;
- leading and trailing whitespace is removed before parsing;
- the remaining text uses the accepted TeaseScript decimal and scientific-number forms, including an optional unary `+` or `-`;
- locale decimal commas, thousands separators, units, and natural-language number phrases are not accepted by the deterministic first POC;
- the parsed result must be finite;
- negative zero is returned as canonical numeric `0`;
- the function returns `number`;
- the player-authored transcript preserves the trimmed submitted number text rather than reformatting it with JavaScript number-to-string conversion.

The first POC adds no minimum, maximum, integer-only, or other domain-range parameters. Authors perform domain validation explicitly after completion.

### `choose`

`choose` is the author-facing TeaseScript construct. `choice` is the noun used for the internal interaction/action kind and for an individual choice group.

Unlabelled compact choices return visible text:

```tease
let result = choose "Bratty", "Very submissive"
let result = choose as mistress "Bratty", "Very submissive"
```

Labelled compact choices return the authored label:

```tease
let result = choose bratty: "Bratty", submissive: "Very submissive"
let result = choose as mistress first: "Mystery", second: "Mystery"
let result = choose 1: "Open the door", 2: "Walk away"
```

Rules:

- all compact options belong to one statement;
- options are comma-separated;
- labelled and unlabelled options may not be mixed;
- identifier labels and finite numeric-literal labels are supported to preserve accepted V30 capability;
- one labelled `choose` uses one label type: identifier labels and numeric labels may not be mixed;
- identifier labels return `string`; numeric labels return `number`;
- labels must be unique;
- numeric-label uniqueness is based on numeric value, so `1` and `1.0` are duplicates;
- labelled choices may repeat visible text because selecting a rendered control supplies one exact label;
- unlabelled choices may not repeat visible text because that text is both the typed match and return value;
- manually submitted text uses exact visible-text matching without trimming, case folding, locale matching, or Unicode normalization;
- when repeated visible text makes manual submission ambiguous in a labelled choice, the typed attempt is invalid and the player must select a rendered control;
- fuzzy or natural-language matching is not part of deterministic completion.

A labelled button or dropdown selection submits the selected label to the engine. An unlabelled control submits the selected visible text. The engine validates it against the active action, derives the canonical visible text from the stored choice option, writes that visible text as the player-authored transcript message, and returns the label or visible text to the script. The Player application does not supply an independent canonical transcript string.

This compact syntax supersedes the V30 split between labelled `{...}` and unlabelled `[...]` choice bodies. The question itself is normally a preceding `say`; compact `choose` has no prompt argument.

### `showButton`

```tease
showButton "Continue"
showButton as mistress "Ready"
```

The first POC form displays one blocking button and has no useful script return value, timeout, or cancellation path. It completes only when the player activates the button.

The completion identifies the active button action. The engine derives the canonical player-authored transcript text from the stored button label; the Player application does not provide replacement transcript text.

Accepted V30 timeout and elapsed-time behavior is not rejected. It is deferred to a later advanced `showButton` extension and is not part of the first implementation slice.

### `say`

The compact grammar is:

```text
say [as speaker] [skippable | unskippable] text [, pacing]
```

Examples:

```tease
say "Normal smart autoplay"
say as mistress "Normal smart autoplay"
say unskippable "Read every word."
say as mistress skippable "You have seen this before."
say "Exactly five seconds", 5
say as mistress unskippable "Wait five seconds before the next message.", 5
say "Immediate", 0
say "Immediate", instant
```

Pacing values mean:

- omitted: account-configured smart autoplay;
- positive finite number: exact pacing gate in seconds; fractional seconds are permitted;
- `0`: immediate output with no resulting gate;
- `instant`: readable alias for `0`;
- negative, non-finite, unsupported-magnitude, or deadline-overflow values: structured error before partial gate creation.

`0` and `instant` also settle and bypass an earlier active pacing gate so the current message is actually immediate.

## Bounded interaction data

Interaction definitions, Standard UI payloads, choice collections, text completions, and host messages must remain within versioned platform string, collection, message, plan, snapshot, checkpoint, nesting, and validation-work limits.

ADR 0018 does not impose separate product-facing character counts on `askText`, hint text, button labels, or choice text. The implementation slice must select concrete shared limit constants before merge and test them across compiler, runtime, Player application, checkpoint, and host-message boundaries.

Required behavior is fixed:

- no silent truncation, clamping, or partial collection acceptance;
- over-limit author data fails compilation or plan validation as appropriate;
- over-limit completion data receives a structured rejection;
- an invalid or over-limit completion does not mutate the action, result, transcript, RNG, event sequence, or continuation;
- the same mandatory interaction remains active after a rejected player attempt.

These are technical safety limits against uncontrolled memory, validation, storage, rendering, and transport work. They are not recommendations that ordinary UI labels should approach the technical maximum. The editor may provide earlier non-blocking usability warnings for unusually long labels or unusually large choice sets.

## Generic typed foreground interaction

The engine uses one discriminated foreground interaction family rather than independent pending-action machinery for each helper.

Conceptually each active interaction contains enough JSON-safe data for:

```text
kind: button | text | number | choice
stable action identity
owning and continuation instruction positions
result destination when applicable
expected result type
validated Standard UI payload
allowed choice labels and visible text when applicable
output target
optional requesting speaker identity
accessible-name data or localized default key
```

The engine owns action identity, active state, expected type, completion validation, result storage, transcript-result derivation, events, checkpoint/restore, idempotency, and structured rejection. The Standard Library and compiler own compact author syntax, defaults, presentation-oriented payload construction, and friendly diagnostics.

Completion messages conceptually contain only the data needed for the active kind:

```text
askText or askNumber:
    actionId
    submittedText

choose through typed input:
    actionId
    submittedText

labelled choose control:
    actionId
    selectedLabel

unlabelled choose control:
    actionId
    selectedText

showButton:
    actionId
```

Exact cross-origin property names remain a host-protocol decision. The semantic payload above is fixed.

A completion with a wrong action ID, wrong kind, invalid type, non-finite number, whitespace-only required text, unknown label, unknown visible value, ambiguous typed choice, or over-limit payload does not mutate the action or continuation. The same interaction remains active and Standard UI provides localized validation feedback.

Retries are built into the interaction contract. An ordinary author does not need to write a retry loop merely because the player submitted invalid input.

## Mandatory completion and pause policy

`askText`, `askNumber`, `choose`, and `showButton` are permanently non-cancellable public interactions:

- they never complete with `null`;
- closing or hiding a control does not complete it;
- invalid input does not complete it;
- package exit or fatal runtime/player failure is cleanup or failure, not an author-visible cancelled value;
- a future `showButton` timeout is normal timeout completion, not cancellation.

The normal Player application has no player-facing pause control and TeaseScript gains no author-facing pause command through this decision. Developer mode may expose Pause alongside Run, Step, checkpoint, restore, and debugger controls. Developer pause is tooling and does not establish player-initiated pause semantics.

Reload or reconnect resumes the exact validated saved state. Time behavior during browser unavailability, reload, reconnect, device sleep, or visibility changes remains a separate lifecycle/time-integrity decision.

## Standard chat composer and choice presentation

The Standard Player application uses one fixed composer area at the bottom of the chat.

During a foreground interaction:

- the transcript remains visible;
- the existing composer becomes the answer field;
- ordinary free-chat submission is blocked;
- choice and button controls appear immediately above the composer;
- the answer field receives focus by default so the player can type without first clicking it.

The Player application dynamically chooses how a `choose` interaction is presented. Buttons may occupy one or two rows. When the available viewport, text lengths, font metrics, zoom, accessibility settings, or other layout constraints make that presentation impractical, the same choices may render as a dropdown. Exact breakpoints and measurement rules remain a Player UI decision.

Button-versus-dropdown presentation is not canonical runtime or checkpoint state. Restoring the same action on another viewport may select another presentation while preserving the same labels, visible texts, completion validation, transcript output, and return value.

Valid `askText` and `askNumber` submissions are represented as player-authored transcript messages using their normalization rules while the engine stores the typed return value.

For `choose`, selecting a button or dropdown entry:

1. supplies the exact stored label for a labelled choice or exact stored text for an unlabelled choice;
2. lets the engine derive and append the exact visible option text as the player's transcript message;
3. completes the pending action for that option;
4. returns its label or visible text to the script.

Typing an exact unambiguous visible choice has the same completion effect.

For `showButton`, activating the button appends its stored visible text as the player's transcript message and completes the pending action. For example:

```tease
say as mistress "Tell me when you are ready."
showButton as mistress "Ready"
```

produces a player message equivalent to `Ready` when the control is activated.

Control labels and field hints are UI payload. They do not become duplicate speaker messages merely because they are associated with a requesting speaker.

## Text-output provenance

The first POC uses one Standard chat target. The engine event and interaction payload still carry an explicit validated target identity supplied by the compiler/Standard Library.

`speakerId` is optional:

- a declared/current/default speaker uses its stable runtime speaker ID;
- narrator or system output uses no invented speaker ID.

Output and foreground interactions use the same target-and-speaker provenance concept. A broader involved-speaker collection and a separate `conversationId` are not required for this POC and remain deferred until LLM context partitioning is designed.

Terminology:

- **player**: the human;
- **Player application** or **player iframe**: the software interface;
- **engine**: the deterministic runtime.

## Smart-autoplay duration

A fresh session captures these account settings into deterministic session configuration:

```text
baseDelayMs
delayPerWordMs
delayPerCharacterMs
```

Each setting is a non-negative JavaScript safe integer representing whole milliseconds. Missing settings use the platform defaults. A present invalid, fractional, negative, non-finite, or unsafe value causes a structured session-configuration error; it is not silently clamped or replaced.

Platform defaults are:

```text
baseDelayMs = 1500
delayPerWordMs = 300
delayPerCharacterMs = 30
```

Smart-autoplay duration is:

```text
delayMs =
    baseDelayMs +
    max(
        wordCount * delayPerWordMs,
        visibleCharacterCount * delayPerCharacterMs
    )
```

`wordCount` counts maximal non-whitespace sequences. `visibleCharacterCount` counts Unicode code points in the final visible string after expression evaluation, interpolation, escape processing, deterministic list selection, and ordinary source-string newline folding.

All counts, multiplication, addition, and deadline construction use checked arithmetic. A non-finite, unsafe, unsupported-magnitude, or overflowing result fails structurally before an action ID, partial gate, or settlement is created. Integer smart-autoplay settings require no rounding.

There is no additional product reading-time cap or automatic clamp. “No maximum duration” remains subject to ADR 0016's technical numeric-magnitude and deadline-overflow boundaries.

Changing account settings does not alter an active or restored session. The exact captured values are retained with the session/checkpoint state required to reproduce its gates.

When the calculated duration is `0`, the message creates no pacing action, action ID, settlement, `actionRequested`, or `actionCompleted` event.

## Pacing gate as an ADR 0016 action

A positive pacing gate is one pending-action kind conceptually named `chatPacingGate`. It uses ADR 0016 action identity, absolute deadline, active-first lookup, typed completion, bounded `lastSettlement`, event sequencing, checkpoint/restore, and continuation rules. It is not a second hidden pacing state machine.

The first POC has at most one active pacing gate because it has one Standard chat target.

### Initial message and background gate

A normal or positive-duration `say` evaluates its speaker, text, pacing, and skip policy once in normal source order.

When no earlier gate blocks it:

1. emit the text-output event;
2. when the resulting duration is positive, allocate and store one `chatPacingGate` in `backgroundActions` with its absolute deadline and skip policy;
3. emit `actionRequested` for that gate;
4. continue unrelated non-blocking execution.

The text-output event precedes `actionRequested`. Both state changes occur at one atomic instruction boundary; no checkpoint may contain the emitted text without the positive gate that the same instruction established.

### A later `say` becomes foreground-blocked

When execution reaches a later normal or positive-duration `say` while the background pacing gate remains active:

1. evaluate the later speaker, final text, pacing, skip policy, and deterministic RNG selections once;
2. store that prepared output and its continuation in JSON-safe state;
3. atomically move the same gate from `backgroundActions` to `foregroundAction` without changing its action ID or deadline;
4. set runtime status to `waiting`;
5. stop normal execution.

The move does not emit a second `actionRequested`; the action was already requested when first created. The accepted invariant remains:

```text
status == waiting
if and only if
foregroundAction != null
```

When that gate settles, `actionCompleted` is emitted before continuation. A later normal runtime entry emits the prepared text exactly once and establishes its next positive gate when applicable. Prepared text and RNG results are never reevaluated after waiting or restore.

### Time completion

`observeTime(...)` may settle a due pacing gate while it is background work or while it is the foreground action blocking prepared output. It uses the same persisted `currentSessionTimeMs` and absolute-deadline semantics as `wait`.

When one time observation settles multiple timed actions, deterministic ordering is:

1. ascending `deadlineMs`;
2. ascending action ID for equal deadlines.

Each settlement emits its own sequenced `actionCompleted`. Continuations do not execute inside the observation mutation.

### Player skip completion

A primary click, tap, or eligible Space key submits a typed completion for the active `chatPacingGate` action ID.

- a skippable active gate settles normally with a skip settlement;
- an unskippable gate rejects the attempt without state mutation;
- active foreground/background lookup occurs before settled, stale, or unknown classification;
- a duplicate matching current `lastSettlement` returns `alreadySettled` without another event, output, RNG change, or continuation;
- a foreground skip makes its prepared-output continuation eligible only for a later runtime entry.

Skip settles only the pacing gate. It does not skip arbitrary instructions, cancel input, complete `wait`, or create a player transcript message.

### Consumption by a foreground interaction

When execution reaches `showButton`, `askText`, `askNumber`, or `choose` while a pacing gate remains active as background work, one atomic instruction transition:

1. settles the pacing gate with a typed `consumedByForegroundInteraction` settlement;
2. removes it from `backgroundActions` and updates bounded `lastSettlement`;
3. emits `actionCompleted` for the gate;
4. creates the new interaction as the sole `foregroundAction`;
5. sets status to `waiting`;
6. emits `actionRequested` for the interaction.

Event order is therefore:

```text
actionCompleted(chatPacingGate)
actionRequested(interaction)
```

No checkpoint may expose an intermediate state with neither the old gate nor the new interaction.

### `instant` and `0`

When `say ..., 0` or `say ..., instant` executes while a pacing gate remains active as background work, one atomic instruction transition:

1. settles the old gate with a typed `supersededByInstantOutput` settlement;
2. emits `actionCompleted` for the old gate;
3. emits the current text-output event;
4. creates no new gate.

If an earlier gate is already the foreground action blocking a prepared `say`, ordinary source execution cannot reach another `say`; the player or time must settle the foreground gate first.

### Interaction with `wait`

`wait` does not consume a pacing gate. A valid future snapshot may therefore contain:

```text
foregroundAction: delay
backgroundActions: [chatPacingGate]
status: waiting
```

A time observation may settle either or both according to deadline and action-ID ordering. The continuation after the foreground delay runs only during a later normal runtime entry.

For:

```tease
say as mistress "One"
wait 1
say as mistress "Two"
```

actual separation is the longer of the remaining `say` gate and the explicit one-second wait. The two durations are not automatically added.

Player-authored messages do not create `say` pacing gates. No compiler lookahead across branches, calls, or loops is used; only the path actually executed matters.

## Skippable and unskippable gates

A speaker may define:

```text
defaultSaySkippable: boolean
```

This presentation default belongs with other speaker presentation settings such as display styling, color, avatar, and font selection. It does not change the player's reading-speed settings.

Effective skip policy is:

- explicit `skippable`: allow player completion of this gate;
- explicit `unskippable`: forbid player completion of this gate;
- no modifier: use the effective speaker's `defaultSaySkippable`;
- no applicable speaker setting: use platform default `true`.

A skippable gate may be completed by:

- a primary pointer click anywhere inside the player iframe viewport, including its background or unused space;
- a primary touch activation;
- Space when the focused Standard chat composer is empty.

An actual interactive control has priority. Activating a control must not also be interpreted as a viewport-wide pacing skip.

The composer is focused by default. Keyboard behavior is:

- ordinary character and number keys enter text;
- Space completes a skippable gate only when the composer is empty;
- when the composer already contains text, Space is ordinary input;
- Space does not skip during text composition, while a relevant text selection is active, or while focus is on another interactive control;
- no click, tap, or Space completion is accepted for an unskippable gate.

## Event, checkpoint, and restore requirements

The implementation must preserve ADR 0015 and ADR 0016:

- action, prepared-output, captured-setting, and pacing state is JSON-safe and fully reconstructable;
- output and action events remain typed and sequenced;
- a pending interaction or pacing gate survives a JSON checkpoint round trip;
- restore does not read a browser clock, silently settle time, or re-evaluate source expressions;
- the Player application submits explicit time observations and typed action/gate completions;
- duplicate completion delivery follows the bounded settlement model;
- invalid completion attempts do not mutate canonical state;
- continuation execution occurs through a later normal runtime entry after settlement;
- implementation must explicitly version every plan, snapshot, and checkpoint schema change needed to permit populated background actions and the new action kinds.

Exact internal TypeScript property names and plan instruction layout remain implementation decisions, provided they satisfy this contract and the existing versioned validation boundaries.

## Accessibility

Every Standard UI text field, number field, choice group, and button must have a programmatic accessible name.

The Standard Library/Player application derives it from sufficient visible control text or from a localized default such as:

```text
Answer
Number
Choose an option
Continue
```

An explicit empty visual hint does not remove the required accessible name. Accessibility labels are not automatically emitted as transcript messages.

The exact advanced author-override field is deferred. A later custom UI library that replaces Standard UI remains responsible for an equivalent accessible name; missing accessibility data must produce a development diagnostic or validation failure rather than an unnamed control.

## Deferred LLM interpretation

The deterministic first POC does not depend on an LLM. A later optional adapter may receive bounded structured context and propose:

- one currently allowed choice label or visible option;
- one finite number;
- or `needsClarification`.

The engine remains authoritative and validates the proposal against the active action. The LLM cannot mutate canonical state, select an unavailable choice, cancel a mandatory interaction, or bypass an unskippable gate. Exact prompt assembly, privacy, provider, retry, and author-option policy remain deferred.

## Relationship to accepted V30 syntax

This ADR accepts these scoped post-V30 changes:

- add compact `as speaker` forms for `askText`, `askNumber`, `choose`, and `showButton`;
- add compact command-expression forms for `askText` and `askNumber`;
- replace the V30 labelled-body versus unlabelled-list `choose` split with one comma-separated compact form;
- retain identifier and numeric labels from accepted V30 capability;
- extend `say` with `skippable`, `unskippable`, exact seconds, `0`, and `instant`;
- define field text as Standard UI hint/label data rather than automatic transcript output.

The broader parenthesized V30 input APIs are not rejected merely because the first POC implements compact forms first. Their advanced options and compatibility mapping remain later work.

V30 `showButton` timeout and elapsed-time return remain accepted future capability but are outside this first implementation slice.

## Follow-up implementation boundaries

Implementation should be split into small issues, at minimum:

1. **Default prelude and lowering boundary** — reserve selected names, add parser/semantic support for compact forms, and lower them without final package import syntax.
2. **Generic foreground interaction runtime** — add the typed action union, shared concrete platform limits, completion validation, transcript derivation, checkpoint/restore, events, and deterministic resume tests.
3. **Basic Standard Library interactions and Standard UI** — implement `showButton`, `askText`, `askNumber`, and `choose`, dynamic button/dropdown presentation, composer integration, transcript behavior, accessibility defaults, and playground acceptance examples.
4. **Smart-autoplay runtime and `say` composition** — implement validated captured account settings, `chatPacingGate`, background-to-foreground promotion, prepared output, exact/instant modes, speaker skip defaults, click/tap/Space completion, wait interaction, event ordering, and resume-equivalence tests.
5. **Editor metadata and diagnostics** — add completion, signature/hover guidance, compact-syntax formatting, duplicate/mixed-choice diagnostics, pacing diagnostics, bounded-data diagnostics, usability warnings, and protected-name diagnostics.
6. **Vertical POC acceptance coverage** — demonstrate compile, run, invalid retry, over-limit rejection, checkpoint, JSON round trip, restore, transcript rendering, dynamic choice presentation, and deterministic completion across the selected APIs.

The implementation issues must inspect the then-current plan/snapshot versions and explicitly version every schema change. They must not reuse issue #74's internal token as an accidental permanent package identity.

## Deferred work

This ADR intentionally defers:

- `showButton` timeout and elapsed-time return;
- detailed result objects containing elapsed time or metadata, and the option name that selects such a return type;
- advanced parenthesized call forms and richer input/choice options;
- custom input hints for compact `choose`;
- exact concrete platform limit values, which must be selected and tested by the implementation slice before merge;
- the exact advanced accessibility-override field;
- LLM implementation and author-facing interpretation options;
- invalid-attempt transcript-retention policy beyond the rule that rejected attempts do not mutate canonical transcript state;
- a deterministic speaker-aware typing indicator before message emission, including its duration formula, syntax, speaker settings, checkpoint state, and interaction with smart autoplay;
- exact button-row/dropdown layout breakpoints and measurement algorithms;
- multiple chat targets and independent pacing gates;
- involved-speaker collections, conversation identity, LLM context assembly, memory, summaries, and model selection;
- camera, files, image input, media, custom views, background timers, and permanent buttons;
- final package manifests, imports, lockfiles, community dependency resolution, Standard Library replacement, and migration policy;
- browser-unavailability, reload, reconnect, device-sleep, and visibility-change time-integrity policy;
- author recovery-point rollback.

A player-facing pause command is not deferred; it is excluded by this accepted contract. Developer pause remains tooling.

## Consequences

### Benefits

- one action model supports the first four interactions;
- common scripts use compact syntax without imports or repeated retry loops;
- completion normalization and transcript derivation are deterministic;
- the chat composer remains visually stable while choice presentation adapts to the viewport;
- pacing uses the accepted pending-action model instead of hidden state;
- pacing is deterministic, account-adjustable, speaker-aware, checkpoint-safe, and optionally skippable;
- mandatory author interactions cannot silently return cancellation values;
- plans remain self-contained and do not depend on an implicit latest library;
- future LLM interpretation can be added as a constrained adapter without becoming canonical state authority.

### Costs and risks

- several post-V30 compact forms require parser/compiler work rather than metadata-only library exports;
- click-anywhere and Space-to-advance require careful event precedence, input-method, and accessibility testing;
- concrete bounded-data constants must be selected from implementation evidence and kept consistent across boundaries;
- account pacing values become deterministic session inputs that must be persisted correctly;
- populated background actions and background-to-foreground gate promotion require explicit schema versioning and adversarial validation tests;
- prepared delayed output must preserve source evaluation and RNG results across checkpoint/restore;
- the first POC deliberately does not solve final library packaging, advanced input options, or multi-conversation provenance.
