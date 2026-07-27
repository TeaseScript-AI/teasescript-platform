# Property and fuzz testing roadmap

**Status:** Implementation roadmap; test infrastructure is not yet implemented  
**Implementation issues:** #120 (Phase 1), #121 (Phase 2)  
**Related architecture work:** #118 and draft PR #119  
**Authority:** `docs/TESTING.md`, accepted ADRs, and implemented public contracts remain authoritative

## Purpose

Recent runtime reviews found several defect classes that example-based tests did not expose early enough:

- a plan accepted by validation could later produce a snapshot rejected by the runtime's own validator;
- checkpoint fields could be individually valid but mutually inconsistent;
- canonical results, transcript data, and destination temporaries could disagree;
- action and event capacity could be sufficient for request creation but insufficient for later completion;
- bounded data limits did not always bound validation work;
- a continuation could exist syntactically while still allowing impossible live temporary state at an exit.

These findings do not indicate that the deterministic architecture must be replaced. They show that the repository needs reusable executable invariants in addition to focused regression tests and manual review.

The selected approach has two implementation phases:

1. add a small deterministic mutation/property harness around existing plans, snapshots, actions, checkpoints, and public runtime operations;
2. extend that same harness with grammar-based TeaseScript generation and model-based pending-action lifecycles after the relevant source and pacing features exist.

This document records placement, sequencing, CI, homelab, and agent-preparation guidance. It does not implement either phase and does not redefine accepted language or runtime behavior.

## Principles

The testing system must follow these rules:

- the repository is the source of truth;
- required CI runs a small deterministic budget;
- optional homelab runs use the same repository implementation with larger explicit budgets;
- every failure is reproducible from a reported seed and operation/case description;
- every confirmed defect becomes a focused permanent regression test;
- generated work is explicitly bounded by depth, size, operation count, and total work;
- public compilation, validation, execution, completion, checkpoint, and restore boundaries are the system under test;
- no production API is added solely for fuzzing;
- no second engine or duplicate canonical state machine is created;
- a new dependency is selected only after concrete implementation evidence and the normal dependency review.

A random-byte fuzzer is not the primary design. Most valuable cases begin with valid domain objects or valid source and then explore controlled mutations and state transitions.

## Repository placement

The current test command discovers compiled root test files through:

```text
dist/tests/*.test.js
```

Therefore the staged harness should retain one root test entrypoint while placing reusable modules below it:

```text
tests/property.test.ts

tests/property/
  prng.ts
  fixtures.ts
  mutations.ts
  invariants.ts
  replay.ts
```

Phase 2 extends this same directory rather than creating a separate framework:

```text
tests/property/
  source-generator.ts
  source-model.ts
  operation-generator.ts
  runtime-model.ts
  reducer.ts
```

File names may be adjusted when implementation evidence supports a clearer cohesive split. The durable requirements are:

- the configured runner discovers the root entrypoint;
- helper modules remain test-only;
- both phases share deterministic seed and replay infrastructure;
- canonical/public boundaries are imported rather than compiler-private or runtime-private internals;
- temporary compatibility facades receive focused compatibility coverage where required, but do not become the harness's canonical API.

## Relationship to the source-layout proposal

Issue #118 and draft PR #119 propose Option A: focused extraction of shared plan contracts, runtime actions/operations, library tooling, Standard Library ownership, and Player/workspace code while retaining one package and one runtime.

That proposal is non-authoritative until approved. The fuzz roadmap must follow its final accepted outcome rather than its current draft paths.

When Option A is accepted and implemented, the harness should align with these ownership rules:

- shared plan model/capture/validation are exercised through their canonical public boundary;
- runtime actions may contain pure action-specific models, validation, and resolution;
- canonical snapshot mutation, event allocation, settlement, and continuation advancement remain exercised through public runtime operations;
- `src/instructions.ts` and other legacy-path facades receive narrow compatibility tests during migration;
- new property-test code does not import legacy facade paths as its normal implementation dependency;
- source-layout movement alone must preserve plans, snapshots, checkpoints, diagnostics, events, RNG behavior, and test results.

