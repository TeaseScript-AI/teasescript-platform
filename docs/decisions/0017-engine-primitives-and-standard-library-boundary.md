# ADR 0017 — Engine primitives and Standard Library boundary

**Status:** Accepted

## Context

TeaseScript needs both a small deterministic runtime and an approachable author API. Accepted V30 currently describes many author-facing commands and functions directly, while the current implementation already distinguishes the TypeScript parser/runtime core from reusable `.ts` libraries.

Recent design work for chat pacing and background timers showed that defining every friendly feature directly as a separate engine concept creates unnecessary coupling:

- `say`, visible timers, prompts, and input helpers repeat presentation policy;
- timer families repeat the same deterministic delay, handle, checkpoint, and lifecycle machinery;
- package libraries would otherwise rebuild common behavior directly from low-level primitives;
- editor support must work for library functions without allowing arbitrary libraries to mutate the language grammar;
- future LLM context selection needs stable speaker and conversation-participant provenance without placing personality or prompt logic in the deterministic engine.

This ADR defines the architectural boundary first. It does not finalize the replacement timer syntax, chat-pacing policy, input API, participant schema, Standard Library linkage syntax, or implementation schedule.

ADR 0015 remains authoritative for explicit JSON-safe execution state. ADR 0016 remains authoritative for the shared pending-action model, deterministic time observation, action identity, settlement, checkpoint, and restore semantics. This ADR changes where higher-level behavior should be composed; it does not silently replace accepted source syntax or pending-action semantics.

## Decision summary

1. Keep the engine core limited to the smallest deterministic, serializable, security-relevant primitives needed to execute TeaseScript and communicate with the player.
2. Provide a platform-owned Standard Library implemented in TypeScript and versioned with the engine/player distribution.
3. Build author-friendly APIs such as `say`, visible timers, common input helpers, and presentation policies primarily in the Standard Library when they can be composed from core primitives without weakening determinism, validation, checkpointing, or security.
4. Allow package libraries to import and reuse the public, capability-safe Standard Library surface.
5. Generate type signatures and editor metadata from library exports so ordinary library functions receive autocomplete, parameter hints, hover documentation, diagnostics, navigation, and formatting through the normal call syntax.
6. Do not allow libraries to add or mutate TeaseScript grammar. New command, block, or other special syntax remains an explicit language/compiler decision.
7. Permit official TeaseScript syntax to lower to a public Standard Library export, a core primitive, or a fixed composition of both. The source form does not determine which internal layer owns the implementation.
8. Keep stable identity, validation, scheduling, checkpoint, restore, event sequencing, and typed host boundaries in the engine even when a Standard Library wrapper provides the public API.
9. Require library behavior crossing a pending-action or checkpoint boundary to be lowered into explicit serializable engine instructions or represented by an engine-managed serializable continuation. Ordinary TypeScript calls may not remain invisibly suspended.
10. Separate public Standard Library exports from privileged platform adapters. Public imports must not transitively expose internal host capabilities.
11. Require deterministic Standard Library identity/version binding whenever behavior is not fully lowered into the instruction plan. Restore may not silently use an implicit latest implementation.
12. Preserve currently implemented behavior until the required library-linkage and metadata pipeline exists. This documentation decision does not move or delete current `say` code.
13. Require later implementation work to test both the engine primitives and the Standard Library behavior built on them. Deferring a Standard Library slice from the current POC does not exempt it from tests when implemented.

## Layer model

```text
TeaseScript scripts (.tease)
    ├── call public Standard Library exports directly
    └── call optional package-library exports
            └── call public Standard Library exports

Public Standard Library
    └── documented typed engine primitives

Privileged platform adapters
    └── internal engine/player capabilities
        (not importable through the public Standard Library surface)

Typed engine primitives
    └── deterministic runtime state, pending actions, events,
        checkpoint/restore, and player boundary
```

Dependencies point toward the engine. A script does not need a package library in order to use the Standard Library. A package library may use the public Standard Library instead of rebuilding its behavior from engine primitives.

Package-library-to-package-library dependencies are not accepted by this ADR. Published community-library dependencies, transitive resolution, cycles, lock data, moderation, capability propagation, and version conflicts remain separate decisions.

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
- typed, validated, JSON-safe data crossing runtime, player, host, checkpoint, and package boundaries, with
  resource/security bounds only at separately justified concrete boundaries;
- stable output provenance such as output target identity and speaker identity where required;
- engine-managed serializable continuations for resumable library workflows;
- validation of required Standard Library identity/version when behavior was not fully lowered into the plan;
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

The Standard Library may compose wrappers such as text, number, choice, image, confirmation, or acknowledgement helpers. The engine still validates untrusted completion data and opaque resource references.

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
- smart, timed, autoplay, instant, or other accepted message-pacing policies;
- visible and mystery timer presentation;
- friendly timer lifecycle wrappers;
- common choice and input helpers;
- one-action acknowledgement/continue helpers;
- validation/retry helpers;
- standard speaker and transcript convenience APIs;
- standard output targets and Standard UI composition;
- reusable formatting, conversion, collection, and utility functions;
- higher-level workflows built from typed core actions.

