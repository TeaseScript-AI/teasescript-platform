// O4 stage 2b: clock.* and the members of date, time, datetime, absoluteDateTime and calendarDuration receivers (§5.3, §5.4).
// A placeholder of the starting commit: the slice delegated to Opus 5.5 fills it in; the lead edits no further line here.
import type { OperationRelation } from "./relation.js";
import type { MemberRules } from "./views.js";

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map();

const RULES: MemberRules = {
  kinds: ["date", "time", "datetime", "absoluteDateTime", "calendarDuration"],
  property: () => undefined,
  method: () => undefined,
};

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
