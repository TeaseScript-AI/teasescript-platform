import type { CallExpression, Expression, Identifier } from "./ast.js";
import {
  booleanFromText,
  CONVERSION_RESULTS,
  describeConversionResult,
  isConversionName,
  isTemporalConversionResult,
  numberFromText,
  MIN_MAX_BUILTINS,
  TEMPORAL_CONVERSIONS,
  temporalTextProblem,
  type ConversionResult,
} from "./conversions.js";
import { NUMERIC_FUNCTIONS } from "./numeric-functions.js";
import type { SourceSpan } from "./source.js";
import { staticNumber, staticVisibleText } from "./static-evaluation.js";
import {
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
  NUMBER_TYPE,
  resolved,
  STRING_TYPE,
  TIME_TYPE,
  TIMESTAMP_TYPE,
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
  TEXT_MEMBERS,
  unknownTextMemberMessage,
  type ArgumentKind,
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

/**
 * Compile-time problems with a member read (`call` is `null`) or method call: unknown text members, members of values
 * that have none, and visible misuse of text operation and `join` arguments, also on a receiver of unknown type for the
 * methods only text or only lists have. Objects, speakers, handles, unions, and the other list and set members are left
 * to the type check's own rules or to the runtime.
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
    if (member.parameters === null)
      return call === null
        ? []
        : problem("length is a property, not a method; write .length without parentheses.");
    if (call === null)
      return problem(
        `${name} is a method; write ${name}(${member.parameters.length === 0 ? "" : "..."}) with parentheses.`,
      );
    return argumentProblems(member, call, typeOf, staticVisibleText(receiver));
  }
  if (type.kind === "list" && name === "join") {
    if (call === null) return problem("join is a method; write .join() with parentheses.");
    const problems = argumentProblems(LIST_JOIN, call, typeOf, undefined);
    const element = unshowableElement(receiver, type.element, typeOf);
    if (element !== undefined)
      problems.push({
        kind: "invalidOperand",
        message: `join() can only join text, numbers, true or false, null, durations, date and time values, and script references, not ${describeValue(element.type)}. Select an element or a property first.`,
        span: element.expression.span,
      });
    return problems;
  }
  if (type.kind === "unknown" || type.kind === "open") {
    // Only lists have `join`, and only text has the other text methods, so their arguments are checked even when the
    // receiver is not known. Text, lists, and sets all have `contains` with one argument of any type for collections.
    if (call === null) return [];
    // Only lists have `take` and `takeLast`, so their count is checked on any receiver too.
    if (name === "take" || name === "takeLast")
      return takeProblems(name, undefined, property, call, typeOf);
    const member = name === "join" ? LIST_JOIN : TEXT_MEMBERS.get(name);
    if (!member?.parameters) return [];
    return name === "contains"
      ? shapeProblems(member, call)
      : argumentProblems(member, call, typeOf, undefined);
  }
  if (type.kind !== "scalar" && type.kind !== "null" && type.kind !== "range") return [];
  const fix =
    type.kind === "scalar" && TEXT_MEMBERS.has(name)
      ? " Text operations need text; convert the value first with toString(...)."
      : "";
  return problem(
    `${capitalized(describeValue(type))} has no ${call === null ? "property" : "method"} '${name}'.${fix}`,
  );
}

/** Argument names, which text operations and `join` never take, and the number of arguments. */
function shapeProblems(member: TextMember, call: CallExpression): OperationProblem[] {
  const parameters = member.parameters!;
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${member.name}() takes its arguments without names; remove '${named.name.name}:'.`,
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
    if (!isAssignable(text ? STRING_TYPE : INTEGER_TYPE, type)) {
      problems.push({
        kind: "invalidOperand",
        message: argumentTypeMessage(member, parameter, describeValue(type)),
        span: value.span,
        ...(text ? {} : { widened: value }),
        fix: argumentFix(parameter, argumentKind(type)),
      });
      continue;
    }
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
  ["removePermanentButton", ["button"]],
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
        message: `${name}(...) takes no named arguments; remove '${named.name.name}:'.`,
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
        message: `${name}(...) has no parameter '${argument.name.name}'; its only named argument is default:.`,
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
            ? `${name}(...) takes no named arguments; remove '${argument.name.name}:'.`
            : `${name}(...) has no parameter '${argument.name.name}'; its only named argument is ${named[0]}:.`,
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
        message: `${name}(...) takes no named arguments; remove '${named.name.name}:'.`,
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
    // Numbers, durations, or date and time values of one kind (V30 §35) compare with each other.
    const kind = isAssignable(NUMBER_TYPE, type)
      ? NUMBER_TYPE
      : [DURATION_TYPE, DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESTAMP_TYPE].find((candidate) =>
          isAssignable(candidate, type),
        );
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
        : `toString(...) converts text, numbers, true or false, null, durations, date and time values, and script references, not ${describeValue(type)}.`;
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

/** A local date and time and a timestamp convert into each other with a method, through the player's zone (V30 §35). */
function zoneMethodFix(result: ConversionResult, type: StaticType, value: Expression): string {
  const method =
    result === "timestamp" && isScalar(type, "datetime")
      ? "toTimestamp"
      : result === "datetime" && isScalar(type, "timestamp")
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

/** The list methods that reorder a list in place, and the set operations of lists and sets (V30 §16, ADR 0013). */
export const COLLECTION_METHODS: ReadonlySet<string> = new Set([
  "sort",
  "shuffle",
  "take",
  "takeLast",
  "intersection",
  "union",
  "difference",
]);

/**
 * Compile-time problems with `sort`, `shuffle`, `intersection`, `union`, or `difference` on a list or set: argument
 * names and count, reordering a set, elements `sort` cannot order, and a set operation's argument that is neither a
 * list nor a set.
 */
export function collectionMethodProblems(
  name: string,
  receiverType: StaticType & { readonly kind: "list" | "set" },
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  if (name === "take" || name === "takeLast")
    return takeProblems(name, receiverType, property, call, typeOf);
  const reorders = name === "sort" || name === "shuffle";
  if (reorders && receiverType.kind === "set")
    return [
      {
        kind: "invalidOperand",
        message: `A set keeps its insertion order, so it has no ${name}(). Copy it into a list with toList() first.`,
        span: property.span,
      },
    ];
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: `${name}() takes its arguments without names; remove '${named.name.name}:'.`,
        span: named.name.span,
      },
    ];
  const expected = reorders ? 0 : 1;
  if (call.arguments.length !== expected)
    return [
      {
        kind: "argumentCount",
        message: `${name}() takes ${reorders ? "no arguments" : "1 argument (other)"}, received ${call.arguments.length}.`,
        span: call.span,
      },
    ];
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
        message: `${name}() takes its count without a name; remove '${named.name.name}:'.`,
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
  const known = staticNumber(count);
  // The first kind the count may be that is not a whole number, such as null in `integer?`.
  const other = members(type).find((member) => !isAssignable(INTEGER_TYPE, member));
  const message =
    other !== undefined
      ? `${name}() needs a whole number (integer), not ${describeValue(other)}.`
      : known !== undefined && known < 0
        ? `${name}() needs a whole number of at least 0, not ${known}.`
        : undefined;
  return message === undefined ? [] : [{ kind: "invalidOperand", message, span: count.span }];
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
          : isScalar(candidate, "date")
            ? "dates"
            : isScalar(candidate, "time")
              ? "times"
              : isScalar(candidate, "datetime")
                ? "dates and times"
                : isScalar(candidate, "timestamp")
                  ? "timestamps"
                  : undefined;
  const unsortable = candidates.find((candidate) => kindOf(candidate) === undefined);
  if (unsortable !== undefined)
    return `sort() sorts numbers, text, durations, or date and time values, not ${describeValue(unsortable)}.`;
  const kinds = new Set(candidates.map(kindOf));
  return kinds.size > 1
    ? `sort() needs elements of one kind, but this list may hold ${[...kinds].join(" and ")}.`
    : undefined;
}
