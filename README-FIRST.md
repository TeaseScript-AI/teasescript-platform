# Read this first

## Authority and conflict handling

Use project material in this order:

1. Check whether an accepted ADR, accepted specification, or controlling current topic document covers the exact
   issue. A post-V30 owner decision becomes durable only after it is synchronized into the applicable accepted owner.
   Chat, issue, pull-request, test, review, or wish text remains evidence or task context until that synchronization
   occurs.
2. For TeaseScript syntax and semantics, use `docs/specifications/accepted-syntaxes-v30.md` unless a later accepted
   ADR or accepted specification update supersedes the exact point within its stated scope.
3. Use `CURRENT-DESIGN.md` and `PHASE-STATUS.md` for current architecture and implementation status.
4. Use the task-specific current topic document in `docs/`.
5. Use `docs/planning/POC-TO-ALPHA-BACKLOG.md` for owner-selected work that remains required before its target gate. Inclusion does not schedule the item and does not define architecture or syntax.
6. Use other files in `docs/planning/` for proposals, gap analysis, and legacy backlog material; planning text is not an accepted decision by itself.
7. Use `WISHES.xml` for product intent and decision history; an active wish is not automatically an implementation decision or backlog commitment.
8. Treat capability research, old project packages, audit reports, and source examples as non-authoritative reference material.

When files conflict, identify the exact conflict. Do not silently combine historical syntax, planning proposals, and accepted syntax.

## Current implementation scope

The current repository implementation includes:

- lexer, parser, immutable AST, source spans, diagnostics, and semantic validation;
- core values, variables, assignments, speakers, output, collections, expressions, comments, ranges, conditionals, loops, and deterministic random built-ins;
- versioned JSON-safe instruction plans, runtime snapshots, checkpoints, deterministic RNG state, typed sequenced events, and explicit loop frames;
- top-level user-defined functions, required/default parameters, positional/named calls, returns, recursion, and explicit serializable call frames;
- source-order-preserving expression and assignment lowering, checkpoint-safe prepared references, complete suspended-caller temporary validation, and centralized V30 protected-name enforcement;
- a standalone fixed-example browser playground.

The current internal instruction-plan, runtime-snapshot, and checkpoint format revisions are documented in [`docs/RUNTIME.md`](docs/RUNTIME.md). These are POC formats, not permanent public wire-format promises.

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

Start with applicable `AGENTS.md` instructions and the assigned issue or pull
request. Then use this route to load only task-controlling sources. Before
implementation, final self-review, or an explicitly assigned pull-request review,
read `docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md`. Read
`docs/review-and-audit/AUDIT.md` only for an explicitly assigned audit; ordinary
work does not load both routes. Read `CURRENT-DESIGN.md` for
architecture-affecting or broad cross-component work and `PHASE-STATUS.md` for
milestone, gate, integration-status, or current-capability work.

- `CURRENT-DESIGN.md`: current architecture and implementation boundaries.
- `PHASE-STATUS.md`: current phase, gate, and high-level implemented-capability status.
- `AGENTS.md`: coding, review, and Git rules for every agent.
- `docs/review-and-audit/`: role-based implementation, review, and explicitly
  assigned audit guidance.
- `docs/DEVELOPMENT-WORKFLOW.md`: coordinator, executor, pull-request, documentation, and final-verification workflow.
- `tools/chatgpt-project-agent/docs/LOCAL-AGENT-BOOTSTRAP.md`: project-agent source layout, current bootstrap route, and remaining #210 migration work.
- `docs/README.md`: documentation map.
- `docs/DOCUMENTATION-OWNERSHIP.md`: mandatory documentation-edit/review guidance and the boundary between canonical repository material and shared research.
- `docs/specifications/`: accepted consolidated specifications.
- `docs/decisions/`: accepted and proposed ADRs.
- `docs/OPEN-DECISIONS.md`: unresolved choices; read it only when the task depends on a gap that current authority does not resolve.
- `docs/planning/POC-TO-ALPHA-BACKLOG.md`: selected work required before a stated POC, pre-alpha, or alpha gate, but not automatically scheduled.
- `docs/planning/`: other non-authoritative proposals, gap analysis, and legacy backlog material.
- `docs/reference/`: routing notices for research intentionally stored outside this repository.
