import {
  argumentCountMessage,
  unknownNamedArgumentMessage,
  type ArgumentShape,
} from "./argument-rules.js";
import { angleStatisticMessage } from "./angle.js";
import type { CallExpression, Expression } from "./ast.js";
import type { ListFunctionName } from "./language-facts.js";
import {
  fewestValuesProblem,
  LIST_FUNCTION_CONTRACTS,
  listFunctionShape,
  listValueMessage,
  mixedListValuesMessage,
  type ListFunction,
  listValueKind,
  type ListValueKind,
  missingPropertyMessage,
  predictPositionMessage,
  predictStartMessage,
  PREDICT_NULL_LINE_MESSAGE,
  predictLineMessage,
} from "./list-function-rules.js";
import { TEMPORAL_KINDS, type TemporalKind } from "./temporal-builtins.js";
import { RANGE_LIST_FIX } from "./list-methods.js";
import type { OperationProblem } from "./operation-checks.js";
import { RANDOM_CONTRACTS } from "./random-functions.js";
import { isList } from "./runtime/values/value-predicates.js";
import { staticChoiceValue, staticVisibleText, type KnownValue } from "./static-evaluation.js";
import {
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
  valueKindOfType,
} from "./static-types.js";
import { PropertyTable } from "./static-types/property-tables.js";
import { copyType } from "./static-types/places.js";
import { describeKind } from "./static-types/type-names.js";

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

/** The kind of the values a list function reads, when the compiler knows it: one it takes, or integers. */
type ReadKind = ListValueKind | "integer";

interface Context {
  readonly name: string;
  /** What the function takes. */
  readonly shape: ArgumentShape;
  readonly call: CallExpression;
  readonly typeOf: (expression: Expression) => StaticType;
  readonly problems: OperationProblem[];
  readonly reads: ListPropertyRead[];
}

/** The value that every run gives an expression, when the compiler knows it (see `KnownValues`). */
type Known = (expression: Expression) => KnownValue | undefined;

/** The number `expression` is known to have, such as a constant percentage or weight, or `undefined`. */
function knownNumber(known: Known, expression: Expression): number | undefined {
  const value = known(expression);
  return typeof value === "number" ? value : undefined;
}

/**
 * Reports a list the compiler knows, with fewer values than the list function needs (see `fewestValuesProblem`), at the
 * list.
 */
function checkFewest(
  context: Context,
  name: ListFunctionName,
  list: Expression,
  known: Known,
): void {
  const value = known(list);
  if (value === undefined || !isList(value)) return;
  const message = fewestValuesProblem(name, value.items.length);
  if (message !== undefined) problem(context, message, list);
}

/**
 * Checks a call of a list function (see `LIST_FUNCTION_CONTRACTS`), `min` and `max` with one list, and gives its result
 * type.
 */
export function listFunctionCheck(
  name: ListFunctionName,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
): ListFunctionCheck {
  const context: Context = {
    name,
    shape: listFunctionShape(name),
    call,
    typeOf,
    problems: [],
    reads: [],
  };
  const type = listFunctionType(context, name, known);
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
  const { shape } = RANDOM_CONTRACTS.randomWeighted;
  const context: Context = { name: "randomWeighted", shape, call, typeOf, problems: [], reads: [] };
  const type = weightedType(context, known);
  return { problems: context.problems, reads: context.reads, type };
}

