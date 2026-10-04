import type { Expression, SwitchStatement } from "./ast.js";
import { durationLiteralMilliseconds } from "./duration.js";
import type { SourceSpan } from "./source.js";
import {
  describeValue,
  isKnown,
  isNumeric,
  members,
  resolved,
  type StaticType,
} from "./static-types.js";

const switchCaseCode = { invalidCaseValue: "TSV047", overlappingCase: "TSV048" } as const;

type SwitchCaseCode = (typeof switchCaseCode)[keyof typeof switchCaseCode];

export type SwitchCaseReport = (code: SwitchCaseCode, message: string, span: SourceSpan) => void;

/** A checked `case` value: a literal, or a number range that matches like `start <= x < end` (`<=` when inclusive). */
type CaseValue =
  | {
      readonly kind: "literal";
      /** Equal for literals that compare equal with `==`, so `2` and `2.0` collide. */
      readonly key: string;
      readonly number: number | undefined;
      readonly text: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "range";
      readonly start: number;
      readonly end: number;
      readonly inclusive: boolean;
      readonly text: string;
      readonly span: SourceSpan;
    };

/**
 * Reports `case` values that are not literals, declared speakers, or number ranges, or that repeat or overlap an earlier
 * case value. Only the first matching case runs, so a later overlap could never be selected for the shared values.
 */
export function validateSwitchCases(
  statement: SwitchStatement,
  isSpeaker: (name: string) => boolean,
  report: SwitchCaseReport,
): void {
  const values: CaseValue[] = [];
  for (const switchCase of statement.cases) {
    for (const expression of switchCase.values) {
      const value = caseValue(expression, isSpeaker, report);
      if (value !== undefined) values.push(value);
    }
  }
  reportOverlaps(values, report);
}

/**
 * The message for a case value whose type can never match the switched value's known type, or `undefined` when it can.
 * `valueType` is the case value's own type; a range case matches only numbers. A value the compiler cannot know may
 * match anything.
 */
export function impossibleCaseMessage(
  subject: Expression,
  subjectType: StaticType,
  value: Expression,
  valueType: StaticType,
): string | undefined {
  const unwrapped = unwrapParentheses(value);
  const range = unwrapped.kind === "rangeExpression";
  // Name validation accepts an identifier case only for a declared speaker, which the type checker may not have seen
  // yet when it checks a function called before the declaration.
  const literal: StaticType =
    unwrapped.kind === "identifier" ? { kind: "speaker" } : resolved(valueType);
  const possible = members(subjectType).some((member) => {
    if (!isKnown(member)) return true;
    if (range) return isNumeric(member);
    if (literal.kind === "scalar" && member.kind === "scalar")
      return member.name === literal.name || (isNumeric(member) && isNumeric(literal));
    return member.kind === literal.kind;
  });
  if (possible) return undefined;
  const described = `${describeSubject(subject)} is ${describeValue(subjectType)}`;
  if (range)
    return `This range case can never match: ${described}, and a range matches only numbers. Compare with a value instead.`;
  const text =
    unwrapped.kind === "identifier" ? unwrapped.name : (literalValue(unwrapped)?.text ?? "it");
  return `This case can never match: ${described}, but ${text} is ${describeValue(literal)}. Use a case value of the same type.`;
}

function describeSubject(expression: Expression): string {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression.kind === "identifier" ? `'${expression.name}'` : "the switched value";
}

function caseValue(
  expression: Expression,
  isSpeaker: (name: string) => boolean,
  report: SwitchCaseReport,
): CaseValue | undefined {
  const unwrapped = unwrapParentheses(expression);
  if (unwrapped.kind === "rangeExpression") {
    const start = numberLiteral(unwrapped.start);
    const end = numberLiteral(unwrapped.end);
    if (start === undefined || end === undefined) {
      report(
        switchCaseCode.invalidCaseValue,
        "A range case needs a number literal on each side, such as 1..5 or 1..=5.",
        expression.span,
      );
      return undefined;
    }
    const text = `${start.text}${unwrapped.inclusive ? "..=" : ".."}${end.text}`;
    if (start.value > end.value || (start.value === end.value && !unwrapped.inclusive)) {
      report(
        switchCaseCode.invalidCaseValue,
        `The range ${text} contains no numbers, so this case can never match. Put the lower bound first, ` +
          "and use ..= to include the upper bound.",
        expression.span,
      );
      return undefined;
    }
    return {
      kind: "range",
      start: start.value,
      end: end.value,
      inclusive: unwrapped.inclusive,
      text,
      span: expression.span,
    };
  }
  // Speakers compare by identity (V30 §37), and a declared speaker name always refers to the same speaker.
  const literal =
    unwrapped.kind === "identifier" && isSpeaker(unwrapped.name)
      ? { key: `speaker:${unwrapped.name}`, number: undefined, text: unwrapped.name }
      : literalValue(unwrapped);
  if (literal === undefined) {
    report(
      switchCaseCode.invalidCaseValue,
      'A case value must be a literal such as "open", 3, true, or null, a declared speaker, or a number range ' +
        "such as 1..5. To compare with a computed value, use if and ==.",
      expression.span,
    );
    return undefined;
  }
  return { kind: "literal", ...literal, span: expression.span };
}

