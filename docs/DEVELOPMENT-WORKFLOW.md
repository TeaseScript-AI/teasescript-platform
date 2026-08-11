# Development workflow

## Guiding principle

Use the simplest GitHub workflow that safely completes the task. The default is:

```text
one issue
    -> one agent
    -> one short-lived branch
    -> one pull request to main
```

Do not introduce a coordinator, integration branch, or multiple executor agents merely because a task is technically difficult, touches several files, or spans more than one layer. Coordination has a cost and must solve a concrete problem.

Use coordinated multi-agent work only when it solves a concrete execution or integration problem, such as genuinely
independent workstreams, dependent work that needs controlled handoffs or merge order, capability separation, or safe
pipelining that materially reduces idle time without blurring ownership. Workflow defaults guide the common case rather
than act as ceremony: a task-proportional deviation is valid when it is simpler or safer for the actual scope, provided
the reason, changed ownership, and verification consequences are made explicit. This flexibility applies to stated
defaults and recommendations, not explicit mandatory repository or capability-route rules, and does not override
accepted behavior, trust boundaries, or required evidence.

Source bundles and agent bootstrap provide local repository access when needed.
Development and integration use GitHub-native branches and pull requests.
Verified patch publication remains a separate route for publishing a concrete
tested patch result.

## Issue sizing and execution recommendation

An issue should normally describe one coherent, reviewable task that one agent can execute from reproduction or design through implementation, tests, documentation impact, and pull request.

The agent creating or substantially refining an issue should include:

- the observed problem, requested outcome, or design goal;
- evidence, reproduction, or relevant source references;
- explicit scope and exclusions;
- acceptance criteria;
- when proposing future-facing infrastructure, the concrete scheduled
  consumer, accepted boundary that must be correct when first introduced, or
  difficult-to-reverse boundary problem that justifies implementing it now;
- an execution recommendation:
  - `Single agent` — the default;
  - `Coordinated multi-agent` — only with a short concrete rationale.

Before recommending multiple agents, first consider whether the work can be split into independent issues. Prefer
separate single-agent issues when each can be implemented, tested, reviewed, and merged safely on its own. A proposed
implementation phase must also be dependency-closed for behavior it introduces: if ordinary successful execution
immediately reaches a required transition, state, serialization rule, or validation path, that reachable behavior
belongs in the same landable phase unless the earlier work remains behavior-neutral. Do not invent temporary semantics
merely to preserve an artificial milestone boundary.

Multiple agents are justified when, for example:

- one accepted goal contains genuinely separate workstreams that can progress independently;
- the workstreams share a contract or integration gate and must land together;
- sequencing or overlapping behavior requires an explicit merge order;
- different capabilities or roles can safely pipeline non-conflicting work and materially reduce idle time;
- the task is too broad for one agent but splitting it into independently mergeable issues would create contradictory intermediate states or duplicated work.

Do not recommend multiple agents only because an issue is large, touches several files, or benefits from review. One agent may still execute a complex but coherent issue.

The issue author's recommendation is advisory. The owner or designated coordinator confirms the execution model before implementation begins.

## Requirement authority and review proportionality

Implementation authority and review severity are separate from how detailed or
confidently written an artifact is. Use the authority hierarchy in
`README-FIRST.md` before treating a statement as a permanent contract, then
classify it as one of:

| Decision type | Governance effect |
| --- | --- |
| Owner-approved product behavior | Required within the recorded scope. |
| Accepted architecture, persistence, determinism, security, or trust boundary | Required within the accepted decision or current canonical boundary for a supported path. |
| Current implementation choice | Describes how the current code works; it is not automatically a permanent compatibility promise. |
| Temporary POC choice | May be replaced without preserving it when accepted behavior and real boundaries remain intact. |
| Optional defensive hardening | May be proposed, but does not block unrelated work without a concrete current need. |
| Unresolved proposal | Requires the normal owner/ADR decision route before implementation treats it as accepted. |

