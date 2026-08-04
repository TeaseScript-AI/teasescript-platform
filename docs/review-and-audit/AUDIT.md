# Audit guidance

## Use this document only for audits

Read this document only for an explicitly assigned audit. Ordinary pull-request
reviewers use `REVIEW.md`; this file is not part of their default reading route.

An audit answers a declared question over an exact snapshot and bounded scope.
It provides no assurance beyond its recorded inventory, evidence, exclusions,
and remaining uncertainty.

This document defines audit planning, execution, evidence, reporting, and the
initial documentation-audit profile. It does not replace:

- the authority hierarchy in `../../README-FIRST.md`;
- finding classes, blocking evidence, KISS, pragmatic YAGNI, scope escalation,
  and review convergence in `../DEVELOPMENT-WORKFLOW.md`;
- executable-evidence strategy in `../TESTING.md`;
- documentation ownership in `../DOCUMENTATION-OWNERSHIP.md`.

Use those documents for their existing rules instead of restating them here.

## Audit boundary

Before substantive work, record:

- the audit question and decision it must support;
- repository and exact commit, tree, artifact, branch, or pull-request head;
- controlling owner decisions, accepted ADRs, specifications, and canonical
  topic documents;
- included files, components, workflows, documents, routes, or behavior;
- explicit exclusions, dependencies, and coordination boundaries;
- selected audit profiles and why each applies;
- audit-specific risks, failure modes, and edge cases;
- inventory method, expected evidence, completion conditions, and stop
  conditions.

An audit is complete only within this boundary. State what was not audited.
Never convert a focused audit into a broad repository campaign without the
normal owner or coordinator scope decision.

## Shared audit method

### 1. Establish authority

Use the authority hierarchy before judging correctness or severity. Do not treat
implementation choices, proposals, history, tests, issues, pull requests, or
earlier audits as accepted authority. Identify conflicts instead of silently
choosing between them.

### 2. Build a bounded inventory

List every item needed to answer the audit question using a suitable bounded
model, such as files, boundaries, state transitions, workflow stages, document
routes, decisions, formats, or tests. Explain why it covers the scope. Mark every
item checked, excluded, blocked, or not applicable, with reasons where needed.

### 3. Select profiles and added risks

Use only profiles relevant to the question. Add task-specific checks for actual
failure modes or uncertainty, but do not turn one incident into permanent policy.
A profile supplements this method; it does not create product requirements,
compatibility promises, mandatory tools, or numeric thresholds.

The first complete profile in this document is documentation. Reusable profiles
for production code, tests, GitHub Actions and publication workflows, security,
performance, and ADR integrity remain future work. Their absence does not block
an explicitly scoped audit: use this shared method with a recorded task-specific
risk model, but do not claim that an unimplemented profile or broader coverage
exists.

### 4. Gather evidence

Use the smallest authoritative evidence set that answers each obligation and
record its exact target and result. Evidence may include source reads, supported-
path reproductions, tests, workflow runs, traces, comparisons, static analysis,
measurements, or generated-output verification. A passing aggregate command does
not prove an unexamined invariant; one systematic test or model may cover several
inventory rows.

### 5. Classify findings

Classify findings under `../DEVELOPMENT-WORKFLOW.md`. Each actionable finding
identifies:

- location and affected scope;
- controlling authority or supported path;
- expected and actual result;
- concrete consequence;
- reproducible evidence or exact evidence gap;
- smallest complete repair;
- related coverage and remaining uncertainty.

### 6. Reassess coverage and convergence

After repairs or new evidence, rerun affected checks and reconsider the full
inventory. When sibling findings from one invariant family recur, stop isolated
patching and follow the convergence guidance in `../DEVELOPMENT-WORKFLOW.md`.

### 7. Conclude precisely

Conclude only when the inventory is accounted for, selected profiles are
complete, evidence and limitations are recorded, findings are classified, and
remaining uncertainty is explicit. State the exact scope that passed; never
claim broader assurance. Keep working notes and PR-specific reports outside the
repository, put active findings in the relevant issue or pull request, and
synchronize durable conclusions into canonical documents, decisions, tests, or
focused follow-up issues.

## Audit record

Use this structure or an equivalent stronger record. Every record retains
identity, authority, scope, inventory, evidence, findings, uncertainty, and a
completion statement. Remove only unused prompts or optional rows.

### Identity

- Audit title:
- Owning issue or pull request:
- Auditor and date:
- Repository and exact snapshot:
- Relevant artifact, tree, base, or merge-base:
- Audit question and intended decision:

### Authority

- Controlling decisions and specifications:
- Canonical topic and workflow documents:
- Owner-approved scope or acceptance criteria:
- Conflicts or unresolved authority:

### Scope and profiles

- Included:
- Excluded:
- Dependencies and coordination:
- Selected profiles and rationale:
- Profile obligations and their applicable, not-applicable, excluded, blocked,
  or complete status:
- Highest-risk supported or trusted paths:
- Audit-specific failure modes and edge cases:
- Stop conditions or missing input requiring owner action:

### Inventory and coverage

| Area or obligation | Why in scope | Evidence | Status | Gap or limitation |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Explain why the inventory is complete enough for the audit question.

### Verification evidence

| Command, read, reproduction, comparison, or measurement | Exact target | Result | Limitation |
| --- | --- | --- | --- |
|  |  |  |  |

### Findings

| ID | Class | Location | Authority or supported path | Consequence | Evidence | Smallest repair |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

### Remaining uncertainty

- Unresolved evidence gaps:
- Blocked checks:
- Assumptions:
- Follow-up issues:

### Completion statement

State exactly what was audited, what evidence supports completion, what remains
excluded or uncertain, and whether any blocker remains.