function listFunctionType(context: Context, name: ListFunctionName, known: Known): StaticType {
  const { call } = context;
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  switch (contract.takes) {
    case "points": {
      if (!shape(context)) return UNKNOWN_TYPE;
      const list = positionalArguments(call)[0]!;
      const y = named(call, "y");
      const x = named(call, "x");
      if (x !== undefined && y === undefined) {
        problem(context, `${name}(...) needs y: with x:, the property that holds the values.`, x);
        return UNKNOWN_TYPE;
      }
      const before = context.problems.length;
      const ys = valueKind(context, valuesType(context, list, y, "y"), contract.values, list);
      // Without names, its points are the list's values.
      if (y === undefined && context.problems.length === before)
        checkFewest(context, name, list, known);
      const xs =
        x === undefined
          ? "integer"
          : valueKind(context, valuesType(context, list, x, "x"), contract.positions, x, true);
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
    case "line":
      return predictType(context, contract.positions);
    case "values": {
      // A statistic, or `min` or `max` of one list.
      if (!shape(context)) return UNKNOWN_TYPE;
      const positional = positionalArguments(call);
      // Its other numbers, such as a percentage: one that may be null has been reported already, and its other members
      // are checked here.
      const numbers = contract.parameters.map((parameter, index) => {
        const argument = positional[index]!;
        if (index === 0) return undefined;
        const type = forUse(context.typeOf(argument));
        if (isAssignable(NUMBER_TYPE, type)) return knownNumber(known, argument);
        problem(
          context,
          `${name}(...) needs a number as its ${parameter}, not ${describeKind(type)}.`,
          argument,
        );
        return undefined;
      });
      for (const domain of contract.domains) {
        const reads = domain.reads.map((parameter) => contract.parameters.indexOf(parameter));
        const values = reads.flatMap((index) => numbers[index] ?? []);
        const failure = values.length === reads.length ? domain.problem(values) : undefined;
        // A domain of one number is reported at it.
        if (failure !== undefined)
          problem(context, failure, reads.length === 1 ? positional[reads[0]!]! : call);
      }
      const list = positional[0]!;
      const by = named(call, "by");
      const before = context.problems.length;
      const kind = valueKind(context, valuesType(context, list, by, "by"), contract.values, list);
      // Without `by:`, its values are the list's.
      if (by === undefined && context.problems.length === before)
        checkFewest(context, name, list, known);
      if (kind === "integer" && contract.integers === "number") return NUMBER_TYPE;
      return typeOfKind(kind);
    }
  }
}

/** Reports names and a number of positional arguments the function does not take; `true` when there are none. */
function shape(context: Context): boolean {
  const { name, call } = context;
  const { count: positional, names, takes } = context.shape;
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
        `${name}(...) needs the name of a property as its ${option}:, not ${describeKind(forUse(propertyType))}.`,
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
      `${name}(...) needs a list, not ${describeKind(other)}.${other.kind === "range" ? RANGE_LIST_FIX : ""}`,
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
      `${name}(...) needs a list of objects for ${option}:, not a list that holds ${describeKind(notObject)}.`,
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
    message: missingPropertyMessage(name, key),
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
  allowed: readonly ListValueKind[],
  at: Expression,
  x = false,
): ReadKind | undefined {
  const parts = members(type).map(resolved);
  if (parts.length === 0 || !parts.every(isKnown)) return undefined;
  const kinds = new Set<ReadKind>();
  for (const part of parts) {
    const valueKind = valueKindOfType(part);
    const listKind = valueKind === undefined ? undefined : listValueKind(valueKind);
    // An integer stays one, for the kind of what the function gives.
    const kind = valueKind === "integer" ? valueKind : listKind;
    if (listKind === undefined || !allowed.includes(listKind)) {
      problem(
        context,
        listValueMessage(context.name, allowed, describeKind(part), listKind, x),
        at,
      );
      return undefined;
    }
    kinds.add(kind!);
  }
  if (kinds.size === 1) return [...kinds][0]!;
  if (kinds.size === 2 && kinds.has("integer") && kinds.has("number")) return "number";
  problem(context, mixedListValuesMessage(context.name, allowed, x), at);
  return undefined;
}

function typeOfKind(kind: ReadKind | undefined): StaticType {
  if (kind === undefined) return UNKNOWN_TYPE;
  if (kind === "integer") return INTEGER_TYPE;
  if (kind === "number") return NUMBER_TYPE;
  return { kind: "scalar", name: kind };
}

/**
 * `predict(line, x)`: a number or duration, as the line's intercept, at an x of the kind of the line's start, one of
 * `positions`.
 */
function predictType(context: Context, positions: readonly ListValueKind[]): StaticType {
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
        !positions.some(
          (kind) => isScalar(member, kind) || (kind === "number" && isScalar(member, "integer")),
        ),
    );
  if (other !== undefined) {
    problem(
      context,
      isScalar(other, "angle")
        ? angleStatisticMessage(name)
        : predictPositionMessage(describeKind(other)),
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
    problem(context, PREDICT_NULL_LINE_MESSAGE, line);
    return UNKNOWN_TYPE;
  }
  if (
    object.kind !== "object" ||
    (object.properties !== null &&
      (intercept === undefined || property("slope") === undefined || start === undefined))
  ) {
    problem(context, predictLineMessage(describeKind(type)), line);
    return UNKNOWN_TYPE;
  }
  const startKind = start === undefined ? undefined : knownKind(start);
  const xType = forUse(typeOf(x));
  if (startKind !== undefined && isKnown(xType)) {
    const fits =
      startKind === "integer" || startKind === "number"
        ? isAssignable(NUMBER_TYPE, xType)
        : isAssignable({ kind: "scalar", name: startKind }, xType);
    if (!fits) problem(context, predictStartMessage(startKind, describeKind(xType)), x);
  }
  const amount = intercept === undefined ? undefined : knownKind(intercept);
  return amount === "duration"
    ? DURATION_TYPE
    : amount === "integer" || amount === "number"
      ? NUMBER_TYPE
      : UNKNOWN_TYPE;
}

/** The single kind of a type that a line's start or intercept may have, or `undefined`. */
function knownKind(type: StaticType): "integer" | "number" | "duration" | TemporalKind | undefined {
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
  const written = withoutParentheses(source);
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
      problem(context, RANDOM_CONTRACTS.randomWeighted.sources.dict, weight);
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
            value: knownNumber(known, entry.value),
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
    if (weight === undefined)
      problem(context, RANDOM_CONTRACTS.randomWeighted.sources.list, source);
    else {
      valueKind(context, valuesType(context, source, weight, "weight"), ["number"], weight);
      const key = staticVisibleText(weight);
      if (written.kind === "listLiteral" && key !== undefined)
        weightProblems(
          context,
          source,
          written.elements.map((element) => {
            const object = withoutParentheses(element);
            const property =
              object.kind === "objectLiteral"
                ? object.properties.find((one) => one.name.name === key)
                : undefined;
            return {
              at: property?.value ?? element,
              value: property === undefined ? undefined : knownNumber(known, property.value),
              kept: true,
            };
          }),
        );
    }
    return copyType(value.element);
  }
  problem(context, RANDOM_CONTRACTS.randomWeighted.sources.other, source);
  return UNKNOWN_TYPE;
}

function withoutParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
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
