import {
  ANGLE_TYPE,
  arithmeticType,
  BOOLEAN_TYPE,
  CALENDAR_DURATION_TYPE,
  DURATION_TYPE,
  isNumeric,
  isScalar,
  isScalarKind,
  resolved,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  withValues,
  type StaticType,
} from "../../static-types.js";
import { typeKey } from "../../storage-types.js";
import { VALUE_KIND_NAMES } from "../../value-kinds.js";
import type { ContractFamily } from "../graph.js";
import type {
  OperandView,
  OperationInputs,
  OperationRelation,
  OperationResult,
} from "./relation.js";
import {
  closedType,
  INVALID,
  isBottom,
  possibleResult,
  typeResult,
  UNCONSTRAINED,
  viewMembers,
} from "./views.js";

/**
 * The operators and the expression forms with a fixed result (O4 stage 2b), as `#binaryTask`, `#operation` and
 * `#expressionTypeTask` of the legacy checker give them. Arithmetic and negation are relations over the operands'
 * members: every pair of members must combine (ADR 0021 rule 3.5), else the operation has no value. A comparison,
 * a logic operator, a test, an interpolation, a unit, an angle and a range always have their kind; what the visitor
 * reports about their operands is checking-only. The keys are `<family>.<name>`, since one module serves nine
 * families.
 */

/** The types an operand the compiler cannot know stands for in an operation (the legacy `OPERAND_KINDS`). */
const OPERAND_KINDS: readonly StaticType[] = [
  ...VALUE_KIND_NAMES.flatMap((kind): StaticType[] =>
    isScalarKind(kind) ? [{ kind: "scalar", name: kind }] : [],
  ),
  { kind: "list", element: UNKNOWN_TYPE },
];

/** A numeric value with `-` before it: the values an `askChoice` restricted it to change sign too. */
function negated(type: StaticType, operator: string): StaticType {
  if (operator !== "-" || type.kind !== "scalar" || type.values === undefined) return type;
  return withValues(
    type,
    type.values.map((value) => (typeof value === "number" ? -value : value)),
  );
}

function unaryResult(operator: string, operand: StaticType): StaticType | undefined {
  return isNumeric(operand) || isScalar(operand, "duration", "calendarDuration", "angle")
    ? negated(resolved(operand), operator)
    : undefined;
}

/**
 * An operation over the members of its operands: each pair must combine; a dynamic operand stands for every kind
 * an operator takes, and the results it could give are the operation's possibilities.
 */
function combine(
  operands: readonly OperandView[],
  result: (...values: StaticType[]) => StaticType | undefined,
): OperationResult {
  if (operands.some(isBottom)) return UNCONSTRAINED;
  const dynamic = operands.find((operand) => operand.dynamic !== null);
  const sides = operands.map((operand) => {
    const closed = viewMembers(operand);
    return operand.dynamic === null ? closed : [...closed, ...OPERAND_KINDS];
  });
  const pairs =
    sides.length === 1
      ? sides[0]!.map((only) => [only])
      : sides[0]!.flatMap((left) => sides[1]!.map((right) => [left, right]));
  const results: StaticType[] = [];
  let failed = false;
  for (const pair of pairs) {
    const type = result(...pair);
    if (type === undefined) failed = true;
    else if (!results.some((known) => typeKey(known) === typeKey(type))) results.push(type);
  }
  if (dynamic === undefined)
    return failed || results.length === 0 ? INVALID : typeResult(union(results));
  // With a dynamic operand only the pairs that combine count; none means the known side works with nothing.
  return results.length === 0 ? INVALID : possibleResult(results, dynamic.dynamic!);
}

function relation(
  family: ContractFamily,
  name: string,
  result: (inputs: OperationInputs) => OperationResult,
): OperationRelation {
  return { contract: { family, name }, result };
}

const FIXED: readonly (readonly [ContractFamily, string, StaticType])[] = [
  ["logic", "not", BOOLEAN_TYPE],
  ["logic", "and", BOOLEAN_TYPE],
  ["logic", "or", BOOLEAN_TYPE],
  ["comparison", "==", BOOLEAN_TYPE],
  ["comparison", "!=", BOOLEAN_TYPE],
  ["comparison", "<", BOOLEAN_TYPE],
  ["comparison", "<=", BOOLEAN_TYPE],
  ["comparison", ">", BOOLEAN_TYPE],
  ["comparison", ">=", BOOLEAN_TYPE],
  ["comparison", "case", BOOLEAN_TYPE],
  ["typeTest", "is", BOOLEAN_TYPE],
  ["typeTest", "is not", BOOLEAN_TYPE],
  ["interpolation", "show", STRING_TYPE],
  ["range", "..", { kind: "range" }],
  ["range", "..=", { kind: "range" }],
];

/**
 * Two lists whose element types mix: the legacy reports them as `union()` reports them (V30 §16) and recovers a list
 * of unknown elements, so the concatenation keeps a value.
 */
function concatenation(inputs: OperationInputs): OperationResult | undefined {
  const [left, right] = inputs.arguments;
  if (left === undefined || right === undefined || isBottom(left) || isBottom(right))
    return undefined;
  const first = left.dynamic === null ? resolved(closedType(left)!) : null;
  const second = right.dynamic === null ? resolved(closedType(right)!) : null;
  if (first?.kind !== "list" || second?.kind !== "list") return undefined;
  return arithmeticType("+", first, second) === undefined
    ? typeResult({ kind: "list", element: UNKNOWN_TYPE })
    : undefined;
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map<string, OperationRelation>(
  [
    ...["+", "-", "*", "/", "%"].map((operator): [string, OperationRelation] => [
      `operator.${operator}`,
      relation(
        "operator",
        operator,
        (inputs) =>
          (operator === "+" ? concatenation(inputs) : undefined) ??
          combine(inputs.arguments, (left, right) => arithmeticType(operator, left!, right!)),
      ),
    ]),
    ...["-", "+"].map((operator): [string, OperationRelation] => [
      `unary.${operator}`,
      relation("unary", operator, (inputs) =>
        combine(inputs.arguments, (operand) => unaryResult(operator, operand!)),
      ),
    ]),
    ...FIXED.map(([family, name, type]): [string, OperationRelation] => [
      `${family}.${name}`,
      relation(family, name, () => typeResult(type)),
    ]),
    ["angle.*", relation("angle", "*", () => typeResult(ANGLE_TYPE))],
  ],
);

/** The relation of a unit key, whose name is the unit itself: a calendar unit gives a calendar duration. */
export function unitRelation(name: string): OperationRelation {
  return relation("unit", name, () =>
    typeResult(name.startsWith("calendar ") ? CALENDAR_DURATION_TYPE : DURATION_TYPE),
  );
}
