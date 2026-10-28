import type {
  Expression,
  AngleExpression,
  CalendarDurationUnit,
  DurationLiteral,
  DurationUnit,
  UnitExpression,
  NumberLiteral,
  TypeAnnotation,
} from "../ast.js";
import { angleUnit } from "../angle.js";
import { createDiagnostic, DiagnosticSeverity } from "../diagnostics.js";
import {
  calendarDurationUnit,
  elapsedDurationUnit,
  UNIT_OPERANDS,
  unitValue,
} from "../duration.js";
import {
  CALENDAR_DURATION_UNITS,
  DURATION_UNITS,
  MISTAKEN_DURATION_UNIT_NAMES,
} from "../language-facts.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { staticNumber } from "../static-evaluation.js";
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
        reportUnitWithoutSpace(parser, expression, start, parser.current - 2, result);
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
 * ends at the token just read. The spaced form of a `calendar` duration fits only where a calendar duration does, so it
 * is shown only where its place proves that (see `adviseDuration`).
 */
function reportUnitWithoutSpace(
  parser: Parser,
  operand: Expression,
  start: number,
  first: number,
  calendar?: DurationLiteral | UnitExpression,
): void {
  const unit = parser.tokens[first]!;
  if (unit.span.start.offset !== operand.span.end.offset) return;
  const spaced = `${parser.sourceText(start, first)} ${parser.sourceText(first, parser.current)}`;
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    calendar === undefined ? `${UNIT_WITHOUT_SPACE} Write '${spaced}'.` : UNIT_WITHOUT_SPACE,
    unit,
  );
  if (calendar !== undefined)
    parser.calendarUnitErrors.set(calendar, {
      diagnostic: parser.diagnostics.at(-1)!,
      calendar: spaced,
      spaced: true,
    });
}

const UNIT_WITHOUT_SPACE = "A unit needs a space before it.";

/**
 * Whether the amount of the calendar duration `duration` gives whole days or months, also where the known-value fold
 * gives it, as in `(3 / 2) month`, or the amount is not known, as in `n months`.
 */
function wholeAmount(duration: DurationLiteral | UnitExpression): boolean {
  if (!duration.calendar) return true;
  const amount =
    duration.kind === "durationLiteral" ? duration.amount.value : staticNumber(duration.operand);
  return amount === undefined || typeof unitValue(amount, duration) !== "string";
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
  ): DurationLiteral =>
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
    reportUnitWithoutSpace(parser, amount, start, parser.current - 2, result);
    return result;
  }
  const exact = elapsedDurationUnit(token.lexeme);
  if (exact !== undefined) {
    const result = literal({ calendar: false, unit: exact }, parser.advance());
    reportUnitWithoutSpace(parser, amount, start, parser.current - 1);
    return result;
  }
  const calendar = calendarDurationUnit(token.lexeme);
  if (calendar === undefined) {
    const meant = MISTAKEN_DURATION_UNIT_NAMES.get(token.lexeme);
    if (meant === undefined) return amount;
    // Read as the unit meant, so that its error is the only one.
    const result = literal({ calendar: false, unit: meant }, parser.advance());
    reportMistakenUnit(parser, amount, token, meant);
    return result;
  }
  const result = literal({ calendar: true, unit: calendar }, parser.advance());
  reportCalendarUnitWithoutCalendar(parser, amount.raw, token, result);
  return result;
}

/** The unit names a mistaken unit is written in, by the unit meant. */
const MEANT_UNITS: Readonly<Record<string, string>> = {
  ms: "milliseconds",
  s: "seconds",
  min: "minutes",
  h: "hours",
};

/** A list of units for a message, as in "d, w, mo, and y". */
const unitList = (units: readonly string[]) =>
  `${units.slice(0, -1).join(", ")}, and ${units.at(-1)!}`;
/** The units of time, for a message: the exact ones, then those after `calendar`. */
const UNITS_OF_TIME = `The units of time are ${unitList(DURATION_UNITS)}. After 'calendar', the units are ${unitList(CALENDAR_DURATION_UNITS)}.`;

/**
 * A word after `amount` that is no unit, as in `5 m` or `30 sec`, whose error names the unit meant and every unit. It
 * shows the amount with the unit only where that compiles in the statement (see `Parser.offerFix`).
 */
function reportMistakenUnit(
  parser: Parser,
  amount: NumberLiteral,
  word: Token,
  meant: DurationUnit,
): void {
  const why = word.lexeme === "m" ? ", because it could mean minutes or months" : "";
  const message = (fix: string) =>
    `'${word.lexeme}' is not a unit${why}. For ${MEANT_UNITS[meant]!}, ${fix}. ${UNITS_OF_TIME}`;
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    message(`use the unit ${meant}`),
    word,
  );
  const fixed = `${amount.raw} ${meant}`;
  parser.offerFix(parser.diagnostics.length - 1, message(`write '${fixed}'`), [
    { start: amount.span.start.offset, end: word.span.end.offset, code: fixed, expression: true },
  ]);
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

/** The advice for a month or a year without `calendar` that names both choices, wherever neither is known to fit. */
function calendarUnitWords(unit: string): string {
  return `A ${unit} has no fixed length. For a length, use days or weeks. For a calendar step, write 'calendar' before the unit.`;
}

