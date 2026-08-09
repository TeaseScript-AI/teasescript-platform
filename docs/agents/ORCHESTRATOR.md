# Orchestrator

## Select this route when

Add this role only when the owner or designated coordinator has explicitly selected coordinated multi-agent
work because independent, dependent, capability-separated, or intentionally pipelined workstreams need controlled
assignment, ownership, integration, or merge order. Difficulty or a large file count alone does not select this route.

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
- direct edits to another executor's branch without an explicit shared-branch plan, visible handoff, or reassignment.

## Source acquisition

Follow the orchestrator's selected source/workspace route. Bind assignments to an exact repository, base,
branch target, and current integration state. Executors independently establish their own trusted source
through the route selected for their capabilities.

## Writes

Each assignment states the exact scope, exclusions, acceptance criteria, relevant authority, expected checks,
source branch and PR target, dependencies, and files reserved for another workstream. Make hard requirements distinct
from illustrative implementation advice: hand off resolved invariants, dependencies, stop conditions, and the required
final state, while treating likely files and examples as starting points unless controlling authority makes them exact.
Exclude chat chronology and rejected alternatives unless they explain a live constraint. Select the simplest capability
route that fits each executor; do not impose the orchestrator's environment on them. Use an integration branch only
when the selected coordinated plan needs one. Keep temporary checklists, sequencing notes, and executor tracking
outside the repository.

Separate executor branches and pull requests are the default because they make ownership and review boundaries
obvious. An explicitly coordinated shared pull-request branch is also valid when it materially reduces integration
cost and the coordinator serializes publication, reserves files or canonical surfaces, and defines which head movement
is expected versus invalidating. Independent workstreams may proceed from the same integration state when their scope
and behavior do not overlap; dependent behavior starts from the predecessor's verified merged or handed-off state.
Never let concurrent executors publish blindly from stale assumptions about a shared target head.

Pipelining is useful when it removes idle time without blurring responsibility. For example, after one executor
publishes a stable implementation result, another executor may begin the next independent investigation while
the orchestrator verifies the prior result or consolidates its documentation, provided the scopes and writes are
reserved so neither workstream can silently invalidate the other. When a next assignment is already dependency-safe
and sufficiently specified, it may be handed off before coordinator-only metadata or documentation consolidation so
execution and coordination overlap instead of waiting serially. A shared-branch pipeline still requires an explicit
handoff or publication order before either workstream changes the same file, semantic surface, or head-sensitive state.

Executors process review feedback on their own pull requests. The orchestrator controls merge order and may
merge or explicitly authorize merge only after scope, checks, documentation impact, and dependency state are
satisfied. Textual non-conflict is not proof of behavioral independence. Assign shared routing, status, and
canonical documentation surfaces explicitly rather than allowing several workstreams to edit them independently.
Semantic documentation consolidation should normally have one designated writer for the active change set;
small mechanical edits may be delegated when their meaning, authority, and conflict risk are demonstrably low.
Follow `../DOCUMENTATION-OWNERSHIP.md` for that distinction rather than imposing an absolute executor/documentation
ban.

## Verification

Require proportionate workstream checks and review first. Treat executor summaries and completion claims as
navigation to evidence, not proof: verify the exact handed-off head, relevant diff, and decisive checks before relying
on the result for integration or dependent behavior. Then verify the combined integration state from a clean install
with the repository's configured environment and checks, inspect the complete combined diff, and run any
milestone-specific integration verification. A final verifier reports failures to the responsible workstream or
orchestrator and does not silently redesign or repair work without reassignment. Record exact commands, results,
conflicts, stale materials, and remaining risks.

## Publication and handoff

Use one final integration pull request to `main` when the combined gate passes. An explicitly coordinated shared
pull request that already targets `main` may itself be that final integration PR. Other executor pull requests normally
use non-closing issue references; the final PR carries issue-closing references. The handoff records actual merged
behavior, canonical documentation impact, and explicit deferred work, not the original plan. Do not merge the final PR
without the required approval.
