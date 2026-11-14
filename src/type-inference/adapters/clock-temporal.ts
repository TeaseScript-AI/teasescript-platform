import type { ScalarTypeName } from "../../ast.js";
import { withValues, type StaticType } from "../../static-types.js";
import {
  CALENDAR_DURATION_PARTS,
  hasTemporalField,
  hasTemporalMethod,
  isCalendarDurationPart,
  isTemporalKind,
  TEMPORAL_FIELDS,
  TEMPORAL_METHODS,
  type TemporalField,
} from "../../temporal-builtins.js";
import type { ValueKind } from "../../value-kinds.js";
import type { OperationResult } from "./relation.js";
import { typeResult, type MemberAnswer, type MemberRules } from "./views.js";

const scalar = (name: ScalarTypeName): StaticType => ({ kind: "scalar", name });

function fieldType(field: TemporalField): StaticType {
  return field.values === undefined
    ? scalar(field.result)
    : withValues(scalar(field.result), field.values);
}

function property(kind: ValueKind, name: string): MemberAnswer | undefined {
  if (kind === "calendarDuration")
    return isCalendarDurationPart(name)
      ? typeResult(scalar(CALENDAR_DURATION_PARTS[name].result))
      : undefined;
  return isTemporalKind(kind) && hasTemporalField(kind, name)
    ? typeResult(fieldType(TEMPORAL_FIELDS[name]))
    : undefined;
}

/** None of these methods takes arguments; a call with any still gives the result. */
function method(kind: ValueKind, name: string): OperationResult | undefined {
  return isTemporalKind(kind) && hasTemporalMethod(kind, name)
    ? typeResult(scalar(TEMPORAL_METHODS[name].result))
    : undefined;
}

const RULES: MemberRules = {
  kinds: ["date", "time", "datetime", "absoluteDateTime", "calendarDuration"],
  property,
  method,
};

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
