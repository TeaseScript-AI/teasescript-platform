import type { ScalarTypeName } from "../../ast.js";
import { LIST_FUNCTION_CONTRACTS } from "../../list-function-rules.js";
import {
  NUMERIC_CONTRACTS,
  type NumericArgument,
  type NumericFunction,
} from "../../numeric-functions.js";
import {
  ANGLE_TYPE,
  INTEGER_TYPE,
  isNumeric,
  isScalar,
  members,
  nonNullType,
  NUMBER_TYPE,
  resolved,
  type StaticType,
} from "../../static-types.js";
import { arithmeticType } from "../../static-types/arithmetic.js";
import { typeKey } from "../../storage-types.js";
import { TEMPORAL_KINDS } from "../../temporal-builtins.js";
import type { OperandView, OperationRelation, OperationResult } from "./relation.js";
import {
  closedType,
  INVALID,
  isBottom,
  possibleResult,
  typeResult,
  UNCONSTRAINED,
} from "./views.js";

/**
 * The numeric functions and the value form of `min` and `max` (O4 stage 2b, work note §5.3.1), as
 * `#numericFunctionType`, `#numberArguments` and the `min`/`max` case of `#builtinType` give them. Each argument is
 * prepared as the legacy prepares it, and the contract's result rule runs on the prepared inputs: a kind it gives is
 * the answer, whatever other inputs are unknown. Where it needs the kind of an input the solver knows nothing of yet,
 * the relation waits; where that input may be dynamic, the relation evaluates the rule on each numeric kind the input
 * may be, and the results are the possibilities. A null or a value of another kind among an argument's members, and a
 * domain the checker sees, are the visitor's reports.
 */
const scalar = (name: ScalarTypeName): StaticType => ({ kind: "scalar", name });

const UNKNOWN_ARGUMENT: NumericArgument = Object.freeze({ type: "unknown", known: undefined });

/** The non-null part of a type, as the legacy uses it; a value that is only null stays null. */
function nonNullTypeForUse(type: StaticType): StaticType {
  const value = nonNullType(type);
  return value.kind === "never" ? resolved(type) : value;
}

/** What the result rule knows about an argument (`NumericArgument`): its kind when it is numeric, and its value. */
function prepared(view: OperandView, angles: boolean): NumericArgument {
  const known = angles
    ? typeof view.known === "object" && view.known?.kind === "angle"
      ? view.known.degrees
      : undefined
    : typeof view.known === "number"
      ? view.known
      : undefined;
  const type = closedType(view);
  if (angles || view.dynamic !== null || type === null) return { type: "unknown", known };
  const parts = members(nonNullTypeForUse(type));
  return {
    type:
      parts.length === 0 || !parts.every(isNumeric)
        ? "unknown"
        : parts.every((part) => isScalar(part, "integer"))
          ? "integer"
          : "number",
    known,
  };
}

/** Whether a call has the arguments the function takes: its positional number, and only its named ones. */
function fitsShape(
  contract: NumericFunction,
  positional: number,
  named: readonly string[],
): boolean {
  return (
    positional === contract.parameters.length &&
    named.every((name) => (contract.named ?? []).includes(name))
  );
}

const RESULT_TYPES = { integer: INTEGER_TYPE, number: NUMBER_TYPE, angle: ANGLE_TYPE } as const;

/** The kinds a numeric input the compiler cannot know may be. */
const NUMERIC_KINDS = ["integer", "number"] as const;

