# Current phase status

## Current phase and gate

The current implementation phase combines the deterministic TypeScript language/runtime POC with the
production-direction Vue Player foundation and local browser development surfaces. This file records verified
capability state at a high level; it is not the canonical source for source identity, live CI state, detailed
contracts, or historical execution evidence.

Owner-selected release-stage outcomes, including work that remains open for POC / Foundation or Alpha, are tracked
in [`docs/planning/RELEASE-ROADMAP.md`](docs/planning/RELEASE-ROADMAP.md). Roadmap placement does not schedule work or
accept syntax, architecture, or implementation details.

## Implemented capability groups

- **Source pipeline:** lexer, parser, immutable AST, source spans, diagnostics, semantic validation, and compilation
  for the implemented TeaseScript subset.
- **Language foundation:** values, variables, assignments, speakers, output, collections, expressions, templates,
  control flow, deterministic random built-ins, and top-level user-defined functions.
- **Deterministic runtime:** versioned JSON-safe instruction plans, runtime snapshots, checkpoints, explicit loop and
  call state, deterministic RNG state, typed sequenced events, instruction budgets, and defensive restore validation.
- **Pending-action, compact-interaction, and chat-pacing foundation:** compiler-owned blocking `wait`; protected
  compact `showButton`, `askText`, `askNumber`, and `choose` forms lowered into one typed foreground-interaction
  family; and ADR 0018 `say` smart/exact pacing with one resumable `chatPacingGate`, deterministic checkpoint/restore,
  prepared output, typed skip settlement, and interaction/`wait` composition.
- **Development and verification:** a standalone browser playground with Standard interaction and pacing controls; a
  modular production-oriented Player presentation POC with a verified, design-neutral Vue 3 Phase 1 foundation
  (Vue/Vite, Tailwind CSS 4, repository-owned local shadcn-vue source/config, the selected Reka primitive foundation,
  and TanStack Vue Virtual as the single bounded, variable-height, stable-anchor transcript owner) connected through a
  framework-independent adapter to the implemented deterministic interaction, transcript, pacing, time-observation,
  checkpoint, and restore slice; the Vue reference now hosts development-only Visual Lab, Layout Debug, and Runtime
  Session tools while the manual/vanilla Player remains transitional legacy pending removal; source-to-runtime
  conformance coverage; focused runtime/checkpoint/state-validation tests;
  reproducible desktop and narrow-screen browser smoke coverage; and a bounded deterministic property campaign.

These summaries are orientation only. The current topic documents below are canonical for the detailed implementation
contracts and boundaries.

## Current major exclusions and blockers

- complete V30 coverage, complete static typing, and units/date/time/duration values;
- production cross-origin Player/host integration, richer editor support, and final browser acceptance coverage;
- background-action kinds beyond `chatPacingGate`, general timers, media actions, camera lifecycle, and custom views;
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
- Browser editor and current playground authoring surface: [`docs/CODE-EDITOR.md`](docs/CODE-EDITOR.md)
- Debugger, simulator, and diagnostic execution: [`docs/DEBUGGER.md`](docs/DEBUGGER.md)
- Testing strategy and configured verification: [`docs/TESTING.md`](docs/TESTING.md)
- Security and trust boundaries: [`docs/SECURITY.md`](docs/SECURITY.md)