An agent-written issue, test, ADR draft, specification draft, pull-request
description, or review comment is evidence and context, not authority by
itself. A previous comment does not become authoritative merely because another
agent accepted or implemented it. A specification or ADR becomes authoritative
only after acceptance through the repository authority process, and only within
its recorded scope. Existing behavior may still require preservation when it is
part of a supported path, an accepted contract, or an explicit owner-approved
acceptance criterion. Tests may prove such behavior, but their private fixture
structure, helper identity, or exact harness design does not independently
create a product contract.

Use words such as `must`, `exact`, `versioned`, `authoritative`, and
`compatibility` only when the text identifies the accepted behavior, real
boundary, or owner decision that requires that strength. A stricter
implementation being technically possible is not sufficient.

Before declaring a project limitation, proposing infrastructure, or presenting
owner options, verify the relevant existing capability through the smallest
authoritative evidence set. Do not generalize one API action, connector method,
helper, or environment limitation to the complete supported workflow. Report a
material shared-workflow failure instead of silently working around it.

Do not invent project-wide policy, numeric thresholds, style or readability
limits, naming rules, compatibility promises, mandatory tools, or workflow
gates. Until a durable rule has evidence, owner approval, and synchronization
into its canonical source, use configured tooling, current authority, and
task-proportional judgment.

### KISS, pragmatic YAGNI, and DRY

Once the current requirement and its authority are established, choose the
simplest complete approach that safely satisfies that requirement and its real
boundaries. Assess simplicity across design, implementation, evidence, workflow,
and maintenance cost. The smallest individual patch is not automatically the
simplest overall solution.

Pragmatic YAGNI applies this rule to future-facing complexity. Implement only
the complexity needed for the current requirement and its real boundaries.

KISS and pragmatic YAGNI are not competing rules. Apparent conflict normally
means simplicity is being assessed too locally or hypothetical future value is
being treated as a current requirement.

Statements such as “we may need this later,” “a more general solution would be
cleaner,” an unscheduled backlog entry, a historical implementation, or an
earlier test or review comment do not by themselves justify present
infrastructure.

Future-facing complexity needs a concrete reason, such as:

- an owner- or coordinator-scheduled consumer that will use it;
- an accepted boundary that must be correct when first introduced;
- a demonstrated data, security, persistence, or public-compatibility problem
  that would be materially harder to repair later.

Use the smallest seam that addresses that concrete reason. A narrow interface
for an already scheduled next consumer may be proportionate; implementing the
complete generalized future subsystem is not.

When no present implementation is justified, propose or route the idea through
the appropriate owner-governed wish, planning, backlog, or open-decision
process. Recording a proposal preserves it without accepting, scheduling, or
authorizing implementation and without turning it into production maintenance
surface.

DRY is subordinate to KISS and pragmatic YAGNI. Use one canonical
implementation, rule, or explanation plus references only when that is clearer
and simpler across the complete maintenance lifecycle. Use limited local
repetition when that is the clearer KISS solution. Do not force DRY when it
creates indirection, competing authority, duplicated moving facts, speculative
abstraction, or unnecessary recurring context cost. For the
documentation-specific application, follow
[`DOCUMENTATION-OWNERSHIP.md`](DOCUMENTATION-OWNERSHIP.md).

### Review finding classes

Classify every actionable finding in plain language:

- **Blocker:** accepted behavior, a supported public/trusted path, a real
  boundary, an explicit owner-approved acceptance criterion, or normal
  development/operation is concretely broken.
- **Non-blocking correctness improvement:** a real defect or inconsistency with
  limited consequence that does not prevent the current task from safely
  landing.
- **Optional hardening:** additional defense beyond current accepted behavior
  and reachable boundaries.
- **Maintainability suggestion:** a readability, organization, or future-cost
  improvement without a current correctness failure.
