# Testing strategy

## Authority and purpose

Accepted language and runtime behavior remains defined by accepted specifications and ADRs. This document defines the repository's verification strategy, required test categories, and quality expectations for changes.

Owner-selected outcomes that remain required before pre-alpha or alpha are tracked in [`planning/POC-TO-ALPHA-BACKLOG.md`](planning/POC-TO-ALPHA-BACKLOG.md). Inclusion there establishes a gate, not an implementation schedule. This document does not accept unresolved syntax, APIs, host protocols, or architecture.

## Current testing model

The current repository uses:

- TypeScript type checking through `tsc --noEmit`;
- a complete TypeScript build before compiled tests run;
- Node's built-in test runner;
- focused tests during development plus the complete configured suite before merge;
- real source-to-runtime tests where public behavior crosses parser, compiler, instruction-plan, and runtime boundaries;
- deterministic RNG seeds, JSON checkpoint round trips, and runtime resume-equivalence coverage;
- playground HTTP and static-path security tests.

The repository currently has no browser-automation or property-testing dependency. New dependencies require a demonstrated need and the normal maintenance and security review.

## Test layers

The testing strategy uses complementary layers:

```text
lexer/parser/semantic unit tests
source-to-runtime contract tests
runtime invariant and checkpoint tests
external-data validation and corruption tests
player/host integration tests
browser E2E tests
performance benchmarks
```

Focused tests isolate syntax, diagnostics, lowering, validators, and runtime operations. Source-to-runtime tests prove that the public compilation and execution path preserves the accepted behavior. Runtime invariant and corruption tests cover explicit serializable state and restore boundaries. Future integration and browser tests cover concrete player/host surfaces after those surfaces exist.

End-to-end testing does not replace focused unit, validator, and invariant tests.

## Regression-test rule

Every confirmed defect fix requires a focused regression test. The test should normally fail on the unmodified baseline for the reported root cause and pass after the repair.

Do not weaken tests to hide failures. Do not fold unrelated speculative cases into a focused repair pull request. A newly suspected defect should first be reproduced against the relevant public boundary before it is documented or filed as established behavior.

## Runtime resume-equivalence invariant

For deterministic runtime scenarios, the required invariant is:

```text
uninterrupted execution
==
execution resumed after JSON checkpoint round trip
```

The current shared test-only runtime-equivalence helper evaluates every completed instruction boundary. It compiles real TeaseScript source, runs an uninterrupted baseline, advances a second execution one instruction at a time, round-trips a self-contained checkpoint through real JSON and the public restore boundary, resumes to completion, and compares the result.

Complete event and snapshot equality is authoritative. The comparison includes:

- accumulated and resumed events;
- event sequence numbers;
- final runtime snapshot and status;
- serialized RNG state;
- speakers and default/contextual speaker state;
- developer-warning events, ordering, replay behavior, and explicitly serialized warning-deduplication state;
- scopes and bindings;
- loop frames;
- call frames;
- temporaries;
- prepared references;
- halt or structured failure state.

Specialized tests may additionally inspect selected event, call, loop, or prepared-reference boundaries, but they do not replace complete equivalence.

The canonical self-contained checkpoint guarantee uses the serialized runtime RNG. A host-provided `RuntimeCapabilities.random` implementation is a compatibility/testing override whose external state is not captured by the runtime snapshot. Tests using that override must explicitly recreate the same deterministic external source and must not present the result as a self-contained checkpoint guarantee.

JSON-safe runtime state at every instruction boundary does not mean production execution must persist after every instruction.

## External-data and mutation testing

A future reusable mutation approach should follow this pattern:

```text
valid plan, snapshot, or checkpoint
-> clone
-> mutate one controlled field
-> invoke the documented public validator or restore boundary
-> verify the documented structured result
```

Mutation categories should include, where applicable:

- missing required fields;
- wrong primitive types;
- non-finite or unsafe numeric values;
- invalid instruction positions;
- inconsistent status;
- duplicate or unknown identities;
- missing temporaries;
- invalid function, scope, speaker, loop, or frame references;
- malformed RNG or event-sequence state;
- cyclic or excessively nested data;
- prototype-sensitive names;
- unsupported format versions.

Do not assume that every unknown extra field must be rejected unless an accepted format contract requires it.

For documented external plan, snapshot, checkpoint, validation, deserialization, and restore boundaries, malformed data must not cause an uncontrolled native stack overflow, hang, silent repair, or partial execution. The boundary must return or throw its documented structured invalid-data result. This requirement does not redefine intentional argument errors of low-level helpers that are not serialized external-data boundaries.

All adversarial cases must be deterministic and bounded by explicit depth, size, and total-work limits.

## Source-to-runtime conformance corpus

A future small behavior-oriented corpus should use a stable layout such as:

```text
tests/cases/
  collections/
  control-flow/
  functions/
  diagnostics/
  checkpoint/
  security-boundaries/
```

A case may define:

- `.tease` source;
- expected diagnostic codes and spans;
- expected public events;
- expected final status;
- selected final values;
- whether full resume-equivalence is required.

Prefer assertions on public behavior. Do not use complete instruction-plan snapshots as broad golden files. Assert internal instruction structure only when that structure is itself an accepted contract or when a focused lowering test requires it.

