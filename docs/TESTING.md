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
- playground HTTP and static-path security tests;
- a repository-owned deterministic Phase 1 mutation/property harness for plan and runtime-state boundaries.

The source-layout refactor keeps the required property layout unchanged and
adds `tools/check-legacy-imports.mjs` to the normal `npm run check` path. The
check is dependency-free, scans static import/export specifiers, resolves
relative `.js`/`.ts` paths, and reports each legacy import with its file, line,
original specifier, and canonical replacement. Facades, the dedicated
compatibility test, and its isolated invalid-import fixtures are the only
documented exceptions; focused tests cover local, deep, canonical, and allowed
specifier forms.

The repository currently has no browser-automation dependency and no external property-testing dependency. New dependencies require a demonstrated need and the normal maintenance and security review.

## Test layers

The testing strategy uses complementary layers:

```text
lexer/parser/semantic unit tests
source-to-runtime contract tests
runtime invariant and checkpoint tests
external-data validation and corruption tests
deterministic property and mutation tests
player/host integration tests
browser E2E tests
performance benchmarks
```

Focused tests isolate syntax, diagnostics, lowering, validators, and runtime operations. Source-to-runtime tests prove that the public compilation and execution path preserves the accepted behavior. Runtime invariant and corruption tests cover explicit serializable state and restore boundaries. Future integration and browser tests cover concrete player/host surfaces after those surfaces exist.

End-to-end testing does not replace focused unit, validator, and invariant tests.

## Regression-test rule

Every confirmed defect fix requires a focused regression test. The test should normally fail on the unmodified baseline for the reported root cause and pass after the repair.

Do not weaken tests to hide failures. Do not fold unrelated speculative cases into a focused repair pull request. A newly suspected defect should first be reproduced against the relevant public boundary before it is documented or filed as established behavior.

A failing test is evidence, not by itself a new product contract or review
blocker. Classify whether it demonstrates accepted behavior failing through a
supported public or trusted path, corruption of canonical/persisted state, or a
real determinism or security boundary failure. A fixture, generator, replay
record, private helper, or manually fabricated unreachable state that fails
without such a consequence is normally a test-harness issue, optional
hardening, or future work. Test-owned IDs, signatures, layouts, and helper
identity may support reliable replay without becoming public compatibility
promises.

This distinction does not reduce coverage at real boundaries. Reproducible
failures in source-to-runtime behavior, checkpoint/restore equivalence,
structured external-data rejection, atomic mutation, deterministic ordering,
or other accepted invariants remain correctness defects and require the
appropriate focused regression.

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

## Implemented Phase 1 property and mutation harness

Issue #120 implements a deterministic, test-owned harness around the current public plan, snapshot, pending-action, completion, checkpoint, restore, and resume boundaries. It uses Node's built-in test runner and adds no dependency or production-only hook.

### Layout and discovery

```text
tests/property.test.ts
tests/property/
  prng.ts
  fixtures.ts
  mutations.ts
  invariants.ts
  replay.ts
```

`tests/property.test.ts` is a root test entrypoint, so the existing `dist/tests/*.test.js` compiled-test discovery executes the smoke campaign through the normal `npm run check` path. Helper modules remain test-owned and import the public exports from `src/index.ts`.

### Commands and budgets

```shell
npm run test:property -- --profile smoke --seed 1364229357 --runs 128
npm run test:property:extended -- --seed 1591436852 --runs 10000
```

The required smoke profile defaults to seed `1364229357` and `128` cases. The current mandatory catalog contains `102` ordered cases, all executed at the start of every smoke run; the remaining cases use the repeatable deterministic schedule. The extended profile defaults to seed `1591436852` and `10,000` cases. A moderate implementation-verification budget is `2,000` cases.

Both commands compile the repository before invoking the same `dist/tests/property/replay.js` campaign implementation. After one successful build, independent larger processes may safely use the compiled entrypoint directly with separate seeds:

```shell
node dist/tests/property/replay.js --profile extended --seed 1591436852 --runs 100000
```

