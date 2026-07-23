# Agent instructions

## Read before changing files

For every substantive task, read:

1. `README-FIRST.md`
2. `CURRENT-DESIGN.md`
3. `docs/specifications/accepted-syntaxes-v30.md` when language syntax or semantics are involved
4. the task-specific planning/specification document
5. relevant ADRs in `docs/decisions/`

Do not treat planning documents as accepted decisions.

## Working rules

- Use English for code, identifiers, comments, documentation, package metadata, and UI text.
- Do not silently change architecture, language semantics, security boundaries, or product scope.
- When documents conflict, identify the exact conflict and follow the authority order in `README-FIRST.md`.
- `.tease` is not TypeScript. Advanced code belongs in `.ts` libraries.
- Keep one engine, one state model, and one save format.
- Laravel is the only public backend.
- Choose the simplest design that meets the current task.
- Do not add dependencies without documenting the need, alternatives, maintenance impact, and security impact.
- Validate external data at runtime.
- Do not weaken tests to hide failures.
- Do not implement deferred capabilities merely because they appear in planning documents.

## Before substantive coding

State briefly:

- files expected to change;
- acceptance criteria;
- major risks or unresolved decisions.

Then work in small verifiable steps.

## Verification

Before finishing a task, run all relevant:

- formatting;
- linting;
- type checking;
- unit/integration tests.

Report commands run and any remaining failures or risks.

## Git workflow

- Keep `main` stable and usable.
- Do not make substantive changes directly on `main`.
- Create one short-lived branch per task. Names may follow patterns such as `poc/parser`, `poc/speaker-runtime`, `docs/syntax-authority`, or `fix/source-spans`.
- Branch names and repository folders are examples, not fixed architecture. Choose clear names that match the task.
- Keep each branch limited to one clear purpose.
- Make small logical commits with concise English imperative messages.
- Push the branch and open a pull request to `main`.
- In the pull request, state what changed, what is intentionally out of scope, how it was verified, and remaining risks or open decisions.
- Review the complete diff for accidental files, debug code, secrets, unrelated changes, and missing documentation.
- Prefer squash merge after all checks pass.
- Delete the merged branch.
- Never force-push or rewrite `main`.
- Do not merge failing, incomplete, or knowingly broken changes unless Peter explicitly instructs it.

## Initial POC limitation

For the first parser POC, do not scaffold the full platform. Implement only the smallest maintainable TypeScript structure needed for lexer, parser, AST, diagnostics, tests, and a CLI/test harness. Propose the concrete folder structure in the task plan before creating it.
