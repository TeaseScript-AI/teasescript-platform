# Libraries and Standard Library

## Accepted direction

- Regular executable content uses `.tease`.
- Advanced reusable programming logic uses real TypeScript in `.ts`.
- `.ts` libraries are not randomly selected content modules.
- Normal TypeScript named exports are the accepted public-library direction.
- Package libraries execute inside the player sandbox and have no unrestricted external network access.

The temporary exact-token catalog, TypeScript-export extractor, external
metadata validator, and tooling facade have been removed. They had no selected
runtime, compiler, editor, or package consumer and do not constrain internal
TypeScript library code.

The exact `.tease` import/linkage syntax, package identity and versioning,
metadata format and transport, validation boundary, automatic export linkage,
and library-aware editor integration remain future consumer-driven work.
Ordinary runtime and Player startup paths do not import or bundle TypeScript
compiler tooling. Historical examples using the rejected procedure concept,
explicit ordinary-function invocation keywords, or procedure-based scheduling
are not authoritative.

## Accepted dependency model

ADR 0017 defines this dependency direction:

```text
TeaseScript scripts
    ├── call public Standard Library exports directly
    └── call optional package-library exports
            └── call public Standard Library exports

Public Standard Library
    └── documented typed engine primitives
```

A package library may import and reuse public Standard Library exports. It should not need to rebuild common behavior directly from engine primitives when a supported Standard Library function already provides it.

Package-library-to-package-library dependencies are not accepted by ADR 0017. Exact dependency declarations, transitive resolution, cycles, lock data, moderation, capability interaction, and version conflicts remain separate open decisions.

The Standard Library is platform-owned TypeScript distributed and versioned with the compatible engine/player. It may compose typed engine capabilities but may not bypass runtime validation, checkpointing, the player sandbox, or security boundaries.

## Accepted responsibility split

### Engine primitives

The engine retains behavior that must be canonical and security-relevant:

- instruction and runtime-state validation;
- pending-action identity and lifecycle;
- deterministic time and settlement;
- opaque engine-managed references;
- typed sequenced events;
- checkpoint, restore, cleanup, and resume equivalence;
- typed and bounded host/player data boundaries;
- stable speaker/output provenance required by runtime history;
- serializable continuations for workflows crossing pending-action or checkpoint boundaries;
- validation of the exact Standard Library identity/version required by a plan when behavior was not fully lowered into that plan.

### Standard Library

Candidate Standard Library behavior includes:

- author-friendly `say` policy and presentation defaults;
- standard text-output targets;
- common choice and input wrappers;
- visible and mystery timer presentation;
- friendly background-timer lifecycle wrappers;
- retries, validation helpers, formatting, and utility functions;
- reusable Standard UI workflows built from typed core capabilities.

ADR 0018 accepts the first concrete subset described below. Listing another candidate here does not make it implemented or accepted syntax.

### Resumability boundary

Ordinary TypeScript library code may run synchronously between engine instruction boundaries. It may calculate values, validate arguments, and call synchronous capabilities.

Library behavior that can wait for time, input, media, a background handler, or another pending result must not keep an ordinary TypeScript call suspended. It must either:

- be lowered into explicit versioned serializable engine instructions; or
- use an explicit versioned engine-managed serializable continuation.

Promises, callbacks, closures, generators, suspended JavaScript/TypeScript stacks, and hidden mutable module state are not canonical resume state.

### Public surface and privileged adapters

Package libraries may import only the public, capability-safe Standard Library surface.

Privileged platform adapters may exist internally for player integration or capability brokering, but they are separate modules and are not transitively exported. Calling a public helper must not grant access to internal host capabilities, the parent DOM, account cookies, raw browser objects, or unrestricted networking.

### Deterministic version binding

A plan/checkpoint must never restore against whichever Standard Library implementation is currently latest.

A conforming implementation must either:

- fully lower the relevant Standard Library behavior into the versioned instruction plan; or
- bind the plan/checkpoint to an exact compatible Standard Library identity/version and reject or explicitly migrate an incompatible restore.

The exact identity fields, compatibility ranges, packaging format, and migration schema remain open for behavior not covered by ADR 0018's full-lowering decision.

## Accepted first Standard Library POC contract

ADR 0018 selects this ordered author-facing sequence:

1. `showButton`, `askText`, `askNumber`, and `choose` on one generic typed foreground-interaction primitive;
2. `say` with deterministic smart autoplay and player-controlled gate completion.

`wait` remains compiler/core-owned. Camera, files, media, background timers, persistence, custom UI, and LLM interpretation are excluded.

### Default prelude

The first POC Platform Standard Library is automatically available without an import. Its selected direct names are protected:

```text
showButton
askText
askNumber
choose
say
```

Ordinary scripts may not shadow these names. The first POC has no default-prelude opt-out, replacement mapping, alternative Standard Library, or namespace requirement.

Published community libraries and package-local libraries still require a later explicit import and manifest decision. Importing another library must never silently change which Standard Library implementation a direct name resolves to.

### First-POC lowering choice

