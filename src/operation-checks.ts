import type { CallExpression, Expression, Identifier, ScalarTypeName } from "./ast.js";
import {
  booleanFromText,
  CONVERSION_RESULTS,
  DATA_TEXT_FUNCTIONS,
  describeConversionResult,
  isConversionName,
  isTemporalConversionResult,
  numberFromText,
  MIN_MAX_BUILTINS,
  TEMPORAL_CONVERSIONS,
  temporalTextProblem,
  unwritableJsonReason,
  WRITABLE_JSON_FIX,
  type ConversionResult,
} from "./conversions.js";
import { NUMERIC_FUNCTIONS } from "./numeric-functions.js";
import { misspelledPropertyHint } from "./object-properties.js";
import type { SourceSpan } from "./source.js";
import { staticNumber, staticVisibleText } from "./static-evaluation.js";
import {
  CALENDAR_DURATION_TYPE,
  containsType,
  DATE_TYPE,
  DATETIME_TYPE,
  describeValue,
  DURATION_TYPE,
  INTEGER_TYPE,
  isAssignable,
  isKnown,
  isScalar,
  members,
  nonNullType,
  NULL_TYPE,
  NUMBER_TYPE,
  REGEX_TYPE,
  resolved,
  STRING_TYPE,
  TIME_TYPE,
  typeName,
  union,
  ABSOLUTE_DATE_TIME_TYPE,
  type StaticType,
} from "./static-types.js";
import {
  argumentCountMessage,
  argumentFix,
  argumentTypeMessage,
  beyondLengthMessage,
  emptyTextMessage,
  endBeforeStartMessage,
  LIST_JOIN,
  negativeMessage,
  regexMemberMessage,
  TEXT_MEMBERS,
  unknownTextMemberMessage,
  type ArgumentKind,
  type MethodParameters,
  type TextMember,
} from "./text-operations.js";

/**
 * A compile-time problem with a built-in operation: a wrong number of arguments, an argument name it does not take, or
 * a value it cannot use.
 */
export interface OperationProblem {
  readonly kind: "argumentCount" | "unknownNamedArgument" | "invalidOperand";
  readonly message: string;
  readonly span: SourceSpan;
  /** An argument whose number type a widened variable may explain; the explanation goes before `fix`. */
  readonly widened?: Expression;
  readonly fix?: string;
}

/** The problem with calling `length`, which text, lists, sets, and dicts have as a property. */
const LENGTH_PROPERTY = "'length' is a property, not a method. Write .length without parentheses.";

/**
 * Compile-time problems with a member read (`call` is `null`) or method call: unknown text members, members of values
 * that have none, and visible misuse of text operation and `join` arguments, also on a receiver of unknown type for the
 * methods only text or only lists have. On a receiver of unknown type, a method that no value has is reported, and the
 * arguments of the other methods are checked where no receiver with the method takes them. Objects, speakers, handles,
 * unions, and the other list and set members are left to the type check's own rules or to the runtime.
 */
export function memberProblems(
  receiver: Expression,
  receiverType: StaticType,
  property: Identifier,
  call: CallExpression | null,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const type = forUse(receiverType);
  const name = property.name;
  const problem = (message: string): OperationProblem[] => [
    { kind: "invalidOperand", message, span: property.span },
  ];
  if (type.kind === "scalar" && type.name === "string") {
    const member = TEXT_MEMBERS.get(name);
    if (member === undefined)
      return problem(unknownTextMemberMessage(name, call === null ? "property" : "method"));
    if (member.parameters === null) return call === null ? [] : problem(LENGTH_PROPERTY);
    if (call === null)
      return problem(
        `'${name}' is a method. Write ${name}(${member.parameters.length === 0 ? "" : "..."}) with parentheses.`,
      );
    return argumentProblems(member, call, typeOf, staticVisibleText(receiver));
  }
  if (type.kind === "list" && name === "join") {
    if (call === null) return problem("'join' is a method. Write .join() with parentheses.");
    const problems = argumentProblems(LIST_JOIN, call, typeOf, undefined);
    const element = unshowableElement(receiver, type.element, typeOf);
    if (element !== undefined)
      problems.push({
        kind: "invalidOperand",
        message: `join() can only join text, numbers, true or false, null, durations, date and time values, script references, and regexes, not ${describeValue(element.type)}. Select an element or a property first.`,
        span: element.expression.span,
      });
    return problems;
  }
  if (type.kind === "unknown" || type.kind === "open") {
    // Only lists have `join`, and only text has the other text methods, so their arguments are checked even when the
    // receiver is not known. Text, lists, and sets all have `contains` with one argument of any type for collections,
    // and text and lists both have `reverse` without arguments.
    if (call === null) return [];
    // A name that no value has as a method fails on every receiver; every value with `length` has it as a property.
    if (!METHOD_NAMES.has(name))
      return problem(
        name === "length"
          ? LENGTH_PROPERTY
          : name === "findAll"
            ? unknownTextMemberMessage(name, "method")
            : `No value has a method '${name}'.${misspelledPropertyHint(name, [...METHOD_NAMES, "length"]) || " Check the name."}`,
      );
    // Only lists have `take` and `takeLast`, so their count is checked on any receiver too.
    if (name === "take" || name === "takeLast")
      return takeProblems(name, undefined, property, call, typeOf);
    // Only lists have `count`, and a list's `indexOf` and `lastIndexOf` take any value, so only one argument without a
    // name is checked.
    if (LIST_SEARCHES.has(name)) return searchProblems(name, undefined, property, call);
    // A list's `get` takes an index and a dict's a key, each with a `default:`.
    if (name === "get") return getProblems(undefined, property, call);
    const member = name === "join" ? LIST_JOIN : TEXT_MEMBERS.get(name);
    if (member?.parameters)
      return name === "contains"
        ? shapeProblems(member, call)
        : argumentProblems(member, call, typeOf, undefined);
    // Every receiver with one of the other methods takes as many arguments, but a message or a permanent button may take
    // `remove()` without any.
    return positionalMethodProblems(name, call, true);
  }
  if (type.kind !== "scalar" && type.kind !== "null" && type.kind !== "range") return [];
  if (isScalar(type, "regex"))
    return problem(regexMemberMessage(name, call === null ? "property" : "method"));
  const fix =
    type.kind === "scalar" && TEXT_MEMBERS.has(name)
      ? " Convert it to text first with toString(...)."
      : "";
  return problem(
    `${capitalized(describeValue(type))} has no ${call === null ? "property" : "method"} '${name}'.${fix}`,
  );
}

