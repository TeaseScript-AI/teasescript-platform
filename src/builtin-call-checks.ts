// Compile-time problems with a call of a built-in function: its argument names and count, values it cannot take,
// constant text it cannot convert, and a default it cannot give.

import type { CallExpression, Expression, ScalarTypeName } from "./ast.js";
import {
  conversionTo,
  CONVERSIONS,
  defaultDescription,
  FILE_TEXT_FUNCTIONS,
  isConversion,
  unwritableJsonMessage,
  type CallShape,
  type Conversion,
  type ValueConversion,
  filesOptionMessage,
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
import { parsePublicKey } from "./public-keys.js";
import { messageText } from "./runtime/values/text-length.js";
import { cannotConvert } from "./runtime/values/value-types.js";
import { staticVisibleText } from "./static-evaluation.js";
import {
  ANGLE_TYPE,
  containsType,
  isAssignable,
  isKnown,
  isScalar,
  members,
  NULL_TYPE,
  NUMBER_TYPE,
  resolved,
  union,
  valueKindOfType,
  isShown,
  type StaticType,
} from "./static-types.js";
import { describeKind, describeValue } from "./static-types/type-names.js";
import { lockOptionMessage, malformedPublicKeyMessage, type LockOption } from "./lock-rules.js";
import { VALUE_KINDS, type ValueKind } from "./value-kinds.js";
import {
  argumentCountMessage,
  argumentsTaken,
  callShapeNames,
  callShapeProblem,
  FIXED_PARAMETERS,
  missingDefaultMessage,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";
import {
  isListFunction,
  LIST_FUNCTION_CONTRACTS,
  minMaxValuesProblem,
  takesValues,
} from "./list-function-rules.js";
import {
  type Known,
  type OperationProblem,
  expressionLabel,
  forUse,
} from "./operation-check-support.js";

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
  const optionProblem = (option: LockOption, fits: (type: StaticType) => boolean): boolean => {
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
      // A public key list, which the option takes, names the element it holds, as the runtime finds it.
      const list =
        option === "publicKey" && candidates.every((candidate) => candidate.kind === "list");
      const element = list ? candidates.find((candidate) => candidate.kind === "list") : undefined;
      problems.push({
        kind: "invalidOperand",
        message: lockOptionMessage(
          name,
          option,
          !decrypts && option !== "key",
          describeKind(element?.kind === "list" ? element.element : forUse(type)),
          element !== undefined,
        ),
        span: value.span,
      });
      return true;
    }
    return false;
  };
  optionProblem("password", (type) => isScalar(type, "string"));
  if (decrypts) {
    optionProblem("key", (type) => isScalar(type, "string"));
    return problems;
  }
  optionProblem("timeLock", (type) => isScalar(type, "absoluteDateTime"));
  // A public key, or a list of them, each an age recipient or an OpenSSH Ed25519 key; the written ones are read here.
  const keyText = (candidate: StaticType) =>
    isScalar(candidate, "string") ||
    (candidate.kind === "list" &&
      members(candidate.element)
        .map(resolved)
        .every((element) => !isKnown(element) || isScalar(element, "string")));
  const publicKey = named.get("publicKey");
  if (publicKey !== undefined && !optionProblem("publicKey", keyText)) {
    let written = publicKey;
    while (written.kind === "parenthesizedExpression") written = written.expression;
    const literals = written.kind === "listLiteral" ? written.elements : [written];
    for (const element of literals) {
      let literal = element;
      while (literal.kind === "parenthesizedExpression") literal = literal.expression;
      const text = literal.kind === "stringLiteral" ? staticVisibleText(literal) : undefined;
      if (text === undefined || parsePublicKey(text) !== null) continue;
      problems.push({
        kind: "invalidOperand",
        message: malformedPublicKeyMessage(name, JSON.stringify(messageText(text))),
        span: element.span,
      });
      break;
    }
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
        message: filesOptionMessage(name, describeKind(forUse(type))),
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
  return [
    {
      kind: "invalidOperand",
      // A value that may be one is named as one; one that holds one, by what holds it.
      message: unwritableJsonMessage(
        unwritableKind,
        members(forUse(type)).some((member) => resolved(member) === unwritable)
          ? undefined
          : (valueKindOfType(forUse(type)) ?? null),
      ),
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
        describeKind(shown),
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

/** The type of each kind of value that `min` and `max` compare, in the order of their contract. */
const MIN_MAX_TYPES: readonly StaticType[] = LIST_FUNCTION_CONTRACTS.min.values.map(
  (kind): StaticType => (kind === "number" ? NUMBER_TYPE : { kind: "scalar", name: kind }),
);

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
    // Values of one kind that `min` and `max` compare (`LIST_FUNCTION_CONTRACTS`) compare with each other.
    const kind = MIN_MAX_TYPES.find((candidate) => isAssignable(candidate, type));
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
  if (kinds === "shown" ? isShown(type) : isScalar(type, ...kinds)) return undefined;
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
        .find((member) => isKnown(member) && !isShown(member));
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
