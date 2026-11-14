# Agent capability routes

Use this router after the universal start route in [AGENTS.md](../../AGENTS.md) and
[README-FIRST.md](../../README-FIRST.md). Select by actual technical capabilities and environment constraints,
not by product, model, vendor, or assigned task role.

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

Read the sections below of [Development workflow](../DEVELOPMENT-WORKFLOW.md) before starting in your role.
**A** is a light/minimal builder, **B** a full-route builder, **R** a round reviewer, **F** an independent final
reviewer, and **C** a coordinator. A section is its heading and text up to the next heading; child sections are
listed separately. Read this capability router and the selected capability guide whole. The whole-file reads
required by `AGENTS.md`, including implementation and review guidance, remain whole-file reads.

A section not read at startup still binds when its case arises; read it then, and read any section whose
applicability you are unsure of. The last column names when roles outside the startup column read a section.

| Workflow section | Startup roles | Otherwise read when |
| --- | --- | --- |
| [Development workflow](../DEVELOPMENT-WORKFLOW.md#development-workflow) | A B R F C | — |
| [Guiding principle](../DEVELOPMENT-WORKFLOW.md#guiding-principle) | A B R F C | — |
| [Issue sizing](../DEVELOPMENT-WORKFLOW.md#issue-sizing) | C | Filing or updating an issue. |
| [Requirement authority and review proportionality](../DEVELOPMENT-WORKFLOW.md#requirement-authority-and-review-proportionality) | A B R F C | — |
| [KISS, pragmatic YAGNI, and DRY](../DEVELOPMENT-WORKFLOW.md#kiss-pragmatic-yagni-and-dry) | A B R F C | — |
| [Review finding classes](../DEVELOPMENT-WORKFLOW.md#review-finding-classes) | A B R F C | — |
| [Proportional review lenses](../DEVELOPMENT-WORKFLOW.md#proportional-review-lenses) | A B R F C | — |
| [Blocking evidence](../DEVELOPMENT-WORKFLOW.md#blocking-evidence) | A B R F C | — |
| [Review convergence](../DEVELOPMENT-WORKFLOW.md#review-convergence) | R F C | Repeated findings or uncertainty about convergence. |
| [Proportional repair and owner escalation](../DEVELOPMENT-WORKFLOW.md#proportional-repair-and-owner-escalation) | — | Proposing a repair, broader scope, or an owner decision. |
| [Execution discipline](../DEVELOPMENT-WORKFLOW.md#execution-discipline) | A B C | Executing or integrating assigned work. |
| [Normal flow](../DEVELOPMENT-WORKFLOW.md#normal-flow) | A B C | Taking a task through issue, branch, pull request, or handoff. |
| [Review routes](../DEVELOPMENT-WORKFLOW.md#review-routes) | A B R F C | — |
| [Roles](../DEVELOPMENT-WORKFLOW.md#roles) | A B R F C | — |
| [Choosing the route](../DEVELOPMENT-WORKFLOW.md#choosing-the-route) | A B R F C | — |
| [The plan](../DEVELOPMENT-WORKFLOW.md#the-plan) | A B R F C | — |
| [Design rounds](../DEVELOPMENT-WORKFLOW.md#design-rounds) | — | Review findings recur, an invariant changes between rounds, or a design round is proposed. |
| [Evidence](../DEVELOPMENT-WORKFLOW.md#evidence) | A B R F C | — |
| [Review rounds](../DEVELOPMENT-WORKFLOW.md#review-rounds) | A B R F C | — |
| [Builder messages and READY](../DEVELOPMENT-WORKFLOW.md#builder-messages-and-ready) | A B C | Sending or assessing a task report. |
| [The final review](../DEVELOPMENT-WORKFLOW.md#the-final-review) | F C | Preparing for a final review or handling its findings. |
| [Pull requests and rebases](../DEVELOPMENT-WORKFLOW.md#pull-requests-and-rebases) | — | Publishing a pull request or rebasing it. |
| [Merge](../DEVELOPMENT-WORKFLOW.md#merge) | C | Deciding whether a change can land or performing an authorized merge. |
| [Capability-specific execution](../DEVELOPMENT-WORKFLOW.md#capability-specific-execution) | A B R F C | — |
| [Documentation ownership](../DEVELOPMENT-WORKFLOW.md#documentation-ownership) | — | Changing or reviewing documentation. |
| [Test expectations by change type](../DEVELOPMENT-WORKFLOW.md#test-expectations-by-change-type) | — | Selecting or assessing tests. |
| [Verification](../DEVELOPMENT-WORKFLOW.md#verification) | A B R F C | — |