Phase 1 is therefore particularly useful before the physical behavior-neutral migration. It can prove stronger closure, replay, and checkpoint invariants while files move.

## Phase 1 — deterministic mutation and invariant harness

Implementation issue: #120

### Timing

- begin from current `main` after #110 is merged;
- prefer to land before the physical Option A migration;
- when migration work has already started, coordinate one merge order rather than duplicating file moves or helpers;
- do not wait for Player, editor, browser, Laravel, or final Standard Library packaging work.

### Inputs

Phase 1 starts from valid test fixtures:

- instruction plans;
- fresh, running, waiting, completed-continuation, halted, and failed snapshots;
- delay and interaction actions;
- settlements;
- completion requests;
- checkpoints before and after JSON round trips.

Fixtures should use real public compile/runtime paths where available. Hand-built valid plans remain acceptable where author-facing syntax is not implemented yet, provided the public plan validator accepts them before mutation.

### Mutations

Controlled mutations should cover:

- missing, extra, and wrong-typed fields;
- boundary, unsafe, non-finite, `0`, and `-0` numbers;
- instruction positions and continuation ownership;
- action, event, speaker, frame, loop, scope, and temporary identities;
- pending destination and settlement/result relationships;
- status/action/settlement chronology;
- technical string and collection limits;
- format versions;
- cyclic, sparse, accessor, prototype-sensitive, and hostile object data where the public boundary accepts unknown host values.

### Core properties

```text
accepted plan + valid snapshot + successful runtime operation
=> resulting snapshot passes the public validator

invalid or duplicate completion
=> no canonical snapshot, event, RNG, counter, or destination mutation

checkpoint -> JSON -> restore
=> equivalent canonical plan and snapshot

restore then continue
=> equivalent to uninterrupted deterministic execution

mutated external plan/snapshot/checkpoint/request
=> documented structured acceptance or rejection without hang, silent repair,
   partial execution, or incidental native exception for expected invalid data

same seed + same budget
=> same cases, mutations, operation order, and result
```

Phase 1 does not require a complete abstract runtime model or grammar-based source generator.

## Phase 2 — grammar and model-based source/runtime testing

Implementation issue: #121

### Timing

- depends on Phase 1;
- begins after #111 and #112 are merged;
- uses the actual implemented author-facing interactions, `say` pacing, `chatPacingGate`, and existing `wait` behavior;
- preferably contributes before or alongside #115's final ADR 0018 acceptance work when explicitly scheduled;
- does not depend on Player rendering or editor UI completion.

### Generated source

The generator should produce bounded meaningful valid programs and targeted near-valid variants using:

- literals, expressions, templates, collections, and deterministic random expressions;
- branches, loops, functions, calls, returns, and exits;
- speakers and `say`;
- `wait`;
- `showButton`;
- `askText`;
- `askNumber`;
- labelled and unlabelled `choose`;
- implemented smart-autoplay, exact pacing, `0`, `instant`, `skippable`, and `unskippable` forms;
- protected-name conflicts;
- source-order and result-consumption paths;
- exact and near-limit data.

It should not generate all token sequences uniformly. Structured generation creates valid programs; targeted mutations create useful invalid programs.

### Model-based operations

The model chooses operations from the current observable state:

```text
run
step or run-to-event
checkpoint
serialize and deserialize
restore
observeTime
completeAction with valid data
completeAction with invalid, wrong-kind, unknown, stale, or duplicate data
resume
```

The abstract model tracks only enough externally observable information to generate legal and intentionally illegal operations:

- runtime status;
- active foreground/background actions;
- action and event identities;
- pending result domain;
- injected session time;
- retained settlement;
- continuation eligibility.

