# ADR 0017 — Engine primitives and Standard Library boundary

**Status:** Proposed

## Context

TeaseScript needs both a small deterministic runtime and an approachable author API. Accepted V30 currently describes many author-facing commands and functions directly, while the current implementation already distinguishes the TypeScript parser/runtime core from reusable `.ts` libraries.

Recent design work for chat pacing and background timers showed that defining every friendly feature directly as a separate engine concept creates unnecessary coupling:

- `say`, visible timers, prompts, and input helpers repeat presentation policy;
- timer families repeat the same deterministic delay, handle, checkpoint, and lifecycle machinery;
- package libraries would otherwise rebuild common behavior directly from low-level primitives;
- editor support must work for library functions without allowing arbitrary libraries to mutate the language grammar;
- future LLM context selection needs stable speaker and conversation-participant provenance without placing personality or prompt logic in the deterministic engine.

This ADR proposes the architectural boundary first. It does not finalize the replacement timer syntax, chat-pacing policy, input API, participant schema, Standard Library linkage syntax, or implementation schedule.

ADR 0015 remains authoritative for explicit JSON-safe execution state. ADR 0016 remains authoritative for the shared pending-action model, deterministic time observation, action identity, settlement, checkpoint, and restore semantics. If accepted, this ADR changes where higher-level behavior should be composed; it does not silently replace accepted source syntax or pending-action semantics.

## Decision summary

1. Keep the engine core limited to the smallest deterministic, serializable, security-relevant primitives needed to execute TeaseScript and communicate with the player.
2. Provide a platform-owned Standard Library implemented in TypeScript and versioned with the engine/player distribution.
3. Build author-friendly APIs such as `say`, visible timers, common input helpers, and presentation policies primarily in the Standard Library when they can be composed from core primitives without weakening determinism, validation, checkpointing, or security.
4. Allow package libraries to import and reuse Standard Library exports and declared package-library dependencies.
5. Generate type signatures and editor metadata from library exports so ordinary library functions receive autocomplete, parameter hints, hover documentation, diagnostics, navigation, and formatting through the normal call syntax.
6. Do not allow libraries to add or mutate TeaseScript grammar. New command, block, or other special syntax remains an explicit language/compiler decision.
7. Permit official TeaseScript syntax to lower to a Standard Library export, a core primitive, or a fixed composition of both. The source form does not determine which internal layer owns the implementation.
8. Keep stable identity, validation, scheduling, checkpoint, restore, event sequencing, and typed host boundaries in the engine even when a Standard Library wrapper provides the public API.
9. Preserve currently implemented behavior until the required library-linkage and metadata pipeline exists. This documentation proposal does not move or delete current `say` code.
10. Require later implementation work to test both the engine primitives and the Standard Library behavior built on them. Deferring a Standard Library slice from the current POC does not exempt it from tests when implemented.

Every item remains proposed until explicit owner approval changes this ADR to `Accepted`.

## Layer model

```text
TeaseScript scripts (.tease)
        ↓
Package libraries (.ts)
        ↓
Platform Standard Library (.ts)
        ↓
Typed engine capability and instruction primitives
        ↓
Deterministic runtime state, pending actions, events, and player boundary
```

Dependencies point downward. A package library may use the Standard Library instead of rebuilding its behavior from engine primitives. The Standard Library may use documented core capabilities. Ordinary scripts normally use the author-facing Standard Library and official TeaseScript syntax.

A package library may also depend on another package library through an explicit, versioned dependency declaration. Cycles, version selection, linkage syntax, and package-resolution rules remain separate decisions.

## Engine-core responsibilities

The engine owns behavior that must remain canonical, deterministic, validated, and checkpoint-safe regardless of which library exposes it.

This includes:

- parsing and compiling official TeaseScript syntax;
- validated instruction plans and explicit serializable runtime state;
- scope, call, loop, temporary, RNG, speaker-reference, and control-flow semantics;
- typed sequenced events;
- foreground and background pending-action identity and lifecycle;
- deterministic session-time observation and timed-action settlement;
- opaque engine-managed handles and reference validation;
- typed, bounded, JSON-safe data crossing runtime, player, host, checkpoint, and package boundaries;
- stable output provenance such as output target identity and speaker identity where required;
- security and capability enforcement;
- cleanup, failure, checkpoint, restore, and resume-equivalence rules.

The engine should not gain a new state machine merely because an author-facing helper has a new name or presentation style.

## Candidate primitive families

Exact public TypeScript names remain open. The following are conceptual capability families, not accepted source APIs.

### Text output

A minimal typed text-output operation can carry the final text and a validated output target. It must also preserve stable provenance required by transcript history, player rendering, and future context selection.

Conceptually:

```text
emitText {
    text
    target
    speakerId: optional
    participantSpeakerIds: optional unique collection
}
```

The exact participant/conversation model remains open. The important boundary is that the engine records stable IDs supplied through validated state; it does not own speaker colors, avatars, personalities, relationship models, LLM prompts, summaries, or context-window policy.

All speakers may write to the same chat target while retaining distinct `speakerId` values. Later LLM tooling may select only the transcript events relevant to a requested set of participants without changing what the shared chat interface displays.

### Typed interactions

A generic foreground interaction primitive can represent typed player input and completion without requiring independent checkpoint machinery for every convenience function.

Conceptually relevant dimensions include:

```text
interaction kind
expected result type
allowed values or validation policy
action identity
result destination
requesting speaker/provenance metadata
reconstructable Standard UI payload
```

The Standard Library may compose wrappers such as text, number, choice, image, or confirmation helpers. The engine still validates untrusted completion data and opaque resource references.

### Timed work

ADR 0016 already provides the shared deterministic timing foundation. The core should expose only the minimum distinction required by execution:

- a foreground delay that blocks the active execution path;
- background timed work that lets the main path continue and later makes a deterministic handler eligible;
- validated lifecycle operations required for background timed work, including pause, resume, and stop once their exact semantics are separately accepted.

Visible countdowns, mystery presentation, labels, default controls, repeating policies, friendly timer handles, and convenience names belong above those primitives when possible.

This ADR does not choose whether the final author API uses `timer`, `startTimer`, another name, methods on a returned handle, or official syntax sugar. It also does not define whether a stopped timer can be restarted; pause/resume and restart-after-stop are separate lifecycle decisions.

## Standard Library responsibilities

The platform Standard Library owns reusable author-facing policy and composition that does not need to become a distinct engine state machine.

Candidate responsibilities include:

- `say` defaults and chat-oriented presentation;
- smart, manual, timed, instant, or other accepted message-pacing policies;
- visible and mystery timer presentation;
- friendly timer lifecycle wrappers;
- common choice and input helpers;
- validation/retry helpers;
- standard speaker and transcript convenience APIs;
- standard output targets and Standard UI composition;
- reusable formatting, conversion, collection, and utility functions;
- higher-level workflows built from typed core actions.

The Standard Library is trusted platform code, but it remains subject to the player sandbox and documented capabilities. It may not bypass runtime validation, mutate parent-page state, access account cookies, or create hidden non-serializable execution state.

## Package-library responsibilities

Package libraries may:

- import Standard Library exports;
- wrap or combine Standard Library functions;
- expose package-specific helpers to `.tease` scripts;
- create custom UI inside the player iframe through allowed UI capabilities;
- accept and return typed serializable values and engine-managed references;
- publish generated signatures and editor metadata.

Package libraries may not:

- add grammar productions, keywords, token forms, or parser hooks;
- bypass core pending-action, time, checkpoint, validation, or security rules;
- access the parent DOM, main-site cookies, unrestricted external networking, or undocumented host capabilities;
- place callbacks, DOM nodes, promises, browser handles, streams, or mutable class instances into canonical runtime state.

## Syntax, functions, and editor tooling

