import type { CallExpression, Expression, Identifier, ScalarTypeName } from "./ast.js";
import {
  conversionTo,
  CONVERSIONS,
  defaultDescription,
  isConversion,
  MIN_MAX_BUILTINS,
  unwritableJsonReason,
  WRITABLE_JSON_FIX,
  type CallShape,
  type Conversion,
  type ValueConversion,
} from "./conversions.js";
import type { ConversionName } from "./language-facts.js";
import { LOCK_CALLS } from "./capture-call.js";
import { NUMERIC_FUNCTIONS, type NumberSignature } from "./numeric-functions.js";
import { isRandomFunction, RANDOM_CONTRACTS, type RandomFunction } from "./random-functions.js";
import { ANGLE_FUNCTIONS, angleArgumentMessage } from "./angle.js";
import { misspelledPropertyHint } from "./object-properties.js";
import { parsePublicKey } from "./public-keys.js";
import { cannotConvert } from "./runtime/value-types.js";
import type { SourceSpan } from "./source.js";
import { canonicalRegexFlags, compileRegex, regexFlagProblem, replacementParts } from "./regex.js";
import { staticNumber, staticVisibleText } from "./static-evaluation.js";
import {
  ANGLE_TYPE,
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
  argumentsTaken,
  FIXED_PARAMETERS,
  getArgumentsProblem,
  LIST_ONLY_METHODS,
  missingDefaultMessage,
  POSITIONAL_METHODS,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";
import { MIN_MAX_TAKES } from "./list-function-rules.js";
import {
  argumentFix,
  argumentTypeMessage,
  beyondLengthMessage,
  emptyTextMessage,
  endBeforeStartMessage,
  LIST_JOIN,
  methodArgumentCountMessage,
  needsNonEmptyText,
  negativeMessage,
  regexMemberMessage,
  takesRegex,
  takesText,
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

/** The fix for a range where a list is needed, as for a set (V30 §6). */
export const RANGE_LIST_FIX = " Make a list of its numbers with toList() first.";

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
        message: `join() can only join text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes, not ${describeValue(element.type)}. Select an element or a property first.`,
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
          : `No value has a method '${name}'.${misspelledPropertyHint(name, [...METHOD_NAMES, "length"]) || " Check the name."}`,
      );
    // Only lists have `take` and `takeLast`, so their count is checked on any receiver too.
    if (name === "take" || name === "takeLast")
      return takeProblems(name, undefined, property, call, typeOf);
    // A list's `indexOf`, `lastIndexOf`, and `count` take any value, so only one argument without a name is checked.
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
        message: unknownNamedArgumentMessage(member.name, named.name.name, []),
        span: named.name.span,
      },
    ];
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  if (call.arguments.length < required || call.arguments.length > parameters.length)
    return [
      {
        kind: "argumentCount",
        message: methodArgumentCountMessage(member, call.arguments.length),
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
    const text = takesText(parameter);
    const searches = takesRegex(parameter);
    const needed = searches
      ? text
        ? union([STRING_TYPE, REGEX_TYPE])
        : REGEX_TYPE
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
    if (text || searches) {
      if (needsNonEmptyText(parameter) && staticVisibleText(value) === "")
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
  if (problems.length === 0 && member.name === "replace")
    problems.push(...replacementProblems(call));
  return problems;
}

/**
 * A replacement that refers to a group the regex does not have (V30 §8), when the search is a regex literal and the
 * replacement's text is known. A literal RE2 rejects is reported where it is written.
 */
function replacementProblems(call: CallExpression): OperationProblem[] {
  let search = call.arguments[0]!.value;
  while (search.kind === "parenthesizedExpression") search = search.expression;
  const replacement = call.arguments[1]!.value;
  const text = staticVisibleText(replacement);
  if (search.kind !== "regexLiteral" || text === undefined) return [];
  if (regexFlagProblem(search.flags) !== null) return [];
  const compiled = compileRegex(search.source, canonicalRegexFlags(search.flags));
  if (!compiled.ok) return [];
  const parts = replacementParts(text, search.source, compiled.program.groups);
  return parts.ok
    ? []
    : [{ kind: "invalidOperand", message: parts.problem, span: replacement.span }];
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
 * Whether a value of this type may be shown by `join`: text, a number, true or false, a duration, an angle, a date or
 * time value, or null; `join` checks the value.
 */
function joinShowable(type: StaticType): boolean {
  return members(type).some(
    (member) => !isKnown(member) || ["scalar", "null"].includes(resolved(member).kind),
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Argument names and the number of arguments of a built-in that takes fixed positional arguments. */
export function builtinShapeProblems(name: string, call: CallExpression): OperationProblem[] {
  const parameters = FIXED_PARAMETERS.get(name);
  return parameters === undefined ? [] : fixedShapeProblems(name, parameters, call);
}

/** Argument names and the number of arguments of a call that takes `parameters` without names. */
function fixedShapeProblems(
  name: string,
  parameters: readonly string[],
  call: CallExpression,
): OperationProblem[] {
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: unknownNamedArgumentMessage(name, named.name.name, [], parameters.length > 0),
        span: named.name.span,
      },
    ];
  if (call.arguments.length === parameters.length) return [];
  return [
    {
      kind: "argumentCount",
      message: argumentCountMessage(name, argumentsTaken(parameters), call.arguments.length),
      span: call.span,
    },
  ];
}

/**
 * Compile-time problems with a call of a conversion (V30 §8, §13, §35), a numeric, random, or angle function, `min`,
 * `max`, a file or hash function of text, or a lock call: its arguments, a value of a known type it cannot take,
 * constant text that cannot convert, and a `default:` it cannot give. Other callees, and `randomWeighted`, whose checks
 * are a list function's, give no problems.
 */
export function builtinCallProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  if (MIN_MAX_BUILTINS.has(name)) return minMaxProblems(name, call, typeOf);
  if (NUMERIC_FUNCTIONS.has(name))
    return numberArgumentProblems(name, NUMERIC_FUNCTIONS.get(name)!, call, typeOf);
  if (isRandomFunction(name)) {
    const random: RandomFunction = RANDOM_CONTRACTS[name];
    if (random.takes === "numbers") return numberArgumentProblems(name, random, call, typeOf);
    return random.takes === "range" ? fixedShapeProblems(name, random.parameters, call) : [];
  }
  if (ANGLE_FUNCTIONS.has(name)) return angleFunctionProblems(name, call, typeOf);
  if (isConversion(name)) return conversionProblems(name, CONVERSIONS[name], call, typeOf);
  const shape = FILE_TEXT_FUNCTIONS.get(name);
  if (shape !== undefined) return fileTextProblems(name, shape, call, typeOf);
  if (LOCK_CALLS.has(name)) return lockProblems(name, call, typeOf);
  return [];
}

/**
 * Problems with `encryptText(text, ...)`, `encryptFile(file, ...)`, `decryptText(text, ..., default:)`, or
 * `decryptFile(file, ..., default:)` (V30 §13): their arguments, a named argument the call does not take, a missing
 * `default:`, an option whose value can never fit it, a written text that is no public key, and an encrypt call that
 * gives some of its openers but not all, or gives each as `false`. The text or file is checked where it is called.
 */
function lockProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const decrypts = name === "decryptText" || name === "decryptFile";
  const openers = ["password", "publicKey", "timeLock"];
  const parameters = decrypts ? ["password", "key", "default"] : openers;
  const problems: OperationProblem[] = [];
  const named = new Map<string, Expression>();
  let positional = 0;
  const quoted = (options: readonly string[], conjunction: string) =>
    options.length < 3
      ? options.map((option) => `'${option}:'`).join(` ${conjunction} `)
      : `${options
          .slice(0, -1)
          .map((option) => `'${option}:'`)
          .join(", ")}, ${conjunction} '${options.at(-1)}:'`;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") positional += 1;
    else if (parameters.includes(argument.name.name)) named.set(argument.name.name, argument.value);
    else
      problems.push({
        kind: "unknownNamedArgument",
        message: unknownNamedArgumentMessage(name, argument.name.name, parameters),
        span: argument.name.span,
      });
  }
  if (positional !== 1)
    problems.push({
      kind: "argumentCount",
      message: argumentCountMessage(
        name,
        `1 argument (${name.endsWith("File") ? "file" : "text"})${decrypts ? " and a 'default:'" : ""}`,
        positional,
      ),
      span: call.span,
    });
  else if (decrypts && !named.has("default"))
    problems.push({
      kind: "argumentCount",
      message: missingDefaultMessage(
        `${name}(${name === "decryptText" ? "text" : "file"}, default: value)`,
        "for when it does not open, such as with a wrong password",
      ),
      span: call.span,
    });
  // An encrypt call's option also takes `true`, which lets the player choose it, or `false`, which leaves it out.
  const optionProblem = (
    option: string,
    fits: (type: StaticType) => boolean,
    expected: string,
  ): boolean => {
    const value = named.get(option);
    if (value === undefined) return false;
    const type = typeOf(value);
    const candidates = members(forUse(type)).map(resolved);
    if (
      candidates.length > 0 &&
      candidates.every(
        (candidate) =>
          isKnown(candidate) &&
          !fits(candidate) &&
          (decrypts || option === "key" || !isScalar(candidate, "boolean")),
      )
    ) {
      problems.push({
        kind: "invalidOperand",
        message: `'${option}:' takes ${expected}${decrypts || option === "key" ? "" : ", true, or false"}, not ${describeValue(type)}.`,
        span: value.span,
      });
      return true;
    }
    return false;
  };
  optionProblem("password", (type) => isScalar(type, "string"), "text (string)");
  if (decrypts) {
    optionProblem("key", (type) => isScalar(type, "string"), "an unlock key as text (string)");
    return problems;
  }
  optionProblem(
    "timeLock",
    (type) => isScalar(type, "absoluteDateTime"),
    "a moment (absoluteDateTime)",
  );
  // A public key, or a list of them, each an age recipient or an OpenSSH Ed25519 key; the written ones are read here.
  const keyText = (candidate: StaticType) =>
    isScalar(candidate, "string") ||
    (candidate.kind === "list" &&
      members(candidate.element)
        .map(resolved)
        .every((element) => !isKnown(element) || isScalar(element, "string")));
  const publicKey = named.get("publicKey");
  if (
    publicKey !== undefined &&
    !optionProblem("publicKey", keyText, "a public key (string), a list of them")
  ) {
    let written = publicKey;
    while (written.kind === "parenthesizedExpression") written = written.expression;
    const literals = written.kind === "listLiteral" ? written.elements : [written];
    const wrong = literals.find((element) => {
      let literal = element;
      while (literal.kind === "parenthesizedExpression") literal = literal.expression;
      const text = literal.kind === "stringLiteral" ? staticVisibleText(literal) : undefined;
      return text !== undefined && parsePublicKey(text) === null;
    });
    if (wrong !== undefined)
      problems.push({
        kind: "invalidOperand",
        message: `'publicKey:' takes public keys, such as "age1…" or "ssh-ed25519 AAAA…", but this is neither.`,
        span: wrong.span,
      });
  }
  const given = openers.filter((option) => named.has(option));
  const missing = openers.filter((option) => !named.has(option));
  if (given.length > 0 && missing.length > 0)
    problems.push({
      kind: "argumentCount",
      message: `${name}(...) gives ${quoted(given, "and")} but not ${quoted(missing, "or")}. Once a call gives one of ${quoted(openers, "and")}, it must give each, so no way to open it is left out by mistake. Add ${quoted(missing, "and")}${missing.length > 1 ? ", each" : ""} with a value, true to let the player choose, or false to leave it out.`,
      span: call.span,
    });
  else if (given.length > 0 && given.every((option) => writtenFalse(named.get(option)!)))
    problems.push({
      kind: "invalidOperand",
      message: `${name}(...) has no way to open, because ${quoted(openers, "and")} are ${openers.length === 2 ? "both" : "all"} false, so nothing could ever open it. Give one of them a value, or true to let the player choose.`,
      span: call.span,
    });
  return problems;
}

