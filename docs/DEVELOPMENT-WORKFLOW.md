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

Use coordinated multi-agent work only when the work cannot reasonably be completed as one coherent agent task, or when several dependent workstreams must be reviewed and landed together.

Source bundles and agent bootstrap provide local repository access when needed.
Development and integration use GitHub-native branches and pull requests.
Verified patch publication remains a separate route for publishing a concrete
tested patch result.

## Issue sizing and execution recommendation

An issue should normally describe one coherent, reviewable task that one agent can own from reproduction or design through implementation, tests, documentation impact, and pull request.

The agent creating or substantially refining an issue should include:

- the observed problem, requested outcome, or design goal;
- evidence, reproduction, or relevant source references;
- explicit scope and exclusions;
- acceptance criteria;
- when proposing future-facing infrastructure, the concrete scheduled consumer
  or difficult-to-reverse boundary problem that justifies implementing it now;
- an execution recommendation:
  - `Single agent` — the default;
  - `Coordinated multi-agent` — only with a short concrete rationale.

Before recommending multiple agents, first consider whether the work can be split into independent issues. Prefer separate single-agent issues when each can be implemented, tested, reviewed, and merged safely on its own.

Multiple agents are justified when, for example:

- one accepted goal contains genuinely separate workstreams that can progress independently;
- the workstreams share a contract or integration gate and must land together;
- sequencing or overlapping behavior requires an explicit merge order;
- the task is too broad for one agent but splitting it into independently mergeable issues would create contradictory intermediate states or duplicated work.

Do not recommend multiple agents only because an issue is large, touches several files, or benefits from review. One agent may still own a complex but coherent issue.

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

### Pragmatic YAGNI

Once the current requirement and its authority are established, implement only
the complexity needed for that requirement and its real boundaries.

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

When no present implementation is justified, route the idea to the appropriate
wish, planning, backlog, or open-decision location. Recording an idea preserves
it without turning it into production maintenance surface.

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

### Blocking evidence

A blocking correctness finding should normally include:

- a reproducible case;
- the supported public or trusted path through which it occurs;
- expected and actual behavior;
- the practical user, data, determinism, security, or maintenance consequence;
- a focused failing test, or a clear reason why one cannot yet be supplied.

Examples include broken accepted TeaseScript behavior, a supported
source-to-runtime regression, partial or corrupt canonical state, observably
incorrect deterministic execution or checkpoint restore, bypass of a real
trust boundary, an unmet owner-approved criterion, or a concrete block to
normal development, deployment, or maintenance.

Manually fabricated impossible internal states, unsupported inputs, private
implementation details, hypothetical future compatibility, and hostile objects
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

Possible alternatives include an explicit test matrix, state-transition table,
invariant inventory, property- or model-based strategy, a focused completeness
audit, splitting an overly broad issue, or simplifying or redesigning the
implementation. Do not prescribe a matrix or new framework for every repeated
finding; choose the smallest method that matches the demonstrated problem.

Isolated findings, unrelated defects, and a known finite repair list whose
remaining coverage is understood may continue through ordinary repair and
review. Repeatedly applying the smallest local patch is not automatically the
simplest overall solution. Under pragmatic YAGNI, a bounded systematic model is
justified when it is the smallest credible way to resolve demonstrated
completeness uncertainty, but it does not justify generic infrastructure,
speculative compatibility, or unrelated hardening.

The implementer must not silently broaden the pull request into a large
campaign. When the revised approach materially changes scope or execution
strategy, present the pattern, options, recommendation, cost, and exclusions to
the owner or coordinator before proceeding.

### Proportional repair and owner escalation

Propose the smallest repair that restores accepted behavior or the real
boundary. Apply the pragmatic YAGNI rule above before broadening a repair for
future prevention or hypothetical reuse. Do not expand a local defect into a
generalized framework, new permanent compatibility layer, public contract,
schema, or unrelated hardening campaign without a separate owner decision.

When owner approval is required, explain in ordinary language what product
behavior, data risk, security boundary, or maintenance problem the stronger
contract protects, what happens without it, and what complexity it adds. Do not
ask the owner to approve an unexplained technical abstraction.

These rules prevent accidental scope escalation. They do not permit reviewers
to dismiss reproducible defects or weaken accepted syntax/semantics,
deterministic execution, serializable checkpoint requirements, or validation at
external, host, checkpoint, persistence, package, and security boundaries.

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

A single-agent pull request that completes its issue may use:

```text
Closes #123
```

## Verified source artifacts for review and handoff

The source-bundle workflows produce short-lived, verifiable Git artifacts when a reviewer, verifier, or network-restricted agent needs an exact repository snapshot with Git history.

`Source bundle` runs automatically for:

- every pull-request update, using the exact pull-request head rather than GitHub's synthetic merge commit;
- every push to `main`, using the exact pushed commit.

To regenerate an artifact for an older or expired source revision through the GitHub connector:

1. Resolve the full lowercase 40-character source commit SHA and the exact current `main` SHA.
2. Choose a nonce matching lowercase `[a-z0-9][a-z0-9-]{0,31}`; for example, `agent-149-1`.
3. Create `source-bundle-request/<source-sha>/<nonce>` at that exact `main` SHA with the connector's `create_branch` action. Do not create an empty commit or add request files.
4. Wait 90 seconds before the first status lookup, then poll the requested source commit for context `source-bundle/request/<nonce>`.
   If it is still absent, wait 30 seconds before each retry. These delays reduce unnecessary connector calls but are not completion guarantees because GitHub Actions queue time varies.
5. On success, parse the status description `artifact <artifact-id> sha256:<artifact-digest>` and pass the numeric ID to `download_workflow_artifact`.
6. Verify the downloaded artifact and confirm that the temporary request branch was removed.

The request branch runs only a permissionless gate. A separate `workflow_run` processor loaded from the default branch revalidates the strict branch name, unchanged request SHA, default-branch ancestry even if `main` advances after branch creation, and requested source commit. The source is checked out separately and treated only as data. Status publication has only `statuses: write`; cleanup has only `contents: write`, checks out no repository content, and deletes the request ref only through an exact-SHA `--force-with-lease` from an empty temporary Git directory. Creating the repository branch is the request authorization; GitHub continues to enforce repository and artifact access for private repositories.

The downloaded ZIP contains:

```text
repository.bundle
manifest.json
SHA256SUMS
```

Turn the downloaded ZIP into a verified local checkout with a trusted preinstalled copy of the repository-owned helper. For pull-request review, obtain `<review-merge-base-sha>` from `compare_commits.merge_base_commit.sha`, not from the current base-branch tip:

```shell
python3 tools/local-agent/prepare-source-review.py \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <github-artifact-sha256> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --expected-head <source-sha> \
  --expected-merge-base <review-merge-base-sha> \
  --output /mnt/data/source-review
```

The helper validates the outer digest, ZIP paths and exact payload, internal checksums, manifest identities, complete bundle, expected head and optional merge-base ancestry, checked-out tree, `git fsck`, and clean worktree. It exposes the output path only after every check succeeds and removes the temporary `origin` remote so the result cannot be mistaken for a network clone.

Connector-based ChatGPT agents must use the local-first route in `CHATGPT-GITHUB-WORKFLOW.md`. In that environment, do not try `git clone` or repeated connector file reads as the normal repository acquisition path; download one exact source artifact, prepare it locally, and reserve the connector for live GitHub state and writes.

A source artifact contains committed repository files and reachable Git history for the selected commit. It does not contain issues, pull-request comments or reviews, Actions history, repository settings, secrets, credentials, `node_modules`, or uncommitted local changes. Artifacts expire after one day; create a new request branch when a fresh copy is required.

## Coordinated multi-agent model

Use this model only after it has been explicitly selected for a complex issue or coordinated milestone:

```text
coordinator
    -> integration branch
executors
    -> one branch and pull request per workstream
coordinator
    -> review, merge order, and canonical documentation
Codex or another final verifier
    -> combined clean verification
integration branch
    -> final pull request to main
```

Several unrelated or independently mergeable issues do not need an integration branch merely because they are being worked on at the same time.

### Coordinator

The coordinator:

- confirms that the multi-agent model is justified;
- divides the accepted issue or milestone into workstreams and records dependencies;
- creates or names the integration branch;
- gives each executor its base, target branch, scope, exclusions, acceptance criteria, and documentation ownership;
- minimizes overlapping file ownership;
- reviews executor pull requests and assigns cross-workstream findings;
- controls merge order and authorizes executor pull-request merges;
- owns the final update of shared status and routing documents;
- prepares or reviews the final pull request to `main`.

Temporary work breakdowns, executor assignments, merge tracking, and chat notes remain outside the repository. Their accepted decisions and implemented results are synchronized into canonical repository documentation.

### Executor

Each executor starts from the assigned repository state and follows `AGENTS.md`. It:

- works only on its assigned workstream;
- creates its own branch;
- implements code, tests, fixtures, examples, and specifically assigned documentation;
- opens a draft pull request to the assigned integration branch when work begins or as soon as a reviewable skeleton exists;
- records final behavior, verification, documentation impact, deferred work, and remaining risks in the pull request description;
- processes review feedback on the same branch and pull request;
- marks the pull request ready only after its own scope and checks are complete.

The pull request is the executor's handoff record. A separate coordinator report is not required. When a repair changes the result, update the pull request description before merge.

Executors do not merge their own workstream pull requests unless the coordinator explicitly authorizes it.

### Final verifier

Codex or another assigned verifier checks the combined integration branch after executor work and canonical documentation have been merged. It does not silently redesign or repair a failed workstream. Failures are returned to the responsible executor or coordinator unless an explicit repair assignment is made.

## Coordinated branch and pull-request structure

Create one integration branch from current `main`, for example:

```text
fix/runtime-foundation-hardening
```

