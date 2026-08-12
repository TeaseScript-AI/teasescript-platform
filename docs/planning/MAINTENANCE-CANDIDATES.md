# Optimization / maintenance candidates

- **Status:** Active candidate inventory
- **Authority:** Non-authoritative and evidence-dependent
- **Use when:** Considering focused optimization or maintainability work from current repository evidence
- **Do not use for:** Architecture, product requirements, accepted capacity claims, or scheduled implementation

## Purpose

This file records concrete optimization and maintenance opportunities worth preserving without turning them into
accepted architecture, product requirements, or scheduled implementation scope. A candidate becomes implementation
work only after the owner or coordinator selects it, current repository evidence is re-established, and a focused issue
is created. Accepted behavior remains defined by specifications, ADRs, and current topic documents. Broad release-stage
performance reassessment remains in [`RELEASE-ROADMAP.md`](RELEASE-ROADMAP.md); this file preserves concrete candidates
between such passes. Historical measurements and audit evidence for migrated optimization families remain in Issue #294
and the combined #306–#315 PR/audit history; this inventory keeps only current candidate rationale.

Revalidate every candidate against current `main` before implementation. Historical measurements preserve evidence
about a mechanism, but later changes may materially alter its reachability, cost, or expected benefit. Before a broad
optimization or redesign, also bound how much of the current workload the affected phase can actually improve; do not
add large complexity to optimize a small fraction of the relevant cost.

Optimization priorities below are triage aids, not schedules or capacity policy. Reclassify a candidate when current
evidence changes:

- **P1 — realistic native-JavaScript failure removal:** valid, plausibly authored or generated `.tease` content can
  fail rather than merely run slowly, so waiting longer cannot recover the operation.
- **P2 — material performance or memory opportunity:** evidence suggests potentially substantial CPU, memory,
  allocation, representation-size, latency, or throughput improvement.
- **P3 — lower-value or speculative opportunity:** expected gains are smaller or uncertain, or a native-JavaScript
  failure is currently demonstrated only for extreme or synthetic input without credible realistic reachability.

## Structural maintenance

### Split large production modules along existing responsibilities

Consider mechanically splitting these large implementation modules while preserving their supported exports and
behavior:

```text
src/runtime/state.ts
src/runtime/engine.ts
```

`src/parser.ts` is also large, but its cursor, recovery, diagnostics, and AST construction are tightly coupled. Do not
split it merely because of line count; require a concrete maintenance problem and a coherent boundary first.

A responsibility-based split may reduce source context, merge conflicts, and invariant ownership ambiguity while making
focused review and navigation easier. The goal is maintainability and parallel-development safety, not reducing total
line count.

A split also creates a large mechanical diff, additional imports and files, and the risk of premature boundaries. Any
implementation must therefore preserve supported public exports and runtime, diagnostic, event, checkpoint, and
serialization behavior; use ordinary internal TypeScript modules and functions; avoid generic plugin, visitor,
service-container, or dependency-injection frameworks; and avoid combining file movement with semantic changes or
performance optimization in the same pull request.

Possible starting sequence, not an accepted module architecture:

1. `src/runtime/state.ts`: separate snapshot types, creation, cloning, and focused validation areas behind the existing
   `state.ts` module.
2. `src/runtime/engine.ts`: separate public execution boundaries, instruction dispatch, expression evaluation, calls,
   prepared references, and event construction behind the existing `engine.ts` module.
3. Reassess `src/parser.ts` only after concrete evidence shows that a split would improve rather than obscure its shared
   parser state.

Exact filenames and boundaries must be derived from repository state at implementation time. Prefer one module group and
one owning agent per pull request, and sequence splits rather than moving all large modules at once.

## P1 — realistic native-JavaScript failure removal

### Source parser nesting

Valid deeply nested source forms have historically reached native JavaScript stack failures in parser paths for
parentheses, collections, templates, and nested blocks. These are source-reachable failures rather than mere throughput
costs, so targeted stack-safe repairs are P1 when current `main` still reproduces a realistic path; observed host depths
must not become TeaseScript limits.

### Semantic-expression and ordinary-lowering traversal

The combined optimization audit reproduced source-side recursive semantic-expression and ordinary-lowering stack cliffs
outside the already repaired unary-wrapper cases. Treat these as P1 only when current `main` reproduces a realistic
authored or generated source path; otherwise keep them P3 until reachability evidence strengthens. When repaired, treat
related traversal stages together far enough that the native stack cliff is not merely moved downstream.

## P2 — material performance or memory opportunities

### Captured-array downstream execution

Historical measurements showed materially slower common array operations on the engine-owned captured-array prototype
than on native arrays, while indexed access and JSON serialization were much closer. This remains P2 because array-heavy
runtime work could recover substantial CPU if current profiling confirms the cost; first prefer narrow hot-consumer or
intrinsic/indexed repairs, while changing the captured-array representation itself must preserve or deliberately
replace its inherited-numeric-setter protection and future mutable-array behavior.

