import type {
  Expression,
  AngleExpression,
  CalendarDurationUnit,
  DurationUnit,
  UnitExpression,
  NumberLiteral,
} from "../ast.js";
import { angleUnit } from "../angle.js";
import { calendarDurationUnit, elapsedDurationUnit, UNIT_OPERANDS } from "../duration.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, spanFrom } from "./tokens.js";

// Unit suffixes after a value: duration, calendar, and angle units.

/**
 * A unit after a name, a member such as `p.delay` or `list[i]`, a call, or parentheses gives the number before it
 * that unit, as a number literal takes one: `count s`, `(count / 2) min`, `randomInteger(5..=10) s` (ADR 0026 §8).
 * It binds tighter than `*` and `+`, so `a + b s` is `a + (b s)`. One duration has one unit: a second unit or a
 * second amount right after it is an error, and parts are added with `+`.
 */
export function parseUnitSuffix(parser: Parser, expression: Expression, start: number): Expression {
  let result = expression;
  const token = parser.peek();
  if (UNIT_OPERANDS.has(expression.kind) && token.kind === TokenKind.Identifier) {
    const withUnit = (
      unit:
        | { readonly calendar: false; readonly unit: DurationUnit }
        | { readonly calendar: true; readonly unit: CalendarDurationUnit },
      last: Token,
    ): UnitExpression =>
      Object.freeze({
        kind: "unitExpression",
        operand: expression,
        ...unit,
        unitSpan: spanFrom(token.span, last.span),
        span: spanFrom(expression.span, last.span),
      });
    const exact = elapsedDurationUnit(token.lexeme);
    // A month or a year needs `calendar` here too, also as `mo` or `y`.
    const withoutCalendar = calendarDurationUnit(token.lexeme);
    if (angleUnit(token.lexeme) !== undefined) {
      result = angleExpression(parser, expression, start);
    } else if (exact !== undefined) {
      parser.advance();
      result = withUnit({ calendar: false, unit: exact }, token);
    } else if (token.lexeme === "calendar") {
      const unit = calendarUnit(parser, parser.advance());
      if (unit !== undefined) result = withUnit({ calendar: true, unit }, parser.advance());
      else parser.unitlessCalendars.add(expression);
    } else if (withoutCalendar !== undefined) {
      reportCalendarUnitWithoutCalendar(parser, parser.sourceText(start, parser.current), token);
      result = withUnit({ calendar: true, unit: withoutCalendar }, parser.advance());
    }
  }
  return reportSecondUnit(parser, result);
}

/**
 * One duration or angle has one unit: a second unit or a second amount with a unit right after it is an error, as in
 * `5 s ms` or `1 h 30 min`, and parts are added with `+`.
 */
function reportSecondUnit(parser: Parser, result: Expression): Expression {
  const angle = result.kind === "angleExpression";
  if (!angle && result.kind !== "durationLiteral" && result.kind !== "unitExpression")
    return result;
  const next = parser.peek();
  const unitWord = (candidate: Token): boolean =>
    candidate.kind === TokenKind.Identifier &&
    (candidate.lexeme === "calendar" ||
      elapsedDurationUnit(candidate.lexeme) !== undefined ||
      calendarDurationUnit(candidate.lexeme) !== undefined ||
      angleUnit(candidate.lexeme) !== undefined);
  if (unitWord(next)) {
    parser.advance();
    parser.reportToken(
      parserDiagnosticCode.unsupportedDurationUnit,
      `This ${angle ? "angle" : "duration"} already has a unit. Remove the '${next.lexeme}' after it.`,
      next,
    );
  } else if (next.kind === TokenKind.NumberLiteral && unitWord(parser.peek(1))) {
    parser.advance();
    parser.advance();
    parser.reportSpan(
      parserDiagnosticCode.unsupportedDurationUnit,
      angle
        ? "Add the parts of an angle with '+', as in '90 deg + 30 deg'."
        : "Add the parts of a duration with '+', as in '1 h + 30 min'.",
      spanFrom(next.span, parser.previous().span),
    );
  }
  return result;
}

/**
 * The angle unit that comes next after `operand`, which begins at `start`: the number before it as an angle, such as
 * `90 deg` or `(a + b) rad` (V30 §13). A space must come before the unit, unlike in `90deg`.
 */
function angleExpression(parser: Parser, operand: Expression, start: number): AngleExpression {
  const token = parser.advance();
  if (token.span.start.offset === operand.span.end.offset)
    parser.reportToken(
      parserDiagnosticCode.unsupportedDurationUnit,
      `A unit needs a space before it. Write '${parser.sourceText(start, parser.current - 1)} ${token.lexeme}'.`,
      token,
    );
  return Object.freeze({
    kind: "angleExpression",
    operand,
    unit: angleUnit(token.lexeme)!,
    unitSpan: copySpan(token.span),
    span: spanFrom(operand.span, token.span),
  });
}

/**
 * A unit identifier directly after a number literal on the same line forms a duration literal: an exact unit, or
 * `calendar` and a calendar unit (ADR 0026). A month or year without `calendar` is an error that suggests it.
 */
export function parseDurationUnit(
  parser: Parser,
  amount: NumberLiteral,
  start: number,
): Expression {
  if (!parser.check(TokenKind.Identifier)) return amount;
  const token = parser.peek();
  if (angleUnit(token.lexeme) !== undefined) return angleExpression(parser, amount, start);
  const literal = (
    unit:
      | { readonly calendar: false; readonly unit: DurationUnit }
      | { readonly calendar: true; readonly unit: CalendarDurationUnit },
    last: Token,
  ): Expression =>
    Object.freeze({
      kind: "durationLiteral",
      amount,
      ...unit,
      unitSpan: copySpan(last.span),
      span: spanFrom(amount.span, last.span),
    });
  if (token.lexeme === "calendar") {
    const unit = calendarUnit(parser, parser.advance());
    return unit === undefined ? amount : literal({ calendar: true, unit }, parser.advance());
  }
  const exact = elapsedDurationUnit(token.lexeme);
  if (exact !== undefined) return literal({ calendar: false, unit: exact }, parser.advance());
  const calendar = calendarDurationUnit(token.lexeme);
  if (calendar === undefined) return amount;
  reportCalendarUnitWithoutCalendar(parser, amount.raw, token);
  return literal({ calendar: true, unit: calendar }, parser.advance());
}

/**
 * The calendar unit that comes next, after the word `calendar`, or `undefined` once an error names the units that may
 * follow `calendar`, the same after a number as after a name.
 */
function calendarUnit(parser: Parser, calendar: Token): CalendarDurationUnit | undefined {
  const next = parser.peek();
  const unit = next.kind === TokenKind.Identifier ? calendarDurationUnit(next.lexeme) : undefined;
  if (unit === undefined)
    parser.reportToken(
      parserDiagnosticCode.unsupportedDurationUnit,
      "Expected a calendar unit after 'calendar': day, week, month, or year.",
      calendar,
    );
  return unit;
}

/** A month or a year after `amount` without `calendar`; days and weeks are exact units. */
function reportCalendarUnitWithoutCalendar(parser: Parser, amount: string, unit: Token): void {
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    `A ${calendarDurationUnit(unit.lexeme) === "mo" ? "month" : "year"} has no fixed length. Write '${amount} calendar ${unit.lexeme}'.`,
    unit,
  );
}
