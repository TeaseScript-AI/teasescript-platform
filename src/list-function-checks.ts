import { argumentCountMessage, unknownNamedArgumentMessage } from "./argument-rules.js";
import { angleStatisticMessage } from "./angle.js";
import type { CallExpression, Expression } from "./ast.js";
import {
  DICT_WEIGHTS_MESSAGE,
  LIST_FUNCTION_SHAPES,
  LIST_WEIGHT_MESSAGE,
  WEIGHTED_SOURCE_MESSAGE,
} from "./list-function-rules.js";
import { percentageFailure } from "./numeric-functions.js";
import { RANGE_LIST_FIX, type OperationProblem } from "./operation-checks.js";
import { RANDOM_CONTRACTS } from "./random-functions.js";
import { staticChoiceValue, staticVisibleText } from "./static-evaluation.js";
import {
  copyType,
  describeValue,
  DURATION_TYPE,
  INTEGER_TYPE,
  isAssignable,
  isKnown,
  isScalar,
  members,
  nonNullType,
  NUMBER_TYPE,
  PropertyTable,
  resolved,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "./static-types.js";

/** The built-ins of lists (V30 §16) whose arguments and result these checks know; `min` and `max` take one list too. */
export const LIST_FUNCTIONS: ReadonlySet<string> = new Set([
  "sum",
  "average",
  "median",
  "percentile",
  "stddev",
  "linearRegression",
  "predict",
]);

/** The problems with a call of a list function, the properties it reads by name, and its result type. */
export interface ListFunctionCheck {
  readonly problems: readonly OperationProblem[];
  readonly reads: readonly ListPropertyRead[];
  readonly type: StaticType;
}

/**
 * A property that a list function reads from each element, named by text such as `by: "count"`. Whether the elements
 * can have it is decided at the end of the check, from code anywhere in the project (#845).
 */
export interface ListPropertyRead {
  /** The text that names the property. */
  readonly at: Expression;
  readonly name: string;
  /** The type of the elements. */
  readonly objects: StaticType;
  /** The error when no element can have the property. */
  readonly message: string;
}

/** The kind of the values a list function reads, when the compiler knows it. */
type ValueKind =
  | "integer"
  | "number"
  | "duration"
  | "calendarDuration"
  | "angle"
  | "date"
  | "time"
  | "datetime"
  | "absoluteDateTime";

const TEMPORAL_KINDS: readonly ValueKind[] = ["date", "time", "datetime", "absoluteDateTime"];

interface Context {
  readonly name: string;
  readonly call: CallExpression;
  readonly typeOf: (expression: Expression) => StaticType;
  readonly problems: OperationProblem[];
  readonly reads: ListPropertyRead[];
}

/** A number the compiler can see, such as a constant percentage or weight, or `undefined`. */
type Known = (expression: Expression) => number | undefined;

/** Checks a call of a list function, or of `min` or `max` with one list, and gives its result type. */
export function listFunctionCheck(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
): ListFunctionCheck {
  const context: Context = { name, call, typeOf, problems: [], reads: [] };
  const type = listFunctionType(context, known);
  return { problems: context.problems, reads: context.reads, type };
}

/**
 * Checks a call of `randomWeighted` (see `RANDOM_CONTRACTS`), which reads its weights as a list function reads values,
 * and gives its result type.
 */
export function weightedChoiceCheck(
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
): ListFunctionCheck {
  const context: Context = { name: "randomWeighted", call, typeOf, problems: [], reads: [] };
  const type = weightedType(context, known);
  return { problems: context.problems, reads: context.reads, type };
}

function listFunctionType(context: Context, known: Known): StaticType {
  const { name, call } = context;
  switch (name) {
    case "linearRegression": {
      if (!shape(context)) return UNKNOWN_TYPE;
      const list = positionalArguments(call)[0]!;
      const y = named(call, "y");
      const x = named(call, "x");
      if (x !== undefined && y === undefined) {
        problem(context, `${name}(...) needs y: with x:, the property that holds the values.`, x);
        return UNKNOWN_TYPE;
      }
      const ys = valueKind(
        context,
        valuesType(context, list, y, "y"),
        ["number", "duration"],
        list,
      );
      const xs =
        x === undefined
          ? "integer"
          : valueKind(
              context,
              valuesType(context, list, x, "x"),
              ["number", "date", "datetime", "absoluteDateTime"],
              x,
            );
      const amount =
        ys === undefined ? UNKNOWN_TYPE : ys === "duration" ? DURATION_TYPE : NUMBER_TYPE;
      return {
        kind: "object",
        properties: new PropertyTable([
          ["slope", amount],
          ["intercept", amount],
          ["r2", NUMBER_TYPE],
          ["start", typeOfKind(xs)],
        ]),
      };
    }
    case "predict":
      return predictType(context);
    default: {
      // `sum`, `average`, `median`, `percentile`, `stddev`, and `min` or `max` of one list.
      const percentile = name === "percentile";
      if (!shape(context)) return UNKNOWN_TYPE;
      if (percentile) {
        const share = positionalArguments(call)[1]!;
        const value = known(share);
        // A percentage that may be null has been reported already; its other members are checked here.
        if (!isAssignable(NUMBER_TYPE, forUse(context.typeOf(share))))
          problem(
            context,
            `${name}(...) needs a number as its percentage, not ${describeValue(forUse(context.typeOf(share)))}.`,
            share,
          );
        else {
          const failure = value === undefined ? undefined : percentageFailure(name, value);
          if (failure !== undefined) problem(context, failure, share);
        }
      }
      const list = positionalArguments(call)[0]!;
      const minMax = name === "min" || name === "max";
      const kind = valueKind(
        context,
        valuesType(context, list, named(call, "by"), "by"),
        minMax
          ? ["number", "duration", "calendarDuration", "angle", ...TEMPORAL_KINDS]
          : name === "sum"
            ? ["number", "duration", "angle"]
            : ["number", "duration"],
        list,
      );
      if (kind === "integer" && name !== "sum" && !minMax) return NUMBER_TYPE;
      return typeOfKind(kind);
    }
  }
}

/** Reports names and a number of positional arguments the function does not take; `true` when there are none. */
function shape(context: Context): boolean {
  const { name, call } = context;
  const { count: positional, names, takes } = LIST_FUNCTION_SHAPES.get(name)!;
  const before = context.problems.length;
  for (const argument of call.arguments)
    if (argument.kind === "namedArgument" && !names.includes(argument.name.name))
      context.problems.push({
        kind: "unknownNamedArgument",
        message: unknownNamedArgumentMessage(name, argument.name.name, names),
        span: argument.name.span,
      });
  const count = call.arguments.filter((argument) => argument.kind === "positionalArgument").length;
  if (count !== positional)
    context.problems.push({
      kind: "argumentCount",
      message: argumentCountMessage(name, takes, count),
      span: call.span,
    });
  return context.problems.length === before;
}

function positionalArguments(call: CallExpression): Expression[] {
  return call.arguments.flatMap((argument) =>
    argument.kind === "positionalArgument" ? [argument.value] : [],
  );
}

function named(call: CallExpression, name: string): Expression | undefined {
  const found = call.arguments.find(
    (argument) => argument.kind === "namedArgument" && argument.name.name === name,
  );
  return found?.value;
}

function problem(context: Context, message: string, at: Expression): void {
  context.problems.push({ kind: "invalidOperand", message, span: at.span });
}

/**
 * The type of the values a list function reads from `list`: its element type, or with `property` the type of that
 * property of each element, which must be objects. Unknown when the compiler cannot tell.
 */
function valuesType(
  context: Context,
  list: Expression,
  property: Expression | undefined,
  option: string,
): StaticType {
  const { name, typeOf } = context;
  // The property name is checked whatever the compiler knows about the list.
  let key: string | undefined;
  if (property !== undefined) {
    const propertyType = typeOf(property);
    if (!isAssignable(STRING_TYPE, forUse(propertyType)))
      problem(
        context,
        `${name}(...) needs the name of a property as its ${option}:, not ${describeValue(forUse(propertyType))}.`,
        property,
      );
    else key = staticVisibleText(property);
  }
  const type = forUse(typeOf(list));
  const lists = members(type).map(resolved);
  const other = lists.find((member) => isKnown(member) && member.kind !== "list");
  if (other !== undefined) {
    problem(
      context,
      `${name}(...) needs a list, not ${describeValue(other)}.${other.kind === "range" ? RANGE_LIST_FIX : ""}`,
      list,
    );
    return UNKNOWN_TYPE;
  }
  const element = lists.every(isKnown)
    ? union(lists.map((member) => (member.kind === "list" ? member.element : UNKNOWN_TYPE)))
    : UNKNOWN_TYPE;
  if (property === undefined) return element;
  // Every element the compiler knows must be an object, also when the property's type stays unknown.
  const parts = members(element).map(resolved);
  const notObject = parts.find((member) => isKnown(member) && member.kind !== "object");
  if (notObject !== undefined) {
    problem(
      context,
      `${name}(...) needs a list of objects for ${option}:, not a list that holds ${describeValue(notObject)}.`,
      list,
    );
    return UNKNOWN_TYPE;
  }
  if (key === undefined) return UNKNOWN_TYPE;
  // Code checked later may still give the elements the property, so whether they can have it is decided at the end.
  context.reads.push({
    at: property,
    name: key,
    objects: element,
    message: `${name}(...): the objects in this list have no property '${key}'.`,
  });
  const found: StaticType[] = [];
  for (const member of parts) {
    const value = member.kind === "object" ? member.properties?.get(key) : undefined;
    if (value === undefined) return UNKNOWN_TYPE;
    found.push(value);
  }
  return found.length === 0 ? UNKNOWN_TYPE : union(found);
}

/**
 * The kind of values of `type`, one of `allowed` (where `number` also allows `integer`), or `undefined` when the
 * compiler cannot tell or has reported a problem. A value that may be null is a problem: the function reads every value.
 */
function valueKind(
  context: Context,
  type: StaticType,
  allowed: readonly ValueKind[],
  at: Expression,
): ValueKind | undefined {
  const parts = members(type).map(resolved);
  if (parts.length === 0 || !parts.every(isKnown)) return undefined;
  const kinds = new Set<ValueKind>();
  for (const part of parts) {
    const kind = (
      ["integer", "number", "duration", "calendarDuration", "angle", ...TEMPORAL_KINDS] as const
    ).find((one) => isScalar(part, one));
    if (kind === undefined || !allowed.includes(kind === "integer" ? "number" : kind)) {
      // An angle wraps around at 360°, so only `sum`, `min`, and `max` take angles.
      problem(
        context,
        kind === "angle"
          ? angleStatisticMessage(context.name)
          : `${context.name}(...) needs ${describeKinds(allowed)}, not ${describeValue(part)}.`,
        at,
      );
      return undefined;
    }
    kinds.add(kind);
  }
  if (kinds.size === 1) return [...kinds][0]!;
  if (kinds.size === 2 && kinds.has("integer") && kinds.has("number")) return "number";
  problem(context, `${context.name}(...) needs values of one kind: ${describeKinds(allowed)}.`, at);
  return undefined;
}

function describeKinds(kinds: readonly ValueKind[]): string {
  const words = kinds.map((kind) =>
    kind === "number"
      ? "numbers"
      : kind === "duration"
        ? "durations"
        : kind === "calendarDuration"
          ? "calendar durations"
          : kind === "datetime"
            ? "datetimes"
            : kind === "absoluteDateTime"
              ? "absolute dates and times"
              : `${kind}s`,
  );
  return words.length === 1
    ? words[0]!
    : `${words.slice(0, -1).join(", ")}${words.length > 2 ? "," : ""} or ${words.at(-1)!}`;
}

function typeOfKind(kind: ValueKind | undefined): StaticType {
  if (kind === undefined) return UNKNOWN_TYPE;
  if (kind === "integer") return INTEGER_TYPE;
  if (kind === "number") return NUMBER_TYPE;
  return { kind: "scalar", name: kind };
}

/** `predict(line, x)`: a number or duration, as the line's intercept, at an x of the kind of the line's start. */
function predictType(context: Context): StaticType {
  const { name, call, typeOf } = context;
  if (!shape(context)) return UNKNOWN_TYPE;
  const line = call.arguments[0]!.value;
  const x = call.arguments[1]!.value;
  // Whatever the line, each kind x may be is a number or a date and time value that is measured in days.
  const other = members(forUse(typeOf(x)))
    .map(resolved)
    .find(
      (member) =>
        isKnown(member) &&
        !(["integer", "number", "date", "datetime", "absoluteDateTime"] as const).some((kind) =>
          isScalar(member, kind),
        ),
    );
  if (other !== undefined) {
    problem(
      context,
      isScalar(other, "angle")
        ? angleStatisticMessage(name)
        : `${name}(...) needs a number, date, datetime, or absolute date and time as its x, not ${describeValue(other)}.`,
      x,
    );
    return UNKNOWN_TYPE;
  }
  const type = forUse(typeOf(line));
  if (!isKnown(type)) return UNKNOWN_TYPE;
  const object = resolved(type);
  const property = (key: string): StaticType | undefined =>
    object.kind === "object" ? (object.properties?.get(key) ?? undefined) : undefined;
  const intercept = property("intercept");
  const start = property("start");
  const fields = [property("slope"), intercept, start];
  if (
    fields.some((field) => field !== undefined && members(field).some((one) => one.kind === "null"))
  ) {
    problem(
      context,
      `${name}(...) needs a line from linearRegression(...), whose slope, intercept, and start are never null.`,
      line,
    );
    return UNKNOWN_TYPE;
  }
  if (
    object.kind !== "object" ||
    (object.properties !== null &&
      (intercept === undefined || property("slope") === undefined || start === undefined))
  ) {
    problem(
      context,
      `${name}(...) needs a line from linearRegression(...), with slope, intercept, and start, not ${describeValue(type)}.`,
      line,
    );
    return UNKNOWN_TYPE;
  }
  const startKind = start === undefined ? undefined : knownKind(start);
  const xType = forUse(typeOf(x));
  if (startKind !== undefined && isKnown(xType)) {
    const fits =
      startKind === "integer" || startKind === "number"
        ? isAssignable(NUMBER_TYPE, xType)
        : isAssignable({ kind: "scalar", name: startKind }, xType);
    if (!fits)
      problem(
        context,
        `${name}(...) needs ${startKind === "integer" || startKind === "number" ? "a number" : describeValue({ kind: "scalar", name: startKind })} as its x, like the line's start, not ${describeValue(xType)}.`,
        x,
      );
  }
  const amount = intercept === undefined ? undefined : knownKind(intercept);
  return amount === "duration"
    ? DURATION_TYPE
    : amount === "integer" || amount === "number"
      ? NUMBER_TYPE
      : UNKNOWN_TYPE;
}

/** The single scalar kind of a type, or `undefined`. */
function knownKind(type: StaticType): ValueKind | undefined {
  const value = resolved(forUse(type));
  return (["integer", "number", "duration", ...TEMPORAL_KINDS] as const).find((kind) =>
    isScalar(value, kind),
  );
}

/** `randomWeighted`: a key of a dict of weights, or a copy of an element of a list of objects with `weight:`. */
function weightedType(context: Context, known: Known): StaticType {
  const { call, typeOf } = context;
  if (!shape(context)) return UNKNOWN_TYPE;
  const source = call.arguments.find((argument) => argument.kind === "positionalArgument")!.value;
  // A dict or list written in the call, whose weights the compiler may see.
  let written = source;
  while (written.kind === "parenthesizedExpression") written = written.expression;
  const weight = named(call, "weight");
  const type = forUse(typeOf(source));
  if (!isKnown(type)) {
    // Only a list takes weight:, which names a property whatever the list holds.
    if (weight !== undefined) valuesType(context, source, weight, "weight");
    return UNKNOWN_TYPE;
  }
  const value = resolved(type);
  if (value.kind === "dict") {
    if (weight !== undefined) problem(context, DICT_WEIGHTS_MESSAGE, weight);
    else {
      valueKind(context, value.element, ["number"], source);
      if (written.kind === "dictLiteral") {
        // Keys the compiler knows differ, but a later key known only at runtime may replace an entry, and a later known
        // key an entry whose key is known only at runtime.
        const weights: Weight[] = [];
        let laterKeysKnown = true;
        for (let index = written.entries.length - 1; index >= 0; index -= 1) {
          const entry = written.entries[index]!;
          const keyKnown = typeof staticChoiceValue(entry.key)?.value === "string";
          weights[index] = {
            at: entry.value,
            value: known(entry.value),
            kept: index === written.entries.length - 1 || (keyKnown && laterKeysKnown),
          };
          laterKeysKnown &&= keyKnown;
        }
        weightProblems(context, source, weights);
      }
    }
    return STRING_TYPE;
  }
  if (value.kind === "list") {
    if (weight === undefined) problem(context, LIST_WEIGHT_MESSAGE, source);
    else {
      valueKind(context, valuesType(context, source, weight, "weight"), ["number"], weight);
      const key = staticVisibleText(weight);
      if (written.kind === "listLiteral" && key !== undefined)
        weightProblems(
          context,
          source,
          written.elements.map((element) => {
            const property =
              element.kind === "objectLiteral"
                ? element.properties.find((one) => one.name.name === key)
                : undefined;
            return {
              at: property?.value ?? element,
              value: property === undefined ? undefined : known(property.value),
              kept: true,
            };
          }),
        );
    }
    return copyType(value.element);
  }
  problem(context, WEIGHTED_SOURCE_MESSAGE, source);
  return UNKNOWN_TYPE;
}

/** A weight written in a call of `randomWeighted`, and whether the dict that holds it keeps it. */
interface Weight {
  readonly at: Expression;
  readonly value: number | undefined;
  readonly kept: boolean;
}

/**
 * The weights of a dict or list written in the call, as the runtime checks them (see `RANDOM_CONTRACTS`): the first
 * weight the compiler can see that is invalid, unless a later entry may replace it (`kept`), and otherwise, when it can
 * see every weight, all of them together.
 */
function weightProblems(context: Context, source: Expression, weights: readonly Weight[]): void {
  const contract = RANDOM_CONTRACTS.randomWeighted;
  for (const weight of weights) {
    const message =
      weight.kept && weight.value !== undefined ? contract.weightProblem(weight.value) : undefined;
    if (message !== undefined) return problem(context, message, weight.at);
  }
  const values = weights.flatMap((weight) => weight.value ?? []);
  // The weights the runtime reads are some of these, so they fail together when all of these do.
  const message =
    values.length > 0 && values.length === weights.length
      ? contract.weightsProblem(values)
      : undefined;
  if (message !== undefined) problem(context, message, source);
}

/**
 * The type an operation acts on: a possibly null value acts on its other members (V30 §34), and a value that is only
 * `null` stays `null`, so its misuse is still visible.
 */
function forUse(type: StaticType): StaticType {
  const value = resolved(nonNullType(type));
  return value.kind === "never" ? resolved(type) : value;
}
