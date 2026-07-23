# TeaseScript V30 → V31 Gap and Conflict Review

**Status:** Working review document  
**Primary authority:** `accepted-syntaxes-v30.md`  
**Purpose:** Identify which previously discussed capabilities are already present in V30, which are still missing, and which V30 semantics deserve reconsideration before the parser/runtime POC.

V30 wins when it conflicts with older proposals unless this document gives a concrete technical reason to reconsider it.

---

## Status legend

- **Resolved by V30** — V30 already contains a sufficiently developed decision.
- **Partly resolved by V30** — the main capability exists, but relevant behavior or API is still missing.
- **Missing from V30** — previously discussed or architecturally required, but absent from V30.
- **Reconsider V30** — V30 contains a concrete semantic problem that is likely to cause implementation or authoring issues.
- **Proposed for V31** — a V30-aligned addition awaiting Peter's confirmation.
- **Post-POC** — relevant later, but not required for the first parser/runtime proof of concept.

---

# 1. Executive result

## 1.1 Real V31 syntax gaps

The three large syntax/API gaps previously selected for review are still genuinely missing:

1. **Custom views**
2. **Rich module metadata and module selection**
3. **TeaseScript linkage to TypeScript libraries**

A fourth confirmed capability is also absent:

4. **`set` as a unique collection type**

## 1.2 Areas substantially resolved by V30

V30 should replace the older proposals for:

- date, time, `datetime`, `duration`, storage and scheduling syntax;
- the default-speaker setter and richer character model;
- ordinary random values, chance, random integers and deterministic RNG;
- image layers, overlay positioning, movement, blur, drawings and transitions;
- typed storage defaults;
- account access, account changes, locks, toys, history and cross-script data;
- exact expression precedence, units, conversions and parser token rules.

## 1.3 Areas only partly resolved

V30 contains adjacent systems but does not yet fully cover:

- continuous-personality lifecycle and official runtime objects;
- server/offline event semantics;
- resource ownership across `call`, `run`, `end` and `goto`;
- complete media pause/resume controls;
- weighted selection, shuffle and sampling helpers;
- the implementation decision for the expression engine.

---

# 2. Reconciliation of earlier review topics

| Earlier topic | V30 status | Conclusion |
|---|---|---|
| Custom views | **Missing** | Add a V30-style API in V31. |
| Module metadata and rich selection | **Missing** | V30 only has path/glob selection and reserves `available when`. |
| TypeScript-library linkage | **Missing** | Architecture exists, but `.tease` import/call syntax does not. |
| Continuous personalities | **Partly resolved** | Account/history/locks are extensive; lifecycle, assignments, reports and runtime queue concepts remain absent. |
| Media resources | **Mostly resolved** | Keep V30's visual-layer design; add only controls proven necessary. |
| Math expressions | **Syntax resolved; implementation open** | V30's own grammar should lead. Math.js should not define TeaseScript syntax. |
| Date/time/duration | **Resolved by V30** | Keep V30, with a few edge-case clarifications later. |
| Default speaker | **Resolved by V30** | `speaker existingIdentifier` is accepted. |
| Random helpers | **Partly resolved** | Core random operations exist; weighted/shuffle/sample helpers remain optional Standard Library work. |
| `list` and `set` | **List resolved; set missing** | Restore the confirmed `set` capability in V31. |

---

# 3. Custom views

## 3.1 Current state

**Status: Missing from V30**

The package architecture and accepted ADR 0012 require:

- a blocking custom view that returns a result;
- a background custom view that returns a handle;
- update and close operations;
- serializable boundary data;
- runtime-owned cleanup and save/resume metadata.

The old accepted syntax is incompatible with V30:

```tease
set result = show custom view "view-id" with { ... }
open custom view "view-id" as handle with { ... }
update handle with { ... }
close handle
```

Problems:

- V30 rejects assignment with `set`;
- V30 normally declares returned handles with `let`;
- V30 increasingly exposes engine APIs as camelCase protected built-ins;
- generic `update` and `close` names are too broad.

## 3.2 Option A — Function API aligned with V30

**Status: Proposed for V31**

Blocking custom view:

```tease
let result = showCustomView(
    view: "punishment-wheel",
    data: {
        title: "Choose your fate",
        options: punishments
    }
)
```

Without input data:

```tease
showCustomView(view: "instructions")
```

Background custom view:

```tease
let panel = openCustomView(
    view: "status-panel",
    data: {
        points: points,
        edges: edgeCount
    }
)

updateCustomView(
    view: panel,
    message: {
        type: "stateChanged",
        points: points,
        edges: edgeCount
    }
)

closeCustomView(panel)
```

### Why this now fits better than our older statement proposal

V30 already uses:

```tease
showImage(...)
showBlur(...)
moveOverlay(...)
animateOverlay(...)
askAccountChange(...)
getPlayerHistory(...)
```

Custom views are another typed engine API. The function form therefore matches V30 better than adding four multiword grammar statements.

### Required protected built-ins

```text
showCustomView
openCustomView
updateCustomView
closeCustomView
```

No new grammar keyword is required.

## 3.3 Option B — Multiword statement syntax

```tease
let result = show custom view "punishment-wheel" with {
    title: "Choose your fate"
}

let panel = open custom view "status-panel" with {
    points: points
}

update view panel with {
    points: newPoints
}

close view panel
```

This remains readable, but it now conflicts with V30's general move toward camelCase engine functions. It also adds grammar solely for one advanced library capability.

**Current recommendation:** use Option A.

## 3.4 Update behavior

Three meanings are possible:

1. Replace the complete original data object.
2. Merge supplied properties into previous data.
3. Send a typed message defined by the TypeScript view.

**Proposed for V31:** send a typed message.

```tease
updateCustomView(
    view: panel,
    message: {
        type: "pointsChanged",
        points: points
    }
)
```

Reasons:

- no hidden shallow/deep merge rules;
- the TypeScript export can define and validate message variants;
- messages can represent actions as well as state;
- save/resume can record the exact message sequence.

## 3.5 Blocking result

The blocking view waits until the view closes:

```tease
let result = showCustomView(
    view: "punishment-wheel",
    data: {
        options: punishments
    }
)

say `You selected ${result.selected}.`
```

The result must contain only supported boundary values:

- strings;
- booleans;
- integers and numbers;
- `null`;
- lists;
- sets converted through a defined boundary representation;
- plain serializable objects;
- accepted typed values such as `date`, `datetime`, `duration` or unit values when their serialization is defined.

Not allowed:

- functions;
- promises;
- DOM nodes;
- cyclic objects;
- arbitrary class instances;
- active runtime handles inside serialized results.

Cancellation should be part of the registered result type. A view that permits cancellation may return `null`; one that does not permit cancellation should not unexpectedly return `null`.

## 3.6 Background interaction

### Option A — Display-only background views in the first POC

The view can display and animate data but cannot asynchronously run TeaseScript handlers. Interactive custom flows use `showCustomView(...)`.

Advantages:

- no second concurrent interaction flow;
- simpler deterministic replay;
- simpler save/resume;
- no event ordering or interruption problem.

### Option B — Background view events

This eventually requires:

- event IDs and typed payloads;
- event queue ordering;
- handler ownership;
- interruption rules;
- behavior after `call`, `run`, `end` and reconnect;
- save/resume of pending events.

**Recommendation:** display-only background views for the first POC. Design typed background events together with the general runtime event queue later.

## 3.7 Proposed ownership

A view belongs to the execution frame that opened it:

| Operation | Proposed result |
|---|---|
| Normal function call | Existing view stays open |
| Local `goto` | Existing view stays open |
| Caller executes `call "child.tease"` | Caller's view stays open |
| Called child reaches `end` | Views opened by the child close |
| `run "next.tease"` | Views owned by the abandoned frame close |
| `exit` | Every view closes |
| `closeCustomView(handle)` | Only that view closes |

This execution-frame model should eventually be shared by timers, permanent buttons and media handles.

## 3.8 Remaining custom-view decisions

- Confirm function API versus multiword statements.
- Confirm `data` and `message` field names.
- Define how TypeScript registers the quoted view ID.
- Define generated input/update/result types and editor autocomplete.
- Decide save/resume: replay messages, snapshot hooks, or both.
- Decide whether views may use `set` values directly across the boundary.
- Decide when background view events enter scope.

---

# 4. Module metadata and rich module selection

## 4.1 Current state

**Status: Missing from V30**

V30 supports:

```tease
call "punishments/strict.tease"
call "punishments/*.tease"
run "endings/*.tease"
```

A glob chooses one random matching file. It cannot express:

- tags;
- availability;
- weights;
- time cooldown;
- recent-history avoidance;
- tag exclusion;
- an explicit empty-result policy.

`available when` is only reserved, not executable.

