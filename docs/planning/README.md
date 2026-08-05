# Active planning

`docs/planning/` contains only active, non-implemented planning. It may record owner-selected gate obligations,
unscheduled maintenance candidates, or proposed direction. Planning does not define accepted architecture, syntax, or
current implementation status.

When planning is implemented, superseded, rejected, or useful only as rationale:

- synchronize accepted decisions into their accepted ADR, specification, or controlling canonical topic owner;
- synchronize current facts, status, and gate obligations into their current topic, status, or backlog owner;
- retain history only when it preserves unique design, migration, compatibility, security, incident, resource, or
  benchmark reasoning that is likely to answer a concrete future question and cannot be reduced without meaningful loss;
- mark retained history non-authoritative and exclude it from default agent reading; or
- otherwise remove it from the working tree and rely on Git history, issues, pull requests, and reviews. When retention
  value is uncertain, rely on Git history.

Do not keep completed work in this directory as a warning, tombstone, migration guide, or status record. Do not treat an
entry as scheduled implementation unless the owner or coordinator explicitly schedules it through the normal workflow.
