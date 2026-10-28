import type {
  Expression,
  AngleExpression,
  CalendarDurationUnit,
  DurationUnit,
  UnitExpression,
  NumberLiteral,
} from "../ast.js";
import { angleUnit } from "../angle.js";
import { createDiagnostic, DiagnosticSeverity } from "../diagnostics.js";
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
      reportUnitWithoutSpace(parser, expression, start, parser.current - 1);
    } else if (token.lexeme === "calendar") {
      const unit = calendarUnit(parser, parser.advance());
      if (unit !== undefined) {
        result = withUnit({ calendar: true, unit }, parser.advance());
        reportUnitWithoutSpace(parser, expression, start, parser.current - 2);
      } else parser.unitlessCalendars.add(expression);
    } else if (withoutCalendar !== undefined) {
      const amount = parser.sourceText(start, parser.current);
      result = withUnit({ calendar: true, unit: withoutCalendar }, parser.advance());
      reportCalendarUnitWithoutCalendar(parser, amount, token, result);
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
 * A unit needs a space before it, as in `90 s`, `count s`, or `(a + b) min` (V30 §3): `90s`, `2min`, and `90deg` are
 * errors that suggest the spaced form. `operand` begins at token `start` and the unit at token `first`, and the unit
 * ends at the token just read.
 */
function reportUnitWithoutSpace(
  parser: Parser,
  operand: Expression,
  start: number,
  first: number,
): void {
  const unit = parser.tokens[first]!;
  if (unit.span.start.offset === operand.span.end.offset)
    parser.reportToken(
      parserDiagnosticCode.unsupportedDurationUnit,
      `A unit needs a space before it. Write '${parser.sourceText(start, first)} ${parser.sourceText(first, parser.current)}'.`,
      unit,
    );
}

/**
 * The angle unit that comes next after `operand`, which begins at `start`: the number before it as an angle, such as
 * `90 deg` or `(a + b) rad` (V30 §13).
 */
function angleExpression(parser: Parser, operand: Expression, start: number): AngleExpression {
  const token = parser.advance();
  reportUnitWithoutSpace(parser, operand, start, parser.current - 1);
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
    if (unit === undefined) return amount;
    const result = literal({ calendar: true, unit }, parser.advance());
    reportUnitWithoutSpace(parser, amount, start, parser.current - 2);
    return result;
  }
  const exact = elapsedDurationUnit(token.lexeme);
  if (exact !== undefined) {
    const result = literal({ calendar: false, unit: exact }, parser.advance());
    reportUnitWithoutSpace(parser, amount, start, parser.current - 1);
    return result;
  }
  const calendar = calendarDurationUnit(token.lexeme);
  if (calendar === undefined) return amount;
  const result = literal({ calendar: true, unit: calendar }, parser.advance());
  reportCalendarUnitWithoutCalendar(parser, amount.raw, token, result);
  return result;
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

/**
 * A month or a year after `amount` without `calendar`, which gives `duration`; days and weeks are exact units. The fix
 * names the calendar unit, unless `duration` is where only an exact duration fits (see `requireExactDuration`).
 */
function reportCalendarUnitWithoutCalendar(
  parser: Parser,
  amount: string,
  unit: Token,
  duration: Expression,
): void {
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    `A ${calendarDurationUnit(unit.lexeme) === "mo" ? "month" : "year"} has no fixed length. Write '${amount} calendar ${unit.lexeme}'.`,
    unit,
  );
  parser.calendarUnitErrors.set(duration, parser.diagnostics.at(-1)!);
}

/** The operators whose operands both give their result its unit, so an exact duration needs exact operands. */
const EXACT_OPERANDS: ReadonlySet<string> = new Set(["+", "-", "*", "otherwise"]);

/**
 * `value` is where only an exact duration fits, such as a wait's length, which `subject` names: a month or a year
 * without `calendar` in it, also inside parentheses, a sign, `+`, `-`, `*`, or `otherwise`, or before `/` and a number
 * literal, gets days or weeks as its fix, because a calendar duration has no fixed length either (ADR 0026 §5). A
 * divisor, or a dividend over anything else, may be a ratio, as in `(1 month / 1 calendar month) * 1 s`, and keeps the
 * calendar fix.
 */
export function requireExactDuration(parser: Parser, value: Expression, subject: string): void {
  const pending = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const error = parser.calendarUnitErrors.get(node);
    const index = error === undefined ? -1 : parser.diagnostics.lastIndexOf(error);
    if (index !== -1 && (node.kind === "durationLiteral" || node.kind === "unitExpression")) {
      const [unit, example] = node.unit === "y" ? ["year", "365 days"] : ["month", "30 days"];
      parser.diagnostics[index] = createDiagnostic(
        DiagnosticSeverity.Error,
        parserDiagnosticCode.unsupportedDurationUnit,
        `${subject} needs an exact length, and a ${unit} has none. Write the length in days or weeks, as in '${example}'.`,
        error!.span,
      );
    } else if (node.kind === "parenthesizedExpression") pending.push(node.expression);
    else if (node.kind === "unaryExpression" && node.operator !== "not") pending.push(node.operand);
    else if (node.kind === "binaryExpression" && EXACT_OPERANDS.has(node.operator))
      pending.push(node.left, node.right);
    else if (
      node.kind === "binaryExpression" &&
      node.operator === "/" &&
      node.right.kind === "numberLiteral"
    )
      pending.push(node.left);
  }
}
