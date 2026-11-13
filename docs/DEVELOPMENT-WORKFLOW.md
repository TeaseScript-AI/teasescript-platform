# Development workflow

## Guiding principle

Keep unfinished work in open issues and update them at each handoff and merge. Split or combine issues, agents and
pull requests as the work needs; keep each pull request one coherent change and make handoffs explicit.

Source bundles and agent bootstrap provide local repository access when needed.
Development and integration use GitHub-native branches and pull requests.
Verified patch publication remains a separate route for publishing a concrete
tested patch result.

## Issue sizing

An issue describes one coherent outcome: a bug, task, change or decision; bundle small related items with a checklist.
Record unfinished work in an issue promptly (recording does not schedule it; an accepted known limit or a decided option
with no planned work is documented where it applies instead, and gets an issue only when something reaches it), using
the relevant headings of the [issue forms](../.github/ISSUE_TEMPLATE/) and omitting empty ones. Write for a reader
without the project's working notes: plain words and a small example first (a TeaseScript example must compile, unless
it shows the error in question), internal references (TABLE, PLAN, notes) only as supporting links, and only durable
links (no `/tmp` paths). An incomplete report is welcome. End it with a line `Filed by:` naming who wrote it, for
example `orchestrator 2 (platform)`. Search open and closed issues first and add evidence to the one tracking the same
problem, reopening it if work remains. Ground a diagnosis in reproduction, source or logs, and mark hypotheses as such.

Labels, described on GitHub:

- one orchestrator label: `platform`, `V2 compiler` or `importer`;
- one area label for the issue's main subject: `area:playroom`, `area:runtime`, `area:compiler`, `area:language`,
  `area:editor`, `area:website` or `area:tooling`; another area it touches goes in its scope;
- while a question the owner has not yet decided is open: `owner: blocking` (work waits) or `owner: input` (nothing
  waits), plus `owner: parked` when the owner has said not now. An issue without one can be finished without asking
  the owner; a task that only waits on a decision issue says "Depends on #N" instead;
- `in progress` while an agent works on it;
- `spare capacity` for work that must be done but can wait: ready, no owner input, and doing it later costs at most
  negligibly more than now (nothing upcoming builds on it, or what does would barely change); a small fix (a sentence
  or a few lines of code) gets no label and is done directly;
- `needs triage` until an orchestrator is assigned.

With `gh`, set the type and labels (`--type`, `--label`); triage fills any gap. GitHub shows a single newline in issue
and pull-request text as a line break, so write each paragraph on one line. Change labels only when the state changes.

Before implementation, the issue states the problem or goal, evidence, scope and exclusions, and acceptance criteria.
Future-facing infrastructure also needs a concrete scheduled consumer, an accepted boundary that must be correct when
first introduced, or a difficult-to-reverse boundary problem.

Prefer separate issues when each can be implemented, tested, reviewed, and merged safely on its own. A proposed
implementation phase must also be dependency-closed for behavior it introduces: if ordinary successful execution
immediately reaches a required transition, state, serialization rule, or validation path, that reachable behavior
belongs in the same landable phase unless the earlier work remains behavior-neutral. Do not invent temporary semantics
merely to preserve an artificial milestone boundary.

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

Where a rule's wording falls short of its evident intent, the intent is followed, and the corrected wording is proposed,
with the case that showed it, for the approval that applies (owner, 2026-11-10).

Before declaring a project limitation, proposing infrastructure, or presenting
owner options, verify the relevant existing capability through the smallest
authoritative evidence set. Do not generalize one API action, connector method,
helper, or environment limitation to the complete supported workflow. Report a
material shared-workflow failure instead of silently working around it.

