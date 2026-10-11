# ADR 0024 — Shared variables in timer, media, and button blocks

**Status:** Accepted
**Decision source:** Owner decisions in issue #627 (2026-10-05, option C)

## Context

A timer expiry block, media block, or permanent button block runs later than the code that creates it. Until this
decision it saw only top-level names and its own locals, so the natural Stop button inside a function, or a reminder
that uses a function parameter, needed a global. #627 first proposed copying the used locals into the block; the owner
chose one shared variable instead.

## Decision

1. A block uses the variables visible where it is created, including the parameters and locals of a function and loop
   variables, as one variable shared with that code. The rules and examples are in V30 §14 (*Variables in timer, media,
   and button blocks*); top-level variables and globals stay shared as before.
2. Each function call, loop iteration, and run of a loop body has its own variables; nested blocks share their
   creator's. A variable lives while a resource or a queued or running block uses it, also after its function returned
   or its file entry was left. Assigning a variable cancels nothing.
3. Value semantics do not change (ADR 0014): only the variable is shared. A declaration, assignment, argument, or result
   still copies its value.
4. The runtime keeps no JavaScript closure. A resource, each queued block, and a running block record the scope that
   holds each shared variable by its ID, in checkpointed, validated state (ADR 0015, ADR 0016). A scope that its code
   leaves while a block still shares it is retained with only the variables a block shares, and dropped once nothing
   shares it.
5. Types follow ADR 0021 rule 5.5: a wait or other suspension cancels what is known about a local that a block shares
   and assigns, and a block starts without the narrowing of the code around it.

## Consequences

- A block cannot declare a local with the name of a variable it sees, which earlier blocks inside functions could.
- `docs/RUNTIME.md` describes the snapshot fields, their lifetime, and their validation.

## Alternatives considered

- Read-only copies made when the block is created: simple, but the Stop button cannot work and a reminder shows stale
  values.
- Private mutable copies per resource: the Stop button compiles but sets a copy, so the loop never ends.
- Separate cells for shared variables only: retains less data, but adds a second storage and lookup path for every
  variable, prepared reference, and checkpoint check.