/**
 * Argument names, which text operations, `join`, and the methods of `POSITIONAL_METHODS` never take, and the number of
 * arguments.
 */
function shapeProblems(member: MethodParameters, call: CallExpression): OperationProblem[] {
  const parameters = member.parameters!;
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${member.name}() takes its arguments without names. Remove '${named.name.name}:'.`,
        span: named.name.span,
      },
    ];
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  if (call.arguments.length < required || call.arguments.length > parameters.length)
    return [
      {
        kind: "argumentCount",
        message: argumentCountMessage(member, call.arguments.length),
        span: call.span,
      },
    ];
  return [];
}

function argumentProblems(
  member: TextMember,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  receiverText: string | undefined,
): OperationProblem[] {
  const shape = shapeProblems(member, call);
  if (shape.length > 0) return shape;
  const parameters = member.parameters!;
  const problems: OperationProblem[] = [];
  const positions: (number | undefined)[] = [];
  let length: number | undefined;
  for (const [index, argument] of call.arguments.entries()) {
    const parameter = parameters[index]!;
    const value = argument.value;
    const type = typeOf(value);
    const fail = (message: string): void => {
      problems.push({ kind: "invalidOperand", message, span: value.span });
    };
    const text = parameter.kind === "text" || parameter.kind === "nonEmptyText";
    const searches = parameter.kind === "regex" || parameter.kind === "textOrRegex";
    const needed =
      parameter.kind === "regex"
        ? REGEX_TYPE
        : parameter.kind === "textOrRegex"
          ? union([STRING_TYPE, REGEX_TYPE])
          : text
            ? STRING_TYPE
            : INTEGER_TYPE;
    if (!isAssignable(needed, type)) {
      problems.push(
        nullCheckProblem(value, type, needed) ?? {
          kind: "invalidOperand",
          message: argumentTypeMessage(member, parameter, describeValue(type)),
          span: value.span,
          ...(text || searches ? {} : { widened: value }),
          fix: argumentFix(parameter, argumentKind(type)),
        },
      );
      continue;
    }
    if (searches) continue;
    if (text) {
      if (parameter.kind === "nonEmptyText" && staticVisibleText(value) === "")
        fail(emptyTextMessage(member, parameter));
      continue;
    }
    const known = staticNumber(value);
    if (parameter.kind === "position") positions.push(known);
    if (known === undefined) continue;
    if (known < 0) {
      fail(negativeMessage(member, parameter, known));
    } else if (parameter.kind === "position" && receiverText !== undefined) {
      length ??= codePointLength(receiverText);
      if (known > length) fail(beyondLengthMessage(member, parameter, known, length));
    }
  }
  const [start, end] = positions;
  if (problems.length === 0 && start !== undefined && end !== undefined && end < start)
    problems.push({
      kind: "invalidOperand",
      message: endBeforeStartMessage(member, start, end),
      span: call.arguments[1]!.value.span,
    });
  return problems;
}

/**
 * The first element of a list literal whose known type `join` cannot show, or for a computed list, its element type
 * when no element of that type can be shown.
 */
function unshowableElement(
  receiver: Expression,
  element: StaticType,
  typeOf: (expression: Expression) => StaticType,
): { readonly expression: Expression; readonly type: StaticType } | undefined {
  let node = receiver;
  while (node.kind === "parenthesizedExpression") node = node.expression;
  if (node.kind !== "listLiteral")
    return joinShowable(element) ? undefined : { expression: receiver, type: element };
  for (const expression of node.elements) {
    const type = typeOf(expression);
    if (!joinShowable(type)) return { expression, type };
  }
  return undefined;
}

/**
 * Whether a value of this type may be shown by `join`: text, a number, true or false, a duration, a date or time value,
 * or null; `join` checks the value.
 */
function joinShowable(type: StaticType): boolean {
  return members(type).some(
    (member) => !isKnown(member) || ["scalar", "null"].includes(resolved(member).kind),
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The parameters of the built-ins that take a fixed number of positional arguments and no names (V30 §7, §8). */
const FIXED_PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["random", []],
  ["chance", ["percent"]],
  ["randomInteger", ["range"]],
  ["escapeMarkup", ["text"]],
]);

/** Argument names and the number of arguments of a built-in that takes fixed positional arguments. */
export function builtinShapeProblems(name: string, call: CallExpression): OperationProblem[] {
  const parameters = FIXED_PARAMETERS.get(name);
  if (parameters === undefined) return [];
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${name}(...) takes no named arguments. Remove '${named.name.name}:'.`,
        span: named.name.span,
      },
    ];
  if (call.arguments.length === parameters.length) return [];
  return [
    {
      kind: "argumentCount",
      message:
        parameters.length === 0
          ? `${name}() takes no arguments, received ${call.arguments.length}.`
          : `${name}(...) takes ${parameters.length} argument (${parameters.join(", ")}), received ${call.arguments.length}.`,
      span: call.span,
    },
  ];
}

