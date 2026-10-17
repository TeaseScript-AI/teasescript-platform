import type { CallExpression, Expression, Identifier, ScalarTypeName } from "./ast.js";
import {
  conversionTo,
  CONVERSIONS,
  defaultDescription,
  FILE_TEXT_FUNCTIONS,
  isConversion,
  WRITABLE_JSON_FIX,
  type CallShape,
  type Conversion,
  type ValueConversion,
} from "./conversions.js";
import type { ConversionName } from "./language-facts.js";
import { LOCK_CALLS } from "./capture-call.js";
import {
  isNumericFunction,
  numberArgumentMessage,
  NUMERIC_CONTRACTS,
  type NumberSignature,
} from "./numeric-functions.js";
import { isRandomFunction, RANDOM_CONTRACTS, type RandomFunction } from "./random-functions.js";
import {
  isTemporalMethod,
  TEMPORAL_METHODS,
  temporalArgumentsMessage,
} from "./temporal-builtins.js";
import { misspelledPropertyHint } from "./object-properties.js";
import { parsePublicKey } from "./public-keys.js";
import { cannotConvert } from "./runtime/value-types.js";
import type { SourceSpan } from "./source.js";
import { staticVisibleText, type KnownValue } from "./static-evaluation.js";
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
  valueKindOfType,
  type StaticType,
} from "./static-types.js";
import { unwritableJsonReason, VALUE_KINDS, type ValueKind } from "./value-kinds.js";
import {
  argumentCountMessage,
  argumentShapeProblem,
  argumentsTaken,
  callShapeNames,
  callShapeProblem,
  FIXED_PARAMETERS,
  getArgumentsProblem,
  missingDefaultMessage,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";
import { DICT_METHODS, dictMethod } from "./dict-operations.js";
import { handleMethod, handleMethodNames, kindsWithMethod } from "./handle-members.js";
import { isListFunction, minMaxValuesProblem, takesValues } from "./list-function-rules.js";
import {
  countProblem,
  LIST_METHODS,
  listArgumentMessage,
  listMethod,
  missingListMethodMessage,
  type ListKind,
  type ListMethod,
  type ListParameterKind,
} from "./list-methods.js";
import {
  argumentFix,
  argumentTypeMessage,
  isTextMember,
  isTextMethod,
  LIST_JOIN,
  methodArgumentCountMessage,
  regexMemberMessage,
  stringLength,
  takesRegex,
  takesText,
  TEXT_METHODS,
  unknownTextMemberMessage,
  type ArgumentKind,
  type DomainValue,
  type MethodParameters,
  type TextDomain,
  type TextParameter,
  type TextSignature,
} from "./text-operations.js";
import { isRegex } from "./runtime/value-predicates.js";

/** The value that every run gives an expression, when the compiler knows it (see `KnownValues`). */
type Known = (expression: Expression) => KnownValue | undefined;

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
  known: Known,
): OperationProblem[] {
  const type = forUse(receiverType);
  const name = property.name;
  const problem = (message: string): OperationProblem[] => [
    { kind: "invalidOperand", message, span: property.span },
  ];
  if (type.kind === "scalar" && type.name === "string") {
    if (name === "length") return call === null ? [] : problem(LENGTH_PROPERTY);
    if (!isTextMethod(name))
      return problem(unknownTextMemberMessage(name, call === null ? "property" : "method"));
    const method = TEXT_METHODS[name];
    if (call === null)
      return problem(
        `'${name}' is a method. Write ${name}(${method.parameters.length === 0 ? "" : "..."}) with parentheses.`,
      );
    const text = known(receiver);
    return argumentProblems(
      method,
      call,
      typeOf,
      known,
      typeof text === "string" ? text : undefined,
    );
  }
  if (type.kind === "list" && name === "join") {
    if (call === null) return problem("'join' is a method. Write .join() with parentheses.");
    const problems = argumentProblems(LIST_JOIN, call, typeOf, known, undefined);
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
    // receiver is not known.
    if (call === null) return [];
    // A name that no value has as a method fails on every receiver; every value with `length` has it as a property.
    if (!METHOD_NAMES.has(name))
      return problem(
        name === "length"
          ? LENGTH_PROPERTY
          : `No value has a method '${name}'.${misspelledPropertyHint(name, [...METHOD_NAMES, "length"]) || " Check the name."}`,
      );
    // Every receiver with a method of lists and sets takes as many arguments, but a message or a permanent button may
    // take `remove()` without any. Text takes text or a regex where a list takes any value, and only lists and sets take
    // a count, a list, or a collection, so those arguments are checked on any receiver too.
    const list = listMethod(name);
    if (list !== undefined && name !== "join")
      return listArgumentProblems(list, undefined, property, call, typeOf, known, true);
    const member = name === "join" ? LIST_JOIN : isTextMethod(name) ? TEXT_METHODS[name] : null;
    if (member !== null) return argumentProblems(member, call, typeOf, known, undefined);
    // Only date and time values have their methods, which take no arguments.
    if (isTemporalMethod(name))
      return call.arguments.length === 0
        ? []
        : [
            {
              kind: "argumentCount",
              message: temporalArgumentsMessage(name, call.arguments.length),
              span: property.span,
            },
          ];
    // Only handles have the other methods, and every handle with one takes the same.
    return handleMethodProblems(name, call);
  }
  if (type.kind !== "scalar" && type.kind !== "null" && type.kind !== "range") return [];
  if (isScalar(type, "regex"))
    return problem(regexMemberMessage(name, call === null ? "property" : "method"));
  const fix =
    type.kind === "scalar" && isTextMember(name)
      ? " Convert it to text first with toString(...)."
      : "";
  return problem(
    `${capitalized(describeValue(type))} has no ${call === null ? "property" : "method"} '${name}'.${fix}`,
  );
}

