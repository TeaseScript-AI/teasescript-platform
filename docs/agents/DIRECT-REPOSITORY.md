# Direct repository agent

## Select this route when

The agent has a normal current repository checkout, local shell/filesystem access, networked `git`, and
`gh` or equivalent authenticated GitHub access. Do not imitate connector-local restrictions while these
capabilities work.

## Reading set

**Required**

- applicable `AGENTS.md`, repository `README-FIRST.md`, and the assigned issue or pull request;
- in `docs/DEVELOPMENT-WORKFLOW.md`: "Guiding principle", "Requirement authority and review proportionality" with
  "KISS, pragmatic YAGNI, and DRY", "Review finding classes", "Proportional review lenses", "Blocking evidence" and
  "Proportional repair and owner escalation", "Execution discipline", "Normal flow" and "Verification";
- the task documents selected by `README-FIRST.md`;
- only the relevant topic documents, accepted decisions, code, and tests selected by the start route.

**Conditional**

- in `docs/DEVELOPMENT-WORKFLOW.md`, the sections of the work the task does: "Issue sizing" for an issue; "Review
  routes" with "Roles", "Choosing the route", "The plan", "Design rounds", "Evidence", "Builder messages and READY" and
  "Pull requests and rebases" for a coordinated pull request; "Review convergence", "Review rounds" and "The final
  review" for a review or its repair; "Merge" for a merge; "Test expectations by change type" with `docs/TESTING.md`;
  "Documentation ownership" with `docs/DOCUMENTATION-OWNERSHIP.md`; "Capability-specific execution" with `docs/agents/`;
- `PUBLICATION-CONSTRAINED.md` only after a concrete normal-publication failure or restriction is verified;
- `CURRENT-DESIGN.md`, `PHASE-STATUS.md`, security documents, and other topic sources when the task requires them.

**Excluded by default**

- `CONNECTOR-LOCAL.md` and `CONNECTOR-SOURCE-ACQUISITION.md`;
- project-agent bootstrap and installed derivative guides;
- `docs/PATCH-PUBLICATION.md` while normal authenticated publication is available.

## Source acquisition

Use the normal repository remote. Confirm the intended repository, branch, base, and exact source state required
by the assigned task before work. Fetch or update through normal Git operations. For an implementation or repair
assignment, create or continue the task's short-lived branch from the assigned base. Do not request a source
artifact merely because another route needs one.

## Writes

Use normal Git and `gh` for branches, commits, pushes, pull requests, comments, reviews, and metadata that the
assigned task and universal workflow permit. Do not replace ordinary source publication with ad hoc connector
blobs, trees, or full-file writes.

## Verification

Run the configured checks in the checkout, including `git diff --check`, and inspect the complete final diff.
Reconfirm the remote PR head before any head-sensitive GitHub action or handoff.

## Publication and handoff

Use the normal authenticated GitHub handoff permitted by the assigned task and universal workflow. For an
implementation change, keep its pull-request description aligned with scope, verification, documentation
impact, deferred work, and risks. Do not merge or close issues without the required authorization; for merges, see
[Merge](../DEVELOPMENT-WORKFLOW.md#merge).
