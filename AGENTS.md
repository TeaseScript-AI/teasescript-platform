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
8. `docs/planning/POC-TO-ALPHA-BACKLOG.md` when proposing or selecting future POC/pre-alpha work
9. `docs/DEVELOPMENT-WORKFLOW.md` when creating implementation issues or participating in coordinated work

Do not treat planning documents, wishes, research files, historical audits, or source examples as accepted decisions. A backlog item is not implementation scope unless the current owner/coordinator assignment or phase plan explicitly schedules its ID.

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

## Issue sizing and execution recommendation

When creating or substantially refining an implementation issue:

- describe one coherent, reviewable task whenever practical;
- include evidence or reproduction, scope, exclusions, and acceptance criteria;
- state `Execution recommendation: Single agent` by default;
- recommend `Coordinated multi-agent` only with a concrete reason why one agent or independently mergeable issues are insufficient;
- do not recommend multiple agents merely because the task is difficult, touches several files, or spans multiple layers;
- first consider splitting broad work into separate single-agent issues.

The owner or designated coordinator confirms the execution model. An issue author's recommendation does not schedule work by itself.

## Verification

Run all configured formatting, linting, type checking, build, relevant unit/integration tests, playground smoke tests, and diff checks. Report the exact commands and remaining failures or risks. If a check is not configured or could not be run, state that rather than inventing success.

## Git workflow

- Keep `main` stable and usable.
- Do not make substantive changes directly on `main`.
- Prefer one issue, one owning agent, one short-lived branch, and one pull request to `main`.
- Use an integration branch and multiple executor branches only when the owner or coordinator explicitly selects coordinated multi-agent work.
- Keep each branch limited to one clear purpose.
- Make small logical commits with concise English imperative messages.
- Open the pull request to the branch assigned for the task: normally `main`, or an integration branch for explicitly coordinated work.
- Do not push to another agent's branch unless ownership has been explicitly handed over or reassigned.
- State scope, intentionally deferred work, verification, documentation impact, and remaining risks in the pull request.
- Process review feedback on the same branch and keep the pull request description aligned with the final result.
- Review the complete diff for accidental files, debug code, secrets, unrelated changes, and stale documentation.
- Prefer squash merge after checks pass, then delete the branch.
- Never force-push or rewrite `main`.

Follow `docs/DEVELOPMENT-WORKFLOW.md` for issue sizing, single-agent defaults, coordinator, executor, integration-branch, documentation, and final-verification responsibilities.

## Backlog governance

- Agents may propose backlog entries, but only the owner or designated coordinator may select an item as required, change its target gate, or schedule it for implementation.
- `docs/planning/POC-TO-ALPHA-BACKLOG.md` contains open obligations selected for a future gate. It is not the current phase plan.
- Ideas that have not been selected as required remain in `WISHES.xml` or another proposal document.
- When a backlog item is implemented and verified, record the result in `PHASE-STATUS.md` and remove the item from the open backlog in the same documentation update. Git history preserves the completed entry.

## Milestone discipline

Use `PHASE-STATUS.md` and the current task/PR description to identify active work. Do not rely on stale parser-POC or earlier-branch wording. Select backlog IDs explicitly when a phase is planned; do not expand a focused branch into timers, media, iframe integration, Laravel, modules, or unrelated V30 syntax without revising the plan and recording the decision.