/**
 * Compile-time problems with a call of a conversion (`toString`, `toNumber`, `toInteger`, `toBoolean`, and the date and
 * time conversions), a numeric function (`round`, `floor`, `ceil`, `abs`, `sqrt`, `pow`), `min`, or `max`: its
 * arguments, a value of a known type it cannot take, constant text that cannot convert (V30 §13, §35), and a `default:`
 * of another type than the result. Other callees give no problems.
 */
export function builtinCallProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  if (MIN_MAX_BUILTINS.has(name)) return minMaxProblems(name, call, typeOf);
  if (NUMERIC_FUNCTIONS.has(name)) return numericFunctionProblems(name, call, typeOf);
  if (DATA_TEXT_FUNCTIONS.has(name) || name === "fileFromBase64" || name === "fileToBase64")
    return dataTextProblems(name, call, typeOf);
  if (name === "toRegex") return regexConversionProblems(call, typeOf);
  if (!isConversionName(name)) return [];
  const result = CONVERSION_RESULTS.get(name)!;
  const problems: OperationProblem[] = [];
  let fallback: Expression | undefined;
  const positional: Expression[] = [];
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") positional.push(argument.value);
    else if (argument.name.name === "default") fallback = argument.value;
    else
      problems.push({
        kind: "unknownNamedArgument",
        message: `${name}(...) has no parameter '${argument.name.name}'. Its only named argument is 'default:'.`,
        span: argument.name.span,
      });
  }
  // A date and a time combine into one date and time (V30 §35).
  const parts = result === "datetime" && positional.length === 2;
  if (positional.length !== 1 && !parts)
    problems.push({
      kind: "argumentCount",
      message: `${name}(...) takes 1 argument (value)${result === "datetime" ? " or 2 (date, time)" : ""}, received ${positional.length}.`,
      span: call.span,
    });
  if (problems.length > 0) return problems;
  if (parts) problems.push(...dateTimePartProblems(positional[0]!, positional[1]!, typeOf));
  else {
    const value = positional[0]!;
    const message = conversionProblem(name, result, value, typeOf(value));
    if (message !== undefined) problems.push({ kind: "invalidOperand", message, span: value.span });
  }
  if (fallback !== undefined) {
    const fallbackType = typeOf(fallback);
    if (!isAssignable({ kind: "scalar", name: result }, fallbackType))
      problems.push({
        kind: "invalidOperand",
        message: `${name}(...) needs ${describeConversionResult(result)} as its default:, not ${describeValue(fallbackType)}.`,
        span: fallback.span,
      });
  }
  return problems;
}

/**
 * Problems with `toJson(value)`, `toBase64(text)`, `fromJson(text, default:)`, `fromBase64(text, default:)`,
 * `fileFromBase64(text, default:)`, or `fileToBase64(file)` (V30 §13 and §33): their arguments, a required `default:`
 * that is missing, a `files:` of `toJson` or `fromJson` that is not true or false, text to read that can never be text,
 * and a value that is or may hold one that `toJson` cannot write. The text of `toBase64` and the file of `fileToBase64`
 * are checked where they are called.
 */
function dataTextProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const reads = name === "fromJson" || name === "fromBase64" || name === "fileFromBase64";
  const takesFiles = name === "toJson" || name === "fromJson";
  const problems: OperationProblem[] = [];
  const positional: Expression[] = [];
  let fallback = false;
  let files: Expression | undefined;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") positional.push(argument.value);
    else if (reads && argument.name.name === "default") fallback = true;
    else if (takesFiles && argument.name.name === "files") files = argument.value;
    else
      problems.push({
        kind: "unknownNamedArgument",
        message: reads
          ? `${name}(...) has no parameter '${argument.name.name}'. ${takesFiles ? "Its named arguments are 'default:' and 'files:'." : "Its only named argument is 'default:'."}`
          : takesFiles
            ? `${name}(...) has no parameter '${argument.name.name}'. Its only named argument is 'files:'.`
            : `${name}(...) takes no named arguments. Remove '${argument.name.name}:'.`,
        span: argument.name.span,
      });
  }
  if (files !== undefined) {
    const type = typeOf(files);
    const candidates = members(forUse(type)).map(resolved);
    if (
      candidates.length > 0 &&
      candidates.every((candidate) => isKnown(candidate) && !isScalar(candidate, "boolean"))
    )
      problems.push({
        kind: "invalidOperand",
        message: `'files:' takes true or false (boolean), not ${describeValue(type)}.`,
        span: files.span,
      });
  }
  if (positional.length !== 1)
    problems.push({
      kind: "argumentCount",
      message: `${name}(...) takes 1 argument (${name === "toJson" ? "value" : name === "fileToBase64" ? "file" : "text"})${reads ? " and a 'default:'" : ""}, received ${positional.length}.`,
      span: call.span,
    });
  else if (reads && !fallback)
    problems.push({
      kind: "argumentCount",
      message: `'${name}(text, default: value)' needs a 'default:' for text that is not valid ${name === "fromJson" ? "JSON" : "Base64"}. Add one, such as 'default: null'.`,
      span: call.span,
    });
  if (problems.length > 0 || name === "toBase64" || name === "fileToBase64") return problems;
  const value = positional[0]!;
  const type = typeOf(value);
  if (reads) {
    // As for a conversion, a value that may be text is read when the script runs.
    const candidates = members(forUse(type)).map(resolved);
    if (
      candidates.length > 0 &&
      candidates.every((candidate) => isKnown(candidate) && !isScalar(candidate, "string"))
    )
      problems.push({
        kind: "invalidOperand",
        message: `${name}(...) reads text (string), not ${describeValue(type)}.`,
        span: value.span,
      });
    return problems;
  }
  let unwritable: StaticType | undefined;
  containsType(type, (part) => {
    if (
      !SESSION_HANDLE_KINDS.has(part.kind) &&
      part.kind !== "range" &&
      !isScalar(part, "calendarDuration", "script", "regex")
    )
      return false;
    unwritable = part;
    return true;
  });
  if (unwritable !== undefined) {
    const kind = describeValue(unwritable);
    const reason = unwritableJsonReason(SESSION_HANDLE_KINDS.has(unwritable.kind));
    problems.push({
      kind: "invalidOperand",
      message:
        resolved(type) === unwritable
          ? `toJson(...) cannot write ${kind}, which ${reason}. ${WRITABLE_JSON_FIX}`
          : `toJson(...) cannot write ${kind}, which ${reason}, and this is ${describeValue(type)}. ${WRITABLE_JSON_FIX}`,
      span: value.span,
    });
  }
  return problems;
}

