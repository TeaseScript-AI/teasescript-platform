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

A work-package ZIP and local integration runner are fallback mechanisms for agents without repository write access; they are not the default path.

## Issue sizing and execution recommendation

An issue should normally describe one coherent, reviewable task that one agent can own from reproduction or design through implementation, tests, documentation impact, and pull request.

The agent creating or substantially refining an issue should include:

- the observed problem, requested outcome, or design goal;
- evidence, reproduction, or relevant source references;
- explicit scope and exclusions;
- acceptance criteria;
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

Verify and clone it from a temporary directory:

```shell
sha256sum --check SHA256SUMS

git init --bare verifier.git
git -C verifier.git bundle verify "$PWD/repository.bundle"

git clone repository.bundle source-review
cd source-review
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git status --short
```

Compare the cloned commit and tree with `commitSha` and `treeSha` in `manifest.json`. The worktree must be clean. GitHub's artifact digest, when available to the downloader, verifies the outer ZIP; `SHA256SUMS` verifies `repository.bundle` and `manifest.json` after extraction.

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
| Confirmed defect | Focused regression test and failing-before evidence for the reported root cause |
| Stateful runtime change | Functional tests plus runtime resume-equivalence |
| External plan, snapshot, or checkpoint boundary | Valid cases and adversarial malformed-data tests through the documented public boundary |
| RNG-dependent behavior | Fixed-seed deterministic comparison |
| Time-dependent behavior | Fake clock or equivalent deterministic source; no real waiting |
| Security boundary | Structured rejection, bounded work, and no uncontrolled host exception at the documented boundary |
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

## Fallback work-package flow

Use repository branches and pull requests by default. Select the work-package fallback only when an assigned agent cannot create the required GitHub branch, commits, or pull request, or when a reproducible external patch handoff is explicitly required.

The assignment must explicitly select fallback mode. Do not create a package ZIP as part of a normal GitHub-native task.

See `../tools/work-packages/README.md` for package authoring, local integration, result, repair, publication, and cleanup rules. Package files remain outside the repository. A successful local integration must still be published, reviewed, verified by CI, and merged through the normal pull-request workflow.
