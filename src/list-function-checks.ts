import type { CallExpression, Expression } from "./ast.js";
import type { OperationProblem } from "./operation-checks.js";
import { staticVisibleText } from "./static-evaluation.js";
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
  "randomWeighted",
]);

/** The problems with a call of a list function, and its result type. */
export interface ListFunctionCheck {
  readonly problems: readonly OperationProblem[];
  readonly type: StaticType;
}

/** The kind of the values a list function reads, when the compiler knows it. */
type ValueKind = "integer" | "number" | "duration" | "date" | "time" | "datetime" | "timestamp";

const TEMPORAL_KINDS: readonly ValueKind[] = ["date", "time", "datetime", "timestamp"];

interface Context {
  readonly name: string;
  readonly call: CallExpression;
  readonly typeOf: (expression: Expression) => StaticType;
  readonly problems: OperationProblem[];
}

/**
 * Checks a call of a list function, or of `min` or `max` with one list, and gives its result type. `known` gives a
 * number the compiler can see, such as a constant percentage.
 */
export function listFunctionCheck(
  name: string,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: (expression: Expression) => number | undefined,
): ListFunctionCheck {
  const context: Context = { name, call, typeOf, problems: [] };
  const type = listFunctionType(context, known);
  return { problems: context.problems, type };
}

function listFunctionType(
  context: Context,
  known: (expression: Expression) => number | undefined,
): StaticType {
  const { name, call } = context;
  switch (name) {
    case "linearRegression": {
      if (!shape(context, 1, ["y", "x"], "1 argument (list), and optionally y: and x:"))
        return UNKNOWN_TYPE;
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
              ["number", "date", "datetime", "timestamp"],
              x,
            );
      const amount =
        ys === undefined ? UNKNOWN_TYPE : ys === "duration" ? DURATION_TYPE : NUMBER_TYPE;
      return {
        kind: "object",
        properties: new Map([
          ["slope", amount],
          ["intercept", amount],
          ["r2", NUMBER_TYPE],
          ["start", typeOfKind(xs)],
        ]),
      };
    }
    case "predict":
      return predictType(context);
    case "randomWeighted":
      return weightedType(context);
    default: {
      // `sum`, `average`, `median`, `percentile`, `stddev`, and `min` or `max` of one list.
      const percentile = name === "percentile";
      if (
        !shape(
          context,
          percentile ? 2 : 1,
          ["by"],
          `${percentile ? "2 arguments (list, percentage)" : "1 argument (list)"}, and optionally by:`,
        )
      )
        return UNKNOWN_TYPE;
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
        else if (value !== undefined && (value < 0 || value > 100))
          problem(
            context,
            `${name}(...) needs a percentage from 0 through 100, not ${value}.`,
            share,
          );
      }
      const list = positionalArguments(call)[0]!;
      const minMax = name === "min" || name === "max";
      const kind = valueKind(
        context,
        valuesType(context, list, named(call, "by"), "by"),
        minMax ? ["number", "duration", ...TEMPORAL_KINDS] : ["number", "duration"],
        list,
      );
      if (kind === "integer" && name !== "sum" && !minMax) return NUMBER_TYPE;
      return typeOfKind(kind);
    }
  }
}