The selected resumable helpers are fully lowered into explicit versioned plan instructions and JSON-safe state. A checkpoint contains the original plan and does not perform runtime lookup against a current or `latest` Standard Library implementation.

The current implementation fully lowers the compact `showButton`, `askText`, `askNumber`, and `choose` forms plus the
ADR 0018 `say` pacing/skip slice into explicit versioned instructions and state. Dynamic interaction payloads are
prepared explicitly before suspension, and result-bearing forms consume the short canonical interaction handoff into
ordinary runtime state before later expression evaluation continues.

A new session may be compiled with a newer compatible Standard Library/compiler, but an active or restored session remains bound to its original plan and captured pacing configuration. No checkpoint migration is included.

ADR 0018 does not add package identity or metadata values to plans/checkpoints
and does not treat them as a final package or semver identity.

### Generic interaction wrapper family

The four blocking helpers share one engine action family with typed kinds equivalent to:

```text
button
text
number
choice
```

`choose` is the source construct; `choice` is the internal interaction noun.

The engine owns action identity, continuation, result destination, expected type, allowed values, completion validation, canonical transcript-result derivation, events, checkpoint/restore, and bounded duplicate settlement behavior. The Standard Library/compiler own author-facing defaults, compact syntax, Standard UI payload, localized feedback, and accessibility defaults.

The interactions are mandatory and permanently non-cancellable. `askText`, `askNumber`, and `choose` never return `null`; `showButton` has no useful first-slice return value. Invalid input keeps the same action active.

Interaction definitions and completions remain subject to justified platform guards; ADR 0018 defines no separate
author-facing counts. Under ADR 0019, tests verify rather than justify a retained bound. Retained guards reject
over-limit data without truncation or partial state mutation.

### Author-facing interaction semantics

`askText` normalizes line endings to `LF`, otherwise preserves submitted text exactly, rejects whitespace-only input, returns `string`, and uses that same normalized text in the player transcript.

`askNumber` trims surrounding whitespace, parses the accepted TeaseScript decimal/scientific forms on one line, returns a finite `number`, canonicalizes negative zero to `0`, and preserves the trimmed submitted number text in the transcript. It adds no first-POC range parameters.

`choose` returns visible text for unlabelled options. Labelled choices retain identifier and numeric labels from V30 capability. Identifier labels return `string`; numeric labels return `number`; one choice may not mix label types. Duplicate unlabelled visible text is invalid; labelled options may repeat visible text when their labels are unique.

A labelled button or dropdown control supplies its label to the engine; an unlabelled control supplies its visible text. The engine validates the selection and derives the canonical visible player-transcript text from the stored action. Manually typed choice input uses exact unambiguous visible-text matching.

`showButton` presents one button, blocks until activation, derives the player transcript from its stored visible label, and then completes. V30 timeout and elapsed-time behavior remains later work.

All four helpers support `as speaker` provenance. The speaker identifies who requested the answer. It does not automatically emit the control text as a speaker message.

### `say` composition

`Say` remains compact official syntax, but ADR 0018 moves pacing policy into a fully lowered Standard Library/compiler composition above typed text output.

Supported pacing is:

```text
omitted -> smart autoplay
positive number -> exact seconds
0 -> immediate
instant -> alias for 0
```

Positive explicit durations may be fractional. Invalid, non-finite, unsupported-magnitude, or overflowing values fail before partial gate creation.

Supported per-message skip modifiers are:

```text
skippable
unskippable
```

Without a modifier, `say` uses the effective speaker's `defaultSaySkippable` presentation setting and otherwise platform default `true`.

Smart autoplay captures non-negative safe-integer millisecond account values `baseDelayMs`, `delayPerWordMs`, and `delayPerCharacterMs` when the session starts. Defaults are `1500`, `300`, and `30`. Duration is:

```text
baseDelayMs + max(
    wordCount * delayPerWordMs,
    visibleCharacterCount * delayPerCharacterMs
)
```

All arithmetic and deadline construction is checked. There is no extra product reading-time cap, but ADR 0016 numeric and deadline limits still apply. Account changes do not modify an active or restored session.

A positive gate is an ADR 0016 `chatPacingGate` action. It begins in `backgroundActions`, may move with the same identity into `foregroundAction` when a later prepared `say` must wait, and uses ordinary action events, settlement replay, checkpointing, and time observation. It is not hidden library state.

`showButton`, `askText`, `askNumber`, and `choose` settle and consume a background gate before creating their foreground interaction. `wait` does not consume it; both may coexist and use the persisted session-time coordinate.

A skippable gate may be completed by a primary click/tap within the player iframe viewport or by Space while the focused empty composer is active. This completes only the gate. Interactive controls have event priority, and unskippable gates reject those completion attempts.

### Standard UI and transcript conventions

The Standard UI uses one fixed chat composer. Foreground interaction controls appear directly above it, and the composer is focused automatically.

Choice buttons may occupy one or two rows. The Player application may instead render a dropdown when viewport, font, zoom, accessibility, or text constraints make buttons impractical. The presentation is not canonical runtime/checkpoint state and does not change completion or transcript semantics.

