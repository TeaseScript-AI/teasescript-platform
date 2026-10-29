import type {
  Expression,
  AngleExpression,
  AngleUnit,
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
  ANGLE_UNIT_NAMES,
  ANGLE_UNITS,
  CALENDAR_DURATION_UNIT_NAMES,
  CALENDAR_DURATION_UNITS,
  capitalizedUnit,
  DURATION_UNITS,
  mistakenDurationUnit,
} from "../language-facts.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { expressionChildren } from "../expression-children.js";
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
    if (angleUnitOf(token) !== undefined) {
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
    } else {
      const meant = mistakenDurationUnit(token.lexeme);
      const calendar = capitalizedUnit(token.lexeme, CALENDAR_DURATION_UNIT_NAMES);
      // Read as the unit meant, so that its error is the only one.
      if (meant !== undefined) {
        result = withUnit({ calendar: false, unit: meant }, parser.advance());
        reportMistakenUnit(parser, expression, token, meant, result);
      } else if (calendar !== undefined) {
        const amount = parser.sourceText(start, parser.current);
        result = withUnit({ calendar: true, unit: calendar }, parser.advance());
        reportCalendarUnitWithoutCalendar(parser, amount, token, result);
      }
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
  // A unit is written in lowercase, also one that has another error, as `calendar Months`.
  const spaced = `${parser.sourceText(start, first)} ${parser.sourceText(first, parser.current).toLowerCase()}`;
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
      capitals: "",
    });
}

const UNIT_WITHOUT_SPACE = "A unit needs a space before it.";

/**
 * Whether the amount of the calendar duration `duration` gives whole days or months, also where the known-value fold
 * gives it, as in `(3 / 2) month`, or only the type checker knows it, as in `n months` (see `knownAmount`).
 */
function wholeAmount(duration: DurationLiteral | UnitExpression): boolean {
  if (!duration.calendar) return true;
  const amount =
    duration.kind === "durationLiteral" ? duration.amount.value : knownAmount(duration.operand);
  return (
    amount === "deferred" ||
    (amount !== "unproved" && typeof unitValue(amount, duration) !== "string")
  );
}

/** The values whose number only the type checker knows. */
const NAMED_VALUES: ReadonlySet<Expression["kind"]> = new Set([
  "identifier",
  "propertyAccessExpression",
  "indexExpression",
  "callExpression",
]);

/**
 * What the parser knows of the number `amount`: its value where the known-value fold gives it, `"deferred"` where a
 * name, member, element, or call in it leaves the number to the type checker, as in `n + 1`, and otherwise
 * `"unproved"`, as for `true` or `1 / 0`, which no fix may take for a number.
 */
export function knownAmount(amount: Expression): number | "deferred" | "unproved" {
  const value = staticNumber(amount);
  if (value !== undefined) return value;
  const pending = [amount];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (NAMED_VALUES.has(node.kind)) return "deferred";
    for (const child of expressionChildren(node)) pending.push(child);
  }
  return "unproved";
}

/** The angle unit that `token` names, also with capitals, as `DEG` (see `angleExpression`). */
function angleUnitOf(token: Token): AngleUnit | undefined {
  return angleUnit(token.lexeme) ?? capitalizedUnit(token.lexeme, ANGLE_UNIT_NAMES);
}

/**
 * The angle unit that comes next after `operand`, which begins at `start`: the number before it as an angle, such as
 * `90 deg` or `(a + b) rad` (V30 §13). A unit with capitals, as `90 DEG`, is read as the unit and is an error that
 * names it in lowercase.
 */
function angleExpression(parser: Parser, operand: Expression, start: number): AngleExpression {
  const token = parser.advance();
  const unit = angleUnitOf(token)!;
  if (angleUnit(token.lexeme) === undefined) reportCapitalAngle(parser, operand, token, unit);
  else reportUnitWithoutSpace(parser, operand, start, parser.current - 1);
  return Object.freeze({
    kind: "angleExpression",
    operand,
    unit,
    unitSpan: copySpan(token.span),
    span: spanFrom(operand.span, token.span),
  });
}

/** The sentences on a unit `word` written with capitals, which no unit is written with. */
function capitalsWords(word: Token): string {
  return `'${word.lexeme}' is not a unit. ${LOWERCASE}`;
}

const LOWERCASE = "Units are written in lowercase.";