/**
 * Argument names and the number of arguments of a method that only handles have, such as `pause()`, as the first handle
 * with it takes them (see `HandleMethod`).
 */
function handleMethodProblems(name: string, call: CallExpression): OperationProblem[] {
  const kind = kindsWithMethod(name)[0];
  if (kind === undefined) return [];
  const named = call.arguments.flatMap((argument) =>
    argument.kind === "namedArgument" ? [argument.name] : [],
  );
  const problem = argumentShapeProblem(
    name,
    handleMethod(kind, name)!.shape,
    call.arguments.length - named.length,
    named.map((identifier) => identifier.name),
  );
  if (problem === undefined) return [];
  return [
    {
      kind: problem.kind,
      message: problem.message,
      span:
        problem.kind === "unknownNamedArgument"
          ? named.find((identifier) => identifier.name === problem.name)!.span
          : call.span,
    },
  ];
}

/**
 * Argument names, which text operations, `join`, and the methods of lists and sets but `get` never take, and the number
 * of arguments.
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

/**
 * The problems with the arguments of a method of text or `join` that the compiler can see: their shape, each argument's
 * type, and each domain whose values it knows, with the runtime's text (see `TextDomain`), where the arguments the
 * domain reads have no other problem. A domain is checked after the last argument it reads, and reported there.
 * `receiverText` is the text the method is called on, when it is known.
 */
function argumentProblems(
  member: TextSignature,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
  receiverText: string | undefined,
): OperationProblem[] {
  const shape = shapeProblems(member, call);
  if (shape.length > 0) return shape;
  const parameters = member.parameters;
  const problems: OperationProblem[] = [];
  // The known value of each argument, `undefined` where it is not known, and `null` after a problem with it.
  const values: (DomainValue | undefined | null)[] = [];
  let length: number | undefined;
  const check = (domain: TextDomain): void => {
    const known: DomainValue[] = [];
    for (const read of domain.reads) {
      const value =
        read !== "length"
          ? values[read]
          : receiverText === undefined
            ? undefined
            : (length ??= stringLength(receiverText));
      if (value === undefined || value === null) return;
      known.push(value);
    }
    const message = domain.problem(known, member);
    if (message === undefined) return;
    for (const read of domain.reads) if (read !== "length") values[read] = null;
    problems.push({
      kind: "invalidOperand",
      message,
      span: call.arguments[lastArgument(domain)]!.value.span,
    });
  };
  for (const [index, argument] of call.arguments.entries()) {
    const parameter = parameters[index]!;
    const value = argument.value;
    const type = typeOf(value);
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
      values[index] = null;
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
    values[index] = knownArgument(parameter, known(value));
    for (const domain of member.domains) if (lastArgument(domain) === index) check(domain);
  }
  return problems;
}

