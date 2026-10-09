# Calendar duration follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted syntax and scheduling contracts control
- **Use when:** Designing calendar recurrence and timezone-sensitive scheduling
- **Do not use for:** The current V30 duration syntax, exact countdown timers, or implemented capability status

V30 section 35 and ADR 0026 define, and the runtime implements, exact units up to days and weeks and calendar units
after `calendar` (days, weeks, months, and years), including clamping to the final valid day when month or year addition
would otherwise produce an invalid date. This note covers only what remains open: recurrence and scheduling.

## Future calendar recurrence

A recurring monthly event should retain its original calendar-day anchor rather than applying each recurrence to the
previous clamped result: January 31 -> February 28 (or 29) -> March 31. The analogous yearly case retains a
February 29 anchor across non-leap years and returns to February 29 in leap years. Each recurrence should target
the same local clock time for the player, including daylight-saving and timezone changes. This is calendar scheduling.
Local/offline and server-backed persistence/execution policy remain part of the joint scheduled-event design; see
[`TIMER-AND-RECOVERY-FOLLOW-UPS.md`](TIMER-AND-RECOVERY-FOLLOW-UPS.md).

Before implementing scheduling, settle how a pending one-time event responds to a mid-schedule timezone change and to
ambiguous or nonexistent local times at a daylight-saving transition. Then update the canonical scheduling contract and
implementation together.
