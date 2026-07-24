# Read this first

## Authority and conflict handling

Use project material in this order:

1. Check whether an accepted ADR or an explicitly recorded post-V30 owner decision covers the exact issue. A later accepted decision overrides V30 only within its stated scope.
2. Otherwise use `docs/specifications/accepted-syntaxes-v30.md` for accepted TeaseScript syntax and semantics.
3. Use `CURRENT-DESIGN.md` and `PHASE-STATUS.md` for current architecture and implementation status.
4. Use the task-specific current topic document in `docs/`.
5. Use `docs/planning/` for proposals, gaps, and deferred work; planning text is not an accepted decision by itself.
6. Use `WISHES.xml` for product intent and decision history; an active wish is not automatically an implementation decision.
7. Treat capability research, old project packages, audit reports, and source examples as non-authoritative reference material.

When files conflict, identify the exact conflict. Do not silently combine historical syntax, planning proposals, and accepted syntax.

## Current implementation scope

The current repository implementation includes:

- lexer, parser, immutable AST, source spans, diagnostics, and semantic validation;
- core values, variables, assignments, speakers, output, collections, expressions, comments, ranges, conditionals, loops, and deterministic random built-ins;
- versioned JSON-safe instruction plans, runtime snapshots, checkpoints, deterministic RNG state, typed sequenced events, and explicit loop frames;
- top-level user-defined functions, required/default parameters, positional/named calls, returns, recursion, and explicit serializable call frames;
- source-order-preserving expression and assignment lowering, checkpoint-safe prepared references, complete suspended-caller temporary validation, and centralized V30 protected-name enforcement;
- a standalone fixed-example browser playground.

Instruction plans, runtime snapshots, and checkpoints currently use version 3. These are POC formats, not permanent public wire-format promises.

This does not mean that the complete V30 language, static type system, timers, input, media, cross-origin player host, Laravel persistence, accounts, publishing, or continuous personalities are implemented.

## Stable architecture boundaries

- Regular executable content uses `.tease`; advanced reusable programming logic uses real TypeScript in `.ts`.
- `main.tease` is the fixed package entry point.
- Laravel with PostgreSQL is the only public backend.
- Parser/runtime code is TypeScript compiled to JavaScript.
- Keep one deterministic engine, one state model, and one save/checkpoint format.
- Runtime execution uses validated explicit state and may not depend on a suspended JavaScript call stack.
- JSON-safe after every instruction boundary does not require persisting after every instruction.
- The final player and package code run inside a sandboxed cross-origin iframe.
- Package code has no unrestricted external network access.

## Documentation routing

- `CURRENT-DESIGN.md`: current architecture and implementation boundaries.
- `PHASE-STATUS.md`: current milestone status and verification evidence.
- `AGENTS.md`: coding, review, and Git workflow rules.
- `docs/README.md`: documentation map.
- `docs/DOCUMENTATION-OWNERSHIP.md`: which material belongs in GitHub versus the shared project research archive.
- `docs/specifications/`: accepted consolidated specifications.
- `docs/decisions/`: accepted and proposed ADRs.
- `docs/planning/`: non-authoritative proposals and backlog.
- `docs/reference/`: routing notices for research intentionally stored outside this repository.