/**
 * Problems with `toRegex(text, default:)` (V30 §8): its arguments, a required `default:` that is missing, text that can
 * never be text, and a `default:` that can be neither a regex nor `null`.
 */
function regexConversionProblems(
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const problems: OperationProblem[] = [];
  const positional: Expression[] = [];
  let fallback: Expression | undefined;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") positional.push(argument.value);
    else if (argument.name.name === "default") fallback = argument.value;
    else
      problems.push({
        kind: "unknownNamedArgument",
        message: `toRegex(...) has no parameter '${argument.name.name}'. Its only named argument is 'default:'.`,
        span: argument.name.span,
      });
  }
  if (positional.length !== 1)
    problems.push({
      kind: "argumentCount",
      message: `toRegex(...) takes 1 argument (text) and a 'default:', received ${positional.length}.`,
      span: call.span,
    });
  else if (fallback === undefined)
    problems.push({
      kind: "argumentCount",
      message:
        "'toRegex(text, default: value)' needs a 'default:' for text that is not a valid regex. Add one, such as 'default: null'.",
      span: call.span,
    });
  if (problems.length > 0) return problems;
  const text = positional[0]!;
  const candidates = members(forUse(typeOf(text))).map(resolved);
  if (
    candidates.length > 0 &&
    candidates.every((candidate) => isKnown(candidate) && !isScalar(candidate, "string"))
  )
    problems.push({
      kind: "invalidOperand",
      message: `toRegex(...) reads pattern text (string), not ${describeValue(typeOf(text))}.`,
      span: text.span,
    });
  const fallbackType = typeOf(fallback!);
  if (!isAssignable(union([REGEX_TYPE, NULL_TYPE]), fallbackType))
    problems.push({
      kind: "invalidOperand",
      message: `toRegex(...) needs a regex or null as its default:, not ${describeValue(fallbackType)}.`,
      span: fallback!.span,
    });
  return problems;
}

/** The handles of what a script started or showed, which exist only in the current session. */
const SESSION_HANDLE_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
  "timer",
  "media",
  "camera",
  "permanentButton",
  "messageHandle",
]);

/**
 * Problems with a numeric function: names it does not take, its number of positional arguments, and arguments that are
 * not numbers.
 */
function numericFunctionProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const { parameters, named = [] } = NUMERIC_FUNCTIONS.get(name)!;
  const problems: OperationProblem[] = [];
  const values: [Expression, string][] = [];
  let positional = 0;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") {
      positional += 1;
      values.push([argument.value, ""]);
    } else if (named.includes(argument.name.name))
      values.push([argument.value, ` as its ${argument.name.name}:`]);
    else
      problems.push({
        kind: "unknownNamedArgument",
        message:
          named.length === 0
            ? `${name}(...) takes no named arguments. Remove '${argument.name.name}:'.`
            : `${name}(...) has no parameter '${argument.name.name}'. Its only named argument is '${named[0]}:'.`,
        span: argument.name.span,
      });
  }
  if (positional !== parameters.length)
    problems.push({
      kind: "argumentCount",
      message: `${name}(...) takes ${parameters.length} argument${parameters.length === 1 ? "" : "s"} (${parameters.join(", ")}), received ${positional}.`,
      span: call.span,
    });
  if (problems.length > 0) return problems;
  for (const [value, place] of values) {
    const type = typeOf(value);
    if (!isAssignable(NUMBER_TYPE, type))
      problems.push({
        kind: "invalidOperand",
        message: `${name}(...) needs a number${place}, not ${describeValue(forUse(type))}.${isScalar(forUse(type), "string") ? " Convert text with toNumber(...) first." : ""}`,
        span: value.span,
      });
  }
  return problems;
}

/**
 * Problems with `min` or `max`: two or more positional arguments that are all numbers or all durations. A possibly null
 * argument is checked by its other members (V30 §34); its value is checked at runtime.
 */
function minMaxProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${name}(...) takes no named arguments. Remove '${named.name.name}:'.`,
        span: named.name.span,
      },
    ];
  if (call.arguments.length < 2)
    return [
      {
        kind: "argumentCount",
        message: `${name}(...) takes 2 or more arguments, or one list, received ${call.arguments.length}.`,
        span: call.span,
      },
    ];
  let family: StaticType | undefined;
  for (const argument of call.arguments) {
    const type = typeOf(argument.value);
    if (!isKnown(forUse(type))) continue;
    // Numbers, durations, calendar durations, or date and time values of one kind (V30 §35) compare with each other.
    const kind = isAssignable(NUMBER_TYPE, type)
      ? NUMBER_TYPE
      : [
          DURATION_TYPE,
          CALENDAR_DURATION_TYPE,
          DATE_TYPE,
          TIME_TYPE,
          DATETIME_TYPE,
          ABSOLUTE_DATE_TIME_TYPE,
        ].find((candidate) => isAssignable(candidate, type));
    const message =
      kind === undefined
        ? `${name}(...) needs numbers, durations, or date and time values, not ${describeValue(forUse(type))}.`
        : family !== undefined && kind !== family
          ? `${name}(...) needs values of one kind, but this is ${describeValue(kind)} and an earlier one is ${describeValue(family)}.`
          : undefined;
    if (message !== undefined)
      return [{ kind: "invalidOperand", message, span: argument.value.span }];
    family = kind;
  }
  return [];
}

/**
 * Why a value of `type` provably cannot convert, or `undefined` when it can or may. A value that may be one of several
 * types is rejected only when none of them can convert; a possibly null value is checked by its other types (V30 §34).
 */
function conversionProblem(
  name: string,
  result: ConversionResult,
  value: Expression,
  type: StaticType,
): string | undefined {
  const candidates = members(forUse(type)).map(resolved);
  if (candidates.length === 0 || candidates.some((candidate) => !isKnown(candidate)))
    return undefined;
  const problems = candidates.map((candidate) =>
    candidateConversionProblem(name, result, value, candidate),
  );
  return problems.every((problem) => problem !== undefined) ? problems[0] : undefined;
}

function candidateConversionProblem(
  name: string,
  result: ConversionResult,
  value: Expression,
  type: StaticType,
): string | undefined {
  const text = isScalar(type, "string") ? staticVisibleText(value) : undefined;
  if (result === "string") {
    if (type.kind === "scalar" || type.kind === "null") return undefined;
    // `.join()` combines only values that are shown as text, so a list of lists or objects needs another fix.
    if (type.kind === "list" || type.kind === "dict") {
      const unjoinable = members(type.element)
        .map(resolved)
        .find((member) => isKnown(member) && member.kind !== "scalar" && member.kind !== "null");
      if (unjoinable !== undefined)
        return `toString(...) cannot convert ${describeValue(type)}, and ${type.kind === "list" ? ".join() cannot combine its elements" : ".values.join() cannot combine its values"}, which hold ${describeValue(unjoinable)}. Show the whole ${type.kind} with say, or select a value inside it that toString(...) converts.`;
    }
    return type.kind === "list" || type.kind === "set"
      ? `toString(...) cannot convert ${describeValue(type)}. Use ${type.kind === "set" ? ".toList().join()" : ".join()"} to combine its elements as text.`
      : type.kind === "dict"
        ? `toString(...) cannot convert ${describeValue(type)}. Use .values.join() to combine its values as text.`
        : `toString(...) converts text, numbers, true or false, null, durations, date and time values, script references, and regexes, not ${describeValue(type)}.`;
  }
  if (isTemporalConversionResult(result)) {
    const conversion = TEMPORAL_CONVERSIONS[result];
    if (isScalar(type, ...conversion.from)) return undefined;
    if (isScalar(type, "string")) {
      const problem = text === undefined ? undefined : temporalTextProblem(result, text);
      return problem === undefined
        ? undefined
        : `${name}(...) cannot convert ${JSON.stringify(text)}${problem}.`;
    }
    return `${name}(...) converts ${conversion.converts}, not ${describeValue(type)}.${zoneMethodFix(result, type, value)}`;
  }
  if (result === "boolean") {
    if (isScalar(type, "boolean")) return undefined;
    if (isScalar(type, "string"))
      return text === undefined || booleanFromText(text) !== undefined
        ? undefined
        : `toBoolean(...) cannot convert ${JSON.stringify(text)}. The text must be "true" or "false".`;
    return `toBoolean(...) converts text and true or false (boolean), not ${describeValue(type)}.${isScalar(type, "integer", "number") ? " Compare the number instead, such as value != 0." : ""}`;
  }
  if (isScalar(type, "integer", "number")) return undefined;
  if (isScalar(type, "string"))
    return text === undefined || numberFromText(text) !== undefined
      ? undefined
      : `${name}(...) cannot convert ${JSON.stringify(text)}. The text must be a number such as 2.5 or -3.`;
  return `${name}(...) converts text and numbers, not ${describeValue(type)}.${isScalar(type, "duration") ? " Divide a duration by a unit instead, such as value / 1 s." : ""}`;
}

/**
 * A local date and time and an absolute date and time convert into each other with a method, through the player's zone
 * (V30 §35).
 */
function zoneMethodFix(result: ConversionResult, type: StaticType, value: Expression): string {
  const method =
    result === "absoluteDateTime" && isScalar(type, "datetime")
      ? "toAbsoluteDateTime"
      : result === "datetime" && isScalar(type, "absoluteDateTime")
        ? "toDateTime"
        : null;
  return method === null
    ? ""
    : ` Convert it with '${expressionLabel(value) ?? "value"}.${method}()'.`;
}

/** `toDateTime(date, time)` needs a date first and a time second; a part that may be one is checked at runtime. */
function dateTimePartProblems(
  date: Expression,
  time: Expression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const problems: OperationProblem[] = [];
  for (const [part, kind, position] of [
    [date, "date", "first"],
    [time, "time", "second"],
  ] as const) {
    const type = forUse(typeOf(part));
    const candidates = members(type).map(resolved);
    if (
      candidates.length > 0 &&
      candidates.every((candidate) => isKnown(candidate) && !isScalar(candidate, kind))
    )
      problems.push({
        kind: "invalidOperand",
        message: `toDateTime(date, time) needs a ${kind} ${position}, not ${describeValue(type)}.${isScalar(type, "string") ? ` Convert the text first with ${kind === "date" ? "toDate" : "toTime"}(...).` : ""}`,
        span: part.span,
      });
  }
  return problems;
}

/** The source spelling of a variable or property path, such as `items` or `door.keys`. */
export function expressionLabel(expression: Expression): string | null {
  const names: string[] = [];
  let current = withoutParentheses(expression);
  while (current.kind === "propertyAccessExpression") {
    names.push(current.property.name);
    current = withoutParentheses(current.object);
  }
  if (current.kind !== "identifier") return null;
  names.push(current.name);
  return names.reverse().join(".");
}

function withoutParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/** The scalar kind of a known argument type, for choosing the conversion a message suggests. */
function argumentKind(type: StaticType): ArgumentKind {
  const value = forUse(type);
  if (value.kind !== "scalar") return null;
  return value.name === "string" ||
    value.name === "integer" ||
    value.name === "number" ||
    value.name === "boolean" ||
    value.name === "duration"
    ? value.name
    : null;
}

function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += text.codePointAt(index)! > 0xffff ? 2 : 1)
    length += 1;
  return length;
}

/**
 * The type an operation acts on: a possibly null value acts on its other members (V30 §34), and a value that is only
 * `null` stays `null`, so its misuse is still visible.
 */
function forUse(type: StaticType): StaticType {
  const value = resolved(nonNullType(type));
  return value.kind === "never" ? resolved(type) : value;
}

/**
 * How other code may change a variable: by assigning it, or only by changing the list, set, dict, or object it holds in
 * place, which keeps the variable on the same value, so never null.
 */
export type Sharing = "assigns" | "changes";

/** Records how `name` is changed, where an assignment says more than a change in place. */
export function noteSharing<K>(writes: Map<K, Sharing>, name: K, how: Sharing): void {
  if (writes.get(name) !== "assigns") writes.set(name, how);
}

/** The methods that change the list, set, or dict they are called on, and so the variable that holds it. */
export const COLLECTION_CHANGES: ReadonlySet<string> = new Set([
  "add",
  "addAll",
  "remove",
  "clear",
  "removeAt",
  "removeFirst",
  "removeLast",
]);

/** The variable a place belongs to, such as `xs` for `xs[0].name`, or `null` for a place no variable holds. */
export function rootName(expression: Expression): string | null {
  let node = expression;
  while (
    node.kind === "parenthesizedExpression" ||
    node.kind === "propertyAccessExpression" ||
    node.kind === "indexExpression"
  )
    node = node.kind === "parenthesizedExpression" ? node.expression : node.object;
  return node.kind === "identifier" ? node.name : null;
}

/** The list methods that search for a value: its first or last position, or how often it occurs (V30 §16). */
export const LIST_SEARCHES: ReadonlySet<string> = new Set(["indexOf", "lastIndexOf", "count"]);

/** The list methods that reorder a list in place, which a set, keeping its insertion order, does not have (V30 §16). */
export const LIST_REORDERS: ReadonlySet<string> = new Set(["sort", "shuffle", "reverse"]);

/**
 * The list methods that reorder a list in place, take part of it, search it, or read an element with a default, and
 * the set operations of lists and sets (V30 §16, ADR 0013).
 */
export const COLLECTION_METHODS: ReadonlySet<string> = new Set([
  ...LIST_REORDERS,
  "take",
  "takeLast",
  ...LIST_SEARCHES,
  "get",
  "intersection",
  "union",
  "difference",
]);

/** A method that takes positional arguments with these names. */
function positionalMethod(name: string, ...parameters: string[]): [string, MethodParameters] {
  return [name, { name, parameters: parameters.map((parameter) => ({ name: parameter })) }];
}

/**
 * The parameters of the methods of lists and sets (V30 §16), timers and media (V30 §22), and date and time values
 * (V30 §35) that take only positional arguments, besides `join`, the searches, `take`, and `takeLast`, which have their
 * own checks. Every other receiver with one of these methods takes as many: text for `contains` and `reverse`, and a dict
 * for `contains`, `remove`, and `clear`. Only a message and a permanent button take `remove()` without arguments (#836).
 */
const POSITIONAL_METHODS: ReadonlyMap<string, MethodParameters> = new Map([
  positionalMethod("add", "value"),
  positionalMethod("addAll", "other"),
  positionalMethod("remove", "value"),
  positionalMethod("removeAt", "index"),
  positionalMethod("removeFirst"),
  positionalMethod("removeLast"),
  positionalMethod("clear"),
  positionalMethod("contains", "value"),
  positionalMethod("sort"),
  positionalMethod("shuffle"),
  positionalMethod("reverse"),
  positionalMethod("intersection", "other"),
  positionalMethod("union", "other"),
  positionalMethod("difference", "other"),
  positionalMethod("toSet"),
  positionalMethod("toList"),
  positionalMethod("pause"),
  positionalMethod("resume"),
  positionalMethod("stop"),
  positionalMethod("toISO"),
  positionalMethod("formatDate"),
  positionalMethod("formatTime"),
  positionalMethod("formatDateTime"),
  positionalMethod("toAbsoluteDateTime"),
  positionalMethod("toDateTime"),
  positionalMethod("toSeconds"),
  positionalMethod("toMilliseconds"),
]);

/**
 * The name of every method a value has: those of text (V30 §8), of lists, sets, and dicts (V30 §16), of timer and media
 * handles (V30 §22), of messages and permanent buttons, and of date and time values (V30 §35). Other values, such as
 * numbers, objects, and speakers, have none.
 */
const METHOD_NAMES: ReadonlySet<string> = new Set([
  ...[...TEXT_MEMBERS.values()]
    .filter((member) => member.parameters !== null)
    .map(({ name }) => name),
  LIST_JOIN.name,
  ...COLLECTION_METHODS,
  ...POSITIONAL_METHODS.keys(),
]);

/**
 * Argument names and the number of arguments of a method in `POSITIONAL_METHODS`, which every receiver with the method
 * rejects. Where the receiver may be a message or a permanent button (`removable`), `remove()` may have no argument.
 */
export function positionalMethodProblems(
  name: string,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const method = POSITIONAL_METHODS.get(name);
  if (method === undefined) return [];
  const problems = shapeProblems(method, call);
  if (!removable || name !== "remove" || problems[0]?.kind !== "argumentCount") return problems;
  if (call.arguments.length === 0) return [];
  return [
    {
      kind: "argumentCount",
      message: `remove() takes 1 argument, or none on a message or permanent button, received ${call.arguments.length}.`,
      span: call.span,
    },
  ];
}

/**
 * Compile-time problems with `sort`, `shuffle`, `reverse`, `take`, `takeLast`, a search, `get`, `intersection`,
 * `union`, or `difference` on a list or set: argument names and count, reordering, taking from, searching, or reading a
 * position of a set, elements `sort` cannot order, and a set operation's argument that is neither a list nor a set.
 */
export function collectionMethodProblems(
  name: string,
  receiverType: StaticType & { readonly kind: "list" | "set" },
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  if (LIST_SEARCHES.has(name)) return searchProblems(name, receiverType, property, call);
  if (name === "get") return getProblems(receiverType, property, call);
  if (name === "take" || name === "takeLast")
    return takeProblems(name, receiverType, property, call, typeOf);
  const reorders = LIST_REORDERS.has(name);
  if (reorders && receiverType.kind === "set")
    return [
      {
        kind: "invalidOperand",
        message: `A set keeps its insertion order, so it has no ${name}(). Copy it into a list with toList() first.`,
        span: property.span,
      },
    ];
  const shape = positionalMethodProblems(name, call, false);
  if (shape.length > 0) return shape;
  if (name === "sort") {
    const message = sortProblem(receiverType.element);
    return message === undefined ? [] : [{ kind: "invalidOperand", message, span: property.span }];
  }
  if (reorders) return [];
  const argument = call.arguments[0]!.value;
  const type = forUse(typeOf(argument));
  // Every member of a union argument must be a list or a set (ADR 0021 rule 3.5).
  const collections = members(type).every((member) => {
    const value = resolved(member);
    return !isKnown(value) || value.kind === "list" || value.kind === "set";
  });
  if (!collections)
    return [
      {
        kind: "invalidOperand",
        message: `${name}() needs a list or a set, not ${describeValue(type)}.`,
        span: argument.span,
      },
    ];
  return [];
}

/** Problems with `take` or `takeLast`: a list method of one count, a whole number of at least 0 (V30 §16). */
function takeProblems(
  name: string,
  receiverType: (StaticType & { readonly kind: "list" | "set" }) | undefined,
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  if (receiverType?.kind === "set")
    return [
      {
        kind: "invalidOperand",
        message: `A set has no ${name}(). Copy it into a list with toList() first.`,
        span: property.span,
      },
    ];
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${name}() takes its count without a name. Remove '${named.name.name}:'.`,
        span: named.name.span,
      },
    ];
  if (call.arguments.length !== 1)
    return [
      {
        kind: "argumentCount",
        message: `${name}() takes 1 argument (count), received ${call.arguments.length}.`,
        span: call.span,
      },
    ];
  const count = call.arguments[0]!.value;
  const type = typeOf(count);
  const nullable = nullCheckProblem(count, type, INTEGER_TYPE);
  if (nullable !== undefined) return [nullable];
  const known = staticNumber(count);
  // The first kind the count may be that is not a whole number, such as the number in `number?`.
  const other = members(type).find((member) => !isAssignable(INTEGER_TYPE, member));
  const message =
    other !== undefined
      ? `${name}() needs a whole number (integer), not ${describeValue(other)}.`
      : known !== undefined && known < 0
        ? `${name}() needs a whole number of at least 0, not ${known}.`
        : undefined;
  return message === undefined ? [] : [{ kind: "invalidOperand", message, span: count.span }];
}

