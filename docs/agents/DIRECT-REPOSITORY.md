# Direct repository agent

## Select this route when

The agent has a normal current repository checkout, local shell/filesystem access, networked `git`, and
`gh` or equivalent authenticated GitHub access. Do not imitate connector-local restrictions while these
capabilities work.

## Reading set

**Required**

- applicable `AGENTS.md`, repository `README-FIRST.md`, and the assigned issue or pull request;
- `docs/DEVELOPMENT-WORKFLOW.md` and `docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md`;
- only the relevant topic documents, accepted decisions, code, and tests selected by the start route.

**Conditional**

- `ORCHESTRATOR.md` or `REVIEWER.md` when that role is assigned;
- `PUBLICATION-CONSTRAINED.md` only after a concrete normal-publication failure or restriction is verified;
- `CURRENT-DESIGN.md`, `PHASE-STATUS.md`, security documents, and other topic owners when the task requires them.

**Excluded by default**

- `CONNECTOR-LOCAL.md` and `CONNECTOR-SOURCE-ACQUISITION.md`;
- project-agent bootstrap and installed derivative guides;
- `docs/PATCH-PUBLICATION.md` while normal authenticated publication is available.

## Source acquisition

Use the normal repository remote. Confirm the intended repository, branch, base, and exact head before work.
Fetch or update through normal Git operations. For an implementation or repair assignment, create or continue
the task's short-lived branch from the assigned base. A reviewer stays on the exact review head and comparison
base without creating or modifying the implementation branch unless a separate repair assignment is accepted.
Do not request a source artifact merely because another profile needs one.

## Writes

Use normal Git and `gh` for branches, commits, pushes, draft pull requests, comments, reviews, and metadata
that the task permits. A selected role overlay may further restrict those writes. Do not replace ordinary source
publication with ad hoc connector blobs, trees, or full-file writes.

## Verification

Run the configured checks in the checkout, including `git diff --check`, and inspect the complete final diff.
Reconfirm the remote PR head before a review, merge, or publication-sensitive handoff.

## Publication and handoff

Push the tested branch, open or update the pull request, and keep its description aligned with scope,
verification, documentation impact, deferred work, and risks. Do not merge or close issues without the
required authorization.
