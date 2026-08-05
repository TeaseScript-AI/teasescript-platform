# Agent capability routes

Use this router after the universal start route in `AGENTS.md` and `README-FIRST.md`. Select by actual
capabilities and assigned role, not by product, model, or vendor name.

## Select the route

1. **Can the agent use a normal repository checkout, shell, networked `git`, and `gh`?**
   Use [`DIRECT-REPOSITORY.md`](DIRECT-REPOSITORY.md).
2. **Does the agent instead have a GitHub control-plane connector plus local shell/filesystem, but no
   supported network clone or fetch?** Use [`CONNECTOR-LOCAL.md`](CONNECTOR-LOCAL.md).
3. **Can the selected execution route publish the tested result through its normal permitted writes?**
   If not, and the verified patch route applies, add
   [`PUBLICATION-CONSTRAINED.md`](PUBLICATION-CONSTRAINED.md).
4. **Is the agent assigning or integrating several explicitly coordinated workstreams?** Add
   [`ORCHESTRATOR.md`](ORCHESTRATOR.md).
5. **Is the agent performing an assigned pull-request review?** Add [`REVIEWER.md`](REVIEWER.md).

Select exactly one source/workspace route: direct repository or connector-local. Publication-constrained,
orchestrator, and reviewer guidance are overlays. An overlay may narrow the selected route's writes but does
not broaden them; the reviewer overlay remains read-only by default unless a separate repair assignment is
explicitly accepted. Do not load every route by default.

## Route summary

| Route | Source acquisition | Normal writes | Verification | Publication or handoff |
| --- | --- | --- | --- | --- |
| Direct repository | Current normal checkout through `git`/`gh` | Normal branch, commit, push, PR, review, and comment operations | Repository checks in the checkout | Push the branch and maintain the PR |
| Connector-local | One exact verified source artifact, then local shell/Git | Connector operations permitted for the task | Repository checks in the prepared checkout | Connector write route, optionally with the publication overlay |
| Publication-constrained | Inherited from the selected source/workspace route | Only the exact verified patch-publication sequence | Tested local result plus the patch candidate gates | Publish to the existing PR branch through `PATCH-PUBLICATION.md` |
| Orchestrator | Inherited from the orchestrator's own source/workspace route | Coordination and integration writes explicitly assigned to the role | Workstream checks plus combined integration verification | Final integration PR and owner/coordinator handoff |
| Reviewer | Exact head and comparison/merge base through the selected source/workspace route | Read-only by default; review/comment writes only | Change-scoped evidence and relevant checks | Exact-head review with landing decision |

## Shared rules

All routes inherit universal authority, scope, KISS, review, documentation ownership, testing, and Git rules
from the repository start route. A focused guide must not redefine those rules. When capabilities change,
the branch/head changes, or the task moves between implementation, review, repair, verification, and
publication, reselect the applicable route before the next write.
