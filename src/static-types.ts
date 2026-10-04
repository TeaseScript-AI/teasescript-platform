import type { Expression, ScalarTypeName, TypeAnnotation } from "./ast.js";
import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";

/**
 * A compile-time value type. `unknown` stands for values the compiler cannot know, such as untyped storage, host data,
 * and function results; they are never rejected at compile time. The compiler never infers an optional type.
 */
export type StaticType =
  | { readonly kind: "unknown" }
  | { readonly kind: "null" }
  | { readonly kind: "scalar"; readonly name: ScalarTypeName }
  | { readonly kind: "list" | "set"; readonly element: StaticType }
  | { readonly kind: "optional"; readonly value: StaticType }
  | { readonly kind: "object" | "range" | "timerHandle" | "mediaHandle" | "speaker" };

const UNKNOWN_TYPE: StaticType = Object.freeze({ kind: "unknown" });
const NULL_TYPE: StaticType = Object.freeze({ kind: "null" });
/** List methods that return the element they remove. */
const LIST_REMOVALS: ReadonlySet<string> = new Set(["removeAt", "removeFirst", "removeLast"]);

function scalar(name: ScalarTypeName): StaticType {
  return { kind: "scalar", name };
}

export function typeFromAnnotation(annotation: TypeAnnotation): StaticType {
  const named = scalar(annotation.name);
  const collection =
    annotation.collection === null ? named : { kind: annotation.collection, element: named };
  return annotation.optional ? { kind: "optional", value: collection } : collection;
}

/** The type without `null`: operations on an optional value act on its non-null type. */
export function nonNullType(type: StaticType): StaticType {
  return type.kind === "optional" ? type.value : type;
}

/** Whether a type can be written as an annotation: a scalar type, or a list or set of one. */
export function isAnnotatable(type: StaticType): boolean {
  const value = nonNullType(type);
  return (
    value.kind === "scalar" ||
    ((value.kind === "list" || value.kind === "set") && value.element.kind === "scalar")
  );
}

/** The type of a list or set element, of a loop variable over an iterable, or `undefined` for other types. */
export function elementType(type: StaticType): StaticType | undefined {
  if (type.kind === "list" || type.kind === "set") return type.element;
  if (type.kind === "range") return scalar("integer");
  return undefined;
}

/** Whether a value of `source` may be stored where `target` is required. Only integer widens, to number. */
export function isAssignable(target: StaticType, source: StaticType): boolean {
  if (target.kind === "unknown" || source.kind === "unknown") return true;
  if (target.kind === "optional")
    return source.kind === "null" || isAssignable(target.value, unwrapOptional(source));
  // A possibly null value is not a definite contradiction; nullable-use checks are a separate rule (V30 §34).
  if (source.kind === "optional") return isAssignable(target, source.value);
  switch (target.kind) {
    case "null":
      return source.kind === "null";
    case "scalar":
      return (
        source.kind === "scalar" &&
        (source.name === target.name || (target.name === "number" && source.name === "integer"))
      );
    case "list":
    case "set":
      return source.kind === target.kind && isAssignable(target.element, source.element);
    default:
      return source.kind === target.kind;
  }
}

function unwrapOptional(type: StaticType): StaticType {
  return type.kind === "optional" ? type.value : type;
}

/** The author-facing type name, as written in an annotation where one exists. */
export function typeName(type: StaticType): string {
  switch (type.kind) {
    case "unknown":
      return "unknown";
    case "null":
      return "null";
    case "scalar":
      return type.name;
    case "list":
      return type.element.kind === "unknown" ? "list" : `${typeName(type.element)}[]`;
    case "set":
      return type.element.kind === "unknown" ? "set" : `${typeName(type.element)} set`;
    case "optional":
      return `${typeName(type.value)}?`;
    case "timerHandle":
      return "timer handle";
    case "mediaHandle":
      return "media handle";
    default:
      return type.kind;
  }
}

/** A plain-language description of a value of `type` for diagnostics. */
export function describeValue(type: StaticType): string {
  if (type.kind === "scalar") {
    switch (type.name) {
      case "string":
        return "text (string)";
      case "integer":
        return "a whole number (integer)";
      case "number":
        return "a number";
      case "boolean":
        return "true or false (boolean)";
      case "duration":
        return "a duration";
      case "date":
        return "a date";
      case "time":
        return "a time";
      case "datetime":
        return "a date and time";
    }
  }
  if (type.kind === "list" || type.kind === "set")
    return type.element.kind === "unknown"
      ? `a ${type.kind}`
      : `a ${type.kind} (${typeName(type)})`;
  if (type.kind === "optional") return `${describeValue(type.value)} or null`;
  if (type.kind === "null") return "null";
  if (type.kind === "object") return "an object";
  return `a ${typeName(type)}`;
}

