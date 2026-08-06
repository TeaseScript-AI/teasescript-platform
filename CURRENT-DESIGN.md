# Current design

## System map

TeaseScript AI is a browser-first community platform with accounts, forum, catalog, authoring tools, and an
interactive player. PHP 8 with Laravel is the only public backend and PostgreSQL is the database. Laravel owns
accounts, forum, catalog, publishing, moderation, persistent state, media metadata, and public platform APIs. A local
Node/TypeScript CLI may support development or Laravel-invoked tooling, but there is no second public Node server.

The parser and deterministic runtime core are written in TypeScript and compiled to JavaScript. `main.tease` is the
fixed package entry point. Regular executable content uses `.tease`; advanced reusable programming logic uses real
TypeScript in `.ts`. Finite sessions and long-running personalities share one engine, one state model, and one
save/checkpoint format.

The current implemented capability state belongs in [`PHASE-STATUS.md`](PHASE-STATUS.md). Detailed component
contracts and current implementation surfaces belong in the topic documents linked below, not in this map.

## Trust, isolation, and platform ownership

The accepted production boundary places the complete player, engine, Platform Standard Library, package libraries,
Standard UI, and custom UI inside a sandboxed cross-origin iframe, preferably on a separate player origin. Main-site
cookies remain host-only and unavailable to the player. The parent, player, server, and future integrations exchange
only selected validated typed plain data.

Package code may use HTML, CSS, canvas, DOM APIs, and optional Shadow DOM only inside that player boundary. It cannot
access the parent DOM, account cookies, forum state, or internal site data and has no unrestricted external network
access. Published media uses platform-managed storage/CDN. Future third-party services and device capabilities
require platform-managed typed integrations rather than direct package access.

Laravel remains authoritative for authentication, authorization, persistence, publishing, moderation, and public API
validation. The player/controller may render Standard UI, invoke browser capabilities, transport checkpoints, and
submit typed observations or outcomes, but it may not directly mutate canonical runtime state or continuations.
Camera, file, media, and similar browser resources cross the engine boundary only through validated engine-managed
references, never as live browser objects in canonical state.

LLM and vision output is untrusted input. It may provide constrained dialogue or typed proposals, but the deterministic
engine validates the result and remains authoritative for rules, state transitions, available choices, permissions,
and device or platform capabilities.

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DATA-AND-API.md`](docs/DATA-AND-API.md) for the maintained
security, privacy, transport, and persistence contracts.

## Deterministic execution boundary

TeaseScript source is parsed and validated before being compiled into an explicit versioned JSON-safe instruction
plan. Runtime execution uses validated explicit state: scopes, loop and call frames, temporaries, deterministic RNG,
sequenced events, pending actions, time observations, settlements, and resumable continuations. AST nodes remain
compile-time data; the parser does not execute runtime behavior.

Execution must not depend on suspended JavaScript functions, generators, closures, promises, callbacks, an implicit
JavaScript call stack, or module-global mutable state. Runtime output is typed data/events rather than direct HTML.
Behavior that survives a wait, input, timer, save, page lifecycle boundary, or restore must be represented by the
runtime as serializable state or a serializable plan.

JSON-safe at every instruction boundary does not mean serializing or persisting after every instruction. A production
runner may mutate validated in-memory state between checkpoint boundaries, provided observable source order,
deterministic behavior, copy semantics, event order, and restore behavior remain equivalent.

Pending actions, handles, canonical identities, time, validation, continuation positions, cleanup, events,
checkpointing, and restore are engine-owned. Hosts supply validated observations and typed outcomes through atomic
runtime operations; they do not edit snapshot fields directly. Exact action models, formats, limits, and completion
semantics belong in [`docs/RUNTIME.md`](docs/RUNTIME.md) and the accepted runtime ADRs.

The serializable runtime architecture is accepted in
[`ADR 0015`](docs/decisions/0015-serializable-runtime-architecture.md); resumable pending actions are accepted in
[`ADR 0016`](docs/decisions/0016-resumable-pending-action-runtime-contract.md).

## Language, engine, and library boundary

[`docs/specifications/accepted-syntaxes-v30.md`](docs/specifications/accepted-syntaxes-v30.md) is the accepted
TeaseScript syntax and semantics baseline. Only a later accepted ADR or accepted specification update supersedes an
exact V30 point within its stated scope.

The engine exposes the smallest deterministic primitives. The public Platform Standard Library provides reusable
author-facing composition over those primitives. Optional package libraries may use only public capability-safe
surfaces; privileged platform adapters remain internal and cannot become transitively importable.

Libraries cannot add TeaseScript grammar, keywords, command forms, or parser hooks. Ordinary synchronous TypeScript
library code may run normally, but resumable behavior cannot suspend invisibly across a pending-action or checkpoint
boundary. It must be lowered into explicit plan data or represented by an engine-managed serializable continuation. A
plan/checkpoint must contain the lowered behavior or bind it to an exact compatible identity; restore never selects an
implicit latest library implementation.

See [`docs/TEASESCRIPT.md`](docs/TEASESCRIPT.md), [`docs/LIBRARIES.md`](docs/LIBRARIES.md),
[`ADR 0017`](docs/decisions/0017-engine-primitives-and-standard-library-boundary.md), and
[`ADR 0018`](docs/decisions/0018-first-standard-library-poc-contract.md) for the detailed language, Standard Library,
interaction, and pacing contracts.

## Product persistence and long-running execution

Persistent platform records live behind Laravel and PostgreSQL. Active browser execution and future server-side
scheduled execution use the same validated deterministic engine and checkpoint model; they must coordinate ownership
rather than create a second personality runtime or incompatible save format. Exact account, global-data, scheduling,
conflict, reconnect, missed-event, and migration contracts remain with their topic documents and unresolved-decision
owners until accepted.

See [`docs/CONTINUOUS-PERSONALITIES.md`](docs/CONTINUOUS-PERSONALITIES.md),
[`docs/DATA-AND-API.md`](docs/DATA-AND-API.md), and [`docs/OPEN-DECISIONS.md`](docs/OPEN-DECISIONS.md).

## Architecture discipline

Keep the design proportional to demonstrated needs. Do not introduce a second public backend, microservices,
Kubernetes, Redis, WebRTC, Electron, native apps, or equivalent infrastructure without a concrete requirement and an
accepted decision. Mobile begins as a responsive PWA; add a small headless helper only for a demonstrated browser
limitation.

Use these current owners for detail:

- [`docs/PRODUCT.md`](docs/PRODUCT.md): product direction and current implementation focus;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): component boundaries, dependency direction, and current source
  placement;
- [`docs/RUNTIME.md`](docs/RUNTIME.md): execution, pending actions, checkpoints, formats, and runtime limits;
- [`docs/LIBRARIES.md`](docs/LIBRARIES.md): engine, Standard Library, package-library, and privileged-adapter boundary;
- [`docs/SECURITY.md`](docs/SECURITY.md): isolation, capture, validation, privacy, and capability restrictions;
- [`docs/DATA-AND-API.md`](docs/DATA-AND-API.md): Laravel ownership, current APIs, persistence, and host/player data
  boundaries;
- [`docs/CODE-EDITOR.md`](docs/CODE-EDITOR.md): editor, simulator, and debugger direction;
- [`docs/LLM-INTEGRATION.md`](docs/LLM-INTEGRATION.md): constrained LLM/vision integration;
- [`PHASE-STATUS.md`](PHASE-STATUS.md): current phase, gates, capability state, and major exclusions.