Valid input and choice/button activations become player-authored transcript messages according to the accepted normalization and derivation rules. Control labels, field hints, localized validation feedback, and accessibility names do not automatically create duplicate speaker transcript output.

### Player and developer controls

The normal Player application has no player-facing pause control, and this POC introduces no author-facing pause command. Developer mode may provide Run, Step, Pause, checkpoint, restore, and debugger controls. Browser-unavailability and reconnect time policy remains separate.

### Deferred Standard Library details

Future long-lived control wrappers must preserve the runtime semantics maintained in [`RUNTIME.md`](RUNTIME.md). Exact
momentary/toggle/select/status/progress API names, data shapes, persistence binding, update/removal surface, and author
syntax remain deferred.

The first POC does not settle:

- advanced parenthesized call forms;
- detailed result objects with elapsed time or metadata;
- the option name that selects a detailed return type;
- `showButton` timeout and elapsed return;
- custom compact `choose` field hints;
- any justified platform guards that later prove necessary;
- exact dynamic choice-layout breakpoints;
- the advanced accessibility override field;
- a deterministic speaker-aware typing indicator;
- LLM implementation and author-facing interpretation options;
- multiple text targets or conversation partitioning;
- final imports, manifests, lockfiles, semver, replacement, or migration.

## Future library scopes and default availability

The owner-selected future product direction distinguishes three author-facing library scopes above the engine:

1. **Platform Standard Library** — platform-owned, version-bound, and available by default so ordinary scripts do not require import boilerplate.
2. **Published community libraries** — independently published reusable libraries that packages explicitly opt into, comparable to plugins or mods.
3. **Package-local libraries** — libraries bundled with and intended primarily for one package.

Published community libraries and package-local libraries remain package code. They run under the same sandbox, deterministic runtime, capability, validation, checkpoint, and security rules. Publishing a reusable library does not create a new privilege tier.

The initial library-linkage implementation should keep dependency resolution simple:

- the Standard Library is the default prelude;
- a package explicitly imports published community libraries;
- package-local libraries may use the public Standard Library and the package's explicitly selected community libraries;
- published community libraries initially use the public Standard Library but do not depend transitively on other community libraries.

Community-library-to-community-library dependencies may be added later only with exact deterministic version binding, cycle rejection, lock data, moderation policy, and no transitive capability escalation.

### Standard Library alternatives and replacements

Advanced packages may later need to avoid or replace selected Standard Library behavior. The intended direction is explicit package configuration rather than accidental name shadowing.

A future manifest may support concepts equivalent to:

- disabling the automatic Standard Library prelude for an advanced package;
- importing an alternative library under an explicit namespace;
- deliberately mapping one or more Standard Library-facing names to compatible alternative exports.

The exact manifest syntax and compatibility contract remain open. Replacements must be intentional and visible in package metadata; importing an unrelated library must not silently change which `say`, timer, or input function a script calls. An alternative implementation remains constrained by engine primitives and cannot weaken validation, checkpointing, permissions, or determinism.

### Package libraries

Package libraries may:

- call public Standard Library functions;
- wrap or combine them into domain-specific APIs;
- use permitted custom UI inside the player iframe;
- expose normal TypeScript exports to TeaseScript tooling;
- exchange only supported serializable values and engine-managed references across the runtime boundary.

Package libraries may not:

- import privileged platform adapters through the public Standard Library;
- extend TeaseScript grammar or inject parser hooks;
- access the parent DOM or account cookies;
- place callbacks, promises, DOM objects, streams, browser handles, or mutable class instances into canonical runtime state;
- suspend an ordinary TypeScript call across a pending-action or checkpoint boundary.

## Generated declarations and editor metadata

Ordinary library exports must receive the same practical authoring support expected from built-ins. Tooling should derive or generate metadata containing at least:

- exported function and type names;
- parameter names, order, defaults, and types;
- return types;
- documentation and deprecation information;
- library/package identity and compatible version information.

The editor and compiler may use that information for:

- autocomplete;
- signature and parameter hints;
- hover documentation;
- navigation;
- type-aware diagnostics;
- import suggestions when imports are required;
- formatting through the normal TeaseScript function-call grammar.

A library export does not automatically create new command or block syntax. Special syntax remains defined by the official TeaseScript grammar and compiler, although that syntax may lower to a public Standard Library export.

ADR 0018 compact forms therefore require parser-owned syntax support in addition to generated metadata. Their lowering must preserve source spans and useful diagnostics.

## POC boundary

The current engine/compiler implements compact `showButton`, `askText`, `askNumber`, and `choose` plus ADR 0018
`say` smart/exact pacing and skip policy. Positive pacing uses the resumable `chatPacingGate` lifecycle described above;
`0`/`instant`, interaction consumption, `wait` coexistence, prepared output, and checkpoint/restore are implemented on
that same deterministic runtime model. Standard Player controls, editor/formatter/simulator support, and final
package/import/version/replacement design remain deferred.

Implemented Standard Library behavior ultimately requires unit, integration, editor-metadata, security-boundary, bounded-data, event-ordering, and checkpoint/resume coverage appropriate to the capabilities it composes.
