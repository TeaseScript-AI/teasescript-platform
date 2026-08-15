# Architecture

## Accepted boundaries

- PHP 8 with Laravel is the only public backend; PostgreSQL is the database.
- The TeaseScript parser/runtime core is TypeScript compiled to JavaScript.
- Laravel may later invoke a local Node/TypeScript CLI; no second public Node server is accepted.
- `main.tease` is the package entry point.
- `.tease` modules are executable content; `.ts` libraries provide reusable programming logic.
- One engine, state model, and save/checkpoint format support sessions and persistent personalities.
- The final player and package code run inside a sandboxed cross-origin iframe.
- Package code has no unrestricted external network access.

## Accepted composition layers

ADR 0017 defines this dependency direction:

```text
TeaseScript scripts (.tease)
    ├── call public Platform Standard Library exports directly
    └── call optional Package libraries (.ts)
            └── call public Platform Standard Library exports

Public Platform Standard Library
    └── documented typed engine primitives

Privileged platform adapters
    └── internal engine/player capabilities
        (not importable through the public Standard Library surface)

Typed engine primitives
    └── deterministic runtime state, pending actions, events,
        checkpoint/restore, and player boundary
```

The engine owns canonical execution behavior: validation, identities, typed events, pending actions, deterministic time, opaque references, checkpointing, restore, cleanup, and security boundaries.

The Standard Library owns reusable author-facing composition when that behavior can be built safely from core primitives. Candidate examples include chat-oriented `say` policy, visible timer presentation, friendly input helpers, retries, validation helpers, and standard UI conventions.

Package libraries may import the public, capability-safe Standard Library surface. They should build on shared behavior rather than directly recreating every feature from low-level primitives. Package-library-to-package-library dependencies remain a separate open decision.

Ordinary TypeScript execution may remain synchronous, but it may not suspend invisibly across a pending-action or checkpoint boundary. Resumable library behavior must be lowered into an explicit serializable plan or represented by an engine-managed serializable continuation.

A plan/checkpoint must either contain the lowered library behavior or bind to an exact compatible Standard Library identity/version. Restore against an implicit latest implementation is not permitted.

This layering is accepted. ADR 0018 compact interactions and `say` pacing are implemented through compiler-owned
full lowering into versioned engine instructions/state. Exact import syntax, linked Standard Library modules, version
binding, generated declarations, and privileged adapter modules remain open.

## Syntax and implementation placement

Public source syntax and internal implementation placement are separate decisions.

An official TeaseScript construct may compile to:

- one engine primitive;
- one public Standard Library export;
- or a fixed compiler-owned composition.

Ordinary library exports use normal function-call syntax when linkage is
implemented. Libraries may not add grammar productions, keywords, command
forms, or parser hooks. New special syntax requires an explicit
language/compiler decision. Package identity, linkage, metadata transport, and
library-aware editor support remain future consumer-driven work; grammar-aware
support for official syntax is parser/compiler-owned.

Accepted V30 forms and current implementation behavior remain authoritative until a later accepted decision supersedes them. ADR 0017 does not by itself remove current `say` instructions or alter ADR 0016 pending-action semantics.

## Implemented deterministic vertical slice

```text
main.tease
    -> parse
    -> semantic validation
    -> versioned JSON-safe instruction plan
    -> explicit versioned runtime state
    -> typed sequenced events
    -> standalone browser playground
```

ADR 0015 defines the current runtime direction. The AST is compile-time data. Runtime execution uses validated instruction plans and explicit scopes, loop frames, call frames, temporaries, RNG state, event sequence state, prepared references, and structured failures. It does not depend on suspended JavaScript functions, generators, closures, or an implicit JavaScript call stack.

Prepared references and suspended-continuation liveness are internal runtime mechanisms used to preserve source order and validate checkpoint restore; they are not new TeaseScript syntax.

## Performance boundary

JSON-safe after every instruction boundary does not mean serializing or persisting after every instruction. The POC exposes one-instruction stepping for testing/debugging and event-boundary stepping for normal use. Production execution may mutate validated in-memory state between checkpoint boundaries and serialize only when required, provided observable semantics and restore behavior remain identical.

## Deferred architecture

The cross-origin host protocol, general/background timer actions, Standard Library linkage and packaging, deterministic library identity/version binding, generated editor metadata, privileged adapter boundaries, media handles, server checkpoint persistence, package identity/migrations, and continuous-personality scheduling remain later work.

## Implemented source-layout seams

The behavior-neutral Option A refactor is implemented for the code present on
the starting `main`. `src/plan/model.ts` contains only the serializable plan
contract; `capture.ts` and `validation.ts` own stable external-data capture and plan
validation, with the small private capture support seam shared to avoid a
capture/validation cycle. `src/compiler/compile-program.ts` owns compilation
orchestration, while `src/compiler/lowering/compiler.ts` owns the cohesive
stateful lowering pass.

Serializable pending-action and settlement contracts live in
`src/runtime/actions/model.ts`; action modules remain pure. The two atomic
public transitions live in `src/runtime/operations/complete-action.ts` and
`observe-time.ts`. Their small `model.ts` and `support.ts` companions hold
shared operation results and common capture/sequence helpers so the engine can
execute instructions without duplicating operation logic. Whole-snapshot
construction, cloning, validation, and cross-state invariants remain in
`src/runtime/state.ts`.

No `src/standard-library/` shell exists yet because the implemented ADR 0018 POC forms are fully lowered by the
parser/compiler/runtime; linked reusable Standard Library modules remain future work.

The technical playground workspace controller lives at
`playground/workspace/controller.ts`. The production-oriented Player presentation
POC lives under `player/` and is served by the existing local playground server at
`/player/`. Its current presentation model and demo data are internal POC seams,
not an accepted engine/Player protocol or cross-origin host contract.

`src/index.ts` is the intentional public package/root API. Canonical internal
paths may change before a published compatibility policy exists; old repository
deep-import paths are not supported compatibility contracts. Any published
compatibility commitment must be decided explicitly rather than inferred from
repository source layout.
