# Current phase status

## Evidence boundary

- Current repository baseline for this status update: `926f4a4bb2583103b7379251e88bc0b7b7472e62` on `main`, including the synchronized status update before issue #124.
- The seven-item implemented-foundation hardening set tracked by issue #7 is complete, including the compiler/template work in PR #19, RNG-state work in PR #20, and non-finite-number source-compiler diagnostics in PR #34.
- PR #37 added sequenced `TSW002` developer warnings when `list.remove(value)` finds no matching value while preserving the unchanged list.
- PR #48 completed the owner-selected reusable runtime resume-equivalence outcome tracked as `POC-ENGINE-002`, with a shared test-only helper and bounded corpus that checks every completed instruction boundary through a real JSON checkpoint round trip.
- PR #46 rejects ordinary instruction-plan control-flow targets that cross between root and function execution regions before execution or checkpoint restore.
- PR #45 rejects core and configured injected builtin identifiers when they are used as ordinary runtime values while preserving direct builtin calls.
- PR #117 completed issue #110 by implementing the generic typed foreground-interaction runtime, shared version-1 interaction limits, canonical player transcript events, typed completion, and versioned checkpoint/restore behavior.
- PR #206 completed issue #173's testing-strategy work: source-to-runtime conformance is the primary safety net, backed by focused runtime/checkpoint/corruption tests and a small deterministic property campaign.
- PR #119 recorded the owner-approved Option A source-layout proposal; issue #124 applies its behavior-neutral physical implementation from this baseline.
- Final verification for PR #206 uses Node `v24.18.0` and npm `11.16.0`; typecheck, build, the bounded property campaign, focused source/runtime suites, the complete configured check (440 tests, 0 failures), full-output check, and diff check pass on its final implementation head.
- Live pull-request and GitHub Actions status must be checked in GitHub; this file records the implemented repository state rather than live CI metadata.

## Implemented in the current repository code

### Local playground workspace

- Native textarea editing of local `.tease` source, versioned local drafts, explicit example reload, bounded local import/export, source revisions, and stale-runtime gating.
- A shared DOM-free compile/run/step helper used by the browser workspace and ephemeral loopback-only development automation routes.
- Technical rendering for current typed pending-action events and `waiting` status without browser clock settlement.

### Language foundation

- Lexer, parser, immutable AST, UTF-16 source spans, structured diagnostics, and semantic validation.
- Literals, expressions, variables, assignments, lexical blocks, speakers, `say`, `say as`, contextual speaker behavior, and `exit`.
- Lists, objects, insertion-ordered scalar sets, deep ordinary-value copying, and current collection/runtime errors.
- Recursive nested template literals inside interpolation, including preserved escapes, source spans, structured unterminated-template diagnostics, and existing recovery behavior.
- `compileSource(...)` rejection of non-finite numeric literals through exact-span `TSC001`, while large finite literals remain valid and failed compilation returns no plan.
- Unsuccessful `list.remove(value)` calls leave the list unchanged and emit one sequenced `TSW002` developer warning per call.
- Core and configured injected builtin identifiers are rejected as non-first-class runtime values while direct builtin calls remain valid.

### Serializable deterministic runtime

- Versioned JSON-safe instruction plans and runtime snapshots.
- Self-contained checkpoints with defensive validation.
- Typed sequenced runtime events and structured failures.
- Versioned deterministic `xorshift32-v1` state with non-zero seed and restored-state validation.
- One-instruction and event-boundary stepping with instruction budgets.
- Standalone repository-backed browser playground and constrained development server.
- Reusable deterministic resume-equivalence coverage that compares uninterrupted execution with execution restored from a JSON-roundtripped checkpoint after every completed instruction boundary across a small bounded runtime-state corpus.
- The approved Option A source-layout seams use canonical internal paths without a format change at that time; later runtime work changed the internal formats independently.
- Issue #180 retired the temporary source-layout facades and migration-only re-exports without changing plan, runtime-snapshot, or checkpoint formats.
- One generic typed foreground-interaction instruction/action/settlement family for runtime-created button, text, number, and choice actions.
- Engine-owned text normalization, number parsing, exact choice matching, requesting-speaker provenance, canonical player transcript derivation, mandatory retry behavior, and bounded duplicate settlement replay.
- Shared version-1 interaction limits of 65,536 UTF-8 bytes for one retained string, 65,536 aggregate UTF-8 bytes per interaction definition, and 4,096 choice options.

### Source-to-runtime conformance and deterministic property testing

