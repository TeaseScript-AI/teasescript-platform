import { parseChild, type ParseTask } from "../parse-continuation.js";
import type {
  Block,
  Expression,
  RangeExpression,
  WaitStatement,
  TimerStatement,
  TimerParts,
  TimerDisplay,
  DurationUnit,
} from "../ast.js";
import { startsCallForm } from "../language-facts.js";
import { emptyRangeProblem, rangeStartProblem } from "../range-checks.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, spanFrom } from "./tokens.js";
import { knownAmount, requireExactDuration } from "./units.js";
import { parseStringLiteral } from "./literals.js";

// `wait` and timers: durations, the short and named timer forms, and their handlers.

/** A timer's displays, written after `timer` in its short form and as `display:` in its named form (V30 §27). */
export const TIMER_DISPLAYS = ["visible", "mystery", "hidden"] as const;
/** The named arguments of the named timer form, which needs `duration:` (V30 §27). */
export const TIMER_ARGUMENTS = [
  "duration",
  "async",
  "display",
  "label",
  "repeat",
  "persist",
] as const;

export function parseWaitStatement(parser: Parser): WaitStatement | null {
  const keyword = parser.advance();
  if (
    parser.check(TokenKind.LeftParenthesis) &&
    parser.peek().span.start.offset === keyword.span.end.offset
  ) {
    parser.reportToken(
      parserDiagnosticCode.expectedExpression,
      "Wait uses command syntax. Write 'wait 1 s'.",
      parser.peek(),
    );
    parser.synchronizeStatement();
    return null;
  }
  const mark = parser.mark();
  const duration = parser.parseExpression();
  if (duration === null) {
    parser.reportMissing(
      mark,
      parserDiagnosticCode.expectedExpression,
      "Expected a duration after 'wait'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  parser.recordCommand(keyword, duration.span.end.offset, false);
  requireExactDuration(parser, duration, "A wait");
  const { duration: delay, unit } = timerDuration(parser, duration, "wait");
  return Object.freeze({
    kind: "waitStatement",
    duration: delay,
    unit,
    lengthSpan: duration.span,
    span: spanFrom(keyword.span, duration.span),
  });
}

export function* parseTimerStatement(parser: Parser): ParseTask<TimerStatement | null> {
  const parts = yield* parseChild(parseTimerParts(parser));
  return parts === null ? null : Object.freeze({ kind: "timerStatement", ...parts });
}

/**
 * Parses `timer [async] [visible|mystery|hidden] <duration> [unit] ["label"] [{ ... }]` or
 * `timer(name: value, ...) [{ ... }]`. The modifiers are contextual words directly after `timer`.
 */
export function* parseTimerParts(parser: Parser): ParseTask<TimerParts | null> {
  const command = parser.advance();
  if (startsCallForm(command, parser.peek())) {
    return yield* parseChild(parser.withinDelimiters(parseNamedTimer(parser, command)));
  }
  const async = parser.checkIdentifier("async");
  if (async) parser.advance();
  let display: TimerDisplay | null = null;
  for (const candidate of TIMER_DISPLAYS) {
    if (parser.checkIdentifier(candidate)) {
      parser.advance();
      display = candidate;
      break;
    }
  }
  const mark = parser.mark();
  const written = parser.parseExpression();
  if (written === null) {
    parser.reportMissing(
      mark,
      parserDiagnosticCode.expectedExpression,
      "Expected a timer duration such as '30 s' or '(5..10) s' after 'timer'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  let end = written.span;
  requireExactDuration(parser, written, "A timer");
  const { duration, unit } = timerDuration(parser, written, "timer");
  let label: Expression | null = null;
  if (parser.match(TokenKind.StringStart)) {
    label = yield* parseChild(parseStringLiteral(parser, parser.previous()));
    if (label === null) return null;
    end = label.span;
  }
  parser.recordCommand(command, end.end.offset, true);
  const handler = yield* parseChild(parseTimerHandler(parser));
  if (handler === false) return null;
  return {
    form: "short",
    async,
    display,
    duration,
    unit,
    lengthSpan: written.span,
    label,
    repeat: false,
    persist: false,
    handler,
    commandSpan: copySpan(command.span),
    span: spanFrom(command.span, handler?.span ?? end),
  };
}

/**
 * A wait or timer keeps the exact unit after its duration apart, because only they take a range with a unit:
 * `timer (5..10) min` draws whole minutes. A calendar unit stays with its operand, which a wait or timer refuses like
 * any calendar duration. A unit after the end of an unparenthesized range, as in `timer 5..10 s`, belongs to the end
 * alone, so the range must be in parentheses.
 */
function timerDuration(
  parser: Parser,
  written: Expression,
  command: "wait" | "timer" | "duration:",
  repeat = false,
): { duration: Expression; unit: DurationUnit | null } {
  if (written.kind === "unitExpression" && !written.calendar)
    return { duration: written.operand, unit: written.unit };
  if (
    written.kind !== "rangeExpression" ||
    (written.end.kind !== "durationLiteral" && written.end.kind !== "unitExpression")
  )
    return { duration: written, unit: null };
  const end = written.end.kind === "durationLiteral" ? written.end.amount : written.end.operand;
  const range = `${parser.textOf(written.start.span, end.span)}`;
  const unit = parser.textOf(written.end.unitSpan, written.end.unitSpan);
  const message = "A unit after a range belongs to its end alone. Put the range in parentheses";
  parser.reportSpan(
    parserDiagnosticCode.unsupportedDurationUnit,
    `${message}, with the unit after the closing parenthesis.`,
    written.span,
  );
  // The range in parentheses, which only compiles where nothing else in the statement is wrong (see `Parser.offerFix`),
  // and where the range rules hold for every bound the parser knows (see `knownRangeHolds`).
  if (!written.end.calendar && knownRangeHolds(written, end, command, repeat, written.end.unit))
    parser.offerFix(
      parser.diagnostics.length - 1,
      `${message}, as in '${command} (${range}) ${unit}'.`,
      [
        {
          start: written.span.start.offset,
          end: written.span.end.offset,
          code: `(${range}) ${unit}`,
          // A wait or timer keeps the unit apart from the range, so no node holds both.
          expression: false,
        },
      ],
    );
  return {
    duration: Object.freeze({ ...written, end, span: spanFrom(written.start.span, end.span) }),
    unit: written.end.calendar ? null : written.end.unit,
  };
}

/**
 * Whether the range from the start of `range` to `end`, which a wait or timer counts in `unit`s, holds the rules of such
 * a range (`range-checks.ts`) as far as the parser knows its bounds (see `knownBound`). A bound that only the type
 * checker knows, such as a name, is the type checker's to check, and one that is no proved number, such as `true`, fails.
 */
function knownRangeHolds(
  range: RangeExpression,
  end: Expression,
  command: "wait" | "timer" | "duration:",
  repeat: boolean,
  unit: DurationUnit,
): boolean {
  const start = knownBound(range.start);
  const stop = knownBound(end);
  if ([start, stop].some(({ value, whole }) => value !== "deferred" && !whole)) return false;
  const timer = command === "wait" ? "wait" : "timer";
  if (
    typeof start.value === "number" &&
    rangeStartProblem(timer, repeat, start.value, unit, "") !== null
  )
    return false;
  return (
    typeof start.value !== "number" ||
    typeof stop.value !== "number" ||
    emptyRangeProblem("", { start: start.value, end: stop.value, inclusive: range.inclusive }) ===
      null
  );
}

/**
 * What the parser knows of a range bound (see `knownAmount`), and whether it is a whole number by its type: one written
 * as it is, also with a sign or in parentheses. Another known value, such as `4 / 2`, may be of type `number`.
 */
function knownBound(bound: Expression): {
  readonly value: ReturnType<typeof knownAmount>;
  readonly whole: boolean;
} {
  let written = bound;
  while (
    written.kind === "parenthesizedExpression" ||
    (written.kind === "unaryExpression" && written.operator !== "not")
  )
    written = written.kind === "parenthesizedExpression" ? written.expression : written.operand;
  return {
    value: knownAmount(bound),
    whole: written.kind === "numberLiteral" && written.numericType === "integer",
  };
}

function* parseNamedTimer(parser: Parser, command: Token): ParseTask<TimerParts | null> {
  const call = yield* parseChild(parser.finishCall(parser.identifier(command), parser.advance()));
  parser.recordCommand(command, call.span.end.offset, true);
  let duration: Expression | null = null;
  let display: Expression | null = null;
  let label: Expression | null = null;
  const flags = { async: false, repeat: false, persist: false };
  let valid = true;
  const seen = new Set<string>();
  for (const argument of call.arguments) {
    if (argument.kind !== "namedArgument") {
      parser.reportSpan(
        parserDiagnosticCode.invalidTimerForm,
        "The parenthesized timer form uses named arguments, such as 'timer(duration: 10 s)'.",
        argument.span,
      );
      valid = false;
      continue;
    }
    const name = argument.name.name;
    if (seen.has(name)) {
      parser.reportSpan(
        parserDiagnosticCode.invalidTimerForm,
        `Duplicate timer argument '${name}'.`,
        argument.name.span,
      );
      valid = false;
      continue;
    }
    seen.add(name);
    const known = TIMER_ARGUMENTS.find((candidate) => candidate === name);
    switch (known) {
      case "duration":
        duration = argument.value;
        requireExactDuration(parser, duration, "A timer");
        break;
      case "display":
        display = argument.value;
        break;
      case "label":
        label = argument.value;
        break;
      case "async":
      case "repeat":
      case "persist":
        if (argument.value.kind !== "booleanLiteral") {
          parser.reportSpan(
            parserDiagnosticCode.invalidTimerForm,
            `Timer argument '${name}' must be the literal true or false.`,
            argument.value.span,
          );
          valid = false;
        } else {
          flags[known] = argument.value.value;
        }
        break;
      case undefined:
        parser.reportSpan(
          parserDiagnosticCode.invalidTimerForm,
          `Unknown timer argument '${name}'. Use ${TIMER_ARGUMENTS.slice(0, -1).join(", ")}, or ${TIMER_ARGUMENTS.at(-1)}.`,
          argument.name.span,
        );
        valid = false;
    }
  }
  if (duration === null && valid) {
    parser.reportSpan(
      parserDiagnosticCode.invalidTimerForm,
      "The parenthesized timer form requires a 'duration' argument.",
      call.span,
    );
  }
  const handler = yield* parseChild(parseTimerHandler(parser));
  if (handler === false || duration === null || !valid) return null;
  const parts = timerDuration(parser, duration, "duration:", flags.repeat);
  return {
    form: "named",
    async: flags.async,
    display,
    duration: parts.duration,
    unit: parts.unit,
    lengthSpan: duration.span,
    label,
    repeat: flags.repeat,
    persist: flags.persist,
    handler,
    commandSpan: copySpan(command.span),
    span: spanFrom(command.span, handler?.span ?? call.span),
  };
}

/** Parses an optional expiry block on the same line; `false` reports an already diagnosed failure. */
function* parseTimerHandler(parser: Parser): ParseTask<Block | null | false> {
  if (!parser.check(TokenKind.LeftBrace)) return null;
  const block = yield* parseChild(parser.parseBlock());
  return block ?? false;
}