/**
 * An angle unit with capitals after `amount`, as `90 DEG`, which names the unit meant. A number with the unit is shown
 * where the statement then parses (see `Parser.offerFix`). Whether another amount, such as a name, takes the unit only
 * the type checker knows, so it keeps the words, as for a duration (see `reportMistakenUnit`).
 */
function reportCapitalAngle(
  parser: Parser,
  amount: Expression,
  word: Token,
  unit: AngleUnit,
): void {
  const message = (fix: string) =>
    `${capitalsWords(word)} For ${unit === "deg" ? "degrees" : "radians"}, ${fix}. The units of an angle are ${ANGLE_UNITS.join(" and ")}.`;
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    message(`use the unit ${unit}`),
    word,
  );
  if (amount.kind !== "numberLiteral") return;
  const fixed = `${amount.raw} ${unit}`;
  parser.offerFix(parser.diagnostics.length - 1, message(`write '${fixed}'`), [
    { start: amount.span.start.offset, end: word.span.end.offset, code: fixed, expression: true },
  ]);
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
  if (angleUnitOf(token) !== undefined) return angleExpression(parser, amount, start);
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
  const meant = mistakenDurationUnit(token.lexeme);
  if (meant !== undefined) {
    // Read as the unit meant, so that its error is the only one.
    const result = literal({ calendar: false, unit: meant }, parser.advance());
    reportMistakenUnit(parser, amount, token, meant, result);
    return result;
  }
  const calendar =
    calendarDurationUnit(token.lexeme) ??
    capitalizedUnit(token.lexeme, CALENDAR_DURATION_UNIT_NAMES);
  if (calendar === undefined) return amount;
  const result = literal({ calendar: true, unit: calendar }, parser.advance());
  reportCalendarUnitWithoutCalendar(parser, amount.raw, token, result);
  return result;
}

/** The unit names a mistaken unit is written in, by the unit meant. */
const MEANT_UNITS: Readonly<Record<DurationUnit, string>> = {
  ms: "milliseconds",
  s: "seconds",
  min: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
};

/** A list of units for a message, as in "d, w, mo, and y". */
const unitList = (units: readonly string[]) =>
  `${units.slice(0, -1).join(", ")}, and ${units.at(-1)!}`;
/** The units of time, for a message: the exact ones, then those after `calendar`. */
const UNITS_OF_TIME = `The units of time are ${unitList(DURATION_UNITS)}. After 'calendar', the units are ${unitList(CALENDAR_DURATION_UNITS)}.`;

/**
 * A word after `amount` that is no unit, as in `5 m`, `n sec`, or `5 S` (`mistakenDurationUnit`), the `duration` it
 * forms, whose error names the unit meant and every unit. A number with the unit is shown where the place of
 * `duration` takes an exact duration (see `adviseDuration`) and the statement then parses (see `Parser.offerFix`).
 * Whether another amount, such as a name, takes the unit only the type checker knows, so it keeps the words.
 */
function reportMistakenUnit(
  parser: Parser,
  amount: Expression,
  word: Token,
  meant: DurationUnit,
  duration: Expression,
): void {
  const lower = word.lexeme.toLowerCase();
  const why = lower === "m" ? ", because it could mean minutes or months" : "";
  const lowercase = lower === word.lexeme ? "" : ` ${LOWERCASE}`;
  const message = (fix: string) =>
    `'${word.lexeme}' is not a unit${why}.${lowercase} For ${MEANT_UNITS[meant]}, ${fix}. ${UNITS_OF_TIME}`;
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    message(`use the unit ${meant}`),
    word,
  );
  if (amount.kind !== "numberLiteral") return;
  const index = parser.diagnostics.length - 1;
  const fixed = `${amount.raw} ${meant}`;
  parser.mistakenUnitFixes.set(duration, () =>
    parser.offerFix(index, message(`write '${fixed}'`), [
      { start: amount.span.start.offset, end: word.span.end.offset, code: fixed, expression: true },
    ]),
  );
}

/**
 * The calendar unit that comes next, after the word `calendar`, or `undefined` once an error names the units that may
 * follow `calendar`, the same after a number as after a name.
 */
