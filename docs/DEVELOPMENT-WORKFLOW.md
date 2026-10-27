# Development workflow

## Guiding principle

Keep unfinished work in open issues and update them at each handoff and merge. Split or combine issues, agents and
pull requests as the work needs; keep each pull request one coherent change and make handoffs explicit.

Source bundles and agent bootstrap provide local repository access when needed.
Development and integration use GitHub-native branches and pull requests.
Verified patch publication remains a separate route for publishing a concrete
tested patch result.

## Issue sizing

An issue describes one coherent outcome: a bug, a task, a change or a decision. Bundle small related items in one issue
with a checklist.

The agent creating or substantially refining an issue should include:

- the observed problem, requested outcome, or design goal;
- evidence, reproduction, or relevant source references;
- explicit scope and exclusions;
- acceptance criteria;
- when proposing future-facing infrastructure, the concrete reason that justifies implementing it now (see
  [KISS, pragmatic YAGNI, and DRY](#kiss-pragmatic-yagni-and-dry)).

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

A previous comment or draft does not become authoritative because another agent accepted or implemented it; a
specification or ADR becomes authoritative only after acceptance through the repository authority process, and only
within its recorded scope. Existing behavior may still require preservation when it is part of a supported path, an
accepted contract, or an explicit owner-approved acceptance criterion. Tests may prove such behavior, but their private
fixture structure, helper identity, or exact harness design does not independently create a product contract.

Use words such as `must`, `exact`, `versioned`, `authoritative`, and `compatibility` only when the text identifies the
accepted behavior, real boundary, or owner decision that requires that strength. A stricter implementation being
technically possible is not sufficient. Until a proposed durable rule has evidence, owner approval, and synchronization
into its canonical source, use configured tooling, current authority, and task-proportional judgment.

### KISS, pragmatic YAGNI, and DRY

Once the current requirement and its authority are established, choose the simplest complete approach that safely
satisfies that requirement and its real boundaries, assessing simplicity across design, implementation, evidence,
workflow, and maintenance cost. The smallest individual patch is not automatically the simplest overall solution. Less
code or documentation is beneficial when clarity, behavior, evidence, and maintenance remain at least as strong.

Pragmatic YAGNI applies this rule to future-facing complexity: implement only the complexity needed for the current
requirement and its real boundaries. The two do not compete; apparent conflict normally means simplicity is being
assessed too locally or hypothetical future value is being treated as a current requirement. “We may need this later,”
“a more general solution would be cleaner,” an unscheduled backlog entry, a historical implementation, or an earlier
test or review comment does not by itself justify present infrastructure. Future-facing complexity needs a concrete
reason, such as:

- an owner- or coordinator-scheduled consumer that will use it;
- an accepted boundary that must be correct when first introduced;
- a demonstrated data, security, persistence, or public-compatibility problem
  that would be materially harder to repair later.

Use the smallest seam that addresses that reason: a narrow interface for an already scheduled next consumer may be
proportionate; implementing the complete generalized future subsystem is not. When no present implementation is
justified, propose or route the idea through the appropriate owner-governed wish, planning, backlog, or open-decision
process. Recording a proposal preserves it without accepting, scheduling, or authorizing implementation and without
turning it into production maintenance surface.

DRY is subordinate to KISS and pragmatic YAGNI. Use one canonical implementation, rule, or explanation plus references
only when that is clearer and simpler across the complete maintenance lifecycle; otherwise use limited local
repetition. Do not force DRY when it creates indirection, competing authority, duplicated moving facts, speculative
abstraction, or unnecessary recurring context cost. [`DOCUMENTATION-OWNERSHIP.md`](DOCUMENTATION-OWNERSHIP.md) applies
this rule to documentation.

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

Review lenses are in
[`IMPLEMENTATION-AND-REVIEW.md`](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#self-review-and-assigned-review);
severity and evidence follow the finding classes above and the blocking-evidence rules below.

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

A review is not converging when successive substantive findings come from the same invariant or problem family and
each repair addresses only one newly found sibling without reducing uncertainty about the remaining supported behavior
space. No fixed review count triggers this rule, and repeated one-off patches do not prove convergence. Both the
implementer and the reviewer recognize and report the pattern without waiting to be asked: from the second review round
on, every review report and every repair report states, for each substantive finding, whether it belongs to a problem
family an earlier round already found, and if so whether the review is converging and why. Whoever coordinates the
work compares those answers across rounds and brings a non-converging pattern to the owner with a proposal; without a
separate coordinator, the implementer does this.

Signals include consecutive findings involving the same lifecycle, validator, helper, state transition, or
public/trusted boundary; repairs repeatedly adding one isolated special case; no explicit account of the remaining
bounded behavior space; tests growing mainly as a list of previously discovered incidents; completeness uncertainty not
decreasing after each repair; and a reviewer continuing to find sibling cases without being able to explain why the
remaining space is covered.

When these signals appear, pause before repeating the same repair cycle and briefly record, in the active pull-request
or issue discussion or in the owner/coordinator handoff when that is the active coordination surface:

1. the recurring pattern;
2. why the current method is not demonstrating convergence;
3. whether the weakness is in the implementation, decomposition, requirement
   model, or evidence strategy;
4. the smallest appropriate alternative;
5. whether a material scope or execution-strategy change needs owner or
   coordinator approval.

Do not create a separate report or policy file solely for this checkpoint unless an existing canonical document
genuinely becomes inaccurate.

The implementer adopts, or the reviewer recommends or requires, the smallest systematic repair or evidence method that
can establish completeness, such as an explicit test matrix, state-transition table, invariant inventory, property- or
model-based strategy, a focused completeness audit, splitting an overly broad issue, or simplifying or redesigning the
implementation. Do not prescribe a matrix or new framework for every repeated finding; choose the smallest method that
matches the demonstrated problem. A bounded systematic model is justified when it is the smallest credible way to
resolve demonstrated completeness uncertainty, but it does not justify generic infrastructure, speculative
compatibility, or unrelated hardening. Isolated findings, unrelated defects, and a known finite repair list whose
remaining coverage is understood may continue through ordinary repair and review.

The implementer must not silently broaden the pull request into a large campaign. When the revised approach is a
material scope, redesign, issue-split, or execution-strategy change, present the pattern, options, recommendation, cost,
and exclusions to the owner or coordinator and obtain their decision before proceeding. Uncertainty that cannot be
bounded may require a separately assigned audit.

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

When existing content must survive, use the normal Git route or verified patch publication; do not switch to full-file
replacement midway through a preservation edit merely because it appears simpler.

## Normal flow

For a normal issue:

1. Confirm the issue is sufficiently scoped and accepted for implementation.
2. Create a short-lived branch from current `main`.
3. Implement code, tests, fixtures, examples, and relevant documentation on that branch.
4. Open a pull request to `main`; a draft pull request may be opened early when visibility or feedback is useful.
5. Keep the pull request description aligned with the final implementation.
6. Process review feedback on the same branch and pull request.
7. Run the required verification and review the complete diff.
8. Merge after approval and passing checks, then delete the branch.

The pull request is the implementation handoff record. Every pull request that fully completes an assigned issue must
include the closing reference `Closes #123`; use `Refs #123` only when the pull request is related to the issue but
intentionally does not complete it.

## Capability-specific execution

This document is canonical only for rules that apply regardless of agent capability.
[`agents/README.md`](agents/README.md) and its focused capability guides are canonical for capability-specific source
acquisition, permitted writes, verification, and publication constraints. Do not copy capability-specific procedures
into this document.

## Documentation ownership

Record material documentation ownership or consolidation decisions (see
[`DOCUMENTATION-OWNERSHIP.md`](DOCUMENTATION-OWNERSHIP.md)) in the active issue, pull request, or review discussion;
do not create a separate report unless the task requires one.

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

Use the exact Node.js version declared in `.nvmrc` and confirm the effective environment before installing dependencies.
Missing NVM is not itself a verification failure when another supported mechanism activated the required version. Reuse
earlier verification while the tested source/content and every relevant input, toolchain, transformation or transport
boundary, and mutable state on which the evidence depends are proven equivalent. Revalidate only when one of those can
invalidate the earlier evidence; a different commit or head alone is not enough when exact relevant tree/content
equivalence is established. Do not repeat equivalent nested suites, unchanged digest checks, or oversized routine
fixtures unless they add distinct evidence.

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

Run any change-specific playground, browser, security, migration, or integration checks, and report stale or
contradictory documentation with the other results `AGENTS.md` requires. Merge only after the required review and checks
pass, then follow the selected capability route for the final publication or handoff operation.