Do not run several build-producing npm commands concurrently against one checkout. Separate compiled processes are read-only and may run in parallel.

### CLI and replay contract

Supported options are:

- `--profile smoke|extended`;
- `--seed` as a decimal integer from `1` through `4294967295`;
- `--runs` as a decimal integer from `1` through `1000000`;
- `--case` as one zero-based case index below the configured run count;
- `--progress-every` from `0` through `1000000`.

Signs, fractions, exponents, non-finite text, unsafe values, unsupported ranges, duplicate options, unknown options, and missing values fail clearly. Argument failures return exit status `2`; property or infrastructure failures return `1`; success returns `0`.

Every property failure reports the seed, run budget, case index, mutation/operation ID, property, first boundary, case-specific fixture/state context, generated variant, cause, and an exact command such as:

```shell
npm run test:property:extended -- --seed 12345 --runs 250 --case 17
```

Progress is concise and periodic. Progress and success lines report the exact accumulated case work units as well as case counts. Successful large campaigns produce one final signature line. The same seed and budget reproduce the same cases, variants, operation order, observations, work-unit total, and signature.

Composite invariant helpers wrap each direct public stage. Failure output therefore reports the first failing stage, such as `createCheckpoint`, `serializeCheckpoint`, `deserializeCheckpoint`, `completeAction:uninterrupted`, or `run:resumed-remainder`, instead of only a composite descriptor label.

### Explicit generation bounds

The harness permits at most:

- `1,000,000` cases;
- at most three controlled field mutations per case;
- sixteen conservative direct-public-boundary work units per case;
- a declared maximum generated graph depth of `64`;
- `16,000,000` total case-execution work units.

Every case definition declares a conservative `workUnits` ceiling. One measured unit represents one direct call to a documented public validation, runtime, completion, checkpoint, serialization, deserialization, or restore boundary. The harness instruments these calls during execution, rejects a case that performs no public boundary, and fails when measured calls exceed the declared ceiling. Composite resume-equivalence cases currently declare twelve units. Module initialization rejects missing, unsafe, zero, or over-sixteen metadata. Before fixture construction, the campaign derives the exact selected schedule, sums its ceilings, and rejects a total above the configured bound. Progress and final output report the measured executed total; the configured ceiling remains available for comparison. Deterministic schedule-generation overhead and the fixed fixture-catalog setup are bounded separately from public-operation work and do not vary per executed boundary.

Each case also declares a conservative controlled-mutation count from zero through three. Module initialization rejects invalid metadata, the selected schedule is summed before execution, and progress/final output report the accumulated declared mutation count.

Technical boundary cases use the accepted interaction limits: at most the exact accepted string/collection boundary for valid fixtures and one unit over it for rejection fixtures. There is no real-time sleep, network access, process-global generator state, or unpublished homelab implementation.

### Fixtures and mutation domains

Fixture construction prefers real public compile and runtime paths. Because author-facing interaction syntax is not implemented yet, interaction fixtures replace a compiled `wait` instruction with the current public interaction instruction shape and must pass `validateInstructionPlan(...)` before execution. Every baseline plan and snapshot is validated before mutation.

The catalog covers fresh, running, waiting, continuation-ready, halted, and failed snapshots; delay and generic interaction actions; settlements; valid, invalid, duplicate, stale, and unknown completions; checkpoints; JSON round trips; speakers; scopes; loops; calls; and temporaries. Builders assert the exact lifecycle status, pending-action kind, interaction kind, settlement, and active frame structures promised by each fixture name before the catalog is frozen.

The complete fixture catalog is recursively frozen. Every case receives that same immutable catalog, and the campaign verifies the freeze before and after execution. A required regression also proves that a case observed inside a full campaign has the exact same trace entry as isolated `--case` replay.

Controlled mutations cover:

- missing, extra, and wrong-typed fields according to each documented boundary;
- zero, negative zero, exact numeric boundaries, unsafe integers, and non-finite numbers;
- action/event, speaker, scope, loop, call-frame, and temporary identities;
- instruction targets, continuation ownership, destinations, settlement/result relationships, and status chronology;
- unsupported plan, snapshot, and checkpoint versions;
- exact-limit and over-limit strings and option collections;
- sparse arrays, cycles, throwing accessors, non-plain objects, and prototype-sensitive own keys.