- **Speculative future concern:** a possible issue that depends on unaccepted
  features, hypothetical consumers, or future architecture.
- **Test-harness issue rather than product issue:** a defect in fixtures,
  generators, replay metadata, or test-only helpers that does not demonstrate a
  product/runtime failure.

Labels such as `bug`, `contract violation`, `security issue`, or `missing edge
case` do not establish severity without the concrete reason.

### Proportional review lenses

Select only lenses relevant to the changed behavior: accepted behavior, issue
scope, and scope expansion; correctness and failure handling; architecture,
ownership, dependency direction, coherent file boundaries, and real security
or trust boundaries; determinism, serialization, ordering, persistence, and
compatibility; test quality and evidence, including negative paths;
maintainability and readability,
including over-compression and needless fragmentation; KISS, pragmatic YAGNI,
useful DRY, and dependency cost; documentation accuracy, stale or conflicting
text, and current-status impact; complete-diff collateral changes, generated
files, debug code, and secrets; and convergence or remaining uncertainty. Ask
whether a reasonable future maintainer could understand and safely change the
result.

This is not a rigid checklist: not every lens applies, and a preference is not
a blocker. Use the finding classes and blocking-evidence rules below for
severity and evidence.

### Blocking evidence

A blocking correctness finding should normally include:

- a reproducible case;
- the supported public or trusted path through which it occurs;
- expected and actual behavior;
- the practical user, data, determinism, security, or maintenance consequence;
- a focused failing test, or a clear reason why one cannot yet be supplied.

Examples include broken accepted TeaseScript behavior, a supported
source-to-runtime regression, partial or invalid canonical state, observably
incorrect deterministic execution or checkpoint restore, violation of a real
trust-boundary requirement, an unmet owner-approved criterion, or a concrete block
to normal development, deployment, or maintenance.

Manually fabricated impossible internal states, unsupported inputs, private
implementation details, hypothetical future compatibility, and malformed objects
that cannot cross a real boundary are not blockers by default. Classify them as
hardening, future work, a harness issue, or out of scope unless evidence shows a
reachable supported path or real boundary consequence.

### Review convergence

A review is not converging when successive substantive findings come from the
same invariant or problem family and each repair addresses only one newly found
sibling without reducing uncertainty about the remaining supported behavior
space. No fixed review count triggers this rule. Both the implementer and the
reviewer are responsible for recognizing and reporting the pattern.

Relevant signals include:

- consecutive findings involving the same lifecycle, validator, helper, state
  transition, or public/trusted boundary;
- repairs repeatedly adding one isolated special case;
- no explicit account of the remaining bounded behavior space;
- tests growing mainly as a list of previously discovered incidents;
- uncertainty about completeness not decreasing after each repair;
- a reviewer continuing to find sibling cases without being able to explain
  why the remaining space is covered.

When these signals appear, pause before repeating the same repair cycle and
briefly record:

1. the recurring pattern;
2. why the current method is not demonstrating convergence;
3. whether the weakness is in the implementation, decomposition, requirement
   model, or evidence strategy;
4. the smallest appropriate alternative;
5. whether a material scope or execution-strategy change needs owner or
   coordinator approval.

Record this assessment in the active pull-request or issue discussion, or in
the owner/coordinator handoff when that is the active coordination surface. Do
not create a separate report or policy file solely for this checkpoint unless
an existing canonical document genuinely becomes inaccurate.

Possible alternatives include an explicit test matrix, state-transition table,
invariant inventory, property- or model-based strategy, a focused completeness
audit, splitting an overly broad issue, or simplifying or redesigning the
implementation. Do not prescribe a matrix or new framework for every repeated
finding; choose the smallest method that matches the demonstrated problem.

Isolated findings, unrelated defects, and a known finite repair list whose
remaining coverage is understood may continue through ordinary repair and
review. Repeatedly applying the smallest local patch is not automatically the
simplest overall solution. Under KISS and pragmatic YAGNI, a bounded systematic
model is justified when it is the smallest credible way to resolve demonstrated
completeness uncertainty, but it does not justify generic infrastructure,
speculative compatibility, or unrelated hardening.

