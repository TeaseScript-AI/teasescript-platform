# Development workflow

## Default model

Use GitHub-native branches and pull requests for coordinated agent work. A work-package ZIP and local integration runner are fallback mechanisms for agents without repository write access; they are not the default path.

For a coordinated milestone, use:

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

A small independent task may use one branch and one pull request directly to `main`.

## Roles

### Coordinator

The coordinator:

- divides the milestone into workstreams and records dependencies;
- creates or names the integration branch;
- gives each executor its base, target branch, scope, exclusions, acceptance criteria, and documentation ownership;
- minimizes overlapping file ownership;
- reviews executor pull requests and assigns cross-workstream findings;
- controls merge order;
- owns the final update of shared status and routing documents;
- prepares or reviews the final pull request to `main`.

Temporary work breakdowns, executor assignments, merge tracking, and chat notes remain outside the repository. Their accepted decisions and implemented results are synchronized into canonical repository documentation.

### Executor

Each executor starts from the assigned repository state and follows `AGENTS.md`. It:

- works only on its assigned workstream;
- creates its own branch;
- implements code, tests, fixtures, examples, and specifically assigned documentation;
- opens a pull request to the assigned target branch;
- records final behavior, verification, documentation impact, deferred work, and remaining risks in the pull request description;
- processes review feedback on the same branch and pull request.

The pull request is the executor's handoff record. A separate coordinator report is not required. When a repair changes the result, update the pull request description before merge.

### Final verifier

Codex or another assigned verifier checks the combined integration branch after executor work and canonical documentation have been merged. It does not silently redesign or repair a failed workstream. Failures are returned to the responsible executor or coordinator unless an explicit repair assignment is made.

## Branch and pull-request structure

For a coordinated milestone, create one integration branch from current `main`, for example:

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

Do not push to another executor's branch unless the coordinator explicitly assigns it. A coordinator may directly commit a small, unambiguous review or documentation correction to a pull-request branch when that is faster than a round trip; the change must remain visible in the pull request and may not silently alter feature scope.

## Minimum executor assignment

An executor assignment must identify:

- repository and assigned base state;
- source branch name and pull-request target branch;
- exact workstream scope and explicit exclusions;
- acceptance criteria;
- relevant accepted specifications, ADRs, open decisions, and backlog IDs;
- expected checks;
- files or shared documents reserved for another workstream.

Fresh executor sessions must read the repository documents required by `AGENTS.md`; they should not depend on another chat's history.

## Documentation ownership

Executors update documentation that is local to their assigned behavior when needed. Shared summary and routing documents are coordinator-owned unless explicitly assigned, especially:

```text
README-FIRST.md
CURRENT-DESIGN.md
PHASE-STATUS.md
README.md
```

Executor pull requests must state the effect on canonical documentation even when the executor is not assigned to edit those files.

After implementation pull requests are merged, the coordinator prepares the canonical documentation update from:

- the merged code and tests;
- the final pull-request descriptions;
- accepted review outcomes;
- current repository documentation.

The coordinator records actual implemented behavior, not the original proposal. Deferred work remains explicit.

## Review and merge loop

1. The executor opens a pull request to the assigned target branch.
2. CI and the coordinator review the workstream in isolation.
3. Findings are handled by the owning executor on the same pull request, or reassigned explicitly when they cross workstream boundaries.
4. The coordinator confirms scope, tests, documentation impact, and merge order.
5. The executor pull request is merged into the integration branch.
6. Dependent executors receive the new integration state.

Do not merge a workstream merely because its files do not conflict. Behavioral contracts, checkpoint formats, public types, and shared tests can create dependencies without textual merge conflicts.

## Final integration gate

After all implementation and coordinator documentation changes are on the integration branch, run from a clean install:

```shell
nvm use
npm ci
npm run check
npm run build
git diff --check
```

Also inspect the complete combined diff and run any milestone-specific playground, browser, security, or migration checks.

The final verifier reports:

- exact commands and results;
- regressions or integration conflicts;
- stale or contradictory documentation;
- remaining risks.

When the gate passes, open one final pull request from the integration branch to `main`. Prefer squash merge, then delete the milestone and executor branches.

## Fallback package flow

Use patch ZIPs and a repository integration runner only when direct GitHub branch and pull-request work is unavailable or a reproducible external patch handoff is specifically required. Fallback packages must remain outside the repository and may not replace pull-request review or final combined verification.
