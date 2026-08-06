# Agent capability routes

Use this router after the universal start route in `AGENTS.md` and `README-FIRST.md`. Select by actual
technical capabilities and environment constraints, not by product, model, vendor, or assigned task role.

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

## Related task guidance

Task guidance remains in the repository start route. Explicitly coordinated multi-agent work also reads
[`ORCHESTRATOR.md`](ORCHESTRATOR.md) after the orchestrator selects its own capability route.

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
