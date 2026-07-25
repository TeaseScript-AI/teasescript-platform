# Current open decisions

Accepted ADRs and V30 override older descriptive documents. Sets, deep value copying, empty collection behavior, speaker fallback, serializable runtime architecture, serializable loop/call frames, source-order evaluation, prepared references, and the current user-function model are not unimplemented design questions.

## Runtime hardening and evolution

- Package/source identity for browser checkpoints and production plan references.
- Migration policy across plan, snapshot, checkpoint, engine, and package versions.
- Production checkpoint frequency, incremental persistence, and performance thresholds.
- Final internal representation and optimization policy for large immutable/deep-copy values.
- Host/global representation for future opaque engine references beyond speakers.
- Complete static type checking and composite equality.
- Server-versus-browser authoritative checkpoint ownership and conflict resolution.

### Compatibility API lifecycle

The current TypeScript surface exposes both the instruction-plan runtime and a compatibility route through `Interpreter`, `execute(program, ...)`, and the host-oriented `RuntimeValue` model.

Decide whether that compatibility surface should:

- remain a supported alpha API;
- remain a temporary testing, migration, or importer adapter without broader feature growth; or
- be deprecated after remaining callers and tests migrate to the instruction-plan runtime.

This decision must define the intended support period, migration expectations, public-export impact, and whether the host-value and serializable-value models remain separate. It should be resolved before a broad refactor that consolidates or removes compatibility-layer types and modules. Until then, the current exports remain implemented POC behavior rather than a permanent alpha commitment.

The exact version-3 schemas are current POC implementation details, not a promise of permanent wire-format compatibility.

## Remaining language and library work

- TypeScript-library import/linkage syntax from `.tease`.
- Exact unit/date/time/datetime/duration implementation.
- Standard Library string methods and detailed API signatures.
- Module metadata, selection, recursion, fallback, cooldown, and history rules.
- Static treatment of contextual `speaker` access when control-flow analysis can prove that no explicit or default speaker is available: compile-time error, warning, or retained runtime failure. Ordinary narrator output such as `say "Hello"` is a separate valid case and does not require a default speaker.
- Remaining accepted V30 constructs and APIs outside the current parser/runtime subset.

## Player and interactions

- Cross-origin parent/player message schemas, capability negotiation, sandbox flags, and CSP.
- Input, choices, waits, timers, pending-action resume behavior, and cancellation.
- Media layering, concurrent ownership, cleanup, recovery, and resource handles.
- Exact custom-view author syntax and lifecycle; capability is accepted, syntax remains open.
- Browser-helper boundary for files, toys, camera, offline behavior, and OS capabilities.

## Platform and personalities

- Account, toy, history, locks, global-data, and checkpoint storage contracts.
- Persistent scheduler missed-event behavior, quotas, deduplication, concurrency, and execution location.
- Continuous-personality lifecycle, assignments, reports, permissions, statuses, and reconnect behavior.
- Publishing, signing, versioning, moderation, and legacy importer details.

## Proposals, not decisions

- Restricted math.js-backed numeric/unit evaluation.
- WebRTC, Redis, Electron, native apps, Kubernetes, and microservices without a concrete documented need.
