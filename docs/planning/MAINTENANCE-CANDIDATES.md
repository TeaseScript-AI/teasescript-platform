# Maintenance candidates

**Status:** Non-authoritative maintenance planning

**Scheduling:** Unscheduled

**Gate:** Not currently required for POC, pre-alpha, or alpha

## Purpose

This file records concrete maintenance opportunities that may improve development and review work but are not accepted architecture decisions, product requirements, or scheduled implementation scope.

A candidate becomes implementation work only after the owner or coordinator selects it, confirms the current repository evidence, and creates a focused issue. Accepted behavior remains defined by specifications, ADRs, and current topic documents.

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

- smaller context windows for agents and reviewers;
- fewer merge conflicts when compiler, validator, state, and execution work proceed in parallel;
- clearer ownership of invariants and their tests;
- easier navigation and more focused reviews;
- less risk that a small change requires loading or touching an entire multi-thousand-line module.

The goal is maintainability and parallel-development safety, not reducing the total line count.

### Risks and constraints

A split also creates costs:

- a large mechanical diff with little immediate user-visible value;
- temporary merge conflicts with active runtime hardening;
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

Consider creating focused implementation issues after:

- current overlapping runtime hardening, facade-retirement, and cleanup work has landed;
- an import/export and test-ownership inventory identifies stable boundaries;
- the proposed split can be reviewed as a mechanical change without bundled semantic work.

Prefer one module group and one owning agent per pull request. Sequence the pull requests rather than moving all large modules at once.