function relation(name: string, contract: NumericFunction): OperationRelation {
  const angles = contract.takes === "angles";
  return {
    contract: { family: "numeric", name },
    result(inputs): OperationResult {
      const named = [...inputs.named];
      // A call with another number of arguments, or a name it does not take, tells the rule nothing of them.
      const shaped = fitsShape(
        contract,
        inputs.arguments.length,
        named.map(([key]) => key),
      );
      // The inputs the rule reads: the positional parameters in order, then the named arguments.
      const slots = [
        ...contract.parameters.map((_, index) => inputs.arguments[index]),
        ...named.map(([, view]) => view),
      ];
      const run = (kinds: ReadonlyMap<number, NumericArgument>) => {
        const read = slots.map((view, slot) =>
          view === undefined || !shaped
            ? UNKNOWN_ARGUMENT
            : (kinds.get(slot) ?? prepared(view, angles)),
        );
        const positional = read.slice(0, contract.parameters.length);
        const byName = Object.fromEntries(
          named.map(([key], index) => [key, read[contract.parameters.length + index]!]),
        );
        return typeof contract.result === "function"
          ? contract.result(positional, byName)
          : contract.result;
      };
      const first = run(new Map());
      if (first !== "unknown") return typeResult(RESULT_TYPES[first]);
      if (!shaped) return INVALID;
      // The rule needs the kind of an input: one the solver knows nothing of yet waits.
      if (slots.some((view) => view !== undefined && isBottom(view))) return UNCONSTRAINED;
      const dynamic = slots.flatMap((view, slot) =>
        view !== undefined && view.dynamic !== null ? [{ slot, why: view.dynamic }] : [],
      );
      if (dynamic.length === 0) return INVALID;
      // Each input that may be dynamic is evaluated on each numeric kind, the other inputs as they are.
      const results: StaticType[] = [];
      for (let combination = 0; combination < 2 ** dynamic.length; combination += 1) {
        const kinds = new Map(
          dynamic.map(({ slot }, index): [number, NumericArgument] => [
            slot,
            {
              type: NUMERIC_KINDS[(combination >> (dynamic.length - 1 - index)) & 1]!,
              known: undefined,
            },
          ]),
        );
        const result = run(kinds);
        if (result !== "unknown" && !results.includes(RESULT_TYPES[result]))
          results.push(RESULT_TYPES[result]);
      }
      return results.length === 0 ? INVALID : possibleResult(results, dynamic[0]!.why);
    },
  };
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.entries(NUMERIC_CONTRACTS).map(([name, contract]): [string, OperationRelation] => [
    name,
    relation(name, contract),
  ]),
);

/** The kinds of values `min` and `max` order, which a value the compiler cannot know may be. */
const ORDERED_TYPES: readonly StaticType[] = [
  INTEGER_TYPE,
  ...LIST_FUNCTION_CONTRACTS.min.values.map(scalar),
];

const SAME_KIND: readonly ScalarTypeName[] = [
  "duration",
  "calendarDuration",
  "angle",
  ...TEMPORAL_KINDS,
];

/**
 * The smaller or larger of two values, as a type: two of one kind of duration, angle, or date and time value give
 * that kind; numbers give what their sum gives, so integers stay integers; any other pair has no result.
 */
function ordered(left: StaticType, right: StaticType): StaticType | undefined {
  const kind = SAME_KIND.find((name) => isScalar(left, name) && isScalar(right, name));
  if (kind !== undefined) return scalar(kind);
  const sum = arithmeticType("+", left, right);
  return sum !== undefined && isNumeric(sum) ? sum : undefined;
}

/**
 * The result of `min`/`max` of two or more values (§5.3): all durations, all calendar durations, all angles, or all
 * date and time values of one kind give that kind, and numbers the fold of `arithmeticType("+")`. A value that may
 * be null is used by its other members, as the legacy does. A value the compiler cannot know stands for each kind
 * the functions order, and the results that combine are the possibilities.
 */
export function minMaxOfValues(views: readonly OperandView[]): OperationResult {
  if (views.length < 2) return INVALID;
  if (views.some(isBottom)) return UNCONSTRAINED;
  let results: readonly StaticType[] | undefined;
  for (const view of views) {
    const type = closedType(view);
    const candidates = [
      ...(type === null ? [] : [nonNullTypeForUse(type)]),
      ...(view.dynamic === null ? [] : ORDERED_TYPES),
    ];
    if (results === undefined) {
      results = candidates;
      continue;
    }
    const next: StaticType[] = [];
    for (const left of results)
      for (const right of candidates) {
        const result = ordered(left, right);
        if (result !== undefined && !next.some((known) => typeKey(known) === typeKey(result)))
          next.push(result);
      }
    results = next;
  }
  const dynamic = views.find((view) => view.dynamic !== null);
  if (results === undefined || results.length === 0) return INVALID;
  if (dynamic === undefined) return results.length === 1 ? typeResult(results[0]!) : INVALID;
  return possibleResult(results, dynamic.dynamic!);
}
