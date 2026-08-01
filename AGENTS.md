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

## Requirement authority and proportional review

Before treating a statement as a permanent requirement or review blocker,
identify whether it is owner-approved product behavior, an accepted
architecture/persistence/determinism/security boundary, a current
implementation choice, a temporary POC choice, optional defensive hardening,
or an unresolved proposal. Use the authority hierarchy in `README-FIRST.md`
when making that classification. Agent-written issues, tests, ADR drafts,
pull-request descriptions, specification drafts, and earlier review comments
do not become authoritative merely because they exist or another agent
implemented them. Strong terms such as `must`, `exact`, `versioned`,
`authoritative`, and `compatibility` require a concrete accepted behavior, real
boundary, or explicit owner decision.

Review findings must use the severity and evidence rules in
`docs/DEVELOPMENT-WORKFLOW.md`. A blocker needs a supported public or trusted
path, a concrete consequence, and reproducible evidence. Propose the smallest
repair that restores accepted behavior; do not turn a local defect into a new
framework, compatibility layer, public contract, or unrelated hardening
campaign without a separate owner decision. When requesting that decision,
explain the practical product, data, security, or maintenance consequence and
the complexity being added.

These proportionality rules do not weaken accepted behavior, deterministic
execution, serializable checkpoints, or validation at real external, host,
checkpoint, persistence, package, and security boundaries.

## Efficient editing and context use

Complete the mandatory authority reads above. For supporting context, prefer
search and bounded or ranged reads when the complete file is not required. Do
not print or quote complete large files, diffs, or workflow logs without a
concrete reason.

Use the environment-provided `apply_patch` command for ordinary localized edits,
including coherent changes across multiple hunks or files in one invocation.
Use a bounded temporary task-specific codemod, such as `ts-morph`, only when
repeated structural or symbol-aware TypeScript edits would make an ordinary
patch unclear or error-prone. Rewrite a complete existing file only when
complete replacement is intentional or most of the file genuinely changes, and
review the complete result.

`apply_patch` is the default for small and medium source and documentation
edits. A failed patch should normally be corrected with a smaller reread and
better context, not by rewriting the entire file. Task-specific scripts should
normally remain uncommitted and be discarded after their verified use. Do not
add a repository-wide fallback for environments that lack `apply_patch`; that
requires separate concrete evidence and review. Rare binary or byte-sensitive
work should use a task-specific method appropriate to that concrete file, not
justify a permanent general helper.

After each coherent edit batch, inspect the relevant hunks, run
`git diff --check`, and run focused checks. Summarize successful test runs
compactly, but retain warnings, failures, and relevant diagnostics. Before a
commit, handoff, or merge, review the complete diff for unexpected collateral
changes.

## Property-testable boundaries

For changes that affect supported parser, compiler, plan, runtime, action,
state, checkpoint, or validated host boundaries, preserve deterministic testing
through the real public or trusted path. Every canonical plan accepted through
that boundary and every successful public runtime transition must produce state
accepted by the corresponding validator. Do not extend this rule to arbitrary
hand-built internal states or unsupported plan compositions merely because
their individual parts are valid. Use explicit time/RNG inputs,
structured invalid-data handling, and reusable valid-state fixtures where
practical. Follow `docs/TESTING.md` and the assigned issue for property or
mutation testing; do not add unrelated fuzzing infrastructure, dependencies,
or production hooks.

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