/** Problems with `indexOf`, `lastIndexOf`, or `count`: a list method of one value of any type (V30 §16). */
function searchProblems(
  name: string,
  receiverType: (StaticType & { readonly kind: "list" | "set" }) | undefined,
  property: Identifier,
  call: CallExpression,
): OperationProblem[] {
  if (receiverType?.kind === "set")
    return [
      {
        kind: "invalidOperand",
        message:
          name === "count"
            ? "A set holds each member once, so it has no count(). Use contains(...) instead."
            : `A set has no positions, so it has no ${name}(). Copy it into a list with toList() first.`,
        span: property.span,
      },
    ];
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${name}() takes its value without a name. Remove '${named.name.name}:'.`,
        span: named.name.span,
      },
    ];
  if (call.arguments.length !== 1)
    return [
      {
        kind: "argumentCount",
        message: `${name}() takes 1 argument (value), received ${call.arguments.length}.`,
        span: call.span,
      },
    ];
  return [];
}

/**
 * Problems with a list's `get(index, default: value)`: one index and a `default:`, as a dict's `get` takes a key and a
 * `default:` (#844), also where the receiver may be either (`receiverType` is `undefined`). The index is checked as for
 * `list[index]`.
 */
function getProblems(
  receiverType: (StaticType & { readonly kind: "list" | "set" }) | undefined,
  property: Identifier,
  call: CallExpression,
): OperationProblem[] {
  if (receiverType?.kind === "set")
    return [
      {
        kind: "invalidOperand",
        message: "A set has no positions, so it has no 'get()'. Use 'contains(...)' instead.",
        span: property.span,
      },
    ];
  const named = call.arguments.filter((argument) => argument.kind === "namedArgument");
  const unknown = named.find((argument) => argument.name.name !== "default");
  if (unknown !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `get(...) has no parameter '${unknown.name.name}'. Its only named argument is 'default:'.`,
        span: unknown.name.span,
      },
    ];
  const positional = call.arguments.length - named.length;
  if (positional === 1 && named.length === 1) return [];
  const list = receiverType !== undefined;
  return [
    {
      kind: "argumentCount",
      message:
        positional === 1 && named.length === 0
          ? list
            ? "'get(index, default: value)' needs a 'default:' for an index the list does not have. Read an element that must exist as 'list[index]'."
            : "'get(index or key, default: value)' needs a 'default:' for an index or key the value does not have. Read one that must exist as 'value[index]'."
          : list
            ? "'get(index, default: value)' takes one index and a 'default:'."
            : "'get(index or key, default: value)' takes one index or key and a 'default:'.",
      span: call.span,
    },
  ];
}

/** The kinds of handles to what a script started or showed, which no literal can write. */
const HANDLE_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
  "timer",
  "media",
  "camera",
  "permanentButton",
  "messageHandle",
  "speaker",
]);

/**
 * The message for a value that may be of a member type an operation does not support, naming the test that makes it
 * safe: `!= null` for null, which also narrows it. Only a plain variable narrows, so a property or element is first
 * kept in a variable. For null, the message also names a fallback, unless the value is what the operation changes.
 */
export function mayBeMessage(
  expression: Expression,
  failing: StaticType,
  passing: readonly StaticType[],
  fallback = true,
): string {
  const node = withoutParentheses(expression);
  const label = node.kind === "identifier" ? node.name : null;
  const test = failing.kind === "null" ? "!= null" : `is ${typeName(union(passing))}`;
  // A type that no value decided yet has no name to give.
  const what =
    resolved(failing).kind === "open"
      ? "of a type that no value decided yet, such as an element of an empty list without a written type"
      : describeValue(failing);
  const or = failing.kind === "null" && fallback ? fallbackFix(label ?? "value", passing) : "";
  return label === null
    ? `This value may be ${what}. Keep it in a variable and check it first, as in: if value ${test} { ... }${or}`
    : `'${label}' may be ${what}. Check it first: if ${label} ${test} { ... }${or}`;
}

/**
 * The fallback that a null check names as well (owner decision on #850), with a value of the `passing` types: `0` for
 * a number, `""` for text, `false` for a boolean, and `...` for any other value. A handle, such as of a timer or of
 * media, has no value to write as a fallback, so it gets none.
 */
export function fallbackFix(label: string, passing: readonly StaticType[]): string {
  if (passing.some((type) => HANDLE_KINDS.has(resolved(type).kind))) return "";
  const every = (...names: ScalarTypeName[]) =>
    passing.length > 0 && passing.every((type) => isScalar(type, ...names));
  const value = every("integer", "number")
    ? "0"
    : every("string")
      ? '""'
      : every("boolean")
        ? "false"
        : "...";
  return `, or give a fallback: ${label} otherwise ${value}`;
}

/**
 * For an argument that may be null and is otherwise of the `needed` type, the problem that names the null check
 * (owner decision on #504 Q1), such as for a position from `indexOf`.
 */
function nullCheckProblem(
  value: Expression,
  type: StaticType,
  needed: StaticType,
): OperationProblem | undefined {
  const all = members(type);
  const passing = all.filter((member) => member.kind !== "null");
  if (
    passing.length === 0 ||
    passing.length === all.length ||
    !passing.every((member) => isAssignable(needed, member))
  )
    return undefined;
  return {
    kind: "invalidOperand",
    message: mayBeMessage(value, NULL_TYPE, passing),
    span: value.span,
  };
}

/** Why elements of `element` type cannot be sorted, or `undefined` when they can or may. */
function sortProblem(element: StaticType): string | undefined {
  const candidates = members(element).map(resolved);
  if (candidates.some((candidate) => !isKnown(candidate))) return undefined;
  const kindOf = (candidate: StaticType): string | undefined =>
    isScalar(candidate, "integer", "number")
      ? "numbers"
      : isScalar(candidate, "string")
        ? "text"
        : isScalar(candidate, "duration")
          ? "durations"
          : isScalar(candidate, "calendarDuration")
            ? "calendar durations"
            : isScalar(candidate, "date")
              ? "dates"
              : isScalar(candidate, "time")
                ? "times"
                : isScalar(candidate, "datetime")
                  ? "dates and times"
                  : isScalar(candidate, "absoluteDateTime")
                    ? "absolute dates and times"
                    : undefined;
  const unsortable = candidates.find((candidate) => kindOf(candidate) === undefined);
  if (unsortable !== undefined)
    return `sort() sorts numbers, text, durations, or date and time values, not ${describeValue(unsortable)}.`;
  const kinds = new Set(candidates.map(kindOf));
  return kinds.size > 1
    ? `sort() needs elements of one kind, but this list may hold ${[...kinds].join(" and ")}.`
    : undefined;
}