### Caller-temporary collection copying

Earlier call-heavy measurements found material cost in copying complete active or suspended `callerTemporaries`
collections around function entry and return. This remains P2 because call-heavy workloads could recover substantial CPU
and allocation if the cost survives later call/value-copy optimizations; prefer simple ownership transfer or narrower
copying before considering copy-on-write or journaling, while preserving value-copy, liveness, nested-call, fault, and
checkpoint/resume behavior.

## P3 — lower-value or speculative opportunities

### Public plan-expression traversal family

Recursive `validateExpression(...)`, `Evaluator.evaluate(...)`, and `collectPreparedReferenceIds(...)` can hit native
stack failures on sufficiently deep structurally valid hand-built plans. Keep them as one traversal family so a repair
does not move the failure to the next stage, but current evidence is primarily extreme synthetic public-plan input
rather than realistic authored source, so the candidate remains P3 unless reachability evidence strengthens.

### Deep checkpoint JSON serialization

Deep valid canonical runtime state can survive capture, validation, and cloning and still reach a native stack failure
in `JSON.stringify(...)` during checkpoint serialization. The failure is real, but current evidence is extreme-depth
and a robust repair may require custom iterative serialization or a persistence representation choice, so it remains
P3 until realistic workloads justify that complexity; do not restore a generic content-depth limit to hide it.

### Additional source-side recursive traversal

Nested-template lexer state and semantic scope-parent traversal remain possible sibling stack-resilience areas beyond
the P1 source paths above. Preserve them as P3 until current source-reachable evidence shows a realistic native
failure or a local stack-safe repair is clearly simpler than retaining recursion.

### Plan-validator pass and index consolidation

Whole-plan correctness validation legitimately performs several passes. Sharing compatible operation-local
producer/target/owner analysis could reduce CPU, but the total validator phase bounds the maximum possible win and older
evidence did not justify large complexity, so pass fusion or indexing remains P3 unless current profiling makes it
material; never fuse checks merely to reduce traversal count or build a validation DSL.

### Snapshot plan-analysis reuse or laziness

Snapshot validation may derive plan analysis that a particular snapshot cannot use. Historical cost was small, so reuse
or lazy construction is P3 and should be considered only when current profiles show a material contribution rather than
adding caches or lifecycle complexity pre-emptively.

### Temporary-ID aggregation allocation

Broad lowering may still allocate intermediate temporary-ID arrays or `flatMap`-style aggregates after the dominant
quadratic suffix work was removed. The remaining opportunity is P3 because its current materiality is unproven; prefer a
simple streaming/append repair only if allocation profiles show this path still matters.

### Function-prologue simplification

Separate supplied/default parameter-prologue machinery may permit fewer instructions or simpler state. This is P3
because instruction-count reduction alone does not justify changing resumable `parameterState`, checkpoint boundaries,
or serialized formats; any format or compatibility impact follows the normal version/compatibility and, when required,
Owner route.

### Snapshot liveness work

Alternative worklists or compatible liveness-result reuse previously reduced structural work more clearly than wall
clock time. This remains P3 unless current profiles make liveness propagation material; the removal of historical
generic validation-work ceilings is not itself a reason to optimize it.

### Runtime lookup and index candidates

Prepared-reference scans across active/suspended temporaries, temporary-ID lookup/update/clear, lexical binding
slots/indexes, and speaker/property lookup indexes remain separate P3 hypotheses. Expected collection sizes and
invalidation, rebasing, shadowing, detachment, and checkpoint semantics can cost more than the scan itself, so add only
a local index whose current repeated-work hotspot is materially demonstrated rather than building a general indexing
framework.

### High-level public runtime-session ownership

A future high-level session API could amortize repeated low-level public capture boundaries for a real external host.
This is P3 because no current consumer requires that API shape and a generic trusted/prepared pipeline or provenance
registry would be premature; introducing such a public ownership/API boundary requires the normal Owner/architecture
route when a concrete consumer exists.

### Further source-location compression

Tables, tuples, relative/delta encoding, or line-index context could reduce plan bytes beyond the compact
`PlanSourceLocation` representation. They remain P3 because earlier alternatives traded bytes against complexity,
capture cost, or workload dependence; revisit only if current plan/checkpoint representation size again becomes a
material bottleneck.

### Playground/editor line-number rendering

Very large editor/playground buffers may allocate substantial temporary line splits or labels for line-number display.
This tooling-only candidate is P3 until representative source sizes make the allocation material; keep any repair with
the editor/tooling surface rather than the core engine.

### Playground development-server body copying

The local development server historically accumulated request chunks and then concatenated them before UTF-8 decode,
which can create an extra full-body copy for very large source uploads. This tooling-only candidate is P3 unless large
source transport becomes a representative development bottleneck.
