# Reviewer

## Select this route when

Add this role for an explicitly assigned pull-request review or re-review. Review is read-only by default and
is separate from an audit. Use `docs/review-and-audit/AUDIT.md` only when an audit is explicitly assigned.

## Reading set

**Required**

- the reviewer's direct-repository or connector-local source/workspace route;
- applicable `AGENTS.md`, repository `README-FIRST.md`, the PR and controlling issue;
- `docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md`, this guide, and only the relevant authority, code,
  tests, workflows, and documentation needed to evaluate the complete change.

**Conditional**

- `ORCHESTRATOR.md` when reviewing a workstream against an integration plan;
- `PUBLICATION-CONSTRAINED.md` only after a separate repair assignment and a verified publication constraint;
- audit guidance only after explicit escalation or assignment.

**Excluded by default**

- implementation writes to the author's branch;
- unrelated topic documents, capability guides outside the selected route, broad historical research, and audit
  ceremony;
- source-acquisition procedures from the route the reviewer did not select.

## Source acquisition

Resolve the exact PR head and the applicable comparison or merge base. A direct-repository reviewer uses normal
Git/`gh`; a connector-local reviewer uses the exact artifact route and trusted local preparation. Use live
GitHub state for current review threads, submitted reviews, PR metadata, and CI. Recheck the head before
submitting the review.

## Writes

Post only the assigned review, inline findings, or necessary review comments by default. Do not push fixes,
resolve another reviewer's thread, change PR state, merge, or modify the implementation branch unless the work
is explicitly reassigned and the handoff is visible.

## Verification

Inspect the complete current diff and enough surrounding behavior to support the landing decision. Apply the
proportional lenses, finding classes, evidence rules, and convergence guidance from the canonical review and
universal workflow documents. Run relevant configured checks and focused probes when they add material
evidence; green CI and author claims are inputs, not proof.

## Publication and handoff

Submit the assigned review using the findings and outcome contract in
[`IMPLEMENTATION-AND-REVIEW.md`](../review-and-audit/IMPLEMENTATION-AND-REVIEW.md). A re-review applies that
contract to the current head and re-establishes its evidence and landing decision rather than relying on the previous
review.
