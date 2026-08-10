# Codex prompt construction

Use this guide whenever constructing a Codex-facing prompt, including implementation, continuation, review-repair,
and follow-up prompts. If its guidance is still fresh because prompt-authoring work has continued without a
context-heavy detour, reuse it rather than re-reading mechanically. Re-read it after substantial code or review
inspection, large tool output, a task switch, or other work likely to have displaced the guidance from active
context. When uncertain whether it is still fresh, re-read it.

This file owns work-package boundaries, milestone handling, prompt content, and the author preflight;
[`CODEX-MODEL-SELECTION.md`](CODEX-MODEL-SELECTION.md) owns executor, model, reasoning, and escalation selection.

Reclassify review-repair prompts by the remaining task; on retries, revisit selection when an escalation
trigger is met.

## Build the work package first

Prefer the largest coherent, dependency-closed work package within scope that Codex can reliably complete and verify in
one execution. Extra prompts repeat reading, context reacquisition, handoff, setup, and verification. Split only when
execution volume, an intervening owner decision or capability change, independent review value, or dependency/ownership
safety materially favors separation. When splitting, end each package in a durable repository state and start dependent
work from its verified head or explicit handoff state.

Before splitting behavior-changing work, trace its immediate dependencies. Include every transition, state,
serialization, validation, or other path that ordinary successful execution can immediately reach. A behavior-neutral
prerequisite may stand alone when it leaves a useful durable state.

Define milestones by dependency order and **measurable durable capability states**, not by prompt or repair count. A
milestone stays open until its acceptance state is satisfied; reviews, retries, and repairs do not create new
milestones. A later assignment may combine remaining repairs with adjacent milestone work when the package remains
coherent, dependency-safe, and reliably executable. Milestones are planning structure, not automatic prompt, branch,
pull-request, context, or model-selection boundaries.

## Select only material context

Follow the repository's mandatory start and task-routing instructions; do not reproduce that stable reading route in
the prompt unless a task-specific exception or ordering requirement makes it necessary.

Add a task-specific source as **Required** only when it materially controls a current implementation decision,
invariant, boundary, acceptance criterion, or verification requirement and the prompt author can name that reason.
Otherwise omit it or make it conditional. Prefer current canonical repository sources over copied documents, historical
reports, or broad context bundles. When a large Required source has a narrow relevant part, point to that section when
practical. Do not restate stable rules or checks already supplied by applicable `AGENTS.md`, CI, tests, or canonical
workflow documentation. Prompt minimization never overrides repository-mandated reads or instructions.

- **Required:** directly controls current implementation or verification.
- **Conditional:** open only when code, dependencies, or a concrete ambiguity makes it relevant.
- **Unrelated:** omit unless later repository evidence reveals a direct dependency or conflict.

Do not accumulate sources merely because they were useful in an earlier prompt.

## Write for execution, not ceremony

Make **Goal, Context, Constraints, and Done when** clear; these are organizing concepts, not sections that must be
filled with invented content. `Done when` states the external completion state, including checks and repository/GitHub
writes actually assigned, resulting identity when needed, and any material deviation or unresolved uncertainty.

Include task-relevant authority, likely code areas or patterns, critical invariants, acceptance criteria, established
verification, permitted writes, and materially necessary write prohibitions only when they reduce search or ambiguity.
Treat likely files as starting points, not exhaustive boundaries. Specify outcomes, invariants, ordering, exceptions,
and boundaries; leave ordinary implementation choices to Codex. Add low-level steps only when they enforce a real
contract or materially reduce ambiguity. Do not write the patch in prose.

Adding more work means adding coherent deliverables or coverage, not explanation, repeated context, micro-steps,
reporting, or ceremony. A plan, focused check, commit, or push is intermediate while the assigned `Done when` state
remains unsatisfied.

Define stop conditions only for genuine blockers such as an unresolved owner/architecture decision, an invalidated
required branch or immutable head, unavailable permission/evidence with no permitted alternative, a trust-boundary
concern, or a repair that would materially broaden scope or change accepted behavior. Recoverable tool or GitHub
failures normally require diagnosis or a supported route. Resolve minor ambiguity from current repository evidence
instead of manufacturing a stop; report only assumptions or deviations that materially affect the final handoff.

A reference SHA is not a stop condition when the task starts from current `main`; synchronize authoritative remote
`main` and branch from it. Require an exact-SHA stop only when immutable source identity actually controls the task. A
stale local branch or remote-tracking ref is synchronization work, not completion.

When dense implementation is a plausible failure mode, make readability/KISS explicit: fewer lines or characters are
not a goal; clarity, maintainability, debuggability, and reviewability are.

## Do not invent prompt content

Include a risk, exclusion, prohibition, or stop condition only when the assigned work, inspected dependencies, a
plausible implementation path, or a real protected boundary makes it material. If Codex has no concrete reason to enter
an unrelated area, do not mention that area.

When removing an unnecessary instruction, remove it completely. **Do not replace it with its negation** unless the
unwanted behavior remains a plausible task-specific failure mode. Removing an unnecessary evidence-log requirement,
for example, does not justify adding “do not create an evidence log”. Do not require a generic risk list or feed
unrelated issues into the prompt merely so Codex can promise not to work on them.

Use a temporary checklist only when it materially helps retain a multi-step assignment. Keep it focused on completion;
do not require per-item evidence, commentary, logs, or deletion proofs unless that output is itself needed. Request
progress reports, inventories, or intermediate proofs only when they have a concrete execution or handoff consumer.

Match specificity to the selected configuration: Luna needs narrower decisions and concrete checks; Terra needs
implementation direction, ownership boundaries, and normal local freedom; Sol needs precise contracts, relevant
evidence, and critical invariants with broader implementation freedom. Low reasoning needs a well-bounded path, Medium
normal repository investigation, and High the actual unresolved questions, trade-offs, or diagnostic burden rather than
extra procedure.

## Mandatory prompt-author preflight

Run this immediately before sending every Codex prompt. It is an authoring gate, **not text to paste into the prompt**.
If any item fails, revise the prompt first.

- **Work package:** Does it end in a measurable durable state with the immediately reachable dependencies needed for
  that state?
- **Prompt boundary:** Is another prompt genuinely justified, or can adjacent work be combined without reducing
  reliable execution or verification?
- **Sources:** For every task-added Required source, what concrete decision, invariant, boundary, acceptance criterion,
  or check does it control? Delete or make conditional any source without an answer.
- **Risks/restrictions:** For every stated risk, exclusion, prohibition, or stop condition, what concrete task path or
  protected boundary makes it plausible? Delete it when there is no answer.
- **Negative inversion:** Did removed work survive as “do not do X”? If Codex has no independent reason to do X,
  delete the sentence entirely.
- **Density:** Is each requirement stated once, with duplicated context and acceptance wording consolidated?
- **Implementation freedom:** Does the prompt state the contract instead of ordinary coding steps Codex can determine
  safely from the repository?
- **Administration:** Does every checklist, log, evidence, progress, or reporting request have a concrete purpose?
  Remove ceremonial work.
- **Completion:** Does `Done when` cover actual checks, complete diff review, assigned publication, and final state
  without restating the prompt?

The goal is not the shortest prompt. Use the smallest context that preserves everything that materially improves the
chance of an accepted result.
