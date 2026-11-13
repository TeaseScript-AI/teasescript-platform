import { lazyDefaultArgumentIndex, lazyDefaultCallOperation } from "../../../plan/expression-children.js";
import type { ExpressionPlan, InstructionPlan, TemplatePartPlan } from "../../../plan/model.js";
import { acceptedDefault, noSpeaker, rangeBound, templateText, unitDuration } from "../../evaluator.js";
import { mayChangeValue } from "../../evaluation/effect-facts.js";
import { notLogicalOperand } from "../../evaluation/operators.js";
import { interpolationText } from "../../evaluation/speakers.js";
import { assertFallbackType } from "../../values/value-types.js";
import type { NativeMachine, NativeReference } from "../execute/machine.js";
import { isNativeReference, readLocation, resolveReference } from "../execute/references.js";
import {
  assertNativeIndexable,
  nativeIndexRead,
  nativeProperty,
  shown,
} from "../operations/access.js";
import { NEEDS_DEFAULT, nativeCall } from "../operations/calls.js";
import { NativeNotImplementedError } from "../operations/not-implemented.js";
import { nativeBinary, nativeUnary } from "../operations/operators.js";
import { fromCanonical } from "../values/codec.js";
import { copyNativeValue } from "../values/copy.js";
import { isNativeComposite, NativeObject, type NativeValue } from "../values/native-value.js";
import { NativePreparationError, type NameLocation } from "./scopes.js";

/** An expression prepared as a closure over the machine. */
export type NativeExpression = (machine: NativeMachine) => NativeValue;

/** What compiling an expression needs: name resolution where it stands, and facts of the plan. */
export interface ExpressionScope {
  readonly plan: InstructionPlan;
  resolve(name: string): NameLocation;
  /** The temporaries a prepared message reads its speaker from, whose `null` fails as no speaker. */
  readonly speakerTemporaries: ReadonlySet<number>;
}

/**
 * Whether an expression's value is new, so a store may keep it without a copy: the closed set of kinds that build a
 * new value or a primitive. Every other kind, including a call or a variable's read, is copied where it is stored.
 */
export function isFreshValue(expression: ExpressionPlan): boolean {
  switch (expression.kind) {
    case "literal":
    case "list":
    case "object":
    case "template":
    case "unary":
    case "range":
      return true;
    case "binary":
      return expression.operator !== "otherwise";
    case "group":
      return isFreshValue(expression.expression);
    default:
      return false;
  }
}

/** Compiles an expression; a kind outside the native engine's slice refuses the plan at preparation. */
export function compileExpression(expression: ExpressionPlan, scope: ExpressionScope): NativeExpression {
  switch (expression.kind) {
    case "literal": {
      const value = expression.value;
      return () => value;
    }
    case "group":
      return compileExpression(expression.expression, scope);
    case "identifier":
      return compileRead(expression.name, scope);
    case "temporary": {
      const id = expression.temporaryId;
      const speaker = scope.speakerTemporaries.has(id);
      const span = expression.span;
      return (machine) => {
        const value = machine.current.temps[id];
        if (value === undefined || isNativeReference(value))
          throw new Error(`Temporary ${id} holds no value where the plan reads it.`);
        if (value === null && speaker) throw noSpeaker(span);
        return value;
      };
    }
    case "preparedReference": {
      const id = expression.temporaryId;
      return (machine) => resolveReference(machine, referenceIn(machine, id));
    }
    case "list": {
      const elements = expression.elements.map((element) => compileOwned(element, scope));
      return (machine) => {
        const list: NativeValue[] = [];
        for (const element of elements) list.push(element(machine));
        return list;
      };
    }
    case "object": {
      const properties = expression.properties.map(
        (property) => [property.name, compileOwned(property.value, scope)] as const,
      );
      return (machine) => {
        const object = new NativeObject();
        for (const [name, value] of properties) object.properties.set(name, value(machine));
        return object;
      };
    }
    case "template":
      return compileTemplate(expression.parts, expression.span, scope);
    case "property": {
      const object = compileExpression(expression.object, scope);
      const name = expression.name;
      const span = expression.span;
      return (machine) => nativeProperty(object(machine), name, span);
    }
    case "index": {
      const object = compileExpression(expression.object, scope);
      const index = compileExpression(expression.index, scope);
      const receiver = expression.object;
      const span = expression.span;
      return (machine) => {
        const indexed = object(machine);
        assertNativeIndexable(machine, receiver, indexed, span);
        return nativeIndexRead(machine, expression, receiver, indexed, index(machine));
      };
    }
    case "unary": {
      const operand = compileExpression(expression.operand, scope);
      return (machine) => nativeUnary(machine, expression, operand(machine));
    }
    case "binary":
      return compileBinary(expression, scope);
    case "range": {
      const start = compileExpression(expression.start, scope);
      const end = compileExpression(expression.end, scope);
      const plan = scope.plan;
      const inclusive = expression.inclusive;
      return (machine) => {
        const from = rangeBound(expression, "start", shown(start(machine)), plan);
        const to = rangeBound(expression, "end", shown(end(machine)), plan);
        return Object.freeze({ kind: "range", start: from, end: to, inclusive });
      };
    }
    case "unit": {
      const operand = compileExpression(expression.operand, scope);
      return (machine) => fromCanonical(unitDuration(expression, shown(operand(machine))));
    }
    case "call":
      return compileCall(expression, scope);
    default:
      throw new NativePreparationError(`the expression kind '${expression.kind}'`);
  }
}