## 4.2 Metadata: recommended file-level form

**Status: Proposed for V31**

One `.tease` file contains at most one executable content module. Optional metadata appears at file scope before executable statements:

```tease
module {
    tags: ["punishment", "anal"]
    weight: 5
    cooldown: 7 days

    available when account.preferences.anal.frequency > 0 and
        player.punishmentPoints >= 2
}

say "You have earned an anal punishment."
end
```

### Why this follows V30

- V30 already uses block configuration without commas for speakers, timers and permanent buttons.
- `available when` is already reserved for this kind of metadata.
- Duration literals already define time cooldowns.
- The module body remains ordinary top-level TeaseScript.
- Metadata remains beside the content instead of in a second manifest file.

### Proposed metadata meanings

```text
tags
weight
cooldown
available when
```

- `tags`: list of package search labels.
- `weight`: positive selection weight among otherwise suitable modules.
- `cooldown`: time-based exclusion after selection.
- `available when`: one boolean expression evaluated against the allowed selection context.

Do not add unrequested metadata such as title, author, role or description to this language block until the package/catalog model needs it.

## 4.3 Recent-history versus cooldown

These are different:

```tease
cooldown: 7 days
```

excludes the module for a time duration.

```tease
avoidRecent: 4
```

asks a selector to avoid the last four selected modules in that history scope.

Both may be useful and should not be collapsed into one ambiguous number such as `cooldown: 3`.

## 4.4 Selector option A — Extend `call` and `run` with a module block

**Status: Proposed for V31**

Returning selection:

```tease
call module {
    from: "modules/punishments"
    includeTags: ["punishment", "anal"]
    excludeTags: ["public"]
    avoidRecent: 4
    fallback: "error"
}

say "The selected punishment has ended."
```

Non-returning selection:

```tease
run module {
    from: "modules/endings"
    includeTags: ["ending"]
    fallback: "error"
}
```

This preserves V30's existing control-flow distinction:

- `call module` returns after the selected file reaches `end`;
- `run module` abandons the current execution path.

### Advantages

- clear control-flow behavior;
- no module-reference value required;
- matches V30 configuration-block style;
- one operation performs collection, filtering, weighted choice and execution.

### Disadvantages

- adds `module` as a grammar keyword;
- selector output cannot be inspected before execution;
- exact fallback labels need specification.

## 4.5 Selector option B — `selectModule(...)` returns a module reference

```tease
let selected = selectModule(
    from: "modules/punishments",
    includeTags: ["punishment", "anal"],
    avoidRecent: 4
)

call selected
```

### Advantages

- the selected metadata can be inspected;
- selection and execution are independently testable;
- a script may display or log the selected module first.

### Disadvantages

- `call` and `run` must accept a new module-reference type;
- more programmer-like;
- two statements for the common case;
- handling `null`/fallback becomes visible in every script.

**Current recommendation:** Option A for normal authoring. A lower-level `selectModule(...)` may still exist later for advanced use.

## 4.6 Candidate selection algorithm

1. Resolve modules from `from`, tags, or both.
2. Reject modules whose `available when` expression is false.
3. Reject modules still under time cooldown.
4. Apply `includeTags` using AND semantics by default.
5. Apply `excludeTags`.
6. Apply `avoidRecent` within the defined history scope.
7. Apply positive `weight`.
8. Select with the deterministic session RNG.
9. Record candidates, exclusions, weights, seed and selected module.
10. Execute with `call` or `run` semantics.
11. Apply the explicit fallback when no candidate remains.

The engine must never silently ignore requirements or cooldown merely to find something.

## 4.7 Decisions still needed

- Does `from` include subfolders?
- May selection use tags without `from`?
- Is `includeTags` always AND, and how is OR expressed?
- What history scope does `avoidRecent` use?
- Is `weight` an integer or any positive number?
- What happens when `available when` reads unavailable server data?
- Which fallback forms exist?
- Can a selected module return a value to `call module`?
- Is every `.tease` file a module, or only files with `module {}` metadata?
- Does `main.tease` permit a `module` metadata block?

---

# 5. TypeScript-library linkage

## 5.1 Current state

**Status: Missing from V30**

Already accepted outside V30:

- `.ts` libraries are programming logic, not content modules;
- normal TypeScript named exports form the public API;
- non-exported helpers remain private;
- tooling generates signatures, docs and autocomplete;
- libraries run inside the sandboxed player iframe;
- package code has no unrestricted external network access.