The Standard Library is trusted platform code, but it remains subject to the player sandbox and documented capabilities. It may not bypass runtime validation, mutate parent-page state, access account cookies, or create hidden non-serializable execution state.

## Resumability boundary

Ordinary TypeScript library code may run synchronously between engine instruction boundaries. It may calculate values, validate arguments, and call synchronous capabilities.

A library workflow that waits for time, input, media, a background handler, or another pending result must not retain an ordinary TypeScript stack, promise, callback, closure, or generator as canonical resume state. It must either:

- be lowered into explicit versioned serializable engine instructions; or
- use an explicit versioned engine-managed serializable continuation.

The exact lowering and linkage mechanism remains deferred, but this invariant does not.

## Public Standard Library and privileged adapters

Package libraries may import only the public, capability-safe Standard Library surface.

Privileged platform adapters may exist internally for player integration or capability brokering, but they are separate modules and are not transitively exported. Calling a public helper must not grant access to internal host capabilities, the parent DOM, account cookies, raw browser objects, or unrestricted networking.

## Deterministic version binding

A plan or checkpoint must never restore against whichever Standard Library implementation is currently latest.

A conforming implementation must either:

- fully lower the relevant Standard Library behavior into the versioned instruction plan; or
- bind the plan/checkpoint to an exact compatible Standard Library identity/version and reject or explicitly migrate an incompatible restore.

The exact identity fields, compatibility ranges, packaging format, and migration schema remain open.

## Package-library responsibilities

Package libraries may:

- import public Standard Library exports;
- wrap or combine Standard Library functions;
- expose package-specific helpers to `.tease` scripts;
- create custom UI inside the player iframe through allowed UI capabilities;
- accept and return typed serializable values and engine-managed references;
- publish generated signatures and editor metadata.

Package libraries may not:

- add grammar productions, keywords, token forms, or parser hooks;
- import privileged platform adapters through the public Standard Library;
- bypass core pending-action, time, checkpoint, validation, or security rules;
- access the parent DOM, main-site cookies, unrestricted external networking, or undocumented host capabilities;
- place callbacks, DOM nodes, promises, browser handles, streams, or mutable class instances into canonical runtime state;
- suspend an ordinary TypeScript call across a pending-action or checkpoint boundary.

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

remain parser-recognized syntax unless a later accepted language decision changes them. The compiler may lower such syntax to a public Standard Library entry point, directly to a core instruction, or to a fixed combination. Libraries cannot request new forms such as arbitrary custom commands or blocks merely by exporting a function.

## Compatibility and POC migration

This decision is documentation-only and requires no immediate source rewrite.

The current repository already implements `say` and speaker-aware output in the core execution path. That behavior remains current POC functionality until a tested Standard Library linkage path can replace or wrap it without observable regressions.

ADR 0016 still selects blocking `wait` as the first pending-action implementation slice. A later plan may implement the accepted `wait` source form by lowering it to a core foreground-delay primitive, a Standard Library wrapper, or a thin compiler-owned adapter. The deterministic pending-action behavior does not depend on that internal placement.

The first Standard Library POC slice may deliberately include only a small set of functions. The selected set, migration order, and acceptance tests require a separate implementation plan.

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
- resumable library helpers need explicit lowering or serializable continuations rather than ordinary suspended TypeScript calls;
- plan/checkpoint compatibility must bind to lowered behavior or an exact compatible Standard Library identity/version;
- some existing accepted V30 APIs may later need explicit superseding decisions about their public names or placement.

## Deferred follow-up decisions

This ADR intentionally does not decide:

- the exact core capability names or TypeScript interfaces;
- the `.tease` import/linkage syntax;
- Standard Library packaging, default-prelude behavior, and version compatibility;
- published community-library and package-local-library packaging;
- community-library-to-community-library dependencies;
- explicit Standard Library replacement/override mappings;
- generated metadata format and editor protocol;
- exact privileged adapter implementation;
- final `say` syntax and detailed smart-autoplay behavior;
- final timer syntax, explicit handle representation, handle methods, pause/resume/stop/restart semantics, repetition, persistence, or presentation;
- final generic interaction schema or `ask...` APIs;
- exact output-target and participant/conversation data structures;
- player-initiated pause time policy or author recovery-point rollback semantics;
- LLM personality, relationship, memory, summarization, or prompt assembly;
- migration of existing implemented `say` instructions;
- which Standard Library functions are included in the next POC slice.

Closed draft PRs #69 and #71 and closed issues #67 and #68 remain historical design references only. Their detailed timer and pacing proposals are not accepted by this ADR.
