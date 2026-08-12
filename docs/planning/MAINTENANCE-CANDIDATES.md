# Optimization / maintenance candidates

- **Status:** Active candidate inventory
- **Authority:** Non-authoritative and evidence-dependent
- **Use when:** Considering focused optimization or maintainability work
- **Do not use for:** Architecture, product requirements, accepted capacity claims, or scheduled implementation

## Purpose

This file preserves concrete optimization and maintenance candidates worth remembering. They are neither scheduled nor
authoritative; implementation starts only after the owner or coordinator selects a candidate and creates a focused
issue.
Accepted behavior remains in specifications, ADRs, and current topic documents. Historical optimization evidence remains
in Issue #294 and the combined #306–#315 PR/audit history.

Revalidate a candidate when it is selected for implementation, not after unrelated merges; later changes may alter its
reachability, cost, or expected benefit. Before a broad optimization or redesign, also bound how much of the relevant
workload the affected phase can actually improve.

Priorities are triage aids, not schedules or capacity policy:

- **P1 — realistic native-JavaScript failure removal:** valid, realistically large or complex `.tease` content can fail
  rather than merely run slowly.
- **P2 — material performance or memory opportunity:** evidence indicates potentially substantial CPU, memory,
  allocation, representation-size, latency, or throughput improvement.
- **P3 — lower-value or speculative opportunity:** expected gains are smaller or uncertain, or a native-JavaScript
  failure is known only from extreme or synthetic input.

## Structural maintenance

### Split large production modules along existing responsibilities

Current candidates are `src/runtime/state.ts` and `src/runtime/engine.ts`. `src/parser.ts` is also large, but its parser
state is tightly coupled; do not split it by line count alone.

The useful outcome is lower source-context and merge-conflict cost with clearer invariant ownership. Keep a split
mechanical: preserve supported exports and runtime/diagnostic/event/checkpoint/serialization behavior, use ordinary
internal TypeScript modules, avoid new framework abstractions, and do not combine file movement with semantic or
performance changes. Derive exact boundaries when scheduled and keep each pull request to one coherent module group.

## P1 — realistic native-JavaScript failures

- **Source parser nesting.** Valid deeply nested source has reached native JavaScript stack failures in parser paths for
  parentheses, collections, templates, and nested blocks. This is P1 because the failure is source-reachable and
  terminates compilation; observed host depths are diagnostics, not TeaseScript limits.
- **Semantic-expression and ordinary-lowering traversal.** The recent optimization audit reproduced source-side native
  stack cliffs outside the unary-wrapper path fixed by #314. This is P1 because valid source can terminate compilation;
  inspect related stages together so a repair does not merely move the native failure downstream.

## P2 — material performance or memory opportunities

- **Captured-array downstream execution.** Historical measurements showed materially slower common built-ins on the
  captured-array prototype while indexed access and JSON serialization were near native. #315 changed surrounding costs,
  so reprofile when selected; prefer narrow hot-consumer repairs. Replacing the prototype requires an Owner decision
  about its current inherited-numeric-setter protection.
- **Caller-temporary collection copying.** Historical call-heavy measurements showed material CPU/allocation cost from
  copying complete `callerTemporaries` around function transitions. #307 and #315 changed surrounding costs, so
  reprofile
  when selected; prefer simple ownership transfer or narrower copying while preserving call, fault, liveness, and
  checkpoint/resume behavior.

## P3 — lower-value or speculative opportunities

- **Public plan-expression traversal.** `validateExpression(...)`, `Evaluator.evaluate(...)`, and
  `collectPreparedReferenceIds(...)` have produced native stack failures on very deep hand-built plans. Keep them as one
  repair family, but current evidence is synthetic rather than a realistic authored-source blocker.
- **Deep checkpoint JSON serialization.** Very deep valid runtime state can reach native `RangeError` in
  `JSON.stringify(...)` during checkpoint serialization. The failure is real, but current evidence is extreme and a
  robust repair is serializer/design-level; do not hide it behind a generic content-depth limit.
- **Other recursive source paths.** Nested-template lexer state and semantic scope-parent recursion remain P3 sibling
  stack paths until stronger source-reachability evidence or a simple local repair justifies work.
- **Profiling-driven engine work.** Validator-analysis sharing, snapshot-analysis/liveness work, temporary aggregation,
  function-prologue simplification, and prepared-reference/temporary/binding/speaker indexes remain lower-priority
  hypotheses. Revisit only when profiling shows a material repeated-work or allocation cost, and prefer local repairs
  over general frameworks.
