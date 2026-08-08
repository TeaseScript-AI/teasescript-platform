# Current phase status

## Current phase and gate

The current implementation phase is the deterministic TypeScript language/runtime POC with a local browser
playground. This file records verified capability state at a high level; it is not the canonical source for source
identity, live CI state, detailed contracts, or historical execution evidence.

Owner-selected obligations that remain open before a POC, pre-alpha, or alpha gate are tracked in
[`docs/planning/POC-TO-ALPHA-BACKLOG.md`](docs/planning/POC-TO-ALPHA-BACKLOG.md). Inclusion there does not schedule
work or accept syntax, architecture, or implementation details.

## Implemented capability groups

- **Source pipeline:** lexer, parser, immutable AST, source spans, diagnostics, semantic validation, and compilation
  for the implemented TeaseScript subset.
- **Language foundation:** values, variables, assignments, speakers, output, collections, expressions, templates,
  control flow, deterministic random built-ins, and top-level user-defined functions.
- **Deterministic runtime:** versioned JSON-safe instruction plans, runtime snapshots, checkpoints, explicit loop and
  call state, deterministic RNG state, typed sequenced events, instruction budgets, and defensive restore validation.
- **Pending-action foundation:** compiler-owned blocking `wait` plus one generic typed foreground-interaction action
  and settlement family with deterministic checkpoint/restore and canonical transcript events.
- **Development and verification:** a standalone browser playground, source-to-runtime conformance coverage,
  focused runtime/checkpoint/corruption tests, and a bounded deterministic property campaign.

These summaries are orientation only. The current topic documents below are canonical for the detailed implementation
contracts and boundaries.

## Current major exclusions and blockers

- complete V30 coverage, complete static typing, and units/date/time/duration values;
- author-facing Standard Library interaction syntax, smart-autoplay pacing, Standard Player controls, editor support,
  and final interaction acceptance coverage;
- populated background actions, general timers, media actions, camera lifecycle, and custom views;
- the cross-origin player-host protocol and production browser security integration;
- TypeScript library linkage, final Standard Library/package identity and compatibility, richer module selection, and
  community dependency resolution;
- Laravel/PostgreSQL persistence, accounts, catalog, publishing, moderation, scheduling, continuous personalities,
  and LLM/vision integration.

Current unresolved choices are recorded in [`docs/OPEN-DECISIONS.md`](docs/OPEN-DECISIONS.md). Concrete
implementation work is tracked in GitHub issues rather than in this status file.

## Verification entrypoint

Use the runtime version declared by [`.nvmrc`](.nvmrc) and the dependency graph declared by
[`package.json`](package.json) and [`package-lock.json`](package-lock.json):

```shell
npm ci
npm run check
git diff --check
```

Inspect the complete diff and any affected security or playground route matrix. Resolve live pull-request and CI
state from GitHub.

## Current topic sources

- Product scope and current implementation focus: [`docs/PRODUCT.md`](docs/PRODUCT.md)
- Architecture and component boundaries: [`CURRENT-DESIGN.md`](CURRENT-DESIGN.md) and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Accepted syntax baseline and implemented language subset:
  [`docs/specifications/accepted-syntaxes-v30.md`](docs/specifications/accepted-syntaxes-v30.md) and
  [`docs/TEASESCRIPT.md`](docs/TEASESCRIPT.md)
- Runtime, actions, checkpoints, and current internal formats: [`docs/RUNTIME.md`](docs/RUNTIME.md)
- Engine primitives and libraries: [`docs/LIBRARIES.md`](docs/LIBRARIES.md)
- Playground, editor, simulator, and debugger: [`docs/CODE-EDITOR.md`](docs/CODE-EDITOR.md)
- Testing strategy and configured verification: [`docs/TESTING.md`](docs/TESTING.md)
- Security and trust boundaries: [`docs/SECURITY.md`](docs/SECURITY.md)