/**
 * A month or a year after `amount` without `calendar`. Which fix compiles depends on where the value goes, so the error
 * names both choices in words until its place proves one (see `adviseDuration`).
 */
function reportCalendarUnitWithoutCalendar(
  parser: Parser,
  amount: string,
  unit: Token,
  duration: Expression,
): void {
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    calendarUnitWords(calendarDurationUnit(unit.lexeme) === "mo" ? "month" : "year"),
    unit,
  );
  parser.calendarUnitErrors.set(duration, {
    diagnostic: parser.diagnostics.at(-1)!,
    calendar: `${amount} calendar ${unit.lexeme}`,
    spaced: false,
  });
}

/**
 * `value` is where only an exact duration fits, such as a wait's length, which `subject` names, so a month or a year
 * without `calendar` in it gets days or weeks (ADR 0026 §5).
 */
export function requireExactDuration(parser: Parser, value: Expression, subject: string): void {
  adviseDuration(parser, value, { exact: subject });
}

/** `value` is where any value fits, such as the text of a `say`, so a month or a year without `calendar` gets it. */
export function allowCalendarDuration(parser: Parser, value: Expression): void {
  adviseDuration(parser, value, "calendar");
}

/**
 * `value` is that of a declaration with the written type `type`, or none: one that takes a calendar duration gets the
 * calendar fix, and one that holds exact durations and nothing else but `null` gets days or weeks. Any other type, such
 * as a list, keeps both choices in words.
 */
export function adviseDeclaredDuration(
  parser: Parser,
  value: Expression,
  type: TypeAnnotation | null,
  subject: string,
): void {
  const names = type === null ? null : writtenNames(type);
  if (names === null || names.has("calendarDuration")) adviseDuration(parser, value, "calendar");
  else if (
    names.has("duration") &&
    [...names].every((name) => name === "duration" || name === "null")
  )
    adviseDuration(parser, value, { exact: subject });
}

/**
 * The type names a written type is made of at its top, through `?` and unions, with a list, set, or dict, which holds
 * no duration as a whole, as `collection`.
 */
function writtenNames(type: TypeAnnotation): ReadonlySet<string> {
  const names = new Set<string>();
  const pending = [type];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.kind === "optionalType") {
      names.add("null");
      pending.push(next.value);
    } else if (next.kind === "unionType") for (const member of next.members) pending.push(member);
    else names.add(next.kind === "namedType" ? next.name : "collection");
  }
  return names;
}

/**
 * The one rule for what a month or a year without `calendar` in `value` gets at `place`, and a calendar duration without
 * a space before its unit, as in `2calendar months`. As the whole value, also in parentheses, it gets days or weeks
 * where only an exact duration fits (in words after a sign), and the calendar unit or the space where any duration does
 * (also after a sign, and in words for a known amount that is not whole, as in `(1.5) month`). Inside `+`, `-`, `*`,
 * `/`, or `otherwise`, where it may be part of a ratio such as `(1 month / 1 calendar month) * 1 s`, and wherever no
 * place proves a fix, the error says the fix in words.
 */
function adviseDuration(
  parser: Parser,
  value: Expression,
  place: { readonly exact: string } | "calendar",
): void {
  const pending = [{ node: value, signed: false }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, signed } = next;
    const error = parser.calendarUnitErrors.get(node);
    const index = error === undefined ? -1 : parser.diagnostics.lastIndexOf(error.diagnostic);
    if (index !== -1 && (node.kind === "durationLiteral" || node.kind === "unitExpression")) {
      const [unit, example] =
        node.unit === "y"
          ? ["year", "365 days"]
          : node.unit === "mo"
            ? ["month", "30 days"]
            : [node.unit === "w" ? "calendar week" : "calendar day", null];
      // No code form is proved for a known calendar amount that is not whole, as in `1.5 month`, nor for a length after a
      // sign where only an exact duration fits, as in `wait -(1 month)`: the words name the choice that remains.
      const proved = place === "calendar" ? wholeAmount(node) : !signed;
      // Days and weeks are exact without `calendar`, as in `wait 2 weeks`.
      const exactFix =
        example === null
          ? "Leave out 'calendar' and put a space before the unit."
          : `Write the length in days or weeks${proved ? `, as in '${example}'` : ""}.`;
      parser.diagnostics[index] = createDiagnostic(
        DiagnosticSeverity.Error,
        parserDiagnosticCode.unsupportedDurationUnit,
        place !== "calendar"
          ? `${place.exact} needs an exact length, and a ${unit} has none. ${exactFix}`
          : error!.spaced
            ? proved
              ? `${UNIT_WITHOUT_SPACE} Write '${error!.calendar}'.`
              : UNIT_WITHOUT_SPACE
            : proved
              ? `A ${unit} has no fixed length. Write '${error!.calendar}'.`
              : `A ${unit} has no fixed length, and a calendar step needs whole months. Write the length in days or weeks.`,
        error!.diagnostic.span,
      );
      // A command that takes the value as an argument knows its place, and its advice comes after.
      parser.calendarUnitErrors.set(node, { ...error!, diagnostic: parser.diagnostics[index]! });
    } else if (node.kind === "parenthesizedExpression")
      pending.push({ node: node.expression, signed });
    else if (node.kind === "unaryExpression" && node.operator !== "not")
      pending.push({ node: node.operand, signed: true });
  }
}