/** Compiles an expression whose value a new collection or a call keeps: a value it does not own is copied. */
export function compileOwned(expression: ExpressionPlan, scope: ExpressionScope): NativeExpression {
  const value = compileExpression(expression, scope);
  if (isFreshValue(expression)) return value;
  return (machine) => copyNativeValue(value(machine));
}

function compileRead(name: string, scope: ExpressionScope): NativeExpression {
  if (name === "speaker")
    throw new NativePreparationError("a read of 'speaker', which a contextual speaker can stand for");
  const location = scope.resolve(name);
  const missing = (): never => {
    throw new NativeNotImplementedError(`a read of '${name}' before it has a value`);
  };
  switch (location.kind) {
    case "local": {
      const { depth, slot } = location;
      return (machine) => machine.current.scopes[depth]![slot] ?? missing();
    }
    case "root": {
      const slot = location.slot;
      return (machine) => machine.root.scopes[0]![slot] ?? missing();
    }
    case "global":
      return (machine) => readLocation(machine, location) ?? missing();
  }
}

function compileTemplate(
  parts: readonly TemplatePartPlan[],
  span: ExpressionPlan["span"],
  scope: ExpressionScope,
): NativeExpression {
  const compiled = parts.map((part) =>
    part.kind === "text"
      ? ({ kind: "text", value: part.value } as const)
      : ({ kind: "expression", plan: part.expression, value: compileExpression(part.expression, scope) } as const),
  );
  return (machine) => {
    let text = "";
    for (const part of compiled)
      text = templateText(
        text,
        part.kind === "text" ? part.value : interpolationText(machine, shown(part.value(machine)), part.plan),
        span,
      );
    return text;
  };
}

function compileBinary(
  expression: Extract<ExpressionPlan, { kind: "binary" }>,
  scope: ExpressionScope,
): NativeExpression {
  const left = compileExpression(expression.left, scope);
  const right = compileExpression(expression.right, scope);
  const operator = expression.operator;
  const plan = scope.plan;
  // A shared list, set, dict or object is read when it is evaluated: copied before a right operand that can change it.
  const copyLeft =
    (operator === "==" || operator === "!=" || expression.left.kind === "preparedReference") &&
    !isFreshValue(expression.left) &&
    mayChangeValue(expression.right);
  const fallbackCheck = expression.fallbackCheck;
  return (machine) => {
    let first = left(machine);
    if (copyLeft && isNativeComposite(first)) first = copyNativeValue(first);
    if (operator === "and" || operator === "or") {
      if (typeof first !== "boolean")
        throw notLogicalOperand(operator, expression.left, shown(first), plan);
      if (operator === "and" ? !first : first) return first;
    }
    // The fallback runs only for a null value.
    if (operator === "otherwise" && first !== null) return first;
    const value = nativeBinary(machine, expression, first, right(machine));
    if (fallbackCheck !== undefined) assertFallbackType(shown(value), fallbackCheck, expression.right.span);
    return value;
  };
}

function compileCall(
  expression: Extract<ExpressionPlan, { kind: "call" }>,
  scope: ExpressionScope,
): NativeExpression {
  const callee = expression.callee;
  const receiver = callee.kind === "property" ? compileExpression(callee.object, scope) : null;
  const lazy = lazyDefaultArgumentIndex(expression);
  const operation = lazyDefaultCallOperation(expression);
  const positional: NativeExpression[] = [];
  const named: Array<readonly [string, NativeExpression]> = [];
  // Each argument is copied as it is evaluated, before the next one runs.
  expression.arguments.forEach((argument, index) => {
    if (index === lazy) return;
    const value = compileOwned(argument.value, scope);
    if (argument.kind === "positional") positional.push(value);
    else named.push([argument.name, value]);
  });
  const fallback = lazy === -1 ? null : compileOwned(expression.arguments[lazy]!.value, scope);
  // A list's `add` changes the list in place, which today's engine does after it freezes the references it reaches.
  const changes = callee.kind === "property" && callee.name === "add";
  const fallbackSpan = lazy === -1 ? null : expression.arguments[lazy]!.value.span;
  return (machine) => {
    const target = receiver === null ? null : receiver(machine);
    const values: NativeValue[] = [];
    for (const argument of positional) values.push(argument(machine));
    const record: Record<string, NativeValue> = {};
    for (const [name, argument] of named) record[name] = argument(machine);
    if (changes && machine.liveReferences !== 0)
      throw new NativeNotImplementedError("a change while a prepared reference it may reach is held");
    const called = nativeCall(machine, expression, target, values, record, fallback !== null);
    if (called !== NEEDS_DEFAULT) return called;
    if (fallback === null || operation === null)
      throw new NativeNotImplementedError("a call that needs a default it does not have");
    const value = fallback(machine);
    acceptedDefault(operation, shown(value), expression.typeCheck, fallbackSpan!, expression.fallbackCheck);
    return value;
  };
}

/** The prepared reference a temporary holds. */
export function referenceIn(machine: NativeMachine, id: number): NativeReference {
  const held = machine.current.temps[id];
  if (!isNativeReference(held)) throw new Error(`Temporary ${id} holds no prepared reference where the plan uses one.`);
  return held;
}
