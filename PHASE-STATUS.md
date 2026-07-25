# Current phase status

## Evidence boundary

- Current repository baseline for this status update: `b67e5f947e628ad4d3784fadf3a8a9c5003055aa` on `main`.
- The seven-item implemented-foundation hardening set tracked by issue #7 is complete at this baseline, including the compiler/template work in PR #19, RNG-state work in PR #20, and the direct-AST non-finite-number boundary repair in PR #34.
- PR #37 added sequenced `TSW002` developer warnings when `list.remove(value)` finds no matching value while preserving the unchanged list.
- PR #48 completed the owner-selected reusable runtime resume-equivalence outcome tracked as `POC-ENGINE-002`, with a shared test-only helper and bounded corpus that checks every completed instruction boundary through a real JSON checkpoint round trip.
- PR #46 rejects ordinary instruction-plan control-flow targets that cross between root and function execution regions before execution or checkpoint restore.
- Final post-merge verification reported for PR #46 at this baseline passed with 294 tests, 0 failures, and a successful TypeScript build.
- Live pull-request and GitHub Actions status must be checked in GitHub; this file records the implemented repository state rather than live CI metadata.

## Implemented in the current repository code

### Language foundation

- Lexer, parser, immutable AST, UTF-16 source spans, structured diagnostics, and semantic validation.
- Literals, expressions, variables, assignments, lexical blocks, speakers, `say`, `say as`, contextual speaker behavior, and `exit`.
- Lists, objects, insertion-ordered scalar sets, deep ordinary-value copying, and current collection/runtime errors.
- Recursive nested template literals inside interpolation, including preserved escapes, source spans, structured unterminated-template diagnostics, and existing recovery behavior.
- `compileSource(...)` rejection of non-finite numeric literals through exact-span `TSC001`, while large finite literals remain valid and failed compilation returns no plan.
- Unsuccessful `list.remove(value)` calls leave the list unchanged and emit one sequenced `TSW002` developer warning per call.

### Serializable deterministic runtime

- Versioned JSON-safe instruction plans and runtime snapshots.
- Self-contained checkpoints with defensive validation.
- Typed sequenced runtime events and structured failures.
- Versioned deterministic `xorshift32-v1` state with non-zero seed and restored-state validation.
- One-instruction and event-boundary stepping with instruction budgets.
- Standalone repository-backed browser playground and constrained development server.
- Reusable deterministic resume-equivalence coverage that compares uninterrupted execution with execution restored from a JSON-roundtripped checkpoint after every completed instruction boundary across a small bounded runtime-state corpus.

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
- Shared non-finite-literal AST validation and semantic validation before direct `Program` compatibility execution.
- Defensive direct lowering with `TSC001` for non-finite numeric literals and `TSC003` for excess positional arguments.
- Explicit rejection of host `RuntimeSpeaker` values at the compatibility boundary.
- Own-property-only runtime builtin registration and prototype-free named builtin arguments.
- Automatic visible-list selection restricted to strings and finite numbers after one item is selected.

The current plan, snapshot, and checkpoint formats are version 3 POC formats. The completed hardening and test-infrastructure work did not change these format versions.

## Verification expected before merge

```shell
nvm use
npm ci
npm run check
npm run build
git diff --check
```

Also inspect the complete diff and verify the playground route/security matrix. Do not infer current CI status from this file.

## Not completed

- complete V30 syntax/runtime coverage and static typing;
- units, date/time/datetime/duration;
- choices, input, waits, timers, and resumable pending actions;
- cross-origin iframe host protocol;
- media lifecycle and custom views;
- TypeScript library linkage and richer modules;
- Laravel persistence, accounts, catalog/publishing, moderation, scheduling, and global data;
- continuous-personality services and LLM/vision integration.

The next implementation milestone remains unselected. Owner-selected pre-alpha and alpha obligations are tracked in `docs/planning/POC-TO-ALPHA-BACKLOG.md`; inclusion there does not schedule them.
