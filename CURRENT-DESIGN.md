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

The unique `set` collection capability was confirmed after earlier discussions but is absent from V30. Its final V31 syntax remains open. This is unrelated to the rejected use of `set` as an assignment keyword.

## Current POC milestones

### 1. Parser POC

Implement only what is necessary to prove source parsing:

- tokenizer/lexer;
- parser;
- AST types;
- source spans and diagnostics;
- automated parser tests;
- initial grammar slice for speaker declarations, default-speaker selection, `say`, `say as`, strings, template interpolation, property access, and `exit`.

Parsing must not execute code.

### 2. Speaker execution POC

Add a minimal event-based interpreter for:

- declared speakers;
- current default speaker;
- one-message `say as` override;
- temporary `speaker` context during interpolation;
- display-name resolution;
- `exit`;
- deterministic, testable `say` events.

No browser UI is required. A CLI or test event log is sufficient.

## Required design discipline

- AST nodes carry source locations.
- The parser does not perform runtime execution.
- Runtime output is represented as typed events, not direct HTML.
- Do not rely on a serializable JavaScript call stack for future pause/resume.
- Build later runtime actions, handles, events, and execution frames as explicit state.

## Accepted architectural boundaries

- `.tease` modules are executable content.
- `.ts` libraries are programming logic.
- Normal TypeScript named exports form the public library API; tooling generates signatures and editor metadata.
- Package code has no unrestricted external network access.
- Server-persistent events require explicit execution-location and missed-event behavior.
- Same parser/runtime/state model supports sessions and persistent personalities.

## Major post-POC gaps

The following are not parser-POC blockers:

- custom-view API and lifecycle;
- TypeScript import/linkage syntax from `.tease`;
- rich module metadata and selection;
- final `set` collection syntax;
- execution-frame ownership for timers, buttons, media, and views;
- media lifecycle controls;
- typed storage and session recovery;
- account, toy, history, locks, and global data implementations;
- persistent scheduler semantics;
- continuous-personality lifecycle, assignments, reports, permissions, statuses, and procedure queue;
- LLM, camera, distribution, and moderation systems.

Consult the V30-to-V31 review and post-POC backlog before designing these.
