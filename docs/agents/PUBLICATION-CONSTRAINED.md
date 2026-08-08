# Publication-constrained agent

## Select this route when

Add this overlay only after selecting the direct-repository or connector-local source/workspace route and
verifying that the agent cannot publish the tested result through normal permitted GitHub writes. The retained
verified patch-publication route must apply to the repository and target pull request.

## Reading set

**Required**

- the selected source/workspace guide and its normal reading set;
- [`../PATCH-PUBLICATION.md`](../PATCH-PUBLICATION.md), which is the canonical protocol and security-contract source;
- the current target PR, exact branch head, and task authorization.

**Conditional**

- `ORCHESTRATOR.md` when publication is one explicitly assigned coordinated workstream.

**Excluded by default**

- this overlay and `docs/PATCH-PUBLICATION.md` when normal Git/`gh` publication works;
- alternative handoff packages, manual full-file substitution, ad hoc object trees, or invented publication formats;
- unrelated connector or bootstrap procedures not required by the selected source/workspace route.

## Source acquisition

Follow the selected direct-repository or connector-local route. Publication constraints do not change source
identity, task authority, or verification requirements.

## Writes

Use only the exact next repository action emitted by the verified patch-publication helper for its declared
transfer payload, record the verified result, and then request the next action. Low-level blob, tree, commit,
branch, or full-file operations are not a general substitute. The complete allowed sequence, raw UTF-8
requirements, trust boundary, validation profiles, cleanup, and retry behavior remain exclusively owned by
`docs/PATCH-PUBLICATION.md`.

## Verification

Prepare from a clean locally tested result, bind the exact current target head and expected result tree, run
the task's configured checks, and inspect the complete diff. Treat the publication candidate gates as
additional transport/publication evidence, not as a replacement for implementation verification.

## Publication and handoff

Publish only to the existing authorized PR branch. Recheck the live target head immediately before starting
the publication command. Update the PR description and report the exact published head and checks. Do not
merge, approve your own work, or close issues unless separately authorized.
