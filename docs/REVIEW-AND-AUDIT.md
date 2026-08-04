# Review and audit method

## Purpose and authority

This document defines the reusable method for repository reviews and scoped
audits. It does not replace the authority hierarchy in `../README-FIRST.md`, the
finding classes and blocking-evidence rules in `DEVELOPMENT-WORKFLOW.md`, the
test strategy in `TESTING.md`, or documentation ownership in
`DOCUMENTATION-OWNERSHIP.md`.

Use those documents for substantive rules. This document defines when to use a
review or audit, how to select profiles, and how to record scope, coverage,
evidence, findings, and remaining uncertainty.

## Review and audit are different

A pull-request review asks whether one proposed change can land safely. Review
the issue scope and authority, changed behavior, supported and trusted paths,
relevant adjacent effects, tests, documentation impact, and complete diff. Use
only the proportional lenses that the change and its risks require. A review is
not automatically a repository-wide audit.

An audit answers an explicit question over a declared snapshot and scope. Before
investigation, record the included and excluded surfaces, selected profiles,
known high-risk paths, added task-specific edge cases, evidence plan, and
completion conditions. An audit is complete only within that declared scope and
must state remaining gaps and uncertainty. Never imply whole-repository
assurance from a narrower audit.

Escalate from ordinary review to a focused audit when repeated sibling findings,
unclear boundaries, or an unbounded behavior space prevent review convergence.
Follow the convergence and scope-escalation rules in
`DEVELOPMENT-WORKFLOW.md`; do not silently turn a PR review into an unrelated
repository campaign.

## Shared principles

1. Establish authority before judging correctness or severity.
2. Preserve accepted behavior and real architecture, persistence, determinism,
   security, trust, and workflow boundaries.
3. Use reproducible evidence through supported public or trusted paths.
4. Apply KISS and pragmatic YAGNI to the audit itself: use the smallest method
   that can credibly answer the question.
5. Select profiles and extra edge cases from the actual change, threat model,
   failure modes, and remaining uncertainty; do not run every profile by
   default.
6. Do not invent product policy, compatibility promises, mandatory tools, or
   numeric quality thresholds while auditing.
7. Separate confirmed defects, evidence gaps, optional hardening,
   maintainability suggestions, and future concerns using the finding classes
   in `DEVELOPMENT-WORKFLOW.md`.
8. Optimize documentation only after correctness, semantic preservation, and
   unambiguous execution are established.

## Documentation lens for every non-trivial review

Every non-trivial code, test, workflow, ADR, or documentation review includes a
proportional documentation check:

1. Did the change make canonical documentation false, incomplete, or stale?
2. Is the information in its canonical owner, or would a targeted edit be
   simpler than a new document or competing explanation?
3. Are policy, priority, scope, conditions, timing, order, exceptions,
   ownership, required action, failure behavior, and intended reader or agent
   behavior preserved?
4. Are dependent routes, examples, references, generated derivatives, moving
   facts, and required synchronization updated?
5. Can the same correct meaning be expressed more compactly without ambiguity,
   lost context, weaker normative force, or changed behavior?

Use `DOCUMENTATION-OWNERSHIP.md` and the documentation profile for the detailed
method. Documentation is part of the reviewed result, not a later cosmetic
pass.

## Planning a scoped audit

Record these items before substantive audit work:

- exact repository, branch or commit, tree or artifact identity when relevant;
- audit question and intended decision;
- controlling issues, accepted decisions, specifications, and canonical topic
  documents;
- included files, components, workflows, documents, routes, or behavior;
- explicit exclusions and known dependencies;
- selected audit profiles and why each applies;
- additional risks and edge cases specific to this audit;
- inventory method and expected evidence;
- completion and stop conditions.

Use `audits/AUDIT-TEMPLATE.md` unless the active issue or accepted process
requires an equivalent stronger format.

## Profiles

Profiles add domain-specific risks, evidence, and completion criteria to this
shared method. Combine profiles only when the audit question genuinely crosses
their boundaries. The current inventory and implementation status are in
`audits/README.md`.

A profile is not a checklist whose every item applies to every task. Record
which items were applicable, not applicable with a reason, or excluded.
Task-specific risks may add checks, but may not silently become permanent
repository policy.

## Inventory, evidence, and coverage

Build a bounded inventory before claiming completeness. The inventory may be a
file list, public/trusted boundary list, workflow graph, state-transition model,
document route, decision set, or another representation suited to the audit.
Explain why it covers the declared scope.

For each included area, record:

- the authority or behavior being checked;
- the evidence source, command, reproduction, or comparison;
- the result and any limitation;
- whether coverage is complete, partial, blocked, or not applicable.

Do not count a passing aggregate command as proof of an unexamined invariant.
Do not require one test per row when existing systematic evidence covers the
same obligation. Follow `TESTING.md` when executable evidence is needed.

## Findings

Use the existing finding classes. Each actionable finding should identify:

- location and affected scope;
- controlling authority or supported path;
- expected and actual result;
- concrete consequence;
- reproducible evidence or the exact evidence gap;
- smallest complete repair;
- related coverage or uncertainty.

A preference, possible future issue, or unreachable internal state is not a
blocker without the evidence required by `DEVELOPMENT-WORKFLOW.md`.

## Completion and reporting

A review may conclude when the proportional changed-surface review, relevant
verification, complete-diff check, and documentation lens are complete and no
unresolved blocker remains.

An audit may conclude only when its declared inventory is accounted for,
selected profiles are completed, evidence and limitations are recorded,
findings are classified, and remaining uncertainty and excluded areas are
explicit. State the exact scope that passed; do not say the repository or system
is fully audited unless that was the declared and evidenced scope.

Keep temporary audit working notes outside the repository. Record active
findings in the relevant issue or pull request. Synchronize durable conclusions
into canonical documentation, accepted decisions, tests, or focused follow-up
issues. Do not retain PR-specific audit reports after their durable information
has been incorporated unless they remain necessary evidence.