/** Whether an expression is the literal `false`, also in parentheses. */
function writtenFalse(expression: Expression): boolean {
  let node = expression;
  while (node.kind === "parenthesizedExpression") node = node.expression;
  return node.kind === "booleanLiteral" && !node.value;
}

/** The arguments of a call of one positional argument, by role, and the problems with its shape. */
interface ShapedCall {
  readonly problems: OperationProblem[];
  readonly positional: readonly Expression[];
  readonly fallback: Expression | undefined;
}

/**
 * The arguments of a call of `shape` (see `CallShape`), and its problems: a named argument it does not take, a
 * `files:` that is not true or false, the number of positional arguments, and a required `default:` that is missing.
 */
function shapedCall(
  name: string,
  shape: CallShape,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): ShapedCall {
  const named = [
    ...(shape.fallback === null ? [] : ["default"]),
    ...(shape.files ? ["files"] : []),
  ];
  const problems: OperationProblem[] = [];
  const positional: Expression[] = [];
  let fallback: Expression | undefined;
  let files: Expression | undefined;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") positional.push(argument.value);
    else if (shape.fallback !== null && argument.name.name === "default") fallback = argument.value;
    else if (shape.files && argument.name.name === "files") files = argument.value;
    else
      problems.push({
        kind: "unknownNamedArgument",
        message: unknownNamedArgumentMessage(name, argument.name.name, named),
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
  const required = shape.fallback?.required ?? null;
  if (positional.length !== 1 && (shape.pair === undefined || positional.length !== 2))
    problems.push({
      kind: "argumentCount",
      message: argumentCountMessage(
        name,
        `1 argument (${shape.parameter})${required === null ? "" : " and a 'default:'"}${shape.pair === undefined ? "" : ` or 2 (${shape.pair.join(", ")})`}`,
        positional.length,
      ),
      span: call.span,
    });
  else if (required !== null && fallback === undefined)
    problems.push({
      kind: "argumentCount",
      message: missingDefaultMessage(
        `${name}(${shape.parameter}, default: value)`,
        `for ${required}`,
      ),
      span: call.span,
    });
  return { problems, positional, fallback };
}

/**
 * Problems with a call of a conversion (see `Conversion`): its shape, an argument that can never be what it takes,
 * text it can see that does not convert, and a `default:` it cannot give. The text of a call without a default, which
 * fails for anything else, is checked where it is called; text that a call with a default cannot read gives the
 * default, so only a value that can never be text is an error.
 */
function conversionProblems(
  name: ConversionName,
  conversion: Conversion,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const { problems, positional, fallback } = shapedCall(name, conversion, call, typeOf);
  if (problems.length > 0) return problems;
  const value = positional[0]!;
  const type = typeOf(value);
  if (conversion.takes === "value") {
    if (conversion.pair !== undefined && positional.length === 2)
      problems.push(...pairProblems(name, conversion.pair, positional, typeOf));
    else {
      const message = conversionProblem(name, conversion, value, type);
      if (message !== undefined)
        problems.push({ kind: "invalidOperand", message, span: value.span });
    }
  } else if (conversion.takes === "text") {
    if (conversion.fallback !== null)
      problems.push(...neverTextProblems(name, conversion.does, value, type));
  } else problems.push(...unwritableJsonProblems(value, type));
  const description = defaultDescription(conversion);
  if (fallback !== undefined && description !== undefined && conversion.result !== "unknown") {
    const fallbackType = typeOf(fallback);
    const result: StaticType = { kind: "scalar", name: conversion.result };
    if (
      !isAssignable(
        conversion.fallback?.type === "optional" ? union([result, NULL_TYPE]) : result,
        fallbackType,
      )
    )
      problems.push({
        kind: "invalidOperand",
        message: `${name}(...) needs ${description} as its default:, not ${describeValue(fallbackType)}.`,
        span: fallback.span,
      });
  }
  return problems;
}

/**
 * The file and hash functions of text (V30 §13, §33). The text or file is checked where they are called, but
 * `fileFromBase64` gives its default for text it cannot read.
 */
const FILE_TEXT_FUNCTIONS: ReadonlyMap<string, CallShape> = new Map([
  [
    "fileFromBase64",
    {
      parameter: "text",
      fallback: { required: "text that is not valid Base64", type: "any" },
      files: false,
    },
  ],
  ["fileToBase64", { parameter: "file", fallback: null, files: false }],
  ["hashText", { parameter: "text", fallback: null, files: false }],
  ["hashFile", { parameter: "file", fallback: null, files: false }],
]);

/** Problems with a call of a file or hash function of text: its shape, and text to read that can never be text. */
function fileTextProblems(
  name: string,
  shape: CallShape,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const { problems, positional } = shapedCall(name, shape, call, typeOf);
  if (problems.length > 0 || shape.fallback === null) return problems;
  const value = positional[0]!;
  return neverTextProblems(name, "reads text (string)", value, typeOf(value));
}

/** A value that can never be text, which a call that `does` something with text cannot use. */
function neverTextProblems(
  name: string,
  does: string,
  value: Expression,
  type: StaticType,
): OperationProblem[] {
  const candidates = members(forUse(type)).map(resolved);
  return candidates.length > 0 &&
    candidates.every((candidate) => isKnown(candidate) && !isScalar(candidate, "string"))
    ? [
        {
          kind: "invalidOperand",
          message: `${name}(...) ${does}, not ${describeValue(type)}.`,
          span: value.span,
        },
      ]
    : [];
}

/** A value that is or may hold one that `toJson` cannot write (V30 §13). */
function unwritableJsonProblems(value: Expression, type: StaticType): OperationProblem[] {
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
  if (unwritable === undefined) return [];
  const kind = describeValue(unwritable);
  const reason = unwritableJsonReason(SESSION_HANDLE_KINDS.has(unwritable.kind));
  return [
    {
      kind: "invalidOperand",
      message:
        resolved(type) === unwritable
          ? `toJson(...) cannot write ${kind}, which ${reason}. ${WRITABLE_JSON_FIX}`
          : `toJson(...) cannot write ${kind}, which ${reason}, and this is ${describeValue(type)}. ${WRITABLE_JSON_FIX}`,
      span: value.span,
    },
  ];
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
 * Problems with a function of numbers, such as a numeric function or `chance`: names it does not take, its number of
 * positional arguments, and arguments that are not numbers.
 */
function numberArgumentProblems(
  name: string,
  { parameters, named = [] }: NumberSignature,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
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
        message: unknownNamedArgumentMessage(
          name,
          argument.name.name,
          named,
          parameters.length > 0,
        ),
        span: argument.name.span,
      });
  }
  if (positional !== parameters.length)
    problems.push({
      kind: "argumentCount",
      message: argumentCountMessage(name, argumentsTaken(parameters), positional),
      span: call.span,
    });
  if (problems.length > 0) return problems;
  for (const [value, place] of values) {
    const type = typeOf(value);
    if (!isAssignable(NUMBER_TYPE, type))
      problems.push({
        kind: "invalidOperand",
        message: `${name}(...) needs a number${place}, not ${describeValue(forUse(type))}.${numberFix(forUse(type))}`,
        span: value.span,
      });
  }
  return problems;
}