Give every executor a separate branch, for example:

```text
fix/runtime-hardening-numeric
fix/runtime-hardening-boundaries
fix/runtime-hardening-lexer
```

Executor pull requests target the integration branch, not `main`. GitHub CI runs for every pull request.

Independent workstreams may branch from the same integration commit and proceed in parallel when their file ownership and behavior do not overlap. Dependent work starts from the predecessor's merged integration state. The coordinator must not present dependent work as safely parallel.

Review feedback normally uses pull-request comments or reviews. Do not push to another agent's branch unless ownership has been explicitly handed over or the work has been reassigned. A handoff must remain visible in the pull request.

Executor pull requests should reference their issue without closing it prematurely:

```text
Refs #123
```

The final integration pull request to `main` closes the completed issues:

```text
Closes #123
Closes #124
```

## Minimum coordinated assignment

A coordinated executor assignment must identify:

- repository and assigned base state;
- source branch name and pull-request target branch;
- exact workstream scope and explicit exclusions;
- acceptance criteria;
- relevant accepted specifications, ADRs, open decisions, and backlog IDs;
- expected checks;
- files or shared documents reserved for another workstream.

Fresh executor sessions must read the repository documents required by `AGENTS.md`; they should not depend on another chat's history.

## Documentation ownership

For a single-agent issue, that agent updates documentation affected by the implemented behavior in the same pull request unless the task explicitly reserves a shared document for someone else.

For coordinated work, executors update documentation local to their assigned behavior. Shared summary and routing documents are coordinator-owned unless explicitly assigned, especially:

```text
README-FIRST.md
CURRENT-DESIGN.md
PHASE-STATUS.md
README.md
```

Executor pull requests must state the effect on canonical documentation even when the executor is not assigned to edit those files.

After coordinated implementation pull requests are merged, the coordinator prepares the canonical documentation update from:

- the merged code and tests;
- the final pull-request descriptions;
- accepted review outcomes;
- current repository documentation.

The coordinator records actual implemented behavior, not the original proposal. Deferred work remains explicit.

## Test expectations by change type

[`TESTING.md`](TESTING.md) defines the detailed repository testing strategy. The minimum verification for a pull request depends on the behavior it changes:

| Change type | Minimum expected verification |
| --- | --- |
| Confirmed defect on a supported path or real boundary | Focused regression test and failing-before evidence for the reported root cause, or a documented reason that failing-before evidence cannot reasonably be supplied |
| Stateful runtime change | Functional tests plus runtime resume-equivalence |
| External plan, snapshot, or checkpoint boundary | Valid cases and adversarial malformed-data tests through the documented public boundary |
| RNG-dependent behavior | Fixed-seed deterministic comparison |
| Time-dependent behavior | Fake clock or equivalent deterministic source; no real waiting |
| Security boundary | Structured rejection, bounded work, and no uncontrolled host exception at the real documented boundary |
| Browser host/player behavior | Real browser E2E after the concrete cross-origin boundary exists |

These are relevance-based requirements. A pull request is not required to run or add every test category when the changed behavior does not reach that layer.

## Coordinated review and merge loop

1. Each executor opens a draft pull request to the assigned integration branch.
2. CI and the coordinator review the workstream in isolation.
3. Findings are handled by the owning executor on the same pull request, or reassigned explicitly when they cross workstream boundaries.
4. The executor marks the pull request ready after completing its scope and checks.
5. The coordinator confirms scope, tests, documentation impact, and merge order.
6. The coordinator merges or explicitly authorizes merging the executor pull request into the integration branch.
7. Dependent executors receive the new integration state.

Do not merge a workstream merely because its files do not conflict. Behavioral contracts, checkpoint formats, public types, and shared tests can create dependencies without textual merge conflicts.

## Verification

Every pull request runs its relevant configured checks and reports exact commands and results.

For a coordinated milestone, after all implementation and coordinator documentation changes are on the integration branch, run from a clean install with the exact Node.js version declared in `.nvmrc`. Activate that version with any suitable mechanism. When NVM is available, `nvm use` is one optional activation method; missing NVM, or NVM not seeing a version activated by `actions/setup-node`, a container, or another version manager, is not itself a verification failure. Confirm the effective environment before installing dependencies:

```shell
node --version
npm --version
npm ci
npm run check
git diff --check
```

The canonical compiler is the `@typescript/native` npm alias pinned in `package.json`; build and typecheck use its public `tsc` command. Repository tooling imports the separately pinned `typescript` compatibility package for the TypeScript 6 programmable API, which exposes `tsc6` rather than competing for `tsc`. Do not replace or collapse these packages without an explicit dependency migration.

Also inspect the complete combined diff and run any milestone-specific playground, browser, security, or migration checks.

The final verifier reports:

- exact commands and results;
- regressions or integration conflicts;
- stale or contradictory documentation;
- remaining risks.

When the gate passes, open one final pull request from the integration branch to `main`. Prefer squash merge, then delete the milestone and executor branches.
