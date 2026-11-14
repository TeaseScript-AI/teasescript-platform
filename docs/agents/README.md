# Agent capability routes

Use this router after the universal start route in [AGENTS.md](../../AGENTS.md) and
[README-FIRST.md](../../README-FIRST.md). Select the capability route by actual technical capabilities and environment
constraints, not by product, model, vendor, or assigned task role.

## Select the capability route

1. **Can the agent use a normal repository checkout, shell, networked `git`, and `gh`?**
   Use [`DIRECT-REPOSITORY.md`](DIRECT-REPOSITORY.md).
2. **Does the agent instead have a GitHub control-plane connector plus local shell/filesystem, but no
   supported network clone or fetch?** Use [`CONNECTOR-LOCAL.md`](CONNECTOR-LOCAL.md).
3. **Can the selected source/workspace route publish the tested result through its normal permitted writes?**
   If not, and the verified patch route applies, add
   [`PUBLICATION-CONSTRAINED.md`](PUBLICATION-CONSTRAINED.md).

Select exactly one source/workspace route: direct repository or connector-local. Add the
publication-constrained overlay only after a concrete publication restriction is verified. Do not load every
capability guide by default.

## Route summary

| Route | Source acquisition | Normal writes | Verification | Publication or handoff |
| --- | --- | --- | --- | --- |
| Direct repository | Git/`gh` checkout | Task-permitted authenticated writes | Checkout checks | Normal task handoff |
| Connector-local | Exact artifact | Connector writes | Local checks | Connector handoff |
| Publication-constrained | Selected route | Patch sequence only | Candidate gates | Existing PR branch |

## Shared rules

All capability routes inherit universal authority, scope, KISS, review, documentation ownership, testing, and
Git rules from the repository start route. A focused guide must not redefine those rules. When technical
capabilities, branch/head, or permitted publication writes change, reselect the applicable capability route
before the next write. Task changes follow `README-FIRST.md`.

## Workflow reading before starting

Before starting, read the sections of [Development workflow](../DEVELOPMENT-WORKFLOW.md) that the table marks for
your role: **A** a light- or minimal-route builder, **B** a full-route builder, **R** a round reviewer, **F** an
independent final reviewer, **C** a coordinator. In two roles, read both roles' sections. A section is its heading and
its text up to the next heading, so a child section has its own row. Only the workflow is read by section: this router
and the selected capability guide are read whole, and the reading instructions of `AGENTS.md` apply as written.

Every section binds whether or not you read it at the start. Read a section when its case in the last column arises,
and read any section you are unsure applies.

| Workflow section | Startup roles | Otherwise read when |
| --- | --- | --- |
| [Development workflow](../DEVELOPMENT-WORKFLOW.md#development-workflow) | A B R F C | — |
| [Guiding principle](../DEVELOPMENT-WORKFLOW.md#guiding-principle) | A B R F C | — |
| [Issue sizing](../DEVELOPMENT-WORKFLOW.md#issue-sizing) | C | Filing, updating or splitting an issue. |
| [Requirement authority and review proportionality](../DEVELOPMENT-WORKFLOW.md#requirement-authority-and-review-proportionality) | A B R F C | — |
| [KISS, pragmatic YAGNI, and DRY](../DEVELOPMENT-WORKFLOW.md#kiss-pragmatic-yagni-and-dry) | A B R F C | — |
| [Review finding classes](../DEVELOPMENT-WORKFLOW.md#review-finding-classes) | A B R F C | — |
| [Proportional review lenses](../DEVELOPMENT-WORKFLOW.md#proportional-review-lenses) | A B R F C | — |
| [Blocking evidence](../DEVELOPMENT-WORKFLOW.md#blocking-evidence) | A B R F C | — |
| [Review convergence](../DEVELOPMENT-WORKFLOW.md#review-convergence) | B R F C | A review or repair report from the second round on, or findings that recur. |
| [Proportional repair and owner escalation](../DEVELOPMENT-WORKFLOW.md#proportional-repair-and-owner-escalation) | R F C | A defect outside the planned change, a resource limit, a type-core difference, a repair broader than its defect, or a question for the owner. |
| [Execution discipline](../DEVELOPMENT-WORKFLOW.md#execution-discipline) | A B C | Executing or integrating assigned work. |
| [Normal flow](../DEVELOPMENT-WORKFLOW.md#normal-flow) | A B C | Taking a task through issue, branch, pull request, or handoff. |
| [Review routes](../DEVELOPMENT-WORKFLOW.md#review-routes) | A B R F C | — |
| [Roles](../DEVELOPMENT-WORKFLOW.md#roles) | A B R F C | — |
| [Choosing the route](../DEVELOPMENT-WORKFLOW.md#choosing-the-route) | A B R F C | — |
| [The plan](../DEVELOPMENT-WORKFLOW.md#the-plan) | A B R F C | — |
| [Design rounds](../DEVELOPMENT-WORKFLOW.md#design-rounds) | C | A design round or a scope cut is proposed or assigned. |
| [Evidence](../DEVELOPMENT-WORKFLOW.md#evidence) | A B R F C | — |
| [Review rounds](../DEVELOPMENT-WORKFLOW.md#review-rounds) | A B R F C | — |
| [Builder messages and READY](../DEVELOPMENT-WORKFLOW.md#builder-messages-and-ready) | A B R F C | — |
| [The final review](../DEVELOPMENT-WORKFLOW.md#the-final-review) | B F C | A final review is due, or its findings are repaired or re-checked. |
| [Pull requests and rebases](../DEVELOPMENT-WORKFLOW.md#pull-requests-and-rebases) | A B C | Opening, rebasing or retargeting a pull request. |
| [Merge](../DEVELOPMENT-WORKFLOW.md#merge) | C | Approving a change or merging it. |
| [Capability-specific execution](../DEVELOPMENT-WORKFLOW.md#capability-specific-execution) | A B R F C | — |
| [Documentation ownership](../DEVELOPMENT-WORKFLOW.md#documentation-ownership) | A B R F C | — |
| [Test expectations by change type](../DEVELOPMENT-WORKFLOW.md#test-expectations-by-change-type) | A B R F C | — |
| [Verification](../DEVELOPMENT-WORKFLOW.md#verification) | A B R F C | — |