/** Reports names and a number of positional arguments the function does not take; `true` when there are none. */
function shape(
  context: Context,
  positional: number,
  names: readonly string[],
  usage: string,
): boolean {
  const { name, call } = context;
  const before = context.problems.length;
  for (const argument of call.arguments)
    if (argument.kind === "namedArgument" && !names.includes(argument.name.name))
      context.problems.push({
        kind: "unknownNamedArgument",
        message:
          names.length === 0
            ? `${name}(...) takes no named arguments; remove '${argument.name.name}:'.`
            : `${name}(...) has no parameter '${argument.name.name}'; its named arguments are ${names.map((one) => `${one}:`).join(" and ")}.`,
        span: argument.name.span,
      });
  const count = call.arguments.filter((argument) => argument.kind === "positionalArgument").length;
  if (count !== positional)
    context.problems.push({
      kind: "argumentCount",
      message: `${name}(...) takes ${usage}, received ${count}.`,
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
  if (!isKnown(type)) return UNKNOWN_TYPE;
  const lists = members(type).map(resolved);
  const other = lists.find((member) => isKnown(member) && member.kind !== "list");
  if (other !== undefined) {
    problem(context, `${name}(...) needs a list, not ${describeValue(other)}.`, list);
    return UNKNOWN_TYPE;
  }
  if (!lists.every(isKnown)) return UNKNOWN_TYPE;
  const element = union(
    lists.map((member) => (member.kind === "list" ? member.element : UNKNOWN_TYPE)),
  );
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
  const found: StaticType[] = [];
  for (const member of parts) {
    if (member.kind !== "object" || member.properties === null || key === undefined)
      return UNKNOWN_TYPE;
    const value = member.properties.get(key);
    if (value === undefined) {
      problem(
        context,
        `${name}(...): the objects in this list have no property '${key}'.`,
        property,
      );
      return UNKNOWN_TYPE;
    }
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
    const kind = (["integer", "number", "duration", ...TEMPORAL_KINDS] as const).find((one) =>
      isScalar(part, one),
    );
    if (kind === undefined || !allowed.includes(kind === "integer" ? "number" : kind)) {
      problem(
        context,
        `${context.name}(...) needs ${describeKinds(allowed)}, not ${describeValue(part)}.`,
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
        : kind === "datetime"
          ? "datetimes"
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
  if (!shape(context, 2, [], "2 arguments (line, x)")) return UNKNOWN_TYPE;
  const line = call.arguments[0]!.value;
  const x = call.arguments[1]!.value;
  // Whatever the line, each kind x may be is a number or a date and time value that is measured in days.
  const other = members(forUse(typeOf(x)))
    .map(resolved)
    .find(
      (member) =>
        isKnown(member) &&
        !(["integer", "number", "date", "datetime", "timestamp"] as const).some((kind) =>
          isScalar(member, kind),
        ),
    );
  if (other !== undefined) {
    problem(
      context,
      `${name}(...) needs a number, date, datetime, or timestamp as its x, not ${describeValue(other)}.`,
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
function weightedType(context: Context): StaticType {
  const { name, call, typeOf } = context;
  if (!shape(context, 1, ["weight"], "1 argument (a dict, or a list with weight:)"))
    return UNKNOWN_TYPE;
  const source = call.arguments.find((argument) => argument.kind === "positionalArgument")!.value;
  const weight = named(call, "weight");
  const type = forUse(typeOf(source));
  if (!isKnown(type)) {
    // Only a list takes weight:, which names a property whatever the list holds.
    if (weight !== undefined) valuesType(context, source, weight, "weight");
    return UNKNOWN_TYPE;
  }
  const value = resolved(type);
  if (value.kind === "dict") {
    if (weight !== undefined)
      problem(
        context,
        `${name}(...) of a dict takes its weights from the dict; remove weight:.`,
        weight,
      );
    else valueKind(context, value.element, ["number"], source);
    return STRING_TYPE;
  }
  if (value.kind === "list") {
    if (weight === undefined)
      problem(
        context,
        `${name}(...) of a list needs weight:, the property that holds each element's weight, as in ${name}(tasks, weight: "chance").`,
        source,
      );
    else valueKind(context, valuesType(context, source, weight, "weight"), ["number"], weight);
    return copyType(value.element);
  }
  problem(
    context,
    `${name}(...) needs a dict of weights or a list of objects, not ${describeValue(value)}.`,
    source,
  );
  return UNKNOWN_TYPE;
}

/**
 * The type an operation acts on: a possibly null value acts on its other members (V30 §34), and a value that is only
 * `null` stays `null`, so its misuse is still visible.
 */
function forUse(type: StaticType): StaticType {
  const value = resolved(nonNullType(type));
  return value.kind === "never" ? resolved(type) : value;
}