## Deterministic fuzz and property testing

Future fuzz and property tests must use fixed seeds and report the failing seed and generated input. Initial implementation should use existing tools unless a demonstrated need justifies a dependency.

Useful generated inputs include:

- short token sequences;
- nested templates and interpolations;
- bounded nested collections;
- expressions and calls;
- malformed plans and checkpoints;
- Unicode and unusual identifiers;
- incomplete strings, comments, and blocks;
- deeply nested but otherwise valid source structures, including parentheses, unary expressions, lists, templates, and interpolations;
- equivalent bounded direct-AST structures that bypass parsing.

Required properties include:

- lexer and parser termination;
- invalid input produces diagnostics rather than an uncontrolled crash;
- accepted plans and snapshots are JSON-safe;
- documented public validation boundaries remain structured;
- the same seed reproduces the same input and result;
- failing input, seed, and first failing boundary are reported;
- generated depth, input size, and total work are bounded;
- deeply nested valid source and direct AST input either succeeds or reaches a documented bounded rejection rather than an incidental native stack overflow.

This strategy does not assert that deeply nested valid source or direct AST input currently has a confirmed defect. A bug issue requires a repository reproduction that identifies the first failing public boundary.

Do not select `fast-check` or another dependency through documentation alone.

## Interactive runtime state-machine testing

ADR 0016 defines the shared pending-action runtime contract. Every implemented choice, input, wait, timer, button, media completion, or future typed player action requires deterministic state-machine testing against that contract.

Representative transitions include:

```text
running
-> waiting
-> checkpoint
-> restore
-> time observation or typed response
-> running
-> event
-> halted
```

Shared required cases include:

- normal completion;
- checkpoint and restore while pending;
- JSON round-trip and deterministic resume equivalence;
- persisted `currentSessionTimeMs` surviving restore;
- a lower time observation not decreasing the persisted coordinate;
- atomic session-time update and due-action settlement;
- invalid session-time values;
- cancellation and timeout according to the action kind;
- invalid, duplicate, or late response;
- duplicate delivery returning the same bounded `lastSettlement`;
- active foreground/background lookup before settled, stale, or unknown classification;
- an older active background action remaining valid after a newer action settles;
- stale and unknown IDs;
- wrong action kind or response type;
- event and action IDs not being reused after restore;
- malformed action, settlement, status, time, or deadline state.

Timed actions must use an injected fake clock or equivalent deterministic time source. Tests must never wait for real seconds.

ADR 0016 defines the shared contract; action-specific tests remain required for each later API and UI behavior.

The implemented ADR 0018 runtime foundation adds manual validated-plan coverage for button, text, number, unlabelled choice, identifier-labelled choice, and numeric-labelled choice. Tests cover exact normalization/parsing, ambiguous typed choices, canonical transcript ordering and requesting-speaker provenance, duplicate/stale/unknown/wrong-kind classification, checkpoint JSON round trips, terminal continuation, exact UTF-8 and option boundaries, malformed actions/settlements, and hostile completion capture. Every rejected completion compares the complete canonical snapshot so RNG state, event/action counters, destinations, ownership, and continuation cannot change unnoticed. Parser/compiler syntax and browser UI coverage remain assigned to their later implementation slices.

## Browser E2E gate

Real browser automation becomes required after the cross-origin host shell and player exist. Coverage should then include:

- iframe sandboxing;
- Content Security Policy;
- typed or otherwise strictly validated `postMessage` communication;
- startup, reload, reconnect, and fatal failure;
- checkpoint save and restore;
- Standard UI and package custom UI;
- focus and keyboard behavior;
- fullscreen and navigation;
- hostile or malformed host/player messages.

No browser framework is selected yet. Playwright or another dependency should be chosen only when a concrete browser surface and its maintenance requirements can be evaluated.

## Coverage and performance boundaries

The repository does not use an arbitrary mandatory line-coverage threshold such as 95 percent. Coverage may later help identify untouched branches and error paths, but correctness, determinism, restore equivalence, and boundary validation are more important than maximizing a percentage.

Performance benchmarks are separate from correctness tests. [`planning/POC-TO-ALPHA-BACKLOG.md`](planning/POC-TO-ALPHA-BACKLOG.md) tracks `POC-ENGINE-001 — Establish runtime performance criteria and a benchmark baseline`.

Performance workloads should measure long-running runtime-state growth as well as instruction throughput. This includes growth in runtime-managed identities, snapshots, checkpoints, cloning, validation, and serialization costs. Repeated scoped speaker creation is a representative workload, but measurements and reachability/lifetime analysis must precede any reclamation or garbage-collection rule.

## Reproducibility requirements

Tests and benchmarks should use:

- fixed RNG seeds;
- bounded loops, recursion, depth, generated input, and total work;
- clear scenario names;
- failing source, seed, mutation, and boundary context in assertion output;
- no external network dependency in ordinary unit tests;
- no real-time sleeping;
- clean deterministic CI behavior;
- exact commands and failures reported in pull-request descriptions.

## Parser depth boundary

Node 24 regression coverage includes deeply nested parentheses, unary and `not` chains, collection literals, templates, and blocks below the source-size limit. Over-limit input must return one stable `TSP027` diagnostic without a native stack exception.