- Representative real `.tease` source through the package-root compile/runtime path is the primary regression safety net for implemented author-facing syntax and source-reachable observable behavior.
- A small test-only deterministic campaign retains successful public-operation closure, rejected completion atomicity, checkpoint JSON/restore/resume equivalence, same-seed execution, and structured malformed plan/snapshot/checkpoint rejection. It supports exact seed/run/case replay on the same repository revision; its private ordering is not a compatibility contract.
- The same bounded required campaign now includes structured valid and near-valid source fuzzing. Each family uses small seed/case-derived source choices within fixed nesting, collection, loop/recursion, and instruction-budget limits. Valid cases prove plan/runtime closure and repeatable results; targeted near-valid cases prove stable structured diagnostics and no executable plan. There are no real waits or external inputs.
- The normal required check includes the bounded campaign; larger explicit-seed campaigns use the same implementation to explore additional source strings. Exact replay is scoped to the same repository revision and campaign implementation. The removed catalog/count identity, campaign signatures, private PRNG vectors, complete traces, fixture catalog, work/mutation accounting, profiles, and extended wrapper are not current requirements.

### Control flow

- Comments, ranges, deterministic random built-ins, `else if`, `repeat`, list/set/range `for`, `while`, `break`, and `continue`.
- Explicit serializable loop frames and restore inside active loops.
- Instruction-plan validation rejects ordinary jumps, loop edges, parameter-default targets, and call return targets that leave their owning root or function execution region.

### User-defined functions and hardening

- Top-level functions, required/default parameters, positional/named calls, returns, nested calls, direct recursion, and mutual recursion.
- Explicit serializable call frames, caller temporaries, scope/loop ownership, and structural call-depth limits.
- Source-order-preserving lowering across composite expressions and assignments.
- Checkpoint-safe prepared references for assignment targets and mutable collection receivers, including list-index rebasing and speaker aliases.
- Complete suspended-caller temporary liveness validation.
- Strict function prologue/region, checkpoint-progress, and prepared-reference validation.
- Central V30 protected-name enforcement.
- Source compilation rejects non-finite numeric literals before producing a plan.
- Internal compiler lowering retains focused `TSC003` diagnostics for malformed compiler inputs.
- Own-property-only runtime builtin registration and prototype-free named builtin arguments.
- Automatic visible-list selection restricted to strings and finite numbers after one item is selected.

The current internal instruction-plan, runtime-snapshot, and checkpoint format revisions are documented in [`docs/RUNTIME.md`](docs/RUNTIME.md). The implemented pending-action foundation supports compiler-owned blocking `wait` delays and one generic typed foreground-interaction action family. Result-bearing completion uses a short atomic commit into an ordinary runtime destination plus one nullable single-use handoff authority that survives settlement replacement only until the first canonical consume, transfer, return, discard, or exit instruction succeeds. The record is then removed immediately; no settlement-result live/released state or whole-plan interaction liveness analysis remains. Author-facing interaction syntax, smart-autoplay pacing, and Player UI remain unimplemented; background actions remain intentionally empty.

Issue #179 removed the temporary exact-token library catalog, TypeScript-export
extractor, external metadata validator, and tooling facade. They had no
selected runtime, compiler, editor, or package consumer. Future package
identity, linkage, metadata transport, validation, and library-aware editor
integration require a concrete producer and consumer; they are not current
infrastructure.

## Verification expected before merge

The exact Node.js version declared in `.nvmrc` is required. Activate that version with any suitable mechanism. When NVM is available, `nvm use` is one optional activation method; missing NVM, or NVM not seeing a version activated by `actions/setup-node`, a container, or another version manager, is not itself a verification failure. Confirm the effective environment before installing dependencies:

```shell
node --version
npm --version
npm ci
npm run check
git diff --check
```

Also inspect the complete diff and verify the playground route/security matrix. Do not infer current CI status from this file.

## Not completed

- complete V30 syntax/runtime coverage and static typing;
- units, date/time/datetime/duration;
- author-facing `showButton`, `askText`, `askNumber`, and `choose` syntax and lowering;
- `say` smart autoplay, `chatPacingGate`, populated background actions, visible/background timers, and Player interaction controls;
- cross-origin iframe host protocol;
- media lifecycle and custom views;
- TypeScript library linkage and richer modules;
- Laravel persistence, accounts, catalog/publishing, moderation, scheduling, and global data;
- continuous-personality services and LLM/vision integration.

PR #126 completes issue #124's approved behavior-neutral Option A source-layout
refactor. Owner-selected pre-alpha and alpha
obligations that remain open are tracked in `docs/planning/POC-TO-ALPHA-BACKLOG.md`;
inclusion there does not otherwise schedule them.
