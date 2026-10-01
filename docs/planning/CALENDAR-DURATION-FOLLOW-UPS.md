# Calendar duration follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted syntax and scheduling contracts control
- **Use when:** Designing calendar recurrence, year durations, and timezone-sensitive scheduling
- **Do not use for:** The current V30 duration syntax, exact countdown timers, or implemented capability status

V30 section 35 already distinguishes exact elapsed-time units (`ms`, `s`, `min`, `h`) from calendar units
(`day`, `week`, `month`). Exact elapsed hours do not change with timezone or daylight-saving transitions.
Calendar arithmetic preserves local clock time in the effective player timezone; a calendar day may therefore
span 23, 24, or 25 elapsed hours. The Owner selected clamping to the final valid day when month addition would
otherwise produce an invalid date; V30 section 35 records that existing `month` behavior.

## Future calendar recurrence

A recurring monthly event should retain its original calendar-day anchor rather than applying each recurrence to the
previous clamped result: January 31 -> February 28 (or 29) -> March 31. The analogous yearly case retains a
February 29 anchor across non-leap years and returns to February 29 in leap years. Each recurrence should target
the same local clock time for the player, including daylight-saving and timezone changes. This is calendar scheduling.
Local/offline and server-backed persistence/execution policy remain part of the joint scheduled-event design; see
[`TIMER-AND-RECOVERY-FOLLOW-UPS.md`](TIMER-AND-RECOVERY-FOLLOW-UPS.md).

`year`/`years` are owner-requested future calendar-duration units, but no spelling or abbreviation is added to accepted
V30 syntax here. Before implementation, settle the exact unit spelling, how a pending one-time event responds to a
mid-schedule timezone change, and ambiguous or nonexistent local times at a daylight-saving transition. Then update the
canonical syntax/scheduling contract and implementation together.
