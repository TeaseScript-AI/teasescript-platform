# Timer and recovery follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted ADRs and current topic documents control
- **Use when:** Planning absolute events/deadlines or author-defined recovery points
- **Do not use for:** Accepted timer/runtime mechanics, the ADR 0012 recovery frontier, durable-effect rules, current
  runtime status, or developer runtime Pause

The accepted specification [§27](../specifications/accepted-syntaxes-v30.md#27-timers) and
[`RUNTIME.md`](../RUNTIME.md#timers-and-scene-time) own timer syntax and mechanics. ADR 0012 and
[`DATA-AND-API.md`](../DATA-AND-API.md) own custom-view recovery and durable-effect rules.
This note retains adjacent owner-selected work that still needs a detailed accepted design.

## Scheduled events and deadlines

Specification [§36](../specifications/accepted-syntaxes-v30.md#36-scheduling) preserves the distinction between
scene-time timers and absolute events. Final event syntax, execution authority, recovery, and Player presentation
need a joint follow-up design.

Owner direction for that design:

- preserve local/offline scheduling for privacy and offline operation;
- provide server-backed authority where stronger anti-tamper or cross-device guarantees are required;
- consider event handles with create/read/move/cancel operations;
- make the absolute date/time dominant when showing a deadline countdown, with remaining time secondary;
- avoid requiring every long/upcoming event to appear as a simultaneous timer widget.

These are design directions, not accepted API spellings or implemented scheduling guarantees.
Unresolved choices are maintained in [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

## Author-defined recovery points

Author-defined recovery points are an advanced feature beyond exact checkpoint resume. A rollback design must define the
treatment of:

- variables, scopes, RNG, call and loop progress, and pending actions;
- transcript, Standard UI, package views, and media;
- completed timers or assignments;
- account writes, history, notifications, and other irreversible external effects.

The design must prevent repeated irreversible effects and distinguish canonical rollback state from reconstructible
UI. It requires a separate accepted decision before implementation.