export interface StaticTypeContext {
  /** The type of a visible variable, speaker, or global, or `undefined` when the name is not a value. */
  readonly identifier: (name: string) => StaticType | undefined;
  readonly isBuiltin: (name: string) => boolean;
}

/** The statically known type of an expression, or `unknown`. Deep expressions use an explicit continuation stack. */
export function expressionType(expression: Expression, context: StaticTypeContext): StaticType {
  return runCompileTask(expressionTypeTask(expression, context));
}

function* expressionTypeTask(
  expression: Expression,
  context: StaticTypeContext,
): CompileTask<StaticType> {
  switch (expression.kind) {
    case "booleanLiteral":
      return scalar("boolean");
    case "nullLiteral":
      return NULL_TYPE;
    case "numberLiteral":
      return scalar(expression.numericType);
    case "durationLiteral":
      return scalar("duration");
    case "stringLiteral":
      return scalar("string");
    case "listLiteral":
    case "setLiteral": {
      const elements: StaticType[] = [];
      for (const element of expression.elements)
        elements.push(yield* compileChild(expressionTypeTask(element, context)));
      return {
        kind: expression.kind === "listLiteral" ? "list" : "set",
        element: commonElementType(elements),
      };
    }
    case "objectLiteral":
      return { kind: "object" };
    case "parenthesizedExpression":
      return yield* compileChild(expressionTypeTask(expression.expression, context));
    case "identifier":
      return context.identifier(expression.name) ?? UNKNOWN_TYPE;
    case "propertyAccessExpression": {
      const object = nonNullType(
        yield* compileChild(expressionTypeTask(expression.object, context)),
      );
      if (object.kind !== "list" && object.kind !== "set") return UNKNOWN_TYPE;
      if (expression.property.name === "length") return scalar("integer");
      return ["first", "last", "random"].includes(expression.property.name)
        ? object.element
        : UNKNOWN_TYPE;
    }
    case "indexExpression": {
      const object = nonNullType(
        yield* compileChild(expressionTypeTask(expression.object, context)),
      );
      return object.kind === "list" ? object.element : UNKNOWN_TYPE;
    }
    case "callExpression": {
      let callee = expression.callee;
      while (callee.kind === "parenthesizedExpression") callee = callee.expression;
      if (callee.kind === "identifier" && context.isBuiltin(callee.name)) {
        if (callee.name === "random") return scalar("number");
        if (callee.name === "randomInteger") return scalar("integer");
        if (callee.name === "chance") return scalar("boolean");
      }
      if (callee.kind === "propertyAccessExpression") {
        const removal = LIST_REMOVALS.has(callee.property.name);
        if (removal || callee.property.name === "contains") {
          const receiver = nonNullType(
            yield* compileChild(expressionTypeTask(callee.object, context)),
          );
          if (removal) return receiver.kind === "list" ? receiver.element : UNKNOWN_TYPE;
          if (receiver.kind === "list" || receiver.kind === "set") return scalar("boolean");
        }
      }
      return UNKNOWN_TYPE;
    }
    case "unaryExpression": {
      if (expression.operator === "not") return scalar("boolean");
      const operand = nonNullType(
        yield* compileChild(expressionTypeTask(expression.operand, context)),
      );
      return operand.kind === "scalar" &&
        (operand.name === "integer" || operand.name === "number" || operand.name === "duration")
        ? operand
        : UNKNOWN_TYPE;
    }
    case "binaryExpression": {
      if (!ARITHMETIC_OPERATORS.has(expression.operator)) return scalar("boolean");
      const left = yield* compileChild(expressionTypeTask(expression.left, context));
      const right = yield* compileChild(expressionTypeTask(expression.right, context));
      return arithmeticType(expression.operator, left, right) ?? UNKNOWN_TYPE;
    }
    case "rangeExpression":
      return { kind: "range" };
    case "interactionExpression": {
      if (expression.interactionKind !== "choice")
        return scalar(expression.interactionKind === "number" ? "number" : "string");
      // `choose` returns a button's value: one written before `:`, or else the option's own value with its type.
      const values: StaticType[] = [];
      for (const option of expression.options) {
        let content = option.expression;
        while (content.kind === "parenthesizedExpression") content = content.expression;
        // An empty list or set gives no buttons, so its written value is never returned.
        if (
          (content.kind === "listLiteral" || content.kind === "setLiteral") &&
          content.elements.length === 0
        )
          continue;
        if (option.value !== null) {
          values.push(
            scalar(option.value.kind === "identifier" ? "string" : option.value.numericType),
          );
          continue;
        }
        let value = option.expression;
        while (value.kind === "parenthesizedExpression") value = value.expression;
        if (value.kind === "listLiteral" || value.kind === "setLiteral") {
          for (const element of value.elements)
            values.push(yield* compileChild(choiceEntryTypeTask(element, context)));
          continue;
        }
        const type = yield* compileChild(choiceEntryTypeTask(value, context));
        // A list or set option gives a button per element; an optional one may also be one `null` button.
        values.push(
          type.kind === "list" || type.kind === "set"
            ? type.element
            : type.kind === "optional" && (type.value.kind === "list" || type.value.kind === "set")
              ? UNKNOWN_TYPE
              : type,
        );
      }
      return sharedValueType(values);
    }
    case "timerExpression":
      return expression.async ? { kind: "timerHandle" } : UNKNOWN_TYPE;
    case "playMediaExpression":
      return expression.async ? { kind: "mediaHandle" } : UNKNOWN_TYPE;
    case "loadExpression":
      return UNKNOWN_TYPE;
  }
}