It must not duplicate the full production engine as an oracle.

### Core properties

```text
compile success
=> public plan validation succeeds

compile failure
=> deterministic diagnostics and spans without uncontrolled native failure

accepted source + fixed runtime seed/configuration + fixed host operations
=> identical plans, snapshots, events, settlements, and final results

successful operation
=> resulting snapshot validates

checkpoint -> JSON -> restore -> continue
=> equivalent to uninterrupted execution

source expressions and side effects
=> evaluated once in accepted source order across pending-action boundaries
```

Phase 2 also combines several pending actions in one lifecycle, including pacing followed by wait or interaction, loops/functions with repeated interactions, restore while pending, duplicate/invalid completion before a later valid completion, and branch/return/exit cleanup.

## CI and homelab model

Both phases use the same implementation with different budgets.

### Required pull-request CI

- fixed deterministic seed set or explicit stable seed schedule;
- small bounded case and operation count;
- no real-time sleep;
- no network dependency;
- stable runtime across supported CI machines;
- failure output includes replay data.

The smoke budget belongs in the normal required check after implementation. Exact budgets must be selected from measured runtime rather than guessed in this planning document.

### Extended local or homelab runs

- run the same repository command;
- accept explicit seeds and run counts;
- use larger but still bounded campaigns;
- print or store enough information to replay failures;
- do not maintain an unpublished fork of the generators or invariants.

A future scheduled self-hosted GitHub runner is a separate security and operations decision. Untrusted pull-request code must not automatically execute on a private homelab merely because the extended command exists.

## Failure and regression workflow

```text
generated failure
-> report seed, case, mutation/source, operations, and first failing boundary
-> replay deterministically
-> reduce to the smallest practical reproduction
-> file or update a focused bug issue when needed
-> add a named permanent regression test
-> repair the root cause
-> keep the broader property case as additional coverage when useful
```

Automatic shrinking is useful but not required for Phase 1. Phase 2 may add a small deterministic reducer or justify a property-testing dependency after concrete experience.

## Dependency policy

The repository currently uses TypeScript and Node's built-in test runner and has no property-testing dependency.

Phase 1 should use existing tools first. `fast-check` or another dependency may be proposed later only when there is a demonstrated need, such as:

- maintainable generation of state-machine command sequences;
- reliable shrinking that a small local reducer cannot reasonably provide;
- substantially lower maintenance than the no-dependency implementation.

Any proposal must document:

- the missing capability;
- no-dependency alternatives;
- maintenance and ownership;
- security implications;
- lockfile and CI impact.

Documentation alone does not select the dependency.

## Agent and Codex preparation

Relevant future pull requests should remain property-testable without implementing unrelated fuzz infrastructure.

For parser, compiler, plan, runtime, state, action, checkpoint, and validated host-boundary changes, agents should:

- preserve deterministic source order and explicit time/RNG inputs;
- keep resumable state JSON-safe and explicit;
- ensure accepted plans and successful runtime operations close over their public validators;
- route untrusted data through capture and validation boundaries;
- preserve structured invalid-data behavior;
- avoid hidden process-global mutable state and direct real-time waits;
- provide reusable test fixtures when they simplify valid state construction;
- add a focused regression for every confirmed defect.

These rules are recorded concisely in `AGENTS.md`. They do not require every feature pull request to add random generators, seeds, a fuzzing dependency, or new infrastructure. Issues #120 and #121 own that work.

## Explicitly deferred

- browser DOM and cross-origin host fuzzing;
- Player keyboard, focus, accessibility-rendering, and iframe automation;
- editor UI fuzzing;
- Laravel, database, account, network, LLM, media, camera, and device integration;
- distributed fuzzing infrastructure;
- crash dashboards;
- coverage-guided native fuzzing;
- production benchmarks;
- automatic self-hosted execution of untrusted pull-request code.

These areas may receive later focused issues when their concrete boundaries exist.