## Documentation audit profile

Use this profile when the audit question includes documentation correctness,
authority, lifecycle, routing, generated derivatives, or recurring context cost.
Read `../DOCUMENTATION-OWNERSHIP.md` first.

### Priority order

Apply this order when goals conflict:

1. correctness and controlling authority;
2. preservation of accepted meaning and intended behavior;
3. clear instructions available before the affected decision or action;
4. correct ownership, lifecycle, routing, and synchronization;
5. maximum safe token and context efficiency.

Shorter wording is not better when it weakens, broadens, narrows, delays,
reprioritizes, or obscures a rule. Retain the clearer wording when equivalence is
uncertain and record the uncertainty.

### Documentation inventory

Within scope, inventory current routing and always-read files; applicable topic
documents, specifications, ADRs, planning, status, history, research, examples,
and derivatives; each item's authority, audience, lifecycle, owner, and reading
route; cross-document ownership and moving facts; complete task-route
walkthroughs; and evidence needed to validate operational statements.

Do not claim a full documentation audit from a changed-file list alone.

### Semantic preservation

For each substantive addition, removal, rewrite, merge, or relocation, compare:

- normative force: requirement, prohibition, permission, recommendation, or
  example;
- priority and hierarchy;
- scope, audience, and applicability conditions;
- timing and order;
- exceptions and stop conditions;
- owner or decision authority;
- required evidence, action, result, and failure behavior;
- intended practical reader or agent behavior.

Classify the result as preserved, preserved through the complete route,
weakened, broadened, narrowed, delayed, ambiguous, lost, moved to the wrong
owner, or duplicated into competing authority.

A meaning change needs an accepted decision or specification, or an explicit
owner-approved scope amendment recorded in the owning issue or pull request.
Cleaner prose, an agent-written issue, or implemented behavior is not authority
by itself.

### Ownership, lifecycle, and placement

Give every maintenance-sensitive rule or moving fact one canonical owner.
Elsewhere use a link or the smallest stable summary. Keep local repetition only
when it improves comprehension without competing authority, drift, duplicated
moving facts, or unnecessary context.

Classify content as current authority, routing summary, necessary context,
moving fact, accepted history, proposal, research, example, or review/audit
evidence. Expire temporary rollout, migration, fallback, and repair wording with
its lifecycle.

Accept a new file only when a targeted edit is not simpler and the file has a
distinct audience, lifecycle, ownership boundary, or executable purpose.

### Complete routes and executable instructions

Audit complete reading and execution routes, not isolated files. Verify that:

1. startup or routing text reaches the controlling destination;
2. required detail appears before the affected decision or action;
3. the destination contains complete conditions, exceptions, order, failure
   handling, and authority;
4. no current document presents a conflicting or weaker route;
5. the combined route causes the intended behavior without broad speculative
   reading.

Validate commands, filenames, options, paths, identifiers, examples, and stated
outputs against exact maintained code, workflows, or artifacts when operational
correctness is claimed.

### Generated and external derivatives

For generated guides, shared files, archives, project-folder copies, or other
derivatives, identify:

- editable canonical source;
- generation and validation steps;
- exact derivative inventory and stable names;
- synchronization owner and manual gates;
- stale or ambiguous copies to remove;
- proof that the reviewed derivative, not only its source, was regenerated and
  checked.

A repository merge does not prove an external derivative was updated.

### Staleness and consistency

Search the declared scope for:

- statements made false by current code, accepted decisions, or workflow;
- conflicting authorities or summaries;
- obsolete files still routed as current;
- expired rollout, fallback, migration, or review-repair wording;
- duplicated versions, counts, defaults, inventories, timings, or status;
- broken or misleading links, commands, filenames, options, and anchors;
- current guidance that treats non-authoritative issues, pull requests, tests,
  audits, wishes, or research as accepted authority.

Identify the exact conflict and controlling source. Do not silently reconcile it.

### Token and context efficiency

After correctness and semantic preservation are established, inspect each
maintained sentence, heading, list, code block, warning, example, and repeated
summary. Ask:

1. Does each word add a distinct rule, condition, exception, boundary, action,
   route, evidence requirement, or necessary disambiguation?
2. Can filler, repeated setup, duplicated nouns, or redundant qualifications be
   removed?
3. Can adjacent sentences or list items be combined without hiding priority,
   timing, or exceptions?
4. Can one-item lists, one-line code blocks, repeated headings, or excess
   vertical structure be collapsed without reducing scanability?
5. Is complete detail repeated where one canonical explanation plus a short
   route would be clearer?
6. Does local repetition materially improve comprehension, or only consume
   recurring context?
7. Would shorter wording create a plausible misreading or weaken normative
   force?
8. Is the content always read, routinely read, or rare? Apply the strictest
   context-cost standard to startup and universal documents.

Classify candidates as safe compaction, unsafe compaction, useful repetition,
harmful duplication, or formatting overhead. Word or token counts are evidence,
not quality thresholds. Optimize the complete routed reading set: moving text
into another always-read file may increase total context even when one file gets
shorter.

For material compaction, preserve the original meaning, proposed replacement,
why removed text adds no distinct meaning, and plausible misreadings checked.
Prefer no edit when equivalence remains uncertain.

### Documentation findings and completion

A documentation blocker should identify the exact text or missing owner,
controlling authority or supported workflow, incorrect or changed meaning,
practical reader or maintenance consequence, reproducible route or comparison,
and smallest complete repair.

A documentation audit is complete only when its declared inventory and reading
routes are accounted for, authority conflicts are resolved or reported,
operational claims have sufficient evidence, generated derivatives are checked,
token-efficiency review is complete, findings and limitations are recorded, and
excluded or blocked areas are explicit.