/** The position of the last argument a domain reads. */
function lastArgument(domain: TextDomain): number {
  return Math.max(...domain.reads.map((read) => (read === "length" ? -1 : read)));
}

/** The known `value` of an argument of `parameter` as its domains read it: text, a whole number, or a regex. */
function knownArgument(
  parameter: TextParameter,
  value: KnownValue | undefined,
): DomainValue | undefined {
  if (!takesText(parameter) && !takesRegex(parameter))
    return typeof value === "number" ? value : undefined;
  return (takesText(parameter) && typeof value === "string") ||
    (takesRegex(parameter) && value !== undefined && isRegex(value))
    ? value
    : undefined;
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
  known: Known,
): OperationProblem[] {
  if (isListFunction(name) && takesValues(name)) return minMaxProblems(name, call, typeOf);
  if (isNumericFunction(name))
    return numberArgumentProblems(name, NUMERIC_CONTRACTS[name], call, typeOf);
  if (isRandomFunction(name)) {
    const random: RandomFunction = RANDOM_CONTRACTS[name];
    if (random.takes === "numbers") return numberArgumentProblems(name, random, call, typeOf);
    return random.takes === "range" ? fixedShapeProblems(name, random.parameters, call) : [];
  }
  if (isConversion(name)) return conversionProblems(name, CONVERSIONS[name], call, typeOf, known);
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
 * The arguments of a call of `shape` (see `CallShape`), and its problems: each named argument it does not take, a
 * `files:` that is not true or false, and then the number of positional arguments or a required `default:` that is
 * missing, with the texts of `callShapeProblem`.
 */
function shapedCall(
  name: string,
  shape: CallShape,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): ShapedCall {
  const named = callShapeNames(shape);
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
  const problem = callShapeProblem(name, shape, positional.length, [], fallback !== undefined);
  if (problem !== undefined)
    problems.push({ kind: "argumentCount", message: problem.message, span: call.span });
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
  known: Known,
): OperationProblem[] {
  const { problems, positional, fallback } = shapedCall(name, conversion, call, typeOf);
  if (problems.length > 0) return problems;
  const value = positional[0]!;
  const type = typeOf(value);
  if (conversion.takes === "value") {
    if (conversion.pair !== undefined && positional.length === 2)
      problems.push(...pairProblems(name, conversion.pair, positional, typeOf));
    else {
      // Without a default, a run fails at any known text that does not convert. With one, the run gives the default,
      // and only text written as a constant is an error (V30 §13).
      const computed = known(value);
      const text =
        fallback !== undefined
          ? staticVisibleText(value)
          : typeof computed === "string"
            ? computed
            : undefined;
      const message = conversionProblem(name, conversion, value, type, text);
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
 * Problems with a call of a file or hash function of text (`FILE_TEXT_FUNCTIONS`): its shape, and text to read that can
 * never be text. The text or file is checked where they are called, but `fileFromBase64` gives its default for text it
 * cannot read.
 */
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
  let unwritableKind: ValueKind | undefined;
  containsType(type, (part) => {
    const kind = valueKindOfType(part);
    if (kind === undefined || VALUE_KINDS[kind].json !== null) return false;
    unwritable = part;
    unwritableKind = kind;
    return true;
  });
  if (unwritable === undefined || unwritableKind === undefined) return [];
  const kind = describeValue(unwritable);
  const reason = unwritableJsonReason(unwritableKind);
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

/**
 * Problems with a function of numbers or angles, such as a numeric or angle function or `chance`: names it does not
 * take, its number of positional arguments, and arguments that are not of the kind it takes.
 */
function numberArgumentProblems(
  name: string,
  signature: NumberSignature & { readonly result: unknown },
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
): OperationProblem[] {
  const { parameters, named = [] } = signature;
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
  const accepted = signature.takes === "angles" ? ANGLE_TYPE : NUMBER_TYPE;
  for (const [value, place] of values) {
    const type = typeOf(value);
    if (isAssignable(accepted, type)) continue;
    const shown = forUse(type);
    problems.push({
      kind: "invalidOperand",
      message: numberArgumentMessage(
        name,
        signature,
        describeValue(shown),
        isScalar(shown, "integer", "number")
          ? "number"
          : isScalar(shown, "string")
            ? "string"
            : isScalar(shown, "angle")
              ? "angle"
              : "other",
        place,
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
  const named = call.arguments.filter((argument) => argument.kind === "namedArgument");
  const problem = minMaxValuesProblem(
    name,
    call.arguments.length - named.length,
    named.map((argument) => argument.name.name),
  );
  if (problem !== undefined)
    return [
      {
        kind: problem.kind,
        message: problem.message,
        span: problem.kind === "unknownNamedArgument" ? named[0]!.name.span : call.span,
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
  text: string | undefined,
): string | undefined {
  const candidates = members(forUse(type)).map(resolved);
  if (candidates.length === 0 || candidates.some((candidate) => !isKnown(candidate)))
    return undefined;
  const problems = candidates.map((candidate) =>
    candidateConversionProblem(name, conversion, value, candidate, text),
  );
  return problems.every((problem) => problem !== undefined) ? problems[0] : undefined;
}

function candidateConversionProblem(
  name: string,
  conversion: ValueConversion,
  value: Expression,
  type: StaticType,
  text: string | undefined,
): string | undefined {
  const { kinds, result } = conversion;
  if (kinds === "shown" ? type.kind === "scalar" || type.kind === "null" : isScalar(type, ...kinds))
    return undefined;
  if (isScalar(type, "string")) {
    // Text it can see converts as the runtime converts it, and does not convert with the runtime's text.
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

/**
 * The name of every method a value has: those of text (V30 §8), of lists and sets (V30 §16), of dicts (V30 §40), of
 * handles (see `HANDLE_MEMBERS`), and of date and time values (V30 §35). Other values, such as numbers, objects, and
 * speakers, have none.
 */
const METHOD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(TEXT_METHODS),
  ...Object.keys(LIST_METHODS),
  ...Object.keys(DICT_METHODS),
  ...handleMethodNames(),
  ...Object.keys(TEMPORAL_METHODS),
]);

/**
 * The method `name` as every receiver with it takes its arguments, all of them without a name: a method of lists and
 * sets but `get` and `join`. A dict (see `DICT_METHODS`), a range, text, a message, and a permanent button take as many
 * with the methods they share with lists, but a message and a permanent button take `remove()`.
 */
function positionalMethod(name: string): MethodParameters | undefined {
  const method = listMethod(name);
  return method !== undefined &&
    !("named" in method && method.named !== undefined) &&
    method.parameters!.every((parameter) => parameter.optional !== true)
    ? method
    : undefined;
}

/**
 * Argument names and the number of arguments of a method that takes them without names (see `positionalMethod`), which
 * every receiver with the method rejects. Where the receiver may be a message or a permanent button (`removable`),
 * `remove()` may have no argument.
 */
export function positionalMethodProblems(
  name: string,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const method = positionalMethod(name);
  return method === undefined ? [] : methodShapeProblems(method, call, removable);
}

/**
 * Argument names and the number of arguments of a dict's method `name` (see `DICT_METHODS`) but `get`, which takes them
 * without names, as `positionalMethodProblems` checks those of lists, for a dict in a union.
 */
export function dictMethodProblems(
  name: string,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const method = dictMethod(name);
  return method === undefined || method.named !== undefined
    ? []
    : methodShapeProblems(method, call, removable);
}

/** Argument names and the number of arguments of `method`, which may be `remove()` where the receiver is `removable`. */
function methodShapeProblems(
  method: MethodParameters,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const problems = shapeProblems(method, call);
  if (!removable || method.name !== "remove" || problems[0]?.kind !== "argumentCount")
    return problems;
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
 * Compile-time problems with a call of a method of lists and sets (see `LIST_METHODS`) on a list or set of a known
 * type: a method its kind does not have, then the problems of `listArgumentProblems`.
 */
export function collectionMethodProblems(
  name: string,
  receiverType: StaticType & { readonly kind: ListKind },
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
  removable = false,
): OperationProblem[] {
  const method = listMethod(name);
  if (method === undefined || !method.receivers.includes(receiverType.kind))
    return [
      {
        kind: "invalidOperand",
        message: missingListMethodMessage(receiverType.kind, name),
        span: property.span,
      },
    ];
  return listArgumentProblems(method, receiverType, property, call, typeOf, known, removable);
}

/**
 * Compile-time problems with the arguments of a method of lists and sets, on a list or set of `receiverType`, or on a
 * receiver of any type (`undefined`): their names and number (`get` takes a `default:`, as a dict's does), a count that is
 * not a whole number of at least 0, a list or collection argument that is another value, and on a list elements `sort`
 * cannot order. A list's index is checked as for `list[index]`, and the elements that `add` and `addAll` store as the
 * list's other elements, by the type check.
 */
function listArgumentProblems(
  method: ListMethod,
  receiverType: (StaticType & { readonly kind: ListKind }) | undefined,
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
  removable: boolean,
): OperationProblem[] {
  if (method.named !== undefined) return getProblems(receiverType, call);
  const shape = methodShapeProblems(method, call, removable);
  if (shape.length > 0) return shape;
  // The shape fits, so each argument has its parameter.
  const problems = call.arguments.flatMap((argument, position) =>
    argumentKindProblems(method, method.parameters[position]!.kind, argument.value, typeOf, known),
  );
  if (method.name !== "sort" || receiverType === undefined) return problems;
  const message = sortProblem(receiverType.element);
  return message === undefined
    ? problems
    : [{ kind: "invalidOperand", message, span: property.span }];
}

/** Problems with one argument of a list method for a parameter of `kind`: a count, a list, or a collection. */
function argumentKindProblems(
  method: ListMethod,
  kind: ListParameterKind,
  argument: Expression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
): OperationProblem[] {
  const problem = (message: string): OperationProblem[] => [
    { kind: "invalidOperand", message, span: argument.span },
  ];
  if (kind === "count") {
    const type = typeOf(argument);
    const nullable = nullCheckProblem(argument, type, INTEGER_TYPE);
    if (nullable !== undefined) return [nullable];
    // The first kind the count may be that is not a whole number, such as the number in `number?`.
    const other = members(type).find((member) => !isAssignable(INTEGER_TYPE, member));
    if (other !== undefined)
      return problem(listArgumentMessage(method.name, "count", describeValue(other), "other"));
    const count = known(argument);
    const message = typeof count === "number" ? countProblem(method.name, count) : undefined;
    return message === undefined ? [] : problem(message);
  }
  if (kind !== "list" && kind !== "collection") return [];
  // Every member of a union argument must be a list, or a list or a set (ADR 0021 rule 3.5).
  const type = forUse(typeOf(argument));
  const kinds = members(type).map((member) => resolved(member));
  const fits = kinds.every(
    (member) =>
      !isKnown(member) ||
      member.kind === "list" ||
      (kind === "collection" && member.kind === "set"),
  );
  if (fits) return [];
  const other =
    kind === "list" && kinds.some((member) => member.kind === "set")
      ? "set"
      : kinds.some((member) => member.kind === "range")
        ? "range"
        : "other";
  return problem(listArgumentMessage(method.name, kind, describeValue(type), other));
}

/**
 * Problems with a list's `get(index, default: value)`: one index and a `default:`, as a dict's `get` takes a key and a
 * `default:` (#844), also where the receiver may be either (`receiverType` is `undefined`). The index is checked as for
 * `list[index]`.
 */
function getProblems(
  receiverType: (StaticType & { readonly kind: ListKind }) | undefined,
  call: CallExpression,
): OperationProblem[] {
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