function calendarUnit(parser: Parser, calendar: Token): CalendarDurationUnit | undefined {
  const next = parser.peek();
  if (next.kind !== TokenKind.Identifier) return reportNoCalendarUnit(parser, calendar);
  const unit = calendarDurationUnit(next.lexeme);
  if (unit !== undefined) return unit;
  const capital = capitalizedUnit(next.lexeme, CALENDAR_DURATION_UNIT_NAMES);
  if (capital === undefined) return reportNoCalendarUnit(parser, calendar);
  // Read as the unit, written in lowercase where the statement then parses (see `Parser.offerFix`).
  parser.reportToken(parserDiagnosticCode.unsupportedDurationUnit, capitalsWords(next), next);
  const lower = next.lexeme.toLowerCase();
  parser.offerFix(parser.diagnostics.length - 1, `${capitalsWords(next)} Write '${lower}'.`, [
    { start: next.span.start.offset, end: next.span.end.offset, code: lower, expression: false },
  ]);
  return capital;
}

/** Reports that no calendar unit follows `calendar`, and gives `undefined`. */
function reportNoCalendarUnit(parser: Parser, calendar: Token): undefined {
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    "Expected a calendar unit after 'calendar': day, week, month, or year.",
    calendar,
  );
  return undefined;
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
  // A unit with capitals, as `Months`, is also named in lowercase.
  const lower = unit.lexeme.toLowerCase();
  const capitals = lower === unit.lexeme ? "" : `${capitalsWords(unit)} `;
  parser.reportToken(
    parserDiagnosticCode.unsupportedDurationUnit,
    `${capitals}${calendarUnitWords(calendarDurationUnit(lower) === "mo" ? "month" : "year")}`,
    unit,
  );
  parser.calendarUnitErrors.set(duration, {
    diagnostic: parser.diagnostics.at(-1)!,
    calendar: `${amount} calendar ${lower}`,
    spaced: false,
    capitals,
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
  adviseDuration(parser, value, "calendar", true);
}

/**
 * `value` is that of a declaration with the written type `type`, or none: one that takes a calendar duration gets the
 * calendar fix, and one that holds exact durations and nothing else but `null` gets days or weeks. Any other type, such
 * as a list, keeps both choices in words. A number with a word taken for a unit gets the unit meant where no written
 * type or one with `duration` takes it.
 */
export function adviseDeclaredDuration(
  parser: Parser,
  value: Expression,
  type: TypeAnnotation | null,
  subject: string,
): void {
  const names = type === null ? null : writtenNames(type);
  if (names === null || names.has("calendarDuration"))
    adviseDuration(parser, value, "calendar", names === null || names.has("duration"));
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
 * place proves a fix, the error says the fix in words. A number with a word taken for a unit, as `5 m`, gets the unit
 * meant as code in the same places where an exact duration fits (`exactFits` where a calendar one does), but not after
 * a sign where only an exact duration fits, and elsewhere keeps it in words.
 */
function adviseDuration(
  parser: Parser,
  value: Expression,
  place: { readonly exact: string } | "calendar",
  exactFits = false,
): void {
  const pending = [{ node: value, signed: false }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, signed } = next;
    const fix = parser.mistakenUnitFixes.get(node);
    if (fix !== undefined && (place === "calendar" ? exactFits : !signed)) {
      parser.mistakenUnitFixes.delete(node);
      fix();
    }
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
      const advice = createDiagnostic(
        DiagnosticSeverity.Error,
        parserDiagnosticCode.unsupportedDurationUnit,
        error!.capitals +
          (place !== "calendar"
            ? `${place.exact} needs an exact length, and a ${unit} has none. ${exactFix}`
            : error!.spaced
              ? proved
                ? `${UNIT_WITHOUT_SPACE} Write '${error!.calendar}'.`
                : UNIT_WITHOUT_SPACE
              : proved
                ? `A ${unit} has no fixed length. Write '${error!.calendar}'.`
                : `A ${unit} has no fixed length, and a calendar step needs whole months. Write the length in days or weeks.`),
        error!.diagnostic.span,
      );
      parser.diagnostics.set(index, advice);
      // A command that takes the value as an argument knows its place, and its advice comes after.
      parser.calendarUnitErrors.set(node, { ...error!, diagnostic: advice });
    } else if (node.kind === "parenthesizedExpression")
      pending.push({ node: node.expression, signed });
    else if (node.kind === "unaryExpression" && node.operator !== "not")
      pending.push({ node: node.operand, signed: true });
  }
}
