# Optimization / maintenance candidates

- **Status:** Active candidate inventory
- **Authority:** Non-authoritative and evidence-dependent
- **Use when:** Considering focused optimization or maintainability work from current repository evidence
- **Do not use for:** Architecture, product requirements, accepted capacity claims, or scheduled implementation

## Purpose

This file records concrete optimization and maintenance opportunities worth preserving without turning them into
accepted architecture, product requirements, or scheduled implementation scope. A candidate becomes implementation work
only after the owner or coordinator selects it and creates a focused issue. Accepted behavior remains defined by
specifications, ADRs, and current topic documents.

Historical evidence may age as surrounding code changes. Revalidate a candidate when it is selected for implementation,
not after unrelated merges. Before a broad redesign, also bound how much of the relevant workload the candidate can
actually improve. Detailed historical evidence remains in Issue #294 and its linked optimization/audit history.

Priorities record the current best classification from the recent optimization work; they are triage aids, not schedules
or capacity policy:

- **P1 — realistic native-JavaScript failure removal:** valid, realistically large or complex `.tease` content can
  fail instead of merely running slowly.
- **P2 — material performance or memory opportunity:** evidence indicates potentially substantial CPU, memory,
  allocation, representation-size, latency, or throughput improvement.
- **P3 — lower-value or speculative opportunity:** expected gains are smaller or uncertain, or the native-JavaScript
  failure is currently known only from extreme or synthetic input.

## Split large production modules along existing responsibilities

### Candidate scope

Consider mechanically splitting these large implementation modules while preserving their supported exports and behavior:

```text
src/runtime/state.ts
src/runtime/engine.ts
```

`src/parser.ts` is also large, but its cursor, recovery, diagnostics, and AST construction are tightly coupled. Do not split it merely because of line count; require a concrete maintenance problem and a coherent boundary first.

### Motivation

A responsibility-based split may provide:

- less source context for focused agent and reviewer work;
- fewer merge conflicts when compiler, validator, state, and execution work proceed in parallel;
- clearer ownership of invariants and their tests;
- easier navigation and more focused reviews;
- less risk that a small change requires loading or touching an entire multi-thousand-line module.

The goal is maintainability and parallel-development safety, not reducing the total line count.

### Risks and constraints

A split also creates costs:

- a large mechanical diff with little immediate user-visible value;
- merge conflicts with concurrent work in the same modules;
- additional files and imports that can become indirection when boundaries are too fine;
- premature module boundaries that may need to move again;

Any implementation must therefore:

- preserve current supported public exports;
- preserve runtime, diagnostic, event, checkpoint, and serialization behavior;
- avoid combining file movement with semantic changes or performance optimization;
- avoid generic plugin, visitor, service-container, or dependency-injection frameworks;
- use ordinary internal TypeScript modules and functions;
- keep each pull request focused on one coherent module group;
- run the full relevant verification after every split.

### Possible starting direction

The following is a candidate sequence, not an accepted module architecture:

1. `src/runtime/state.ts`: separate snapshot types, creation, cloning, and focused validation areas behind the existing `state.ts` module.
2. `src/runtime/engine.ts`: separate public execution boundaries, instruction dispatch, expression evaluation, calls, prepared references, and event construction behind the existing `engine.ts` module.
3. Reassess `src/parser.ts` only after concrete evidence shows that a split would improve rather than obscure its shared parser state.

Exact filenames and boundaries must be derived from the repository state at implementation time. This list does not authorize a broad rewrite.

### When to schedule

Consider creating a focused implementation issue only when current evidence identifies a concrete maintenance problem,
an import/export and test-ownership inventory shows a stable boundary, and the split can be reviewed without bundled
semantic work.

Prefer one module group and one owning agent per pull request. Sequence the pull requests rather than moving all large
modules at once.

## Optimization candidates

### P1 — realistic native-JavaScript failures

- **Source parser nesting.** Recent optimization work found valid nested source paths that can exhaust the native
  JavaScript stack during parsing. This is P1 because the failure prevents compilation rather than merely slowing it;
  observed host-stack depths are diagnostics, not TeaseScript limits.
- **Semantic-expression and ordinary-lowering traversal.** Recent work also found source-side recursive semantic and
  lowering stack cliffs outside the already repaired unary-wrapper path. This is P1 for the same compile-failure reason;
  when repaired, inspect the related stages together so the native failure is not merely moved downstream.

### P2 — material performance or memory opportunities

- **Captured-array downstream execution.** Common operations on captured arrays showed a material downstream CPU penalty
  in the recent optimization work. Prefer narrow hot-consumer repairs first; changing the representation may require an
  Owner decision.
- **Caller-temporary collection copying.** Call-heavy work showed material CPU/allocation cost from copying complete
  caller-temporary collections around function transitions. Prefer simple ownership transfer or narrower copying before
  copy-on-write or journaling, while preserving call, fault, and checkpoint/resume semantics.

### P3 — lower-value or speculative opportunities

- **Public plan-expression traversal.** `validateExpression(...)`, `Evaluator.evaluate(...)`, and
  `collectPreparedReferenceIds(...)` can hit native stack failures on extremely deep hand-built plans. Keep them as one
  repair family, but current evidence is synthetic rather than a realistic authored-source blocker.
- **Deep checkpoint JSON serialization.** Extremely deep valid runtime state can reach a native `JSON.stringify(...)`
  stack failure during checkpoint serialization. The failure is real, but a robust serializer-level repair is not
  justified without more realistic persistence evidence.
- **Other recursive source paths.** Nested-template lexer state and semantic scope-parent traversal remain possible
  stack-resilience follow-ups, but current evidence does not justify promoting them above P3.
- **Profiling-driven engine work.** Validator pass/index sharing, snapshot-analysis laziness, temporary aggregation,
  function-prologue simplification, snapshot liveness work, and prepared-reference/temporary/binding/speaker indexes
  remain hypotheses to revisit only when profiling makes their total contribution material.
- **Further source-location compression.** Tables, tuples, or delta-style encoding could reduce representation size
  beyond the current compact location record, but previous alternatives did not justify their added complexity.
- **Tooling-only allocation.** Playground line-number rendering and development-server request/body copying may matter
  at very large authoring scale; keep any future repair with the tooling surface rather than the core engine.
