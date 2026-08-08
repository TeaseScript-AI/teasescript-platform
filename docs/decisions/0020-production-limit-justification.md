# ADR 0020 — Production-limit justification

**Status:** Accepted  
**Issue:** #277  
**Parent:** #129  
**Amends:** ADR 0019

## Context

ADR 0019 established the repository-wide taxonomy, evidence statuses, registry contract, and change process for
resource limits. It correctly distinguishes internal guards from official capacity claims, but its original
`provisional` wording still permits a production limit whose concrete value, formula, predicate, or mechanism lacks
sufficient justification as long as the guard protects a real risk.

That is too weak. In practice, historical round values can then survive because they are conservative, convenient,
already tested, or labelled provisional. Agents may spend substantial effort preserving or reaching such values even
when no evidence shows that the selected number is the right boundary.

The Owner therefore tightens ADR 0019: uncertainty about a broader product or end-to-end capacity claim may remain
provisional, but an arbitrary production bound itself may not.

## Decision

Every retained production limit or implicit hard bound must justify **both**:

1. why a limit is required at that boundary; and
2. why its selected value, formula, predicate, accepted domain, or mechanism is appropriate for that purpose.

A production bound has no right to remain merely because it is historical, round, conservative, convenient, already
covered by tests, below another unrelated budget, or labelled `provisional`.

Acceptable justification may come from one or more of:

- a representation invariant or accepted semantic domain;
- a structural or algorithmic derivation tied to the protected failure mode;
- deterministic measurements of a real technical constraint together with a documented safety rationale;
- an externally imposed transport, storage, tooling, platform, or protocol constraint;
- explicit accepted product, capacity, compatibility, or safety policy.

The evidence burden remains proportional to the claim. An internal implementation guard does not need end-to-end
public-capacity proof, but it still needs evidence for its **own** existence and selected boundary. A statement such as
"this seems safely large", "this matches another round constant", or "tests already use this value" is not sufficient
justification.

## `provisional` after this amendment

`provisional` may describe incomplete evidence or policy for a **broader claim** than the locally justified boundary.
For example, a locally justified parser work guard may remain provisional as a future product-capacity statement.

`provisional` may not excuse an unjustified current production value. Before a production limit can remain as a
provisional guard, its local boundary, protected risk, measurement definition, and selected value/formula/mechanism
must already have a concrete evidence-based rationale.

If those facts cannot be justified, the entry is non-compliant with this ADR and must not be preserved indefinitely as
`provisional`.

## Existing unjustified limits

ADR 0020 does not silently choose replacement numbers and does not authorize broad unreviewed production changes.
Issue #129 must identify existing production limits whose values or mechanisms lack sufficient justification and route
each through the smallest complete repair:

- remove the limit when no real bound is needed;
- replace an arbitrary number with a derived structural predicate, formula, execution quantum, or other justified
  mechanism;
- derive and test a justified numeric boundary when a numeric limit is actually required;
- adopt an externally imposed constraint where it genuinely governs the supported path; or
- obtain the applicable explicit Owner decision when the boundary is product/capacity/compatibility policy.

Leaving the broader language or product capacity unspecified is preferable to inventing a replacement maximum merely
so a number exists. Structured resource failure at a narrower implementation boundary may remain appropriate when it
is truthful and justified.

Until an existing suspect limit is repaired, documentation and tests must not promote it into a source, product, UI,
or end-to-end capacity promise. Historical or empirical adjacent pass/fail values remain evidence only.

## Testing and evidence

Boundary tests prove implementation agreement with a value; they do not justify that value. Retaining a quantitative
production limit therefore requires an evidence record that explains the protected risk and why the selected boundary
or safety margin follows from the relevant derivation, measurement, external constraint, or accepted policy.

The repository must not create circular evidence by using the production constant itself as the only oracle for why
that constant is correct.

Exact `max - 1`, `max`, and `max + 1` tests remain useful where the justified ordered boundary makes those cases
meaningful. They are regression evidence after justification, not a substitute for it.

## Relationship to ADR 0019

ADR 0019 remains authoritative for taxonomy, boundary separation, end-to-end official-capacity evidence, registry
metadata, Owner-information duty, decision triggers, versioning, compatibility, and proportional testing except where
this ADR tightens the treatment of insufficiently justified limits.

This ADR specifically supersedes any ADR 0019 wording that can be read to allow a production value, formula,
predicate, accepted domain, or hard-bound mechanism to remain merely because a practical risk exists while the chosen
boundary itself lacks adequate justification.

The distinction between a locally justified implementation guard and an officially supported capacity remains intact:
local justification is mandatory for the guard to exist; broader end-to-end proof is required only for the broader
capacity claim.

## Consequences

- #129 must treat unjustified historical numbers as repair/removal candidates, not stable provisional defaults.
- Existing values such as interaction, capture, validation, parser, compiler, runtime, tooling, or execution bounds
  receive no presumption of validity from age, test coverage, or current use.
- No replacement value is selected by this ADR.
- A justified internal guard may still be provisional with respect to future product or end-to-end capacity.
- Agents must optimize implementation for accepted behavior and real constraints, not for reaching an unsupported
  historical number.
