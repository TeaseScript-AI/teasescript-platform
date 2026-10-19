import type { ScalarTypeName } from "../../ast.js";
import { withValues, type StaticType } from "../../static-types.js";
import {
  CALENDAR_DURATION_PARTS,
  CLOCK_CONTRACTS,
  hasTemporalField,
  hasTemporalMethod,
  isTemporalMethod,
  isCalendarDurationPart,
  isTemporalKind,
  TEMPORAL_FIELDS,
  TEMPORAL_METHODS,
  type TemporalField,
} from "../../temporal-builtins.js";
import type { ValueKind } from "../../value-kinds.js";
import { NO_PARAMETERS, type OperationRelation, type OperationResult } from "./relation.js";
import { typeResult, type MemberAnswer, type MemberRules } from "./views.js";

/**
 * The clock reads and the members of date and time values and calendar durations (O4 stage 2b), as `#builtinType`,
 * `memberPropertyType` and `memberMethodType` of the legacy checker give them: a clock read gives a value of its
 * kind, a field or part is computed when it is read, with the field's few values kept (`weekday` is one of the seven
 * names), and a method gives a new value of its result. None of them takes arguments; a call with any is the
 * visitor's report, and the result stands. An exact duration has no members.
 */
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

function method(kind: ValueKind, name: string): OperationResult | undefined {
  return isTemporalKind(kind) && hasTemporalMethod(kind, name)
    ? typeResult(scalar(TEMPORAL_METHODS[name].result))
    : undefined;
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.entries(CLOCK_CONTRACTS).map(([name, contract]): [string, OperationRelation] => [
    name,
    {
      contract: { family: "clock", name },
      parameters: NO_PARAMETERS,
      result: () => typeResult(scalar(contract.result)),
    },
  ]),
);

const RULES: MemberRules = {
  kinds: ["date", "time", "datetime", "absoluteDateTime", "calendarDuration"],
  // a temporal method takes no arguments (`temporalArgumentsMessage`)
  parameters: (name) => (isTemporalMethod(name) ? NO_PARAMETERS : undefined),
  property,
  method,
};

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
