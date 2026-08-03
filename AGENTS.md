# Agent instructions

## Start and authority

Start with the applicable `AGENTS.md` files, `README-FIRST.md`, and the assigned
issue or pull request. Use `README-FIRST.md` to load only the controlling topic
documents, accepted decisions, workflow profile, code, and tests needed for the
task. Read `CURRENT-DESIGN.md` for architecture-affecting or broad
cross-component work and `PHASE-STATUS.md` for milestone, gate,
integration-status, or current-capability work.

Planning documents, wishes, research, historical audits, examples, draft ADRs,
tests, issues, pull-request text, and review comments are not accepted authority
by themselves. Do not invent project-wide policy, thresholds, style rules,
naming rules, compatibility promises, mandatory tools, or workflow gates.
Propose durable rules separately with evidence and owner approval.

Before the next write after context loss, session resumption, a changed review
head, or a transition between implementation, review, repair, verification, and
publication, re-establish the exact repository and branch/head, task scope and
authority, current diff or review state, required checks, remaining work, and
permitted GitHub writes. Long-task scratch notes stay outside the repository.

## Core boundaries

- Use English for source code, identifiers, comments, documentation, package metadata, editor text, and UI text.
- Do not silently change architecture, language semantics, security boundaries, or product scope.
- `.tease` is not TypeScript; advanced reusable code belongs in `.ts` libraries.
- Laravel is the only public backend.
- Keep one deterministic engine, one state model, and one save/checkpoint format.
- Preserve deterministic source evaluation order and explicit JSON-safe pause/resume state.
- Validate external, checkpoint, host, package, and future integration data at runtime.
- Explain need, alternatives, maintenance impact, and security impact before adding a dependency.
- Do not weaken tests to hide failures.

## Requirements, simplicity, and review

Use the authority hierarchy in `README-FIRST.md` before treating a statement as
a permanent requirement or blocker. Follow the finding classes, evidence rules,
proportional review lenses, KISS, pragmatic YAGNI, DRY, and escalation guidance
in `docs/DEVELOPMENT-WORKFLOW.md`. A blocker needs a supported public or trusted
path, a concrete consequence, and reproducible evidence. Prefer the smallest
complete repair; do not turn a local defect into a framework, compatibility
layer, public contract, or unrelated hardening campaign without owner approval.

Accepted behavior, deterministic execution, serializable checkpoints, and real
validation or security boundaries remain mandatory. When repeated sibling
findings stop reducing uncertainty, report the pattern and reassess the
implementation or evidence strategy instead of continuing isolated repairs.
Use `docs/TESTING.md` for systematic coverage when it is proportionate.

Before declaring a project limitation, proposing infrastructure, or presenting
owner options, verify the complete relevant capability rather than generalizing
from one action, helper, connector, or environment. Report material shared
workflow failures instead of silently working around them.

## Work and editing

Before substantive work, state the expected files, acceptance criteria, and
major risks or unresolved decisions, then continue in small verifiable steps.
Use targeted reads and edits. Correct existing wording before appending an
amendment, and rewrite a complete file only when complete replacement is
intentional or most of the file genuinely changes. Use the task's supported
editing route, inspect each coherent edit batch, and review the complete diff
before commit, handoff, or merge. Follow `docs/DOCUMENTATION-OWNERSHIP.md` for
non-trivial documentation edits and reviews.

If required input cannot be obtained, stop repeating equivalent impossible
attempts, identify the exact missing input and checked alternatives, and request
the smallest owner action that unblocks the work.

For supported parser, compiler, plan, runtime, checkpoint, or host behavior,
verify through the real public or trusted path. New author-facing syntax and
source-reachable observable behavior require representative source-to-runtime
coverage. Follow `docs/TESTING.md`; do not add unrelated fuzzing infrastructure,
dependencies, or production hooks.

## Verification and Git

Run configured formatting, linting, type checking, build, relevant tests,
playground checks, and `git diff --check`. Report exact commands, failures,
warnings, skipped checks, and remaining risks. `npm run check` is the normal
complete suite; use full-output variants only as diagnostic reruns when compact
output is insufficient.

Keep `main` stable. Use one issue, one owning agent, one short-lived branch, and
one pull request by default. Do not make substantive changes directly on
`main`, push to another agent's branch without an explicit handoff, force-push
or rewrite `main`, or silently combine unrelated work. Keep the pull-request
description aligned with the final scope, verification, documentation impact,
and risks. Prefer squash merge after approval and passing checks, then delete
the branch.

The owner or coordinator selects scheduling and any coordinated multi-agent
exception. Backlog, wish, and planning entries do not schedule themselves.
Follow `docs/DEVELOPMENT-WORKFLOW.md` for issue sizing, execution roles,
publication, review, merge, and final verification.
