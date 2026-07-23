# Current design

## Product and architecture

- Browser-first community platform with accounts, forum, catalog, editor, and tease player.
- Backend: PHP 8 with Laravel and PostgreSQL.
- Parser/runtime core: TypeScript compiled to JavaScript.
- Laravel remains the only public backend; do not add a second public Node server.
- The player, engine, Standard Library, package libraries, and custom UI eventually run in a sandboxed cross-origin iframe.
- `main.tease` is the fixed package entry point.
- Use one deterministic engine, one state model, and one save format for finite sessions and long-running personalities.

## TeaseScript authority

`docs/specifications/accepted-syntaxes-v30.md` is the current accepted syntax specification.

`docs/planning/V30-TO-V31-GAP-REVIEW.md` is not accepted syntax. It records proposed additions, identified conflicts, and missing capabilities. V30 wins when it conflicts with older documents unless Peter confirms a newer choice.

Important current syntax includes:

- speaker declarations;
- `speaker existingIdentifier` to set the default speaker;
- `say` and `say as`;
- double-quoted strings and backtick interpolation;
- variables, expressions, functions, control flow, lists, storage, timers, media, date/time, scheduling, and account-facing APIs as defined by V30.

ADR 0013 accepts the unique `set` collection after V30. Set literals use
`set[...]`, explicit element types use `type set`, sets preserve insertion
order and use copy semantics, and sets are not indexable. This is unrelated to
the rejected use of `set` as an assignment keyword; direct assignment remains
`score = 20`.

ADR 0014 defines the current core runtime value semantics. Variable
declarations and direct assignments recursively copy ordinary lists, sets, and
script objects. Cyclic values are rejected with structured runtime errors.
Sets currently accept only scalar and `null` elements. Empty collection
`.first`, `.last`, and `.random` access is an error and does not consume RNG
state. A speaker without an explicit or derived display name uses its
identifier and emits one developer warning when that fallback is first used.

## Current POC milestones

### 1. Parser and core-language foundation — complete

The implemented core slice includes the tokenizer, parser, AST, diagnostics,
source spans, literals and expressions, variables and assignments, lexical
`if`/`else` blocks, speakers, `say`, `say as`, `exit`, lists, objects, and the
accepted ordered scalar set.

### 2. Serializable runtime and standalone playground — current

The current vertical slice adds:

- a semantic-validation pass for the implemented syntax;
- a flat, versioned, JSON-safe instruction plan with source spans;
- explicit, versioned, JSON-safe deterministic runtime state;
- low-level instruction stepping and higher-level event-boundary stepping;
- sequenced typed events and structured runtime failures;
- a self-contained plan-and-snapshot checkpoint;
- a versioned serializable deterministic RNG;
- a standalone browser-first development playground that loads
  `examples/playground/main.tease`.

The runtime executes the compiled instruction plan, not AST nodes. The browser
transcript remains UI state rather than runtime snapshot state.

The playground does not yet implement the future cross-origin iframe host,
Laravel communication, persistence, accounts, media, input, or timers.

## Required design discipline

- AST nodes carry source locations.
- The parser does not perform runtime execution.
- Runtime output is represented as typed events, not direct HTML.
- The AST is compile-time data; runtime execution uses a validated serializable
  instruction plan.
- Runtime snapshots and checkpoints are explicit versioned JSON-safe data and
  do not depend on a suspended JavaScript call stack.
- Build later runtime actions, handles, events, and execution frames as
  explicit state.

## Accepted architectural boundaries

- `.tease` modules are executable content.
- `.ts` libraries are programming logic.
- Normal TypeScript named exports form the public library API; tooling generates signatures and editor metadata.
- Package code has no unrestricted external network access.
- Server-persistent events require explicit execution-location and missed-event behavior.
- Same parser/runtime/state model supports sessions and persistent personalities.
- ADR 0015 defines the serializable instruction-plan, runtime-state,
  checkpoint, stepping, event-sequence, and deterministic-RNG boundaries.

## Major post-POC gaps

The following are not parser-POC blockers:

- custom-view API and lifecycle;
- TypeScript import/linkage syntax from `.tease`;
- rich module metadata and selection;
- execution-frame ownership for timers, buttons, media, and views;
- media lifecycle controls;
- typed storage and session recovery;
- account, toy, history, locks, and global data implementations;
- persistent scheduler semantics;
- continuous-personality lifecycle, assignments, reports, permissions, statuses, and procedure queue;
- LLM, camera, distribution, and moderation systems.

Consult the V30-to-V31 review and post-POC backlog before designing these.
