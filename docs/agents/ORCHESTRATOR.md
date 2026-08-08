# Orchestrator

## Select this route when

Add this role only when the owner or designated coordinator has explicitly selected coordinated multi-agent
work because dependent workstreams need controlled assignment, integration, or merge order. Difficulty or a
large file count alone does not select this route.

## Reading set

**Required**

- the orchestrator's own direct-repository or connector-local route;
- applicable `AGENTS.md`, repository `README-FIRST.md`, the controlling issue or milestone, and
  `docs/DEVELOPMENT-WORKFLOW.md`;
- this guide and the current integration/PR state.

**Conditional**

- each executor capability guide needed to create a valid assignment;
- `PUBLICATION-CONSTRAINED.md` only for a concrete constrained publication step.

**Excluded by default**

- every capability guide for every executor before that capability is relevant;
- a permanent repository coordinator report, task-state file, agent registry, or generalized orchestration system;
- direct edits to another executor's branch without an explicit visible handoff or reassignment.

## Source acquisition

Follow the orchestrator's selected source/workspace route. Bind assignments to an exact repository, base,
branch target, and current integration state. Executors independently establish their own trusted source
through the route selected for their capabilities.

## Writes

Each assignment states the exact scope, exclusions, acceptance criteria, relevant authority, expected checks,
source branch and PR target, dependencies, and files reserved for another workstream. Select the simplest
capability route that fits each executor; do not impose the orchestrator's environment on them. Use an
integration branch only when the selected coordinated plan needs one. Keep temporary checklists, sequencing
notes, and executor tracking outside the repository.

Each executor uses a separate branch and pull request to the assigned integration target. Independent
workstreams may proceed from the same integration state when their assigned scope and behavior do not overlap;
dependent work starts from the predecessor's merged state. Do not push to another executor's branch without a
visible handoff or reassignment.

Executors process review feedback on their own pull requests. The orchestrator controls merge order and may
merge or explicitly authorize merge only after scope, checks, documentation impact, and dependency state are
satisfied. Textual non-conflict is not proof of behavioral independence. Assign shared routing and status
documents explicitly rather than allowing several workstreams to update them independently.

## Verification

Require proportionate workstream checks and review first. Then verify the combined integration state from a
clean install with the repository's configured environment and checks, inspect the complete combined diff, and
run any milestone-specific integration verification. A final verifier reports failures to the responsible
workstream or orchestrator and does not silently redesign or repair work without reassignment. Record exact
commands, results, conflicts, stale materials, and remaining risks.

## Publication and handoff

Open one final integration pull request to `main` when the combined gate passes. Executor pull requests normally
use non-closing issue references; the final PR carries issue-closing references. The handoff records actual merged
behavior, canonical documentation impact, and explicit deferred work, not the original plan. Do not merge the
final PR without the required approval.
