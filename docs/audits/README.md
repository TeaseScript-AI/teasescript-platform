# Audit profiles

This directory contains reusable audit material governed by
`../REVIEW-AND-AUDIT.md`. Profiles add domain-specific risks and evidence; they
do not replace repository authority, review severity, testing, or documentation
ownership rules.

## Current files

- `AUDIT-TEMPLATE.md`: reusable scope, inventory, evidence, coverage, findings,
  and completion form.
- `profiles/DOCUMENTATION.md`: documentation review and full documentation-audit
  profile.

## Planned profiles

The following profiles need focused owner-reviewed implementation when selected
by an issue. Do not add empty placeholders:

- production code;
- tests and test infrastructure;
- GitHub Actions and publication workflows;
- security and trust boundaries;
- performance and resource use;
- ADR and decision integrity.

Each profile must add only its distinct risk model, edge cases, evidence, and
completion criteria. Shared review and audit rules stay in
`../REVIEW-AND-AUDIT.md`.

## Selection

Use the fewest profiles that completely cover the audit question. A workflow
security audit may combine workflow and security profiles; a documentation-only
review normally needs only the universal review method and documentation
profile. Record task-specific added risks in the audit form instead of creating
a new profile for one incident.