Do not invent project-wide policy, numeric thresholds, style or readability
limits, naming rules, compatibility promises, mandatory tools, or workflow
gates. Until a durable rule has evidence, the approval that applies (`AGENTS.md`:
the owner's, except for development tooling and mechanical checks), and
synchronization into its canonical source, use configured tooling, current
authority, and task-proportional judgment.

### KISS, pragmatic YAGNI, and DRY

Once the current requirement and its authority are established, choose the
simplest complete approach that safely satisfies that requirement and its real
boundaries. Assess simplicity across design, implementation, evidence, workflow,
and maintenance cost. The smallest individual patch is not automatically the
simplest overall solution. Simplicity is judged on the code a reader meets
afterwards, not on the size of the diff: putting new code in the module and
folder its owner names is part of the simplest complete solution, and a folder or
module for a new concern is not the speculative abstraction YAGNI forbids.

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

DRY is subordinate to KISS and pragmatic YAGNI. Use:

- one canonical implementation, rule, or explanation plus references when that
  is clearer and simpler across the complete maintenance lifecycle, in
  particular when every change to one copy would have to be made to the others;
- limited local repetition when that is the clearer KISS solution, in particular
  when the copies may change independently.

A copy kept to check another (a test's independently derived expected value, an
oracle) is not repetition under this rule; `TESTING.md` governs it. Do not:

- force DRY when it creates indirection or speculative abstraction;
- keep repetition when it creates competing authority or duplicated moving facts;
- do either when it adds unnecessary recurring context cost.

For the documentation-specific application, follow
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

Fix confirmed in-scope findings in the reviewed pull request before merge; track all others, including post-merge
findings, in open issues linked to the review.

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
implementation details, hypothetical future compatibility, and unsupported
object shapes or behaviors that cannot cross a real boundary are not blockers by
default. Classify them as hardening, future work, a harness issue, or out of scope
unless evidence shows a reachable supported path or real boundary consequence.

### Review convergence

A review is not converging when successive substantive findings come from the
same invariant or problem family and each repair addresses only one newly found
sibling without reducing uncertainty about the remaining supported behavior
space. No fixed review count triggers this rule. Both the implementer and the
reviewer are responsible for recognizing and reporting the pattern without
waiting to be asked: from the second review round on, every review report and
every repair report states, for each substantive finding, whether it belongs to
a problem family an earlier round already found, and if so whether the review
is converging and why. Whoever coordinates the work compares those answers across rounds and decides how a non-converging review continues,
choosing the cheapest candidate that makes the claim true: a narrower claim (one of the three shapes in [Rules over an
open set](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#rules-over-an-open-set), with the fact that supports it shown in
the pull request: the forms actually used, a log, a count), one systematic structure, an invariant, a design round; a
scope cut to an issue is possible at any candidate. A later candidate is owed only when the earlier one leaves a sibling
live. The second sibling of one family starts the choice, in the builder's reply to the round that found it: the
implementer stops repairing instances and reports the
narrower claim and the structure, each with its cost, and a third instance is not repaired on its own. When the family's
mechanism is another tool's or the runtime's semantics (a linter's configuration, a renderer, runtime provenance read by
a static check are illustrations, not the list), the narrower claim names what the repository owns and the residual, and
makes the other tool's own run, or the runtime evidence, the oracle for it; that run is then part of the change's
required evidence, not an option. A narrowed claim that gains a sibling of its own takes the next candidate. A rule over an open set is built as in
[Rules over an open set](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#rules-over-an-open-set) from the start.
The structure and the invariant are bounded models as described below, not a generalized framework, which still needs an owner decision
([Proportional repair](#proportional-repair-and-owner-escalation)). The owner decides only when the outcome changes
product behavior or product scope, including an owner-approved acceptance criterion. Without a separate coordinator,
the implementer brings the pattern to the owner with a proposal.

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
whoever decides under the first paragraph of this section before proceeding.

### Proportional repair and owner escalation

Propose the smallest repair that restores accepted behavior or the real
boundary. Apply the KISS and pragmatic YAGNI rule above before broadening a
repair for future prevention or hypothetical reuse. Do not expand a local
defect into a generalized framework, new permanent compatibility layer, public
contract, schema, or unrelated hardening campaign without a separate owner
decision.

Record a technical limit in `docs/RESOURCE-LIMITS.md` per ADR 0019 and continue only with evidence that no reasonable
fix exists: a fix is impossible, or costs far more than it gains (such as a depth no real script reaches). Growth or
memory use that a reasonable fix removes is a bug to fix, not a limit. ADR 0019's owner decisions still apply.

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

A change under which every script still runs the same, and which changes only a warning, or the wording of a message or
a reported type, in an edge case, is the coordinator's to decide; the coordinator reports it to the owner afterwards
(owner, 2026-11-09). "Runs the same" must be established, not expected: apart from that warning or wording, the same
output, and the same success or failure at the same place, for every script and every input to it, shown by a derivation
or by a measurement over a stated complete domain. The report says in plain words what a maker could notice and in which
case.

What the type core (`src/type-inference/core/`) does on its test-only candidate route is not yet accepted behavior; the
coordinator decides it (owner, 2026-11-10). Of its differences from the legacy type checker, only a real error blocks a
pull request of it (owner, 2026-11-13): a value let through unchecked (#1526's condition 1, in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md#coarse-type-core-bounds)), a crash, a compile error for code the language text
(V30, the ADRs) does not call wrong, or a run that differs from what the language text says. A hang is a crash, and so
is work the route does not charge, since only a charge lets the work budget end it; a wrong compile error counts on a
source the base route planned, and a source the base route refused (`CandidateOutsideSlice`, [Static type
analysis](ARCHITECTURE.md#static-type-analysis)) and the head rejects with a wrong compile error is filed as an issue
with the number of converted scripts (makers' scripts converted to TeaseScript) it reaches, where the builder has them,
since they are not in the repository (coordinator, 2026-11-13). A refusal on the route stays only where it keeps a part
of the analysis that is not right yet away from sources, never to keep the legacy checker's message (coordinator,
2026-11-13). Any other difference, in a message, a warning, or when a wrong source is caught, is a note in the pull
request's body, unless it drops or worsens a fix the legacy one gives, which is a defect to repair
([`TESTING.md`](TESTING.md#the-shadow-comparison)). A choice that shapes the language, the switch itself, or what makers
get after the switch still comes to the owner when it arises (owner, 2026-11-10).

These rules prevent accidental scope escalation. They do not permit reviewers
to dismiss reproducible defects or weaken accepted syntax/semantics,
deterministic execution, serializable checkpoint requirements, or validation at
external, host, checkpoint, persistence, package, and security boundaries.

A small product defect found while building may be fixed in the same pull request only when fixing it costs less than
filing an issue, the fix stays within the files and behavior the pull request already changes, and it does not change
architecture, language behavior, security boundaries, or a public contract. The pull-request description names it,
never silently, and it is proportionately checked. A larger defect, or one whose fix would widen the review, is filed
as an issue with its witness and listed under that issue number in the pull-request body's Known differences section
([Evidence](#evidence)). A defect in a test oracle or shared test helper is fixed before any pull request that relies
on it merges, in its own pull request when it is outside scope.

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

## Normal flow

For a normal issue:

1. Confirm the issue is sufficiently scoped and accepted for implementation.
2. Choose the [review route](#review-routes); on the full route, get the plan accepted.
3. Create a short-lived branch from current `main`.
4. Implement code, tests, fixtures, examples, and relevant documentation on that branch.
5. Open a pull request to `main`; a draft pull request may be opened early when visibility or feedback is useful.
6. Keep the pull request description aligned with the final implementation.
7. Process review feedback on the same branch and pull request.
8. Run the required verification and review the complete diff, as the [merge rules](#merge) assign it.
9. Merge after approval and passing checks ([Merge](#merge)), then delete the branch.

Every route, including the minimal one, uses this flow. A minimal-route pull request needs no issue, so step 1 does not
apply to it.

The pull request is the implementation handoff record.

Make small logical commits with concise English imperative messages.

Every pull request that fully completes an assigned issue must include the closing reference: `Closes #123`

Use `Refs #123` only when the pull request is related to the issue but intentionally does not complete it.

## Review routes

The route sets the plan, evidence, and reviews a pull request needs. Roles are assignments for one piece of work, not
persistent identities.

### Roles

- **Owner:** decides product behavior, product scope, and policy; can hold any merge.
- **Coordinator** (an orchestrator): schedules work, chooses routes, starts pre-research and design rounds, accepts
  plans, briefs the final review, decides how a non-converging review continues
  ([Review convergence](#review-convergence)), and merges. Rules of thumb: [`ORCHESTRATION.md`](ORCHESTRATION.md).
- **Builder:** plans, implements, starts the plan and code review rounds, repairs, and reports. It never merges.
- **Round reviewer:** runs pre-research, plan rounds, design rounds, and code review rounds.
- **Independent final reviewer:** runs the final review in a fresh session that reviewed none of the pull request's
  rounds. A different model only when the coordinator records why the round reviewer's model is not enough.

The coordinators' private repository `TeaseScript-AI/orchestration-notes` holds the role-to-model table
(`shared/model-roles.md`) and each coordinator's plans, design reports, and briefs; its README names where evidence
lives. This document names roles only and does not copy that repository's contents.

### Choosing the route

The coordinator names the route in the assignment. The plan confirms it or proposes another, and the coordinator
chooses again once the fix is known. Choose by what the planned change can break, not by its size, its component, or
the area the bug is in. A bug whose fix is not yet known starts light unless a trigger below is already visible. When
it is unclear whether a trigger holds for the planned change, take the heavier route.

**Full route** when any of these holds:

1. **A contract changes:** something other work relies on, such as language syntax or semantics, a public or
   host API, a protocol between components, a stored or exchanged data format (saves, checkpoints, a database schema),
   a security or trust boundary, or which inputs complete, stop, or fail under a limit or budget. An additive field
   counts when it is persisted or part of a format, protocol, or API that others consume, whether or not anything reads
   the new field yet. Compatibility rules belong to the component's own documents, such as
   [Format evolution](RUNTIME.md#format-evolution) and
   [Stability and future contracts](DATA-AND-API.md#stability-and-future-contracts); this section does not decide them.
2. **A rule that produces many outputs changes:** a generated message, check, derived type, format rule, or layout
   rule. Changing one literal string or one field does not count.
3. **A mechanism changes that other code builds on:** who owns some state, a lifecycle, the order or timing of
   asynchronous work, caching, scheduling, or a test oracle or shared test helper.
4. **The planned change has broad or hard-to-see effects:** it can alter behavior or cost in many places at once, or
   in ways one test cannot show, because it changes an ordering, timing, or concurrency mechanism, input handling shared
   by many paths, or growth with input size. A local guard with a deterministic regression test does not count.

**Light route** for a behavior change that meets none of them, such as a local repair with a reproduction or a local
guard with a deterministic regression test, and for a refactor, tooling, or generator change meant to keep behavior.

**Minimal route** for a change with no behavior change: documentation, comments, identity rebases (the diff against the
new base equals the old diff), and test-only clean-ups that touch no test oracle or shared test helper (otherwise
trigger 3 applies). [Test admission](TESTING.md#test-admission-and-consolidation) still applies to test clean-ups.

The coordinator moves a pull request to the full route as soon as a finding shows a trigger, a problem family forms
across rounds ([Review convergence](#review-convergence)), or a light-route pull request still has open findings after
its second round. There is no route beyond full; a family there follows the steps in Review convergence.

| | Full | Light | Minimal |
| --- | --- | --- | --- |
| Compiler | a rule that changes diagnostics, emitted plans, or checks; charging, stop thresholds, or growth with input | a crash on one input; a tooling or generator change | docs, comments |
| Runtime | a checkpoint field; the protocol between runtime and Player; a value or format rule | a local error with a reproduction | a test clean-up that touches no oracle or shared helper |
| Player | who owns input state; the mechanism that orders asynchronous replies; a layout rule used everywhere | one component's layout fault; a guard against a double tap, with a deterministic regression test | wording in docs |
| Backend | a database migration; an API contract, including an additive field; authentication | a validation fix in one endpoint | config comments |
| Website front end | an API client contract; sign-in or session handling; a component or style rule used on every page | one page's fault, with a deterministic regression test | copy text |

### The plan

On the light route, a short plan goes in the pull-request description; it needs no acceptance, so the builder proceeds,
and the coordinator may redirect at any review. On the full route, the plan is a document in the coordinators'
repository that the pull request links, and the coordinator accepts it before code. On either route, the plan names
every tool, check, proof or generator the change builds whose verdict an acceptance claim rests on, wherever it lives,
an evidence folder included: what it decides, the set it closes and what an input outside that set does, the maintained
tool that already does that job (the language's own parser or compiler, an existing checker, differ or test runner, a
helper under `shared/`) and the reason the plan does not use it.
[Rules over an open set](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#rules-over-an-open-set) holds for such a check
as for the code it checks: a check over code forms fails every form it does not name, or the plan narrows its claim to
what the check resolves. Such a tool lives under the script boundary in [Report what cost a wrong
turn](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#report-what-cost-a-wrong-turn) (a shared helper with its header
until a rule names its output, then a repository tool with tests), never loose in an evidence folder. A probe that only
collects figures an existing tool prints needs no entry. Anything a later reader needs from it, or from the reports it
links, is summarised in the pull request. A full-route plan states:

- the files and the expected size of each change (lines changed per file), and where new code goes: its module and
  folder, per [Code structure](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-structure);
- what must stay identical and what may differ. "Identical to the base" is the bar only for a change meant to change
  nothing (a speed-up, a clean-up, a move), and only for normal compiles and runs: those that reach no limit of the
  [resource-limit registry](RESOURCE-LIMITS.md), failing ones included. Every difference outside that bar is named with
  its judgement (an improvement, neutral, or a regression) and its extent: the set it was measured over, how that set
  was chosen, and the case that would break the claim;
- the evidence level;
- the growth bar, when it applies;
- the construction, its clauses, and a mutant for each clause;
- the hunks near other open work: files that other open pull requests also change (`gh pr list`, then
  `gh pr diff <N> --name-only` for each);
- the facts about existing code that the construction depends on, each marked read, probed, or unverified.

The **construction** is the mechanism the plan proposes to make its claim true; a **clause** is one property the
construction must guarantee.

**Pre-research** comes before the plan when the design is unsettled or a decisive fact about existing code is
unverified. The coordinator starts it and the round reviewer runs it; it informs the plan without writing it, and the
plan marks the facts it probed as probed. A plan that still marks a decisive fact unverified gets one plan round, which
the builder starts and the round reviewer runs, probing those facts first; a second plan round happens only when the
first refuted the construction. Pre-research, plan-round, and design-round reports go in the coordinators' repository,
and the plan links them. Before a pull request exists, these rounds write only there, never to this repository.

### Design rounds

A design round is due when a family reaches its fourth sibling finding (a count of siblings of one mechanism, not of
rounds, so it is not a fixed review count), or when an invariant chosen under [Review convergence](#review-convergence)
has gained a clause in each round. The coordinator starts it. The round reviewer designs a construction with the whole
family as the bar and writes a design report in the coordinators' repository. The report first answers whether one
structure in the mechanism can close the class, or whether the mechanism is blind to it, as a static check is to runtime
provenance. The builder writes a new plan from the report, linking it rather than copying it, and the coordinator
accepts the plan. The code review rounds then restart at round 1 on the new construction; the pull request's earlier
rounds stay visible.

When the report finds the mechanism blind, a second design round on the rewritten plan is the last. After it, the claim
narrows to what the mechanism proves, and the plan and the pull-request body name the residual class and the guard
that does prove the invariant.

A scope cut splits its residual:

- a part that another mechanism can guard is filed as that mechanism's item, and it is not `spare capacity`, because
  supported behavior stays unguarded until that guard exists;
- a part that no supported path reaches is closed with its reason and evidence, to the bar of a proven limit in
  [ADR 0019](decisions/0019-resource-limit-governance.md) when it concerns production behavior.

Only a residual that cannot bite stays in the backlog.

### Evidence

The plan names an evidence level. The default is level 1 on the light route and level 2 on the full route. Level 3
applies when the change alters a rule that produces many outputs, a stored or exchanged format, or limit behavior; in
other cases the coordinator judges whether it applies.

1. Focused tests and the component's checks.
2. Level 1, plus a before/after comparison over the component's corpus.
3. Level 2, plus the component's extended set.

Each component's row in [Checks and corpora by component](TESTING.md#checks-and-corpora-by-component) defines its
levels. Where a level has no corpus yet, the plan states what it uses instead.

On the light route, the evidence is CI plus, for a confirmed defect fix on a supported product path or real boundary,
the regression test that the [regression-test rule](TESTING.md#regression-test-rule) requires, including its
exception: "When failing-before evidence cannot reasonably be supplied, document why and provide the strongest focused
reproduction available." A refactor, tooling, or generator change uses an identical before/after comparison instead. On
the minimal route, the evidence is CI plus `git diff --check`.

When a pull request knowingly leaves at least one difference, on any route, its body has a **Known differences**
section listing each one with its issue number.

On the full route, the before/after comparison is classified. Each difference is in one class: identical; cost only
(work, time, memory, or size); limit behavior moved (what completes, stops, or fails under a limit); output added or
lost (a diagnostic, check, message, or field); or result changed. Each difference is also judged: an improvement,
neutral, or a regression. The plan or the pull-request body proposes the judgement and a reviewer contests it with a
case. A difference that departs from accepted syntax, semantics or a recorded decision is a regression whatever its
merit; when the merit is worth changing the decision (not for a nitpick), the coordinator proposes that change to the
owner, with the case and what it improves, and work the answer does not block continues meanwhile (owner, 2026-11-10).
A difference that restores them is an improvement. A lost check is always a regression and a blocker. Any other
difference is a blocker only when it is a regression, or when the change was meant to change nothing and the difference
is in a normal compile or run. A review asks for no improvement to be undone, and no round is spent on a difference
judged neutral. A cost-only difference is a regression only when the growth bar applies and is exceeded. The
pull-request body's comparison ledger records every difference, one a review found included, with its class, its
judgement, its extent and the case that shows it, and includes the known differences.

The **growth bar** applies when the change alters a path whose work grows with input and an amplification risk is
credible; its method is in [Scaling diagnostics](TESTING.md#scaling-diagnostics).

**Mutants** apply to each clause of a full-route construction:

- each mutant is a temporary patch, identified by the SHA-256 of the patch;
- it dies on a test for its own clause, not only on a shared assertion;
- a survivor needs a killing witness, or an equivalence argument in the pull-request body;
- survivors are never reported as a bare count.

Mutants are disposable evidence, like the
[negative probes](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#self-review-and-assigned-review), not kept tests,
unless [test admission](TESTING.md#test-admission-and-consolidation) accepts them.

Evidence goes in a directory that READY names, where the coordinators' repository's README says, kept at least until
merge, with a `SHA256SUMS` manifest that `sha256sum -c SHA256SUMS` verifies from that directory. The pull request
summarises what a later reader needs from it.

### Review rounds

The builder starts each code review round as a new reviewer session with a compact brief: the head, the plan, the
earlier findings and their answers, the diff since the last round, and the scope. The reviewer's only write is one
comment on the pull request, with the content in
[Findings and outcome](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#findings-and-outcome): the comment names the
exact head SHA and, where evidence contradicts what the brief assumes, says so first; from the second round on it
states for each earlier finding whether it is closed. Rounds after the
first are scoped to the open findings. Findings follow [Review convergence](#review-convergence).

- **Full:** rounds until the reviewer states that every finding from every round is closed, then the final review.
- **Light:** one or two rounds; when a round found a blocker, a final review follows READY, as on the full route.
- **Minimal:** no rounds; one review of the diff gives the approval ([Merge](#merge)).

If a reviewer is unavailable or stalls, wait, or cancel the round and start it again with the same brief; the pull
request holds. Never move a review to another role's model, except under a fallback the role-to-model table names.

### Builder messages and READY

The builder sends one complete message per event to the coordinator, through the channel the assignment names: the
plan; READY; a question, with the options and a recommendation, continuing meanwhile on whatever the answer does not
block; a finding or a ruling the builder contests, with the reason, before it is repaired or built; a blocker; or a
family report ([Review convergence](#review-convergence)). There are no progress notes between events, and stopping
work does not deliver a message.

A critical question is asked when something deserves asking, by a builder, a reviewer or a coordinator alike, of a
plan, a brief, a ruling or a finding, in the message its author already sends; the number is whatever is worth asking,
and none is invented to fill a place. A plan, a READY, a review comment and a coordinator's brief each carry one line,
`Critical questions:`, with those questions or `none`: the line records that its author considered it, and is no duty
to find one.

READY contains:

- the head SHA, the base branch and its SHA, and that it merges cleanly;
- the CI state;
- the evidence directory, and that its manifest verifies, where the route has evidence beyond CI and the pull
  request's own tests;
- for every comparison run, how many runs completed of how many were expected; a run that failed to complete is not
  complete;
- every review round so far, as a link to its comment, with its verdict;
- departures from the accepted plan;
- friction met, one line each with its class and what was done (fixed here, the issue, or the proposed rule), as in
  [Report what cost a wrong turn](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#report-what-cost-a-wrong-turn),
  and the line "Worked around or repeated by hand:", with "none" when there was nothing;
- each lint disable, `@ts-expect-error` or `@ts-ignore`, skipped test and allowlist entry the change adds, with its
  reason;
- the claim the builder holds weakest, and the command behind each count and each "none" in this message;
- on the full route, what the final review should cover, starting with that claim.

After any repair, the builder sends READY again at the new head.

### The final review

The coordinator writes the final reviewer's brief. It contains:

- the exact head and base, and what to read;
- numbered items, each with the claim, the cases to construct beyond the pull request's own tests, and what counts as
  a blocker; the builder's weakest claim comes first, and where the coordinator doubts a claim the item asks the
  reviewer to break it;
- the clarity and structure item: does anything the change adds or touches mislead, or sit outside the module and
  folder its owner names, as in [Code that does not mislead](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-that-does-not-mislead)
  and [Code structure](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-structure);
- the delta item: from the diff against the base, confirm that the change is exactly the planned one and nothing else,
  naming collateral or generated files, debug code, secrets, unrelated changes, and stale documentation;
- the output format, which follows
  [Findings and outcome](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#findings-and-outcome).

The builder's own summary is never the reviewer's only input. A blocker is as defined, canonically, in
[Review finding classes](#review-finding-classes): "accepted behavior, a supported public/trusted path, a real
boundary, an explicit owner-approved acceptance criterion, or normal development/operation is concretely broken", with
the evidence in [Blocking evidence](#blocking-evidence). The final reviewer's only write is one comment on the pull
request that names the exact head SHA.

The builder repairs each blocker and reruns the evidence the repair can invalidate ([Verification](#verification)).
The round reviewer checks the repair in one round scoped to those findings, which also repeats the delta item at the
new head. A second final review happens only when the repair changed the construction.

### Pull requests and rebases

- The builder opens the pull request as a draft and marks it ready only after READY.
- The builder never merges and never changes the base, except to retarget a stacked pull request to the default branch
  after its parent merges. Stacks merge parent first; the child then gets an identity rebase and is retargeted.
- When the base moves in the pull request's files, the builder rebases. It then either proves identity (the diff
  against the new base equals the old diff, with line counts on both sides) or reruns the affected evidence. A rebase
  that changes the delta, including one that resolves conflicts, restarts the review rounds on the changed part; on the
  full route, a further final review happens only when that change alters the construction.

### Merge

The coordinator merges under the owner's standing authorization; this is the authorization that
[`agents/DIRECT-REPOSITORY.md`](agents/DIRECT-REPOSITORY.md) requires. An owner hold always wins: it is the
`owner: blocking` label, or an owner comment on the pull request asking to hold, and the coordinator checks both
before merging. Approval is a review
comment that names the head SHA and states that the change can land. The author never approves its own change. On the
minimal route, the coordinator's review of the diff is the approval; when the coordinator authored the change, another
agent (a builder or a round reviewer) approves it.

The complete-diff review before merge is, on the full route, the final review's delta item (repeated at the new head
after a repair) together with the coordinator's scope check: the file list and size against the plan, collateral or
generated files, debug code, secrets, unrelated changes, and stale documentation; the coordinator reads the hunks this
check or the pattern scan flags. On the light route, the coordinator reviews the complete diff; on the minimal route,
the approver does.

Before the merge command, a mechanical pattern scan looks for generated files, debug code, and secrets, for example:

```shell
gh pr diff <N> --name-only | rg '(^|/)(dist|coverage)/|\.(map|log|tgz)$'
gh pr diff <N> | rg -n '^\+.*(debugger;|console\.(log|debug)\(|\.only\(|PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})'
```

`rg` exits 1 when nothing matches; each match is a hunk to read.

The merge checklist:

1. The head is unchanged since the last review that approved it.
2. The base is the intended branch.
3. The pull request is mergeable and clean, CI is green on the head, and `git diff --check` against the base passes.
4. Every review round, including the final review, is a comment on the pull request that names its head SHA.
5. The evidence manifest verifies, where the route has evidence beyond CI.
6. The complete-diff review and the pattern scan pass.
7. No owner hold is open: no `owner: blocking` label on the issue or the pull request, and no owner comment on the
   pull request asking to hold.
8. The project's records are updated with the merge: the issue, its labels, the tracker issues that list it, and any
   status document the change makes stale.
9. Merge by squash, as `AGENTS.md` prefers, delete the branch, and, when the pull request closes an issue, confirm it
   closed through `Closes #N`.

## Capability-specific execution

This document is canonical only for rules that apply regardless of agent capability. Before source acquisition or a
repository write, select the applicable route in [`agents/README.md`](agents/README.md). That router and its
focused capability guides are canonical for capability-specific source acquisition, permitted writes, verification, and
publication constraints. Do not copy capability-specific procedures into this document.

## Documentation ownership

Before every non-trivial documentation change or documentation review, read
[`DOCUMENTATION-OWNERSHIP.md`](DOCUMENTATION-OWNERSHIP.md). Record material ownership or consolidation
decisions in the active issue, pull request, or review discussion; do not create a separate report unless the
task requires one.

The agent implementing a change updates documentation affected by the implemented behavior in the same pull
request unless the task explicitly assigns that documentation update elsewhere. Every pull request states its
documentation impact, including when no edit is needed.

Canonical documentation records actual implemented behavior and explicit deferred work, not an obsolete plan.

## Test expectations by change type

[`TESTING.md`](TESTING.md) defines the detailed repository testing strategy. The minimum verification for a
pull request depends on the behavior it changes:

| Change type | Minimum expected verification |
| --- | --- |
| Confirmed defect on a supported path or real boundary | Focused regression test and failing-before evidence for the reported root cause, or a documented reason that failing-before evidence cannot reasonably be supplied |
| Stateful runtime change | Functional tests plus runtime resume-equivalence |
| External plan, snapshot, or checkpoint boundary | Valid cases and invalid-data rejection tests through the documented public boundary |
| RNG-dependent behavior | Fixed-seed deterministic comparison |
| Time-dependent behavior | Fake clock or equivalent deterministic source; no real waiting |
| Security boundary | Structured rejection, bounded work, and no uncontrolled host exception at the real documented boundary |
| Browser host/player behavior | Real browser E2E after the concrete cross-origin boundary exists |

These are relevance-based requirements. A pull request is not required to run or add every test category when
the changed behavior does not reach that layer.

## Verification

Every pull request runs its relevant configured checks and reports exact commands and results. Use the exact
Node.js version declared in `.nvmrc` and confirm the effective environment before installing dependencies.
The code targets ES2025 (`tsconfig.json`'s `target`, the Player's `lib` in `player/vue/tsconfig.json` and its Vite
`build.target`), which Node 26 and current browsers implement; older browsers are not supported (owner, 2026-11-07).
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
its public `tsc` command. The separately pinned `ts-morph` package supports development-only codemods and
[lint exception parsing](LINTING.md). Do
not replace either dependency without an explicit dependency migration.

Inspect the complete diff and run any change-specific playground, browser, security, migration, or integration
checks. Report failures, warnings, skipped checks, stale or contradictory documentation, and remaining risks.
Merge only after the route's approval and checks pass ([Merge](#merge)), then follow the selected capability route for
the final publication or handoff operation.
