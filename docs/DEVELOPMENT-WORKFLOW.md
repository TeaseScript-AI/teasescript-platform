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
- when proposing future-facing infrastructure, the concrete scheduled
  consumer, accepted boundary that must be correct when first introduced, or
  difficult-to-reverse boundary problem that justifies implementing it now;
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

Before declaring a project limitation, proposing infrastructure, or presenting
owner options, verify the relevant existing capability through the smallest
authoritative evidence set. Do not generalize one API action, connector method,
helper, or environment limitation to the complete supported workflow. Report a
material shared-workflow failure instead of silently working around it.

Do not invent project-wide policy, numeric thresholds, style or readability
limits, naming rules, compatibility promises, mandatory tools, or workflow
gates. Until a durable rule has evidence, owner approval, and synchronization
into its canonical owner, use configured tooling, current authority, and
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
contract protects, what happens without it, and what complexity it adds. Do not
ask the owner to approve an unexplained technical abstraction.

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

A single-agent pull request that completes its issue may use:

```text
Closes #123
```

## Verified source artifacts for review and handoff

The Source-bundle workflows produce seven-day, verifiable Git artifacts when a
reviewer, verifier, or network-restricted agent needs one exact repository
snapshot with reachable Git history.

`Source bundle` runs automatically for:

- every pull-request update, using the exact pull-request head rather than
  GitHub's synthetic merge commit;
- every push to `main`, using the exact pushed commit.

Every trusted producer publishes a successful artifact under the fixed commit
status context `source-bundle/artifact-v1` on the exact bundled source SHA. The
status `target_url` is the exact repository artifact URL. The artifact API,
not the human-readable status description, is authoritative for the numeric
artifact ID, exact name `teasescript-source-<source-sha>`, digest, producer run,
repository, and expiration.

The automatic producer uses a separate default-branch `workflow_run` indexer.
That indexer has only `actions: read` and `statuses: write`, does not check out
or download source or artifact content, and derives the bundled SHA from the
trusted workflow event identity before validating the artifact metadata. The
branch-regeneration and comment-regeneration producers validate their upload
results before publishing the same fixed success status. Never publish
`pending` or `failure` under the fixed context: a failed request belongs to its
own run and result surface, and must not hide an older valid success.

### Zero-compute connector cache path

For `main`, `pr:<number>`, or `sha:<full-sha>`:

1. Resolve the selector to one immutable full source SHA. For `pr:`, also retain
   the PR number, head repository/ref, current base SHA, and the exact merge base
   reported by `compare_commits`.
2. Read the combined status for that exact source SHA and select a successful
   `source-bundle/artifact-v1` entry.
3. Parse the run ID and artifact ID from its exact `target_url`.
4. Read that run's artifact metadata and require the exact ID, expected name,
   SHA-256 digest, producer run/repository identity, and a non-expired artifact.
5. Download the artifact by numeric ID and run the fully populated trusted
   preparation command.

A deleted, expired, malformed, wrong-name, wrong-run, or otherwise unverifiable
artifact is a cache miss. A valid hit requires no issue comment, workflow run,
runner allocation, nonce, request branch, or run-number search.

During issue #228's additive rollout, this fixed-index route is available for
post-merge live validation but does not yet replace every mandatory agent route.
Do not change `AGENTS.md` to make it the sole happy path until the required
same-repository PR, fork PR, `main`, exact-SHA, stale-artifact, concurrent-miss,
and clean-workspace proofs have passed on the default branch.

### Collaborator-gated regeneration on a confirmed miss

Only after the cache lookup confirms a miss, post one strict command on an issue
or pull request:

```text
/artifact source main
/artifact source pr:225
/artifact source sha:<full-lowercase-40-character-sha>
```

The default-branch `issue_comment` workflow applies an association prefilter
before runner allocation, then requires the event actor to equal the exact
comment author and requires legacy collaborator permission `write` or `admin`.
GitHub maps Maintain to legacy `write`. Read-only, unknown, missing, and API
failure results are rejected. This authorization protects Actions compute and
artifact storage, not public source confidentiality.