Unknown extra fields are observed according to the current contract; the harness does not assume they must be rejected. For the current version-1 completion request boundary, an unknown top-level field is accepted and ignored: the harness compares the complete operation result with the same completion request without that field.

### Executable properties

The shared assertions enforce:

```text
accepted plan + valid snapshot + successful public runtime operation
=> result snapshot passes the public validator
=> input plan and input snapshot remain unchanged

invalid or duplicate completion
=> complete canonical state and emitted events remain unchanged

checkpoint creation
=> checkpoint plan and snapshot equal the original canonical inputs

checkpoint -> JSON -> restore
=> complete canonical plan and snapshot equality with those original inputs

restore then continue
=> complete event and final-snapshot equality with uninterrupted execution

mutated external plan/snapshot/checkpoint/request
=> documented structured acceptance or rejection without incidental native failure,
   hang, partial mutation, or hidden continuation

same seed + same budget
=> same complete trace of cases, variants, measured boundary order, mutations, and observations
=> same SHA-256 signature
```

The mandatory catalog is pinned by ordered case ID and count, rejects duplicate IDs, and must fit inside the smoke budget. Known PRNG vectors, a seed/index descriptor vector, and the complete 128-case smoke SHA-256 signature are pinned. The required smoke test captures and compares the exact trace twice; the CLI prints only the compact digest.

A genuine internal programming defect is not concealed. Each confirmed production defect must be reduced to a focused named regression test and handled in the owning repair issue or a separate blocker rather than by weakening the property.

### Large-campaign handoff

A practical first Codex/homelab campaign is `100,000` cases for each of several explicit seeds, for example `1591436852`, `1`, `305419896`, and `3735928559`. On Node `24.18.0`, the strengthened implementation measured `2,000` direct cases in about `1.58` seconds after build with approximately `149` MB maximum resident memory. The complete required suite passed `505` tests in about `7.40` seconds including build with approximately `446` MB maximum resident memory. These measurements are environment-specific; use progress output for unattended runs and derive revised estimates from the target machine.

No private configuration or unpublished helper is required. Record any failure's seed, runs, case, property, boundary, state summary, and replay command on the implementation pull request. Rerun the exact case after every harness repair. Convert confirmed production defects to permanent focused regressions and separate issues where the repair is unrelated or substantial.

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

## Future Phase 2 source and model-based testing

Future Phase 2 fuzz and property tests must use fixed seeds and report the failing seed and generated input. Initial implementation should use existing tools unless a demonstrated need justifies a dependency.

Useful generated inputs include:

- short token sequences;
- nested templates and interpolations;
- bounded nested collections;
- expressions and calls;
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

Phase 1 does not select `fast-check` or another dependency. Phase 2 may propose one only after concrete implementation evidence and the normal dependency review.

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

The implemented ADR 0018 runtime foundation adds manual validated-plan coverage for button, text, number, unlabelled choice, identifier-labelled choice, and numeric-labelled choice. Tests cover exact normalization/parsing, ambiguous typed choices, canonical transcript ordering and requesting-speaker provenance, duplicate/stale/unknown/wrong-kind classification, checkpoint JSON round trips, destination absence before action creation, immutable settlement replay plus separate live/released result lifecycle after intervening instructions and across suspended caller temporaries, destination liveness through branches/loops/returns/exits, rejection of ambiguous lifecycle merges and newer foreground actions while a result is live, bounded interaction control-flow work, exact event-capacity boundaries, exact UTF-8 and option boundaries with measurement instrumentation, unknown persisted fields, malformed actions/settlements, and hostile completion capture. Every rejected completion compares the complete canonical snapshot so RNG state, event/action counters, destinations, ownership, and continuation cannot change unnoticed. Parser/compiler syntax and browser UI coverage remain assigned to their later implementation slices.

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