V30 says advanced developers may extend through TypeScript libraries, but it does not define how `.tease` references one.

## 5.2 Option A — Explicit namespace import

**Status: Proposed for V31**

```tease
import "libraries/punishment-math.ts" as PunishmentMath

let count = PunishmentMath.calculateCount(
    points: player.punishmentPoints,
    multiplier: 1.5
)
```

### Advantages

- dependency visible at the top of the script;
- exports grouped under one clear namespace;
- avoids function-name collisions;
- ordinary calls remain ordinary V30 function calls;
- `call` remains reserved for `.tease` scripts.

### Disadvantages

- adds `import` as a grammar keyword;
- path/dependency resolution needs definition;
- `as` gains another grammar use, although V30 already reserves it.

## 5.3 Option B — Automatically exposed namespaces

```tease
let count = PunishmentMath.calculateCount(points)
```

No import is written.

Advantages:

- less syntax.

Disadvantages:

- hidden dependencies;
- namespace conflicts;
- unclear package/version source;
- worse static analysis;
- adding a dependency can silently change name resolution.

## 5.4 Option C — Import selected exports

```tease
import {
    calculateCount,
    calculateDifficulty
} from "libraries/punishment-math.ts"
```

This is familiar to TypeScript developers but less aligned with TeaseScript's beginner-oriented syntax and creates more unqualified name collisions.

**Current recommendation:** Option A.

## 5.5 Import rules proposed for V31

- imports occur at file scope before executable statements;
- package-local paths cannot escape the package;
- aliases must be unique in the file;
- the imported library must be declared in package dependencies where applicable;
- published dependencies use stable package identifiers and versions;
- imports do not grant network/device/account privileges;
- normal named exports are generated automatically from TypeScript;
- a `.ts` file is never selectable by `run`, `call` glob or module selection.

## 5.6 Function categories for the POC

### Immediate exports

Safe initial POC boundary:

```tease
let result = Library.calculateSomething(input)
```

These exports:

- complete during the current engine step;
- return supported typed values;
- do not expose promises to TeaseScript;
- do not hold resumable workflow state on the JavaScript call stack.

Suitable uses:

- calculations;
- validation;
- formatting;
- filtering;
- building plain objects;
- deterministic algorithms.

### Runtime-managed exports

Long-running work includes:

- waits;
- media;
- timers;
- user interaction;
- custom views;
- workflows that survive pause/resume.

These must be represented through engine-managed actions, handles or serializable plans. A raw JavaScript promise or suspended function stack is not sufficient.

**POC recommendation:** implement immediate exports first. Let official engine APIs own waits, timers, media and custom views. Add general author-defined action plans only after the basic runtime state model works.

## 5.7 Boundary types still needed

Define exact mapping for:

- `integer` versus JavaScript `number`;
- `date`, `time`, `datetime` and `duration`;
- unit values;
- list copy semantics;
- `set`;
- optional values;
- plain objects;
- engine-managed local media references;
- error propagation.

---

# 6. Continuous personalities

## 6.1 What V30 genuinely resolves

**Status: Partly resolved by V30**

V30 now contains extensive concrete design for:

- read-only account data;
- blocking account changes;
- account locks and hardcore/permissive modes;
- current state versus append-only history;
- account-backed toys;
- script-global and cross-script data;
- checkpoints;
- current and completed duration activities;
- history queries;
- server-confirmed account mutations;
- chastity scheduling concepts.

This is substantially more developed than the older generic proposal and should lead.

## 6.2 What is still absent

The older architecture requires official runtime concepts that V30 does not yet define:

### Lifecycle entrypoints

Examples:

```text
firstStart
startup
dayStart
wake
sleep
away
return
```

There is no accepted syntax such as:

```tease
on wake {
    ...
}
```

### Assignments/jobs

An assignment is not ordinary variable assignment. It is a server-tracked task with:

- stable ID/key;
- status;
- creation time;
- deadline;
- reminders;
- completion/failure/cancellation;
- consequence/reward;
- history.

V30 account history can store results, but does not define the live assignment object or API.

### Reports

A report is structured submitted information, potentially including:

- multiple answers;
- confession text;
- evidence/media references;
- requested/received timestamps;
- review state.

`askText` plus `save` can emulate simple reports, but does not create a standard interoperable report subsystem.

### Flags with expiration

Normal `save` can hold a boolean, but an official expiring flag also needs:

- expiry processed while browser is closed;
- history;
- source/owner;
- scheduler integration;
- querying active/expired state.

### Personality status/mode

Account hardcore/permissive mode is account policy. A personality status such as `"strict"`, `"playful"` or `"angry"` is a different package-specific runtime state with entry/exit behavior and history.

### In-world permission requests

This is distinct from:

- browser camera/microphone permission;
- `askAccountChange(...)`.

It represents an ongoing consensual rule or authority permission inside the personality model.

### Priority queue and resource claims

V30 defines timer/button handlers, but not the general runtime queue needed when several personality events become actionable simultaneously.

## 6.3 Recommendation

Do not force all of these into V31 merely for the parser POC.

For the POC:

- retain ordinary storage, scheduling and account/history APIs;
- design the runtime execution-frame and event model correctly;
- defer official assignment/report/lifecycle APIs until the basic scheduler is proven.

However, do not mark continuous personalities as fully resolved. V30 resolves much of the data domain, not the complete runtime model.

---

# 7. Media reconciliation

## 7.1 Resolved by V30

V30 now has a stronger author-facing model than the old generic resource proposal:

- background image/color/video;
- multiple overlay images/videos with references;
- one top-level image;
- overlay movement and keyframes;
- blur;
- drawings;
- transitions;
- background audio handles;
- foreground blocking sound/video.

Keep this V30 model.

## 7.2 Still missing or unclear

- pause/resume for background audio;
- explicit stop/pause/resume for background and overlay video;
- whether replacing background video invalidates an old reference;
- ownership/cleanup on `call`, `run`, `end`, `goto` and reconnect;
- whether foreground playback can be paused and resumed;
- whether `showBackgroundVideo(...)` returns a reference;
- save/resume of active movement, transition and playback.

These are mostly runtime/API details, not reasons to replace V30's syntax with a generic `MediaHandle` author model.

## 7.3 POC recommendation

Implement the V30 slots/layers first:

- foreground sound/video;
- background visual slot;
- overlay references;
- top-image slot;
- background sound handles.

Internally, use one generic resource registry even when the public API remains media-specific.

---

# 8. Random and Standard Library helpers

## 8.1 Resolved by V30

```tease
random()
chance(25)
randomInteger(1..=6)
items.random
timer 5..10
call "modules/*.tease"
```

All use the deterministic session RNG.

## 8.2 Still missing but not necessarily keywords

Potential Standard Library additions:

```tease
let shuffled = items.shuffled()
let sample = items.sample(3)

let result = weightedChoice([
    { value: "light", weight: 5 },
    { value: "strict", weight: 2 }
])
```

Also potentially:

- random decimal within a range;
- seeded substreams when a subsystem needs isolated reproducibility;
- metronome helpers;
- reusable countdown helpers.

These should be functions/methods, not grammar keywords.

## 8.3 Control-flow milestone edge behavior (not accepted semantics)

The `feature/control-flow-runtime` implementation needs conservative behavior
where V30 does not yet fix an edge case. These choices are implementation notes,
not additions to accepted language semantics:

- descending integer ranges currently iterate zero times;
- an empty range passed to `randomInteger(...)` is a structured runtime error;
- range iteration and `randomInteger(...)` currently require safe integer
  bounds, while a range value itself may retain finite numeric bounds;
- negative, fractional, non-finite, or unsafe dynamic `repeat` counts are
  structured runtime errors; statically known negative or fractional counts are
  semantic errors;
- `chance(0)` and `chance(100)` still consume one value from the deterministic
  session RNG;
- `for` copies its list or set iteration source when the loop starts, so later
  mutation of the original collection does not change the active iterator.

These details should be reviewed before they are documented as permanent
language behavior.

---

# 9. Date, time and duration

## 9.1 V30 wins

**Status: Resolved by V30**

V30 incorporates and improves the old proposal:

- separate `date`, `time`, `datetime`, `duration`;
- long and short duration literals;
- exact elapsed units versus calendar-aware days/weeks/months;
- arithmetic and comparisons;
- localized visible output;
- explicit formatting;
- ISO/UTC/Unix conversion;
- typed storage;
- `askDate`, `askTime`, `askDateTime`;
- scheduling directly from `datetime`.

No older syntax should replace this.

## 9.2 Minor edge rules still worth defining

Not POC grammar blockers, but eventually specify:

- month-end behavior for `31 January + 1 month`;
- nonexistent local times during spring DST transition;
- ambiguous local times during autumn DST transition;
- application order of a duration containing both calendar and exact components;
- comparison and modulo rules for durations, if supported;
- exact formatting options and rounding of displayed durations;
- arithmetic involving `date` or `time` without `datetime`.

---

# 10. `set` collection

## 10.1 Current state

**Status: Missing from V30; capability previously confirmed by Peter**

V30 defines lists but not a unique collection type.

Intended semantic distinction:

- `list`: ordered, indexable, duplicates allowed;
- `set`: unique values, stable insertion order, not indexable by numeric position.

A duplicate insertion into a set does not create another entry.

## 10.2 Syntax is not yet recovered

The capability was confirmed, but a V30-compatible literal/type syntax is still needed.

Possible options:

### Option A

```tease
let names: set = [
    "pet",
    "puppy",
    "pet"
]
```

The element type is inferred. Result contains `"pet"` and `"puppy"`.

### Option B

```tease
let names: set<string> = [
    "pet",
    "puppy",
    "pet"
]
```

More precise, but introduces generic angle-bracket type syntax not otherwise used in V30.

### Option C

```tease
let names = toSet([
    "pet",
    "puppy",
    "pet"
])
```

Requires no special literal grammar, but makes `set` look like a conversion rather than a first-class collection.

This needs a fresh syntax decision. Do not claim that V30 already contains it.

Likely operations:

```tease
names.add("toy")
names.remove("pet")
names.contains("puppy")
names.clear()
names.length
names.first
names.last
names.random
names.toList()
```

Numeric indexing should be rejected:

```tease
names[0] // compile error for set
```

---

# 11. Expression engine and math.js

## 11.1 Earlier recommendation

The old proposal suggested using `math.parse()` as the expression parser with an allowlist.

## 11.2 Why V30 changes that recommendation

V30 now precisely defines:

- lexical numeric forms;
- units;
- property access;
- indexing;
- function calls;
- ranges;
- comparisons;
- word logical operators;
- precedence;
- associativity;
- strings, lists and objects;
- zero-based list semantics;
- protected built-ins.

Math.js has its own broader and partly incompatible expression language. Making it the parser would require rejecting or rewriting many valid math.js nodes while separately parsing TeaseScript-only nodes.

## 11.3 Revised recommendation

**Use the TeaseScript parser itself for the complete V30 expression grammar.**

Math.js may still be used internally for:

- unit definitions and compatible conversion;
- selected pure mathematical operations;
- numeric helpers where it adds value.

Do not let math.js determine accepted TeaseScript syntax.

Never use JavaScript `eval` or `new Function`.

This is a case where V30 should supersede the older implementation proposal.

---

# 12. V30 semantics worth reconsidering before the POC

These are not merely missing features. They are existing V30 rules with concrete implementation problems.

## 12.1 `call` removes caller timers and permanent buttons

V30 says a non-persistent timer/button is removed on `call`.

Example:

```tease
let timerId = startTimer 60 {
    goto tooLate
}

call "questions/check-progress.tease"
```

`call` returns to the caller after the child reaches `end`. Destroying caller-owned resources merely because a child was called is surprising and makes reusable sub-scripts unsafe.

**Recommended correction:**

- caller-owned resources survive a `call`;
- child-owned resources close when the child returns;
- resources are owned by execution frames.

This same rule is proposed for custom views.

## 12.2 Persistent handler with local `goto`

V30 allows:

```tease
let timerId = startTimer 30 {
    persist: true
    goto tooLate
}
```

but persistent timers survive `run` and `end`, while labels are local to the current script. After the owner script is abandoned, `tooLate` may no longer have an active frame.

Possible fixes:

1. Persistent handlers may not use local `goto`.
2. Persistent handlers retain and restore their owner execution frame.
3. Persistent handlers must call/run a stable script or emit a named runtime event.

**Current recommendation:** prohibit local `goto` from a handler that may outlive its owner frame.

The same issue applies to persistent permanent buttons.

## 12.3 `schedule` with local `goto`

V30 allows:

```tease
let eventId = schedule releaseTime {
    goto eveningScene
}
```

The accepted architecture says schedules may fire while the browser is closed and have explicit execution locations. A server event cannot jump to a local label in an inactive browser frame.

Recommended distinction:

- `startTimer`: session-local; local `goto` may be valid;
- `schedule`: persistent server-known event; handler must be server-safe or create/launch a stable client procedure/script when the player returns.

V30 still needs:

- execution location;
- missed-event policy;
- deduplication;
- pending-interaction behavior.

## 12.4 `run` and `end` selection flow

V30 states:

- `run` abandons the current path and does not return;
- when a run script reaches `end`, control returns to an active script-selection flow that may select another matching script.

That active selection flow is not defined. For a glob, it is unclear whether:

```tease
run "endings/*.tease"
```

selects exactly one file or starts a repeating pool.

**Recommended clarification:** one `run` performs exactly one selection and starts exactly one script. Its `end` ends that run chain unless another explicit engine/package flow was already defined.

## 12.5 `showButton` timeout result

V30 returns only elapsed time. At the exact timeout boundary, the caller cannot distinguish a click from timeout.

Possible correction:

```tease
let result = showButton(
    text: "Continue",
    timeout: 5 seconds
)

result.clicked
result.timedOut
result.elapsed
```

This is not essential for the parser POC, but the current result is semantically incomplete.

---

# 13. POC priority

## Required before or during the first POC

1. Preserve V30 grammar as the source of truth.
2. Implement execution-frame ownership.
3. Clarify `call`, `run`, `end` and resource cleanup.
4. Build the expression parser from V30 grammar.
5. Decide the role of math.js as math/unit backend rather than syntax parser.
6. Confirm `set` syntax if it belongs in the first POC.
7. Define TypeScript immediate-export linkage if the POC must demonstrate `.ts` libraries.
8. Define minimal custom-view API if the POC must demonstrate custom DOM UI.

## Can follow after basic parser/runtime proof

- rich module metadata and tag selection;
- background custom-view events;
- assignments/reports/lifecycle API;
- persistent offline event policies;
- full media pause/resume;
- action plans;
- weighted/shuffle/sample Standard Library;
- complete month/DST edge behavior.

---

# 14. Proposed V31 review order

1. **Execution frames and resource ownership**  
   This affects timers, buttons, custom views, media, `call`, `run`, save/resume and persistent handlers.

2. **`set` syntax**  
   Small language decision and previously confirmed capability.

3. **TypeScript import/linkage**  
   Needed to make advanced libraries and custom view registration real.

4. **Custom-view API**  
   Prefer the V30-aligned function API unless Peter chooses otherwise.

5. **Module metadata and selection**  
   Keep `call`/`run` semantics and add rich filtering separately.

6. **Persistent scheduler semantics**  
   Execution location, missed policy, pending interactions and stable handlers.

7. **Continuous personality Standard Library**  
   Lifecycle, assignments, reports, flags, status and permissions.

---

# 15. Decision table for the next discussion

| Decision | Current proposal | Status |
|---|---|---|
| V30 remains leading | Yes | Confirmed by Peter |
| Custom-view style | camelCase function API | Proposed |
| Background custom-view events in first POC | No | Proposed |
| Custom-view updates | typed messages | Proposed |
| Module metadata | file-level `module {}` | Proposed |
| Module execution selector | `call module {}` / `run module {}` | Proposed |
| TypeScript linkage | `import "path.ts" as Namespace` | Proposed |
| TS exports in first POC | immediate typed exports only | Proposed |
| `set` capability | required, syntax undecided | Confirmed capability / open syntax |
| Expression parser | own V30 parser | Proposed revision |
| math.js | optional math/unit backend | Proposed revision |
| Caller resources survive `call` | yes | Proposed correction |
| Persistent local `goto` | prohibit when owner can disappear | Proposed correction |
| One `run` selects one script | yes | Proposed clarification |

---

# 16. Reconciliation with the previous developer's post-POC backlog

**Source reviewed:** `TeaseScript_Post-POC_Development_Backlog.md`

**Interpretation:** The source defines the POC narrowly as a lexer/parser POC. Under that definition, its listed runtime, media, account and server topics do not block the parser POC. This does not mean they are all optional for a later executable runtime.

## 16.1 Open items accepted into the consolidated backlog