Authorized requests share one queued, non-cancelling regeneration concurrency
group. After entering that production slot, the workflow resolves and pins the
complete immutable identity, rechecks the fixed status, and returns an existing
valid artifact when another producer already completed. On a remaining miss it
checks out trusted tooling from `github.workflow_sha`, checks out the exact
selected source separately with `persist-credentials: false`, verifies `HEAD`,
and invokes only the trusted `create-source-bundle.sh`. Selected source is data:
no selected-source action, script, dependency, hook, build, submodule, or
configuration is executed.

The bot result is bound to the exact request-comment ID, author, and body hash.
It reports the original selector, resolved immutable identity, artifact ID/name,
digest, producer run, expiration, exact connector download arguments, and a
fully populated local preparation command. A repeated delivery updates the one
authoritative bot result for that request. For `pr:`, the result also includes
the pinned head repository/ref, base SHA, and merge-base SHA. If a semantic
selector moves while a request waits, use the complete identity in the returned
result; do not combine it with an earlier independently resolved head or merge
base.

This route leaves no request branch or other temporary Git ref.

### Compatibility request-branch fallback

The existing request-branch route remains an internal compatibility fallback
during rollout. It is not the normal connector procedure when the fixed index
or collaborator-gated command is available.

To use it for an exact source SHA:

1. Resolve the full lowercase 40-character source commit SHA and the exact
   current `main` SHA.
2. Choose a nonce matching lowercase `[a-z0-9][a-z0-9-]{0,31}`.
3. Create `source-bundle-request/<source-sha>/<nonce>` at that exact `main` SHA.
4. Wait 90 seconds before the first lookup, then poll context
   `source-bundle/request/<nonce>` on the requested source SHA at 30-second
   intervals.
5. On success, download the reported artifact ID, verify its digest, and confirm
   that the exact unchanged request ref was removed.

The permissionless create-event gate and default-branch processor revalidate
the strict branch name, unchanged request SHA, default-branch ancestry, and
requested commit. Bundling uses only `contents: read`; dynamic and fixed status
publication uses `actions: read` plus `statuses: write`; cleanup checks out no
repository content and deletes only the unchanged exact ref through
`--force-with-lease` with `contents: write`.

### Local verification boundary

The downloaded ZIP contains:

```text
repository.bundle
manifest.json
SHA256SUMS
```

Turn it into a verified local checkout with the trusted preinstalled copy of the
repository-owned helper. For pull-request review, use the exact merge base from
`compare_commits.merge_base_commit.sha`, not the current base-branch tip:

```shell
python3 tools/local-agent/prepare-source-review.py \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <github-artifact-sha256> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --expected-head <source-sha> \
  --expected-merge-base <review-merge-base-sha> \
  --output /mnt/data/source-review
```

The helper validates the outer digest, ZIP paths and exact payload, internal
checksums, manifest identities, complete bundle, expected head and optional
merge-base ancestry, checked-out tree, `git fsck`, and clean worktree. It exposes
the output only after every check succeeds and removes the temporary `origin`
remote.

Connector-based ChatGPT agents use the local-first route in
`CHATGPT-GITHUB-WORKFLOW.md`. Do not use network Git, workflow run-number
searches, request branches outside the documented compatibility fallback, or
artifacts from unrelated pull requests as substitutes for exact source
acquisition.

A source artifact contains committed repository files and reachable Git history
for the selected commit. It does not contain issues, pull-request comments or
reviews, Actions history, repository settings, secrets, credentials,
`node_modules`, or uncommitted local changes.

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

Before every non-trivial documentation change or documentation review, read
[`DOCUMENTATION-OWNERSHIP.md`](DOCUMENTATION-OWNERSHIP.md). Record material
ownership or consolidation decisions in the active issue, pull request, or
review discussion; do not create a separate report unless the task explicitly
requires one.

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

The canonical compiler is the `@typescript/native` npm alias pinned in `package.json`; build and typecheck use its public `tsc` command. The separately pinned `ts-morph` package is a development-only agent codemod tool. Do not replace either dependency without an explicit dependency migration.

Also inspect the complete combined diff and run any milestone-specific playground, browser, security, or migration checks.

The final verifier reports:

- exact commands and results;
- regressions or integration conflicts;
- stale or contradictory documentation;
- remaining risks.

When the gate passes, open one final pull request from the integration branch to `main`. Prefer squash merge, then delete the milestone and executor branches.