Library functions use ordinary call syntax:

```tease
say(text: "Hello")
askNumber(minimum: 1, maximum: 10)
```

Their exported signatures and metadata can provide:

- autocomplete;
- parameter names, defaults, and types;
- hover documentation;
- go-to-definition or generated declaration navigation;
- compile-time diagnostics;
- deprecation and version information;
- standard formatting of the normal function call.

A formatter formats the call according to the normal TeaseScript grammar. It does not transform a library export into a new language construct.

Special syntax remains official and scarce. For example, accepted forms such as:

```tease
say "Hello"
wait 2
```

remain parser-recognized syntax unless a later accepted language decision changes them. The compiler may lower such syntax to a Standard Library entry point, directly to a core instruction, or to a fixed combination. Libraries cannot request new forms such as arbitrary custom commands or blocks merely by exporting a function.

## Compatibility and POC migration

This proposal is documentation-only and requires no immediate source rewrite.

The current repository already implements `say` and speaker-aware output in the core execution path. That behavior remains current POC functionality until a tested Standard Library linkage path can replace or wrap it without observable regressions.

ADR 0016 still selects blocking `wait` as the first pending-action implementation slice. A later plan may implement the accepted `wait` source form by lowering it to a core foreground-delay primitive, a Standard Library wrapper, or a thin compiler-owned adapter. The deterministic pending-action behavior does not depend on that internal placement.

The first Standard Library POC slice may deliberately include only a small set of functions, such as `say`, `wait`, or one timer wrapper. The selected set, migration order, and acceptance tests require a separate implementation plan.

## Consequences

### Benefits

- fewer independent runtime state machines;
- one deterministic checkpoint and pending-action model;
- reuse across the Standard Library and package libraries;
- smaller engine security surface;
- author-friendly APIs without hard-coding every product concept;
- full editor support for ordinary library functions;
- custom presentation without unrestricted grammar extension;
- a cleaner future path for transcript provenance and separated LLM contexts.

### Costs

- the project needs a real library-linkage, versioning, declaration, and metadata pipeline;
- Standard Library behavior requires its own test suite and compatibility policy;
- official syntax lowering must preserve source spans and useful diagnostics across the library boundary;
- trusted Standard Library capabilities must be documented so package libraries cannot accidentally gain privileged access;
- some existing accepted V30 APIs may later need explicit superseding decisions about their public names or placement.

## Explicit owner decisions required

Owner approval or revision is required for:

1. the engine-core/Standard-Library/package-library dependency direction;
2. package libraries being allowed to import and reuse Standard Library exports;
3. generated signatures and metadata as the basis for autocomplete and type-aware editor support;
4. libraries being unable to extend TeaseScript grammar;
5. official syntax being allowed to lower to Standard Library exports;
6. keeping canonical identity, validation, pending actions, time, handles, checkpointing, and provenance in the engine;
7. treating `say`, common input helpers, and timer presentation as Standard Library candidates rather than automatically distinct engine systems;
8. preserving current implementations until replacement linkage is tested;
9. requiring tests for later Standard Library implementations even when their implementation is outside the current POC slice.

## Deferred follow-up decisions

This ADR intentionally does not decide:

- the exact core capability names or TypeScript interfaces;
- the `.tease` import/linkage syntax;
- Standard Library packaging and version compatibility;
- generated metadata format and editor protocol;
- whether Standard Library code has any privileged capability tier;
- final `say` syntax and pacing behavior;
- final timer syntax, handle methods, pause/resume/stop/restart semantics, repetition, persistence, or presentation;
- final generic interaction schema or `ask...` APIs;
- exact output-target and participant/conversation data structures;
- LLM personality, relationship, memory, summarization, or prompt assembly;
- migration of existing implemented `say` instructions;
- which Standard Library functions are included in the next POC slice.

Closed draft PRs #69 and #71 remain historical design references only. Their detailed timer and pacing proposals are not accepted by this ADR.