| Previous backlog item | Consolidated status | Relationship to this review |
|---|---|---|
| Camera and webcam API | Post-POC; partly present in V30 | V30 has `takePhoto()` and camera-capable input, but richer capture, permission, encryption, toy-photo and debug semantics remain open. |
| Official math functions | Post-parser POC; needed during interpreter/Standard Library work | Matches the open allowlist for `round`, `floor`, `ceil`, `abs`, `min`, `max`, `mean`, `median`, `sqrt`, and related protected built-ins. |
| `publishGlobal(...)` / `getGlobal(...)` contract | Post-POC server/API design | V30 fixes names and a minimum result shape, but overwrite/append, retention, filtering, types and script-family scope remain open. |
| Concurrent active script policy | Post-POC server/runtime policy | Newly added to the consolidated backlog. It affects locks, timers, history, save data and reconnect behavior. |
| Media lifecycle functions | Post-POC runtime/API design | Matches section 7 of this review. |
| Toy Standard Library helpers | Post-POC Standard Library | Newly added. These should be helpers rather than grammar. |
| Extend duration settings to toys | Future account-schema extension | V30 explicitly leaves this unaccepted for now. |
| Default dynamic name-list content | Product/content work | Fallback semantics are fixed; actual account defaults and migrations remain open. |
| Player-to-player interaction | Future product/server feature | Keep separate from basic typed global score/value publication because messages require moderation and abuse controls. |
| `available when` | Missing module suitability design | This is only one part of the larger module metadata and rich-selection gap. |
| Generic media controls | Later API decision | Matches the open pause/resume/stop design. |

## 16.2 Closed decisions adopted from the previous backlog

The following are treated as closed because they align with V30. Do not reopen them without a concrete new reason:

1. Default speaker setter remains:

```tease
speaker mistressVera
```

2. Timer, permanent-button and schedule blocks are inherently their handlers. Do not add `onClick`, `onFinish` or `onTrigger` wrappers.

3. Account changes are blocking and wait for the host/server result.

4. Do not add `useSpeaker`.

5. Do not use `set` as an assignment keyword:

```tease
score = 10
```

This decision is limited to assignment syntax. It does **not** reject `set` as the unique collection type previously confirmed by Peter.

6. Record values belong under derived statistics rather than a separate writable records-storage category.

7. Preferences use exactly `frequency` and `intensity`; do not add separate `interest` or `limit` fields.

8. Edge history is grouped per session rather than one history event per edge.

9. `schedule` accepts `datetime`; a technical timestamp string must first be converted with `toDateTime(...)`.

10. Do not add `cumSquirt`.

11. Do not add dynamic speaker pairs for unchanged words such as `frenulum`, `urethra` and `perineum`.

12. Use `strokerMasturbator`; do not add `strokerRubber`.

13. Scripts may disable a toy through an approved account change but may not permanently delete the toy record.

## 16.3 Important gaps not covered by the previous backlog

The previous backlog is useful but not complete. It does not cover these previously identified requirements:

- custom views;
- TeaseScript import/linkage syntax for TypeScript libraries;
- full module metadata and rich module selection beyond `available when`;
- the confirmed unique `set` collection;
- execution-frame ownership for timers, buttons, media and custom views;
- persistent-handler/local-`goto` conflicts;
- offline scheduler execution location and missed-event policy;
- continuous-personality lifecycle, assignments, reports, permissions, status and procedure queue;
- custom-view save/resume and background event handling;
- TypeScript boundary types and resumable action representation.

These remain in the consolidated V30→V31 review.

## 16.4 POC scope clarification

There are now two useful milestones:

### Parser POC

Contains only:

- lexer/tokenizer;
- parser;
- AST;
- source locations and diagnostics;
- parser tests.

It can prove that speaker declarations, `speaker mistressVera`, `say`, `say as`, strings and interpolation produce the expected AST.

No runtime behavior is proven.

### Speaker execution POC

Adds a minimal interpreter/event emitter for:

- speaker declarations;
- current default speaker;
- `say`;
- `say as`;
- temporary `speaker` context during interpolation;
- display-name resolution;
- `exit`.

This is needed to prove that speaker behavior works, not merely that the syntax parses.

The broad Phase 1 from the previous backlog—functions, all control flow, RNG, timers, inputs, units and date/time—is not required before this smaller speaker execution POC.

## 16.5 Revised post-POC sequencing

1. Parser POC.
2. Minimal speaker execution POC.
3. Core interpreter: variables, expressions, scopes, functions and control flow.
4. Execution frames and deterministic runtime actions.
5. TypeScript immediate-export linkage and Standard Library basics.
6. Timers, input and date/time.
7. Local media runtime, camera and custom views.
8. Typed storage, checkpoints and session recovery.
9. Account, toy, state, history and account changes.
10. Persistent scheduler and continuous-personality runtime.
11. Global/cross-script data, player-to-player features and distribution.

This is a planning sequence, not a new accepted architecture decision.