The implementer must not silently broaden the pull request into a large
campaign. When the revised approach materially changes scope or execution
strategy, present the pattern, options, recommendation, cost, and exclusions to
the owner or coordinator before proceeding.

### Proportional repair and owner escalation

Propose the smallest repair that restores accepted behavior or the real
boundary. Apply the KISS and pragmatic YAGNI rule above before broadening a
repair for future prevention or hypothetical reuse. Do not expand a local
defect into a generalized framework, new permanent compatibility layer, public
contract, schema, or unrelated hardening campaign without a separate owner
decision.

When owner approval is required, explain in ordinary language what product
behavior, data risk, security boundary, or maintenance problem the stronger
contract protects, what happens without it, and what complexity it adds. For a
durable or ADR-level choice, also present viable alternatives, project-wide
consequences, recurring maintenance cost, difficult-to-reverse effects, and the
simplest credible option. The technical agent should make and justify a
recommendation instead of delegating arbitrary implementation details or
numeric guesses to the owner. Ask the owner to decide the product, policy,
compatibility, cost, or difficult-to-reverse trade-off that actually requires
owner authority; do not ask the owner to approve an unexplained technical
abstraction.

These rules prevent accidental scope escalation. They do not permit reviewers
to dismiss reproducible defects or weaken accepted syntax/semantics,
deterministic execution, serializable checkpoint requirements, or validation at
external, host, checkpoint, persistence, package, and security boundaries.

A small related low-risk repair may ride in the current pull request only when
it is needed for reliable execution or verification, stays within the same
ownership area, is explicitly disclosed and proportionately checked, and does
not change architecture, language behavior, security boundaries, product scope,
or public compatibility.

## Execution discipline

For longer work, coherent milestones and an orchestrator-supplied temporary
checklist may be used. Before claiming completion, the executor must reread the
checklist and verify every item against the actual diff and relevant files.
Store long editable drafts in temporary files outside the repository rather
than disposable chat blocks, unless the file is an intended deliverable.

If required input cannot be obtained in the current environment, stop repeating
equivalent impossible variants, record the exact missing input and checked
alternatives, and request the smallest concrete owner action that can unblock
the work.

Before destructively discarding substantial experimental work that established
useful coupling, failure, migration, or verification evidence, preserve a local
recovery point when practical, such as a temporary commit, stash, or patch. A
recovery point is not review evidence and must not be pushed or merged merely
because it exists.

For routine branch integration, prefer the normal version-control or platform
merge machinery available through the selected capability route. Let it carry
non-conflicting changes and inspect or resolve the actual conflicting hunks; do
not manually reconstruct an entire merge merely to reproduce work the supported
route already performs. Escalate to a more manual integration method only when
the normal route cannot preserve the required semantics or exact source identity.

When an assignment says to start from current `main`, resolve and synchronize the
current branch tip before creating the task branch. A prompt-supplied reference
SHA is not an immutable stop condition unless the assignment explicitly binds the
task, review, reproduction, or evidence to that exact identity.

Tool, command, option, file, branch, issue, and workflow names describe durable
purpose rather than temporary cleanup history or the latest review complaint.

Use full-file create or replacement actions only for genuinely new files or an
intentional complete replacement. When existing content must survive, use the
normal Git route or verified patch publication. Do not switch to full-file
replacement midway through a preservation edit merely because it appears
simpler.

## Default single-agent flow

For a normal issue:

1. Confirm the issue is sufficiently scoped and accepted for implementation.
2. Create one short-lived branch from current `main`.
3. Implement code, tests, fixtures, examples, and relevant documentation on that branch.
4. Open a pull request to `main`; a draft pull request may be opened early when visibility or feedback is useful.
5. Keep the pull request description aligned with the final implementation.
6. Process review feedback on the same branch and pull request.
7. Run the required verification and review the complete diff.
8. Merge after approval and passing checks, then delete the branch.

