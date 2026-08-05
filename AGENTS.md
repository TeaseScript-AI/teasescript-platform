# Agent instructions

## Start and authority

Start with the applicable `AGENTS.md` files, `README-FIRST.md`, and the assigned
issue or pull request. Use `README-FIRST.md` to load only the controlling topic
documents, accepted decisions, workflow profile, code, and tests needed for the
task. Before implementation, read
`docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md` and reuse it for final
self-review or an explicitly assigned pull-request review. Read
`docs/review-and-audit/AUDIT.md` only for an explicitly assigned audit; do not load
both routes by default. Read `CURRENT-DESIGN.md` for architecture-affecting or
broad cross-component work and `PHASE-STATUS.md` for milestone, gate,
integration-status, or current-capability work.

Planning documents, wishes, research, historical audits, examples, draft ADRs,
tests, issues, pull-request text, and review comments are not accepted authority
by themselves. A model preference, external convention, tool default, or
earlier agent suggestion is not a repository requirement. Do not invent
project-wide policy, numeric thresholds, style or readability limits, naming
rules, compatibility promises, mandatory tools, or workflow gates. Use strong
requirement language only for accepted behavior, real boundaries, or explicit
owner decisions recorded in a canonical owner. Propose durable rules separately
with evidence; after owner approval, record them canonically before treating
them as authority.

Before the next write after context loss or compaction, session resumption, a
changed branch or pull-request head, or a transition between implementation,
review, repair, verification, and publication, re-establish the exact repository
and branch/head; assigned issue or pull request; scope, exclusions, and
controlling authority; required checks; current worktree, diff, or review state;
remaining work; and permitted GitHub writes. Temporary task-state notes stay
outside the repository.

## Core boundaries

- Use English for source code, identifiers, comments, documentation, package metadata, editor text, and UI text.
- Do not silently change architecture, language semantics, security boundaries, or product scope.
- `.tease` is not TypeScript; advanced reusable code belongs in `.ts` libraries.
- Laravel is the only public backend.
- Keep one deterministic engine, one state model, and one save/checkpoint format.
- Preserve deterministic source evaluation order and explicit JSON-safe pause/resume state.
- Validate external, checkpoint, host, package, and future integration data at runtime.
- Do not add a dependency without documenting its need, alternatives, maintenance impact, and security impact.
- Do not weaken tests to hide failures.

## Requirements, simplicity, and review

Use the authority hierarchy in `README-FIRST.md` before treating a statement as
a permanent requirement or blocker. KISS is primary. Pragmatic YAGNI applies
KISS to future-facing complexity. DRY is subordinate to both: use one canonical
source plus references only when that is the simpler complete solution, and
prefer limited local repetition when it is clearer without creating competing
authority, duplicated moving facts, or unnecessary recurring context.

Follow the requirement/decision classifications, finding classes, evidence
rules, proportional review lenses, and escalation guidance in
`docs/DEVELOPMENT-WORKFLOW.md`. A blocker needs a supported public or trusted
path, a concrete consequence, and reproducible evidence. Prefer the smallest
complete repair; do not turn a local defect into a framework, compatibility
layer, public contract, or unrelated hardening campaign without a separate
owner decision.

These proportionality rules do not weaken accepted behavior, deterministic
execution, serializable checkpoints, or validation at real external, host,
checkpoint, persistence, package, and security boundaries. When repeated
sibling findings stop reducing uncertainty, report the pattern and reassess the
implementation or evidence strategy instead of continuing isolated repairs.
Use `docs/TESTING.md` for systematic coverage when it is proportionate.

Before claiming a project limitation, proposing infrastructure, or presenting
owner options, verify the relevant capability through the smallest authoritative
evidence set. Do not generalize one API action, connector method, helper, or
environment limitation to the complete supported workflow. Report material
shared-workflow failures.

## Work and editing

Before substantive work, state the expected files, acceptance criteria, and
major risks or unresolved decisions, then continue in small verifiable steps.
Use targeted reads and edits. Keep successful output compact; do not print or
quote complete large files, diffs, or logs without a concrete need, but preserve
actionable warnings, failures, and diagnostics. Keep long editable drafts out of
chat and repository scratch files; use a temporary file unless it is a
deliverable.

Correct existing wording before appending an amendment. Use preservation-aware
edits; full-file creation or replacement is only for a new file or intentional
total replacement. Inspect the changed hunks from each coherent edit batch, run
`git diff --check`, and run proportionate focused checks. Before commit, handoff,
or merge, review the complete diff for collateral or generated files, debug code,
secrets, unrelated changes, and stale documentation. Follow
`docs/DOCUMENTATION-OWNERSHIP.md` for non-trivial documentation edits and
reviews.

If required input remains unavailable, stop equivalent retries, record the exact
missing input and checked alternatives, and request the smallest concrete owner
action that unblocks the work.

For supported parser, compiler, plan, runtime, action, state, checkpoint, or
host behavior, verify through the real public or trusted path. New author-facing
syntax and source-reachable observable behavior require representative
source-to-runtime coverage. Follow `docs/TESTING.md`; do not add unrelated
fuzzing infrastructure, dependencies, or production hooks.

## Connector source acquisition rollout

Connector agents validate `source-bundle/artifact-v1` before requesting work. A
valid hit is downloaded immediately without a comment, workflow run, or wait.
During issue #234 Phase 1, a confirmed miss may use only Artifact mailbox #235
and the exact request ID in its single authenticated bot registry. Do not invent
a mailbox delay or remove the request-branch fallback until default-branch proof
selects and documents the measured initial wait, 10-second polling cadence, and
overall timeout.

## Verification and Git

Run configured formatting, linting, type checking, build, relevant tests,
playground checks, and `git diff --check`. Report exact commands, failures,
warnings, skipped checks, and remaining risks. `npm run check` is the normal
complete suite; use full-output variants only as diagnostic reruns when compact
output is insufficient.

Keep `main` stable. Use one issue, one owning agent, one short-lived branch, and
one pull request by default. Do not make substantive changes directly on
`main`, push to another agent's branch without an explicit handoff, or silently
combine unrelated work. Never force-push or rewrite `main`. Keep the
pull-request description aligned with the final scope, deferred work,
verification, documentation impact, and risks. Process review feedback on the
same branch and pull request. Make small logical commits with concise English
imperative messages. Prefer squash merge after approval and passing checks,
then delete the branch.

The owner or coordinator selects scheduling and any coordinated multi-agent
exception. Backlog, wish, and planning entries do not schedule themselves.
Follow `docs/DEVELOPMENT-WORKFLOW.md` for issue sizing, execution roles,
publication, review, merge, and final verification.
