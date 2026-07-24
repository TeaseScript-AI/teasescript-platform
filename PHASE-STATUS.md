# Current phase status

## Evidence boundary

- Last independently recorded merged `main` baseline before the function milestone: `348170dd75598a1265f82e22a1f0e3cd8a639321`.
- Function hardening code commit immediately before this documentation update: `df51ebe` on `feature/functions-runtime`.
- User-provided terminal output reported 239 passing tests, zero failures, successful TypeScript build, and a successful push of that commit.
- Live pull-request, merge, and GitHub Actions status must be checked in GitHub; this file does not substitute for live repository metadata.

## Implemented in the current repository code

### Language foundation

- Lexer, parser, immutable AST, UTF-16 source spans, structured diagnostics, and semantic validation.
- Literals, expressions, variables, assignments, lexical blocks, speakers, `say`, `say as`, contextual speaker behavior, and `exit`.
- Lists, objects, insertion-ordered scalar sets, deep ordinary-value copying, and current collection/runtime errors.

### Serializable deterministic runtime

- Versioned JSON-safe instruction plans and runtime snapshots.
- Self-contained checkpoints with defensive validation.
- Typed sequenced runtime events and structured failures.
- Versioned deterministic RNG state.
- One-instruction and event-boundary stepping with instruction budgets.
- Standalone repository-backed browser playground and constrained development server.

### Control flow

- Comments, ranges, deterministic random built-ins, `else if`, `repeat`, list/set/range `for`, `while`, `break`, and `continue`.
- Explicit serializable loop frames and restore inside active loops.

### User-defined functions and hardening

- Top-level functions, required/default parameters, positional/named calls, returns, nested calls, direct recursion, and mutual recursion.
- Explicit serializable call frames, caller temporaries, scope/loop ownership, and structural call-depth limits.
- Source-order-preserving lowering across composite expressions and assignments.
- Checkpoint-safe prepared references for assignment targets and mutable collection receivers, including list-index rebasing and speaker aliases.
- Complete suspended-caller temporary liveness validation.
- Strict function prologue/region, checkpoint-progress, and prepared-reference validation.
- Central V30 protected-name enforcement.

The current plan, snapshot, and checkpoint formats are version 3 POC formats.

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

The next milestone must be selected explicitly after the function-runtime PR is resolved.