/** How to turn text or an angle into the number a numeric function needs, or nothing for other values. */
function numberFix(type: StaticType): string {
  if (isScalar(type, "string")) return " Convert text with toNumber(...) first.";
  return isScalar(type, "angle") ? " Convert it to a number of degrees with toDeg(...) first." : "";
}

/**
 * Problems with an angle function (V30 §13): names, its number of arguments, and arguments that are not of the kind it
 * takes. A plain number where an angle is needed names the unit to write.
 */
function angleFunctionProblems(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const { parameters, takes } = ANGLE_FUNCTIONS.get(name)!;
  const problems: OperationProblem[] = [];
  const values: Expression[] = [];
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") values.push(argument.value);
    else
      problems.push({
        kind: "unknownNamedArgument",
        message: unknownNamedArgumentMessage(name, argument.name.name, []),
        span: argument.name.span,
      });
  }
  if (values.length !== parameters.length)
    problems.push({
      kind: "argumentCount",
      message: argumentCountMessage(name, argumentsTaken(parameters), values.length),
      span: call.span,
    });
  if (problems.length > 0) return problems;
  const accepted = takes === "angle" ? ANGLE_TYPE : NUMBER_TYPE;
  for (const value of values) {
    const type = forUse(typeOf(value));
    if (!isAssignable(accepted, typeOf(value)))
      problems.push({
        kind: "invalidOperand",
        message: angleArgumentMessage(
          name,
          takes,
          describeValue(type),
          isScalar(type, "integer", "number") ? "number" : isScalar(type, "string") ? "string" : "",
        ),
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
        message: unknownNamedArgumentMessage(name, named.name.name, []),
        span: named.name.span,
      },
    ];
  if (call.arguments.length < 2)
    return [
      {
        kind: "argumentCount",
        message: argumentCountMessage(name, MIN_MAX_TAKES, call.arguments.length),
        span: call.span,
      },
    ];
  let family: StaticType | undefined;
  for (const argument of call.arguments) {
    const type = typeOf(argument.value);
    if (!isKnown(forUse(type))) continue;
    // Numbers, durations, calendar durations, angles, or date and time values of one kind (V30 §35) compare with each
    // other.
    const kind = isAssignable(NUMBER_TYPE, type)
      ? NUMBER_TYPE
      : [
          DURATION_TYPE,
          CALENDAR_DURATION_TYPE,
          ANGLE_TYPE,
          DATE_TYPE,
          TIME_TYPE,
          DATETIME_TYPE,
          ABSOLUTE_DATE_TIME_TYPE,
        ].find((candidate) => isAssignable(candidate, type));
    const message =
      kind === undefined
        ? `${name}(...) needs numbers, durations, angles, or date and time values, not ${describeValue(forUse(type))}.`
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
  conversion: ValueConversion,
  value: Expression,
  type: StaticType,
): string | undefined {
  const candidates = members(forUse(type)).map(resolved);
  if (candidates.length === 0 || candidates.some((candidate) => !isKnown(candidate)))
    return undefined;
  const problems = candidates.map((candidate) =>
    candidateConversionProblem(name, conversion, value, candidate),
  );
  return problems.every((problem) => problem !== undefined) ? problems[0] : undefined;
}

function candidateConversionProblem(
  name: string,
  conversion: ValueConversion,
  value: Expression,
  type: StaticType,
): string | undefined {
  const { kinds, result } = conversion;
  if (kinds === "shown" ? type.kind === "scalar" || type.kind === "null" : isScalar(type, ...kinds))
    return undefined;
  if (isScalar(type, "string")) {
    // Text it can see converts as the runtime converts it, and does not convert with the runtime's text.
    const text = staticVisibleText(value);
    return text === undefined || conversion.textProblem(text) === undefined
      ? undefined
      : cannotConvert(name, conversion, text);
  }
  if (kinds === "shown") {
    // `.join()` combines only values that are shown as text, so a list of lists or objects needs another fix.
    if (type.kind === "list" || type.kind === "dict") {
      const unjoinable = members(type.element)
        .map(resolved)
        .find((member) => isKnown(member) && member.kind !== "scalar" && member.kind !== "null");
      if (unjoinable !== undefined)
        return `${name}(...) cannot convert ${describeValue(type)}, and ${type.kind === "list" ? ".join() cannot combine its elements" : ".values.join() cannot combine its values"}, which hold ${describeValue(unjoinable)}. Show the whole ${type.kind} with say, or select a value inside it that ${name}(...) converts.`;
    }
    if (type.kind === "list" || type.kind === "set")
      return `${name}(...) cannot convert ${describeValue(type)}. Use ${type.kind === "set" ? ".toList().join()" : ".join()"} to combine its elements as text.`;
    if (type.kind === "dict")
      return `${name}(...) cannot convert ${describeValue(type)}. Use .values.join() to combine its values as text.`;
  }
  const fix =
    result === "boolean"
      ? isScalar(type, "integer", "number")
        ? " Compare the number instead, such as value != 0."
        : ""
      : result === "number" || result === "integer"
        ? isScalar(type, "duration")
          ? " Divide a duration by a unit instead, such as value / 1 s."
          : isScalar(type, "angle")
            ? " Use toDeg(...) or toRad(...) for the size of an angle instead."
            : ""
        : zoneMethodFix(result, type, value);
  return `${name}(...) converts ${conversion.converts}, not ${describeValue(type)}.${fix}`;
}

/**
 * A local date and time and an absolute date and time convert into each other with a method, through the player's zone
 * (V30 §35).
 */
function zoneMethodFix(result: string, type: StaticType, value: Expression): string {
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

/**
 * The parts of a conversion's second form, `toDateTime(date, time)`, each of its type; a part that may be one is
 * checked at runtime.
 */
function pairProblems(
  name: string,
  pair: readonly [ScalarTypeName, ScalarTypeName],
  parts: readonly Expression[],
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const problems: OperationProblem[] = [];
  for (const [index, kind] of pair.entries()) {
    const part = parts[index]!;
    const type = forUse(typeOf(part));
    const candidates = members(type).map(resolved);
    if (
      candidates.length > 0 &&
      candidates.every((candidate) => isKnown(candidate) && !isScalar(candidate, kind))
    )
      problems.push({
        kind: "invalidOperand",
        message: `${name}(${pair.join(", ")}) needs a ${kind} ${index === 0 ? "first" : "second"}, not ${describeValue(type)}.${isScalar(type, "string") ? ` Convert the text first with ${conversionTo(kind)}(...).` : ""}`,
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
      message: argumentCountMessage(
        "remove",
        "1 argument, or none on a message or permanent button",
        call.arguments.length,
      ),
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
        message: `${name}() needs a list or a set, not ${describeValue(type)}.${members(type).some((member) => resolved(member).kind === "range") ? RANGE_LIST_FIX : ""}`,
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
        message: unknownNamedArgumentMessage(name, named.name.name, []),
        span: named.name.span,
      },
    ];
  if (call.arguments.length !== 1)
    return [
      {
        kind: "argumentCount",
        message: methodArgumentCountMessage(LIST_ONLY_METHODS.get(name)!, call.arguments.length),
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
        message: unknownNamedArgumentMessage(name, named.name.name, []),
        span: named.name.span,
      },
    ];
  if (call.arguments.length !== 1)
    return [
      {
        kind: "argumentCount",
        message: methodArgumentCountMessage(LIST_ONLY_METHODS.get(name)!, call.arguments.length),
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
  const problem = getArgumentsProblem(
    receiverType === undefined ? "either" : "list",
    call.arguments.length - named.length,
    named.map((argument) => argument.name.name),
  );
  if (problem === undefined) return [];
  return [
    {
      kind: problem.kind,
      message: problem.message,
      span:
        problem.kind === "unknownNamedArgument"
          ? named.find((argument) => argument.name.name === problem.name)!.name.span
          : call.span,
    },
  ];
}

/**
 * The kinds of speakers and of handles to what a script started or showed, which no literal can write. Every copy of
 * one names the same speaker or handle, so a change through any copy reaches it.
 */
export const HANDLE_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
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
            : isScalar(candidate, "angle")
              ? "angles"
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
    return `sort() sorts numbers, text, durations, angles, or date and time values, not ${describeValue(unsortable)}.`;
  const kinds = new Set(candidates.map(kindOf));
  return kinds.size > 1
    ? `sort() needs elements of one kind, but this list may hold ${[...kinds].join(" and ")}.`
    : undefined;
}