The pull request is the implementation handoff record. A separate coordinator report, integration branch, or milestone orchestrator is not required.

Make small logical commits with concise English imperative messages.

Every pull request that fully completes an assigned issue must include the closing reference: `Closes #123`

Use `Refs #123` only when the pull request is related to the issue but intentionally does not complete it.

## Capability-specific execution

This document is canonical only for rules that apply regardless of agent capability. Before source acquisition or a
repository write, select the applicable route in [`agents/README.md`](agents/README.md). That router and its
focused capability guides are canonical for capability-specific source acquisition, permitted writes, verification, and
publication constraints. Explicitly coordinated work may add the focused orchestrator task guide after
capability selection. Do not copy those procedures into this document.

## Documentation ownership

Before every non-trivial documentation change or documentation review, read
[`DOCUMENTATION-OWNERSHIP.md`](DOCUMENTATION-OWNERSHIP.md). Record material ownership or consolidation
decisions in the active issue, pull request, or review discussion; do not create a separate report unless the
task requires one.

The agent implementing a change updates documentation affected by the implemented behavior in the same pull
request unless the task explicitly assigns that documentation update elsewhere. Every pull request states its
documentation impact, including when no edit is needed. For explicitly coordinated work, use the assignment and
integration rules in [`agents/ORCHESTRATOR.md`](agents/ORCHESTRATOR.md).

Canonical documentation records actual implemented behavior and explicit deferred work, not an obsolete plan.

## Test expectations by change type

[`TESTING.md`](TESTING.md) defines the detailed repository testing strategy. The minimum verification for a
pull request depends on the behavior it changes:

| Change type | Minimum expected verification |
| --- | --- |
| Confirmed defect on a supported path or real boundary | Focused regression test and failing-before evidence for the reported root cause, or a documented reason that failing-before evidence cannot reasonably be supplied |
| Stateful runtime change | Functional tests plus runtime resume-equivalence |
| External plan, snapshot, or checkpoint boundary | Valid cases and malformed-data rejection tests through the documented public boundary |
| RNG-dependent behavior | Fixed-seed deterministic comparison |
| Time-dependent behavior | Fake clock or equivalent deterministic source; no real waiting |
| Security boundary | Structured rejection, bounded work, and no uncontrolled host exception at the real documented boundary |
| Browser host/player behavior | Real browser E2E after the concrete cross-origin boundary exists |

These are relevance-based requirements. A pull request is not required to run or add every test category when
the changed behavior does not reach that layer.

## Verification

Every pull request runs its relevant configured checks and reports exact commands and results. Use the exact
Node.js version declared in `.nvmrc` and confirm the effective environment before installing dependencies.
Missing NVM is not itself a verification failure when another supported mechanism activated the required
version. Reuse earlier verification while the tested source/content and every relevant input, toolchain,
transformation or transport boundary, and mutable state on which the evidence depends are proven equivalent. Revalidate
only when one of those can invalidate the earlier evidence; a different commit or head alone is not enough when exact
relevant tree/content equivalence is established. Do not repeat equivalent nested suites, unchanged digest checks, or
oversized routine fixtures unless they add distinct evidence.

```shell
node --version
npm --version
npm ci
npm run check
git diff --check
```

The canonical compiler is the `@typescript/native` npm alias pinned in `package.json`; build and typecheck use
its public `tsc` command. The separately pinned `ts-morph` package is a development-only agent codemod tool. Do
not replace either dependency without an explicit dependency migration.

Inspect the complete diff and run any change-specific playground, browser, security, migration, or integration
checks. Report failures, warnings, skipped checks, stale or contradictory documentation, and remaining risks.
Merge only after the required review and checks pass, then follow the selected capability route for the final
publication or handoff operation.