/**
 * The type all choice values share; integers and numbers together are numbers. Values of different types give
 * `unknown`, because the compiler never infers a union or an optional type.
 */
function sharedValueType(values: readonly StaticType[]): StaticType {
  const numeric = (type: StaticType): boolean =>
    type.kind === "scalar" && (type.name === "integer" || type.name === "number");
  let shared: StaticType | undefined;
  for (const value of values) {
    if (value.kind === "unknown") return UNKNOWN_TYPE;
    if (shared === undefined || typeName(shared) === typeName(value)) shared ??= value;
    else if (numeric(shared) && numeric(value)) shared = scalar("number");
    else return UNKNOWN_TYPE;
  }
  return shared ?? UNKNOWN_TYPE;
}

/** The value type of one choice button: a choice object's `value`, else its `text`, else the option itself. */
function* choiceEntryTypeTask(
  entry: Expression,
  context: StaticTypeContext,
): CompileTask<StaticType> {
  while (entry.kind === "parenthesizedExpression") entry = entry.expression;
  if (entry.kind !== "objectLiteral") {
    const type = yield* compileChild(expressionTypeTask(entry, context));
    // A computed choice object's value type is not known.
    return nonNullType(type).kind === "object" ? UNKNOWN_TYPE : type;
  }
  const property =
    entry.properties.find((candidate) => candidate.name.name === "value") ??
    entry.properties.find((candidate) => candidate.name.name === "text");
  return property === undefined
    ? UNKNOWN_TYPE
    : yield* compileChild(expressionTypeTask(property.value, context));
}

export const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/**
 * The result type of arithmetic on known operand types, or `undefined` when it is not known or not valid. Integer
 * arithmetic stays integer except `/`, which returns a number when necessary.
 */
export function arithmeticType(
  operator: string,
  leftType: StaticType,
  rightType: StaticType,
): StaticType | undefined {
  const left = nonNullType(leftType);
  const right = nonNullType(rightType);
  if (left.kind !== "scalar" || right.kind !== "scalar") return undefined;
  const numeric = (name: ScalarTypeName): boolean => name === "integer" || name === "number";
  if (numeric(left.name) && numeric(right.name)) {
    return left.name === "integer" && right.name === "integer" && operator !== "/"
      ? scalar("integer")
      : scalar("number");
  }
  if (left.name === "duration" && right.name === "duration") {
    if (operator === "+" || operator === "-") return scalar("duration");
    if (operator === "/") return scalar("number");
    return undefined;
  }
  if (left.name === "duration" && numeric(right.name) && (operator === "*" || operator === "/"))
    return scalar("duration");
  if (numeric(left.name) && right.name === "duration" && operator === "*")
    return scalar("duration");
  return undefined;
}

/** One element type for all elements; integers and numbers together are numbers. Anything else is unknown. */
function commonElementType(elements: readonly StaticType[]): StaticType {
  let common: StaticType | undefined;
  for (const element of elements) {
    if (element.kind !== "scalar") return UNKNOWN_TYPE;
    if (common === undefined || isAssignable(element, common)) common = element;
    else if (!isAssignable(common, element)) return UNKNOWN_TYPE;
  }
  return common ?? UNKNOWN_TYPE;
}
