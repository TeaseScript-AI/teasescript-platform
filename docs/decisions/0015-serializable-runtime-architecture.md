# ADR 0015 — Serializable runtime architecture

**Status:** Accepted

## Compile-time and runtime representations

The AST is a compile-time representation. The deterministic runtime executes a
compiled instruction plan and never executes AST nodes directly.

An instruction plan is explicitly versioned plain JSON-safe data. Instructions
and structured expression plans retain their relevant source spans. A plan may
not contain JavaScript closures, functions, class instances, `Map`, `Set`,
`Date`, `undefined`, symbols, or Node-specific objects. Expressions may remain
structured expression plans; this decision does not require a stack-bytecode
expression VM.

Plans are validated before execution. Control-flow targets must be explicit and
valid instruction positions. Malformed or unsupported plan versions are
rejected with structured errors.

## Runtime state

Runtime state is explicit, versioned, deterministic, and JSON-safe. For the
currently implemented language subset it contains:

- the next instruction position;
- lexical environment and scope frames;
- runtime bindings and values;
- mutable declared-speaker state;
- the current default speaker;
- temporary contextual-speaker state when applicable;
- deterministic RNG algorithm and state;
- developer-warning deduplication state;
- the next runtime-event sequence number;
- runtime status;
- structured failure information after execution fails.

Execution may not depend on a suspended JavaScript call stack, an
unserializable generator, closures, or implicit module-global mutable state.
Host and built-in capabilities are injected explicitly and are not serialized
as part of runtime state.

## Checkpoints

A POC checkpoint is a versioned JSON-safe, self-contained bundle containing the
instruction plan and runtime snapshot. Restoring a checkpoint validates the
checkpoint, plan, and snapshot format versions and rejects malformed or
unsupported data through structured errors.

Future production storage may store a package plan separately and save its
identity with mutable runtime state. That backend design is outside this
decision and outside the current POC.

## Execution levels

The runtime exposes two stepping levels:

1. execute exactly one instruction;
2. continue until the next externally visible runtime event, halt, or
   structured error.

The browser playground uses the event-boundary operation so a normal `Step`
click produces visible progress. Full execution has a configurable instruction
budget; exhausting it produces a structured runtime error instead of hanging.

## Events

Runtime output consists of typed events and never direct HTML. Every event has
a monotonically increasing sequence number. A restored checkpoint continues
with the snapshot's next sequence number so event identities do not repeat.

The browser transcript is UI state and is deliberately not part of the core
runtime snapshot.

## Deterministic random source

The standalone playground uses a versioned `xorshift32` implementation with an
explicit algorithm identifier, one unsigned 32-bit state value, a configurable
seed, and a documented fixed example seed. The algorithm is deterministic and
serializable, but is not cryptographically secure and is not permanent
TeaseScript syntax. Its version permits deliberate migration later.
