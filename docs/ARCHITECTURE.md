# Architecture

## Accepted boundaries

- PHP 8 with Laravel is the only public backend; PostgreSQL is the database.
- The TeaseScript parser/runtime core is TypeScript compiled to JavaScript.
- Laravel may later invoke a local Node/TypeScript CLI; no second public Node server is accepted.
- `main.tease` is the package entry point.
- `.tease` modules are executable content; `.ts` libraries provide reusable programming logic.
- One engine, state model, and save/checkpoint format support sessions and persistent personalities.
- The final player and package code run inside a sandboxed cross-origin iframe.
- Package code has no unrestricted external network access.

## Implemented deterministic vertical slice

```text
main.tease
    -> parse
    -> semantic validation
    -> versioned JSON-safe instruction plan
    -> explicit versioned runtime state
    -> typed sequenced events
    -> standalone browser playground
```

ADR 0015 defines the current runtime direction. The AST is compile-time data. Runtime execution uses validated instruction plans and explicit scopes, loop frames, call frames, temporaries, RNG state, event sequence state, prepared references, and structured failures. It does not depend on suspended JavaScript functions, generators, closures, or an implicit JavaScript call stack.

Prepared references and suspended-continuation liveness are internal runtime mechanisms used to preserve source order and validate checkpoint restore; they are not new TeaseScript syntax.

## Performance boundary

JSON-safe after every instruction boundary does not mean serializing or persisting after every instruction. The POC exposes one-instruction stepping for testing/debugging and event-boundary stepping for normal use. Production execution may mutate validated in-memory state between checkpoint boundaries and serialize only when required, provided observable semantics and restore behavior remain identical.

## Deferred architecture

The cross-origin host protocol, pending input/timer actions, media handles, server checkpoint persistence, package identity/migrations, and continuous-personality scheduling remain later work.
