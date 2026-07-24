# Agent instructions

## Read before changing files

For every substantive task, read:

1. `README-FIRST.md`
2. `CURRENT-DESIGN.md`
3. `PHASE-STATUS.md`
4. `docs/specifications/accepted-syntaxes-v30.md` when language syntax or semantics are involved
5. the task-specific current document or planning file
6. relevant ADRs in `docs/decisions/`
7. `docs/OPEN-DECISIONS.md` when resolving a gap

Do not treat planning documents, wishes, research files, historical audits, or source examples as accepted decisions.

## Working rules

- Use English for source code, identifiers, comments, documentation, package metadata, editor text, and UI text.
- Do not silently change architecture, language semantics, security boundaries, or product scope.
- `.tease` is not TypeScript. Advanced reusable code belongs in `.ts` libraries.
- Keep one engine, one state model, and one save/checkpoint format.
- Laravel is the only public backend.
- Preserve deterministic source evaluation order and explicit JSON-safe pause/resume state.
- Validate external, checkpoint, host, package, and future integration data at runtime.
- Choose the simplest design that meets the current milestone.
- Do not add dependencies without documenting need, alternatives, maintenance impact, and security impact.
- Do not weaken tests to hide failures.
- Do not implement deferred capabilities merely because they appear in planning or reference material.

## Before substantive coding

State briefly:

- files expected to change;
- acceptance criteria;
- major risks or unresolved decisions.

Then work in small verifiable steps.

## Verification

Run all configured formatting, linting, type checking, build, relevant unit/integration tests, playground smoke tests, and diff checks. Report the exact commands and remaining failures or risks. If a check is not configured or could not be run, state that rather than inventing success.

## Git workflow

- Keep `main` stable and usable.
- Do not make substantive changes directly on `main`.
- Create one short-lived branch per clear task.
- Keep each branch limited to one clear purpose.
- Make small logical commits with concise English imperative messages.
- Push the branch and open one pull request to `main`.
- State scope, intentionally deferred work, verification, and remaining risks in the pull request.
- Review the complete diff for accidental files, debug code, secrets, unrelated changes, and stale documentation.
- Prefer squash merge after checks pass, then delete the branch.
- Never force-push or rewrite `main`.

## Milestone discipline

Use `PHASE-STATUS.md` and the current task/PR description to identify active work. Do not rely on stale parser-POC or earlier-branch wording. Select the next milestone explicitly; do not expand a focused branch into timers, media, iframe integration, Laravel, modules, or unrelated V30 syntax without revising the plan and recording the decision.