function literalValue(
  expression: Expression,
): Omit<Extract<CaseValue, { kind: "literal" }>, "kind" | "span"> | undefined {
  const { negative, operand } = signed(expression);
  if (operand.kind === "durationLiteral") {
    const milliseconds = (negative ? -1 : 1) * durationLiteralMilliseconds(operand);
    return {
      key: `duration:${milliseconds === 0 ? 0 : milliseconds}`,
      number: undefined,
      text: `${negative ? "-" : ""}${operand.amount.raw} ${operand.unit}`,
    };
  }
  const number = numberLiteral(expression);
  if (number !== undefined) {
    return {
      // `==` compares integers and numbers by value, and -0 equals 0.
      key: `number:${number.value === 0 ? 0 : number.value}`,
      number: number.value,
      text: number.text,
    };
  }
  switch (expression.kind) {
    case "stringLiteral": {
      let value = "";
      for (const part of expression.parts) {
        if (part.kind !== "stringText") return undefined;
        value += part.value;
      }
      return { key: `string:${value}`, number: undefined, text: JSON.stringify(value) };
    }
    case "booleanLiteral":
      return {
        key: `boolean:${expression.value}`,
        number: undefined,
        text: String(expression.value),
      };
    case "nullLiteral":
      return { key: "null", number: undefined, text: "null" };
    default:
      return undefined;
  }
}

/** A number literal with an optional sign, such as `3`, `-2.5`, or `+1`. */
function numberLiteral(expression: Expression): { value: number; text: string } | undefined {
  const { negative, operand } = signed(expression);
  if (operand.kind !== "numberLiteral") return undefined;
  return {
    value: negative ? -operand.value : operand.value,
    text: `${negative ? "-" : ""}${operand.raw}`,
  };
}

/** The expression without one leading `+` or `-`, as in `-2.5` or `-500 ms`. */
function signed(expression: Expression): { negative: boolean; operand: Expression } {
  expression = unwrapParentheses(expression);
  if (
    expression.kind === "unaryExpression" &&
    (expression.operator === "-" || expression.operator === "+")
  ) {
    return {
      negative: expression.operator === "-",
      operand: unwrapParentheses(expression.operand),
    };
  }
  return { negative: false, operand: expression };
}

/**
 * Reports case values that repeat or overlap an earlier one, on the later value. Non-numbers compare by key; numbers and
 * ranges are intervals swept in order of their lower bound, so the check stays near-linear in the number of cases. Every
 * overlap produces an error; a value that overlaps several others names one of them.
 */
function reportOverlaps(values: readonly CaseValue[], report: SwitchCaseReport): void {
  const firstByKey = new Map<string, { readonly value: CaseValue; readonly order: number }>();
  const intervals: { readonly value: CaseValue; readonly order: number }[] = [];
  /** The earlier value that each later, overlapping value is reported against, by the later value's order. */
  const overlaps = new Map<number, CaseValue>();
  const reportPair = (
    first: CaseValue,
    second: CaseValue,
    firstOrder: number,
    secondOrder: number,
  ) => {
    const [earlier, laterOrder] =
      firstOrder < secondOrder ? [first, secondOrder] : [second, firstOrder];
    if (!overlaps.has(laterOrder)) overlaps.set(laterOrder, earlier);
  };
  values.forEach((value, order) => {
    if (value.kind === "range" || value.number !== undefined) {
      intervals.push({ value, order });
      return;
    }
    const earlier = firstByKey.get(value.key);
    if (earlier === undefined) firstByKey.set(value.key, { value, order });
    else reportPair(earlier.value, value, earlier.order, order);
  });

  // Every interval includes its lower bound. Sorting by it, an interval overlaps an earlier-sorted one exactly when it
  // starts inside the one reaching furthest so far.
  intervals.sort(
    (left, right) => lowerBound(left.value) - lowerBound(right.value) || left.order - right.order,
  );
  let reach: (typeof intervals)[number] | undefined;
  for (const current of intervals) {
    if (reach !== undefined) {
      const [end, inclusive] = upperBound(reach.value);
      const start = lowerBound(current.value);
      if (start < end || (start === end && inclusive)) {
        reportPair(reach.value, current.value, reach.order, current.order);
      }
    }
    if (reach === undefined || reachesFurther(current.value, reach.value)) reach = current;
  }

  for (const [order, earlier] of [...overlaps].sort(([left], [right]) => left - right)) {
    const later = values[order]!;
    report(
      switchCaseCode.overlappingCase,
      earlier.kind === "literal" && later.kind === "literal"
        ? `The case value ${later.text} already appears on line ${earlier.span.start.line + 1}. Remove one of them.`
        : `The case value ${later.text} overlaps ${earlier.text} on line ${earlier.span.start.line + 1}. ` +
            "Each value may match only one case; change or remove one of them.",
      later.span,
    );
  }
}

function lowerBound(value: CaseValue): number {
  return value.kind === "range" ? value.start : value.number!;
}

function upperBound(value: CaseValue): readonly [number, boolean] {
  return value.kind === "range" ? [value.end, value.inclusive] : [value.number!, true];
}

function reachesFurther(candidate: CaseValue, current: CaseValue): boolean {
  const [candidateEnd, candidateInclusive] = upperBound(candidate);
  const [currentEnd, currentInclusive] = upperBound(current);
  return (
    candidateEnd > currentEnd ||
    (candidateEnd === currentEnd && candidateInclusive && !currentInclusive)
  );
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}
