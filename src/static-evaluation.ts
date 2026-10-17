import {
  angleArithmetic,
  angleDegrees,
  angleValue,
  formatAngle,
  type StoredAngle,
} from "./angle.js";
import type { CallExpression, Expression, Identifier, Program } from "./ast.js";
import { runCompileTask, compileChild, type CompileTask } from "./compiler/continuation.js";
import { CONVERSIONS, fitsDefault, isConversion } from "./conversions.js";
import {
  addDurations,
  divideDuration,
  durationFamily,
  durationLiteralValue,
  durationParts,
  durationQuotient,
  formatDuration,
  negateDuration,
  scaleDuration,
  unitValue,
  type AnyDuration,
} from "./duration.js";
import { lazyDefaultArgument } from "./lazy-defaults.js";
import { isListFunction } from "./list-function-rules.js";
import { hasListMethod, LIST_METHODS, onlyReadsList, type ListMethod } from "./list-methods.js";
import { isNumericFunction } from "./numeric-functions.js";
import { canonicalRegexFlags, regexFlagProblem } from "./regex.js";
import { withRegexWorkPool } from "./regex-engine.js";
import { readCollection } from "./runtime/collection-operations.js";
import { listFunctionValue } from "./runtime/list-statistics.js";
import { conversionResult, joinedValue, numericFunction } from "./runtime/pure-operations.js";
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableList,
  createCapturedSerializableSet,
  setOwnedSerializableDictValue,
  type SerializableRuntimeDict,
  type SerializableRuntimeValue,
} from "./runtime/serializable-values.js";
import { callStringMethod } from "./runtime/string-operations.js";
import { temporalMethod } from "./runtime/temporal-operations.js";
import { withTextLengthLimit } from "./runtime/text-length.js";
import { isList, isSet, isTemporal } from "./runtime/value-predicates.js";
import { joinedText, visibleText } from "./runtime/value-text.js";
import type { SourceSpan } from "./source.js";
import type { TemporalContext } from "./temporal.js";
import { recordValidationTestWork } from "./validation-testing.js";

export function staticNumber(expression: Expression): number | undefined {
  return runCompileTask(staticNumberTask(expression));
}

export function staticVisibleText(expression: Expression): string | undefined {
  const known = staticScalar(expression);
  return known === undefined ? undefined : scalarText(known.value);
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

function* staticNumberTask(expression: Expression): CompileTask<number | undefined> {
  let negate = false;
  while (true) {
    expression = unwrapParentheses(expression);
    if (
      expression.kind !== "unaryExpression" ||
      (expression.operator !== "+" && expression.operator !== "-")
    )
      break;
    if (expression.operator === "-") negate = !negate;
    expression = expression.operand;
  }

  let value: number | undefined;
  if (expression.kind === "numberLiteral") {
    value = expression.value;
  } else if (expression.kind === "binaryExpression") {
    const left = yield* compileChild(staticNumberTask(expression.left));
    const right = yield* compileChild(staticNumberTask(expression.right));
    if (left === undefined || right === undefined) return undefined;
    switch (expression.operator) {
      case "+":
        value = left + right;
        break;
      case "-":
        value = left - right;
        break;
      case "*":
        value = left * right;
        break;
      case "/":
        value = right === 0 ? undefined : left / right;
        break;
      case "%":
        value = right === 0 ? undefined : left % right;
        break;
      default:
        value = undefined;
        break;
    }
  }
  // A step without a finite result is a visible overflow, reported once by `findVisibleOverflows`.
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return negate ? -value : value;
}

/**
 * A scalar known at compile time: text, a finite number, a boolean, `null`, an exact or calendar duration, or an angle.
 */
export type StaticScalar = string | number | boolean | null | AnyDuration | StoredAngle;

/**
 * The value of a literal, of interpolated text whose parts are known, or of number, duration, and angle arithmetic on
 * known operands, with the runtime's operations. Anything else is `undefined`.
 */
function staticScalar(expression: Expression): { readonly value: StaticScalar } | undefined {
  return runCompileTask(staticScalarTask(expression));
}

/** Scalar visible text, as the runtime converts the value. */
function scalarText(value: StaticScalar): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(Object.is(value, -0) ? 0 : value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return isStaticAngle(value) ? formatAngle(value) : formatDuration(value);
}

function* staticScalarTask(
  expression: Expression,
): CompileTask<{ readonly value: StaticScalar } | undefined> {
  recordValidationTestWork("staticFolds");
  expression = unwrapParentheses(expression);
  switch (expression.kind) {
    case "stringLiteral": {
      const parts: string[] = [];
      for (const part of expression.parts) {
        if (part.kind === "stringText") {
          parts.push(part.value);
          continue;
        }
        const known = yield* compileChild(staticScalarTask(part.expression));
        if (known === undefined) return undefined;
        parts.push(scalarText(known.value));
      }
      return { value: parts.join("") };
    }
    case "numberLiteral":
      return finite(expression.value);
    case "booleanLiteral":
      return { value: expression.value };
    case "nullLiteral":
      return { value: null };
    case "durationLiteral": {
      const value = durationLiteralValue(expression);
      return typeof value === "string" ? undefined : finite(value);
    }
    case "unitExpression": {
      const known = yield* compileChild(staticScalarTask(expression.operand));
      if (typeof known?.value !== "number") return undefined;
      const value = unitValue(known.value, expression);
      return typeof value === "string" ? undefined : finite(value);
    }
    case "angleExpression": {
      const known = yield* compileChild(staticScalarTask(expression.operand));
      if (typeof known?.value !== "number") return undefined;
      const degrees = angleDegrees(known.value, expression.unit);
      return degrees === undefined ? undefined : { value: angleValue(degrees) };
    }
    case "unaryExpression": {
      if (expression.operator !== "+" && expression.operator !== "-") return undefined;
      const known = yield* compileChild(staticScalarTask(expression.operand));
      const value = known?.value;
      if (typeof value === "number") return { value: expression.operator === "+" ? value : -value };
      if (isStaticAngle(value))
        return { value: expression.operator === "+" ? value : angleValue(-value.degrees) };
      if (!isStaticDuration(value)) return undefined;
      return expression.operator === "+" ? { value } : { value: negateDuration(value) };
    }
    case "binaryExpression": {
      const left = yield* compileChild(staticScalarTask(expression.left));
      if (left === undefined) return undefined;
      const right = yield* compileChild(staticScalarTask(expression.right));
      if (right === undefined) return undefined;
      return finite(arithmetic(expression.operator, left.value, right.value));
    }
    default:
      return undefined;
  }
}

/**
 * Number, duration, and angle arithmetic as the runtime performs it, before its finite-result check, so an overflow or
 * a zero divisor gives a non-finite result; `undefined` for other operands.
 */
function arithmetic(
  operator: string,
  left: KnownValue,
  right: KnownValue,
): number | AnyDuration | StoredAngle | undefined {
  if (typeof left === "number" && typeof right === "number") {
    switch (operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
      case "%":
        return left % right;
      default:
        return undefined;
    }
  }
  if (isStaticAngle(left) || isStaticAngle(right))
    return (typeof left === "number" || isStaticAngle(left)) &&
      (typeof right === "number" || isStaticAngle(right))
      ? angleArithmetic(operator, left, right)
      : undefined;
  const known = (duration: AnyDuration | string) =>
    typeof duration === "string" ? undefined : duration;
  if (isStaticDuration(left) && isStaticDuration(right)) {
    if (operator === "+") return addDurations(left, right);
    if (operator === "-") return addDurations(left, right, -1);
    if (operator === "/") {
      const ratio = durationQuotient(left, right);
      return typeof ratio === "string" ? undefined : ratio;
    }
    return undefined;
  }
  if (isStaticDuration(left) && typeof right === "number") {
    if (operator === "*") return known(scaleDuration(left, right));
    if (operator === "/") return known(divideDuration(left, right));
    return undefined;
  }
  if (typeof left === "number" && isStaticDuration(right) && operator === "*")
    return known(scaleDuration(right, left));
  return undefined;
}

export function isStaticDuration(value: KnownValue | undefined): value is AnyDuration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value.kind === "duration" || value.kind === "calendarDuration")
  );
}

function isStaticAngle(value: KnownValue | undefined): value is StoredAngle {
  return typeof value === "object" && value !== null && value.kind === "angle";
}

function finite<Value extends KnownValue>(
  value: Value | undefined,
): { readonly value: Value } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? { value } : undefined;
  if (isStaticAngle(value)) return Number.isFinite(value.degrees) ? { value } : undefined;
  // Calendar parts stay whole numbers of days and months that a value can store.
  if (isStaticDuration(value)) {
    const parts = durationParts(value);
    return Number.isFinite(parts.milliseconds) &&
      Number.isSafeInteger(parts.months) &&
      Number.isSafeInteger(parts.days)
      ? { value }
      : undefined;
  }
  return { value };
}

/** A choice option value known at compile time, with `-0` as `0` like a runtime choice value. */
export function staticChoiceValue(
  expression: Expression,
): { readonly value: StaticScalar } | undefined {
  const known = staticScalar(expression);
  return known !== undefined && typeof known.value === "number" && Object.is(known.value, -0)
    ? { value: 0 }
    : known;
}

/** The message of a visible overflow by its cause. */
export const VISIBLE_OVERFLOW_MESSAGES = {
  zero: "This divides by zero, so it has no result. Divide by a value other than zero.",
  number: "This calculation gives a number too large to represent. Use smaller values.",
  duration: "This calculation gives a duration too long to represent. Use a shorter duration.",
  angle: "This calculation gives an angle too large to represent. Use a smaller angle.",
} as const;

/**
 * An arithmetic step the runtime always rejects: known operands with a non-finite result (`TSR036`), or a known zero
 * divisor, which fails for every dividend.
 */
export interface VisibleOverflow {
  readonly span: SourceSpan;
  /** `zero` for a division or remainder by zero, otherwise the kind of value that grew too large. */
  readonly cause: "zero" | "number" | "duration" | "angle";
}

const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/**
 * Every arithmetic step in the program whose operands are known (see `KnownValues`) and finite but whose result is not,
 * and every division or remainder by a known zero, in source order. A reported step is unknown to the steps around it,
 * so one overflow is reported once. `known` computes each value once, so the walk is linear in the program size.
 */
export function findVisibleOverflows(
  program: Program,
  known: KnownValues,
): readonly VisibleOverflow[] {
  const found: VisibleOverflow[] = [];
  const work: unknown[] = [program];
  while (work.length > 0) {
    const node = work.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) work.push(item);
      continue;
    }
    // Source spans hold no expressions.
    for (const [key, child] of Object.entries(node))
      if (key !== "span" && !key.endsWith("Span")) work.push(child);
    // EVIDENCE: invariant: the parser builds every AST object with a string `kind`; other kinds have no known value.
    const expression = node as Expression;
    // A known zero divisor fails for every dividend, so the dividend need not be known.
    if (dividesByKnownZero(expression, known)) {
      found.push({ span: expression.span, cause: "zero" });
      continue;
    }
    const value = knownValue(expression, (operand) => known.known(operand));
    if (value === undefined || finite(value) !== undefined) continue;
    found.push({
      span: expression.span,
      cause: isStaticDuration(value) ? "duration" : isStaticAngle(value) ? "angle" : "number",
    });
  }
  return found.sort((left, right) => left.span.start.offset - right.span.start.offset);
}

/**
 * The value of a literal number or duration, a grouping, a sign, a unit, an angle, or an arithmetic step from its
 * operands' known values, before any check, so that an overflow stays visible; `undefined` for other expressions.
 */
function knownValue(
  expression: Expression,
  known: (operand: Expression) => KnownValue | undefined,
): KnownValue | undefined {
  switch (expression.kind) {
    case "numberLiteral":
      return Number.isFinite(expression.value) ? expression.value : undefined;
    case "durationLiteral": {
      const value = durationLiteralValue(expression);
      return typeof value === "string" || !Number.isFinite(value.milliseconds) ? undefined : value;
    }
    case "parenthesizedExpression":
      return known(expression.expression);
    case "unitExpression": {
      const value = known(expression.operand);
      if (typeof value !== "number") return undefined;
      // A duration too long to represent stays known, so that its overflow is reported.
      const duration = unitValue(value, expression);
      return typeof duration === "string" ? undefined : duration;
    }
    case "angleExpression": {
      const value = known(expression.operand);
      // An angle too large to represent stays known, so that its overflow is reported.
      return typeof value === "number"
        ? angleValue(angleDegrees(value, expression.unit) ?? Infinity)
        : undefined;
    }
    case "unaryExpression": {
      const value = known(expression.operand);
      if (expression.operator === "-" && typeof value === "number") return -value;
      if (expression.operator === "-" && isStaticDuration(value)) return negateDuration(value);
      if (expression.operator === "-" && isStaticAngle(value)) return angleValue(-value.degrees);
      return expression.operator === "+" &&
        (typeof value === "number" || isStaticDuration(value) || isStaticAngle(value))
        ? value
        : undefined;
    }
    case "binaryExpression": {
      if (!ARITHMETIC_OPERATORS.has(expression.operator)) return undefined;
      const left = known(expression.left);
      const right = known(expression.right);
      return left === undefined || right === undefined
        ? undefined
        : arithmetic(expression.operator, left, right);
    }
    default:
      return undefined;
  }
}

/**
 * A division or remainder by a zero number or duration the compiler can see. The runtime rejects it for every dividend:
 * as a non-finite result where the operation is supported, and otherwise as an unsupported operation or a wrong kind.
 */
function dividesByKnownZero(expression: Expression, known: KnownValues): boolean {
  if (expression.kind !== "binaryExpression") return false;
  if (expression.operator !== "/" && expression.operator !== "%") return false;
  const divisor = known.known(expression.right);
  return (
    divisor === 0 ||
    (isStaticDuration(divisor) && durationFamily(durationParts(divisor)) === "zero") ||
    (isStaticAngle(divisor) && divisor.degrees === 0)
  );
}

/**
 * A value the compiler knows: one that every run gives an expression where it stands. It is text, a finite number, true
 * or false, null, a duration, an angle, a regex, a date or time value, or a list, set, or dict of these, as the runtime
 * holds it.
 */
export type KnownValue = SerializableRuntimeValue;

/**
 * The most work the known values of one check may take together: the UTF-16 code units of the texts and the entries of
 * the lists, sets, and dicts that they build and that their calls read, and the work of their regex searches. Past it,
 * values are not known, so that no script makes the compiler build large values or compute for long; a run has far
 * higher limits.
 */
export const KNOWN_VALUE_WORK = 10_000_000;

/**
 * The values the compiler knows (see `KnownValue`), each computed once from its operands' known values, with the
 * runtime's own operations, so a known value is the value a run gets:
 * - a literal, and text whose interpolated parts are known;
 * - arithmetic on numbers, durations, and angles, and `+` on two texts;
 * - `otherwise`, which gives its left side unless that is null, and then its right side;
 * - a list, set, or dict written with known elements;
 * - a call of a conversion, a numeric or list function, or a method of text, lists, sets, or date and time values that
 *   only reads them, with known arguments; a call that needs the player's zone or presentation is not known, and a
 *   `default:` counts where the call gives it;
 * - a variable that keeps its first value: `initializer` gives that value's expression where a read counts.
 * A step without a finite result, one that the runtime rejects, or one past `KNOWN_VALUE_WORK` is not known.
 */
export class KnownValues {
  readonly #values = new Map<Expression, KnownValue | undefined>();
  readonly #initializer: (identifier: Identifier) => Expression | undefined;
  /** The work left (see `KNOWN_VALUE_WORK`), which regex searches also use up. */
  readonly #work = { remaining: KNOWN_VALUE_WORK };
  /** The work each list, set, dict, regex, or date and time value takes (see `knownSize`), once it was measured. */
  readonly #sizes = new WeakMap<object, number>();

  public constructor(
    initializer: (identifier: Identifier) => Expression | undefined = () => undefined,
  ) {
    this.#initializer = initializer;
  }

  /**
   * The value `expression` is known to have, or `undefined`. Iterative, so a long chain of steps or variables does not
   * deepen the native stack.
   */
  public known(expression: Expression): KnownValue | undefined {
    const pending: Expression[] = [expression];
    const entered = new Set<Expression>();
    while (pending.length > 0) {
      const current = pending.at(-1)!;
      if (this.#values.has(current)) {
        pending.pop();
        continue;
      }
      if (!entered.has(current)) {
        entered.add(current);
        let missing = false;
        for (const operand of this.#operands(current))
          if (!this.#values.has(operand)) {
            pending.push(operand);
            missing = true;
          }
        if (missing) continue;
      }
      // An operand still missing here waits on this expression, which no checked program has; it is not known.
      this.#values.set(current, this.#value(current));
      pending.pop();
    }
    return this.#values.get(expression);
  }

  /** The expressions whose known values decide `expression`'s. */
  #operands(expression: Expression): readonly Expression[] {
    switch (expression.kind) {
      case "parenthesizedExpression":
        return [expression.expression];
      case "unaryExpression":
      case "unitExpression":
      case "angleExpression":
        return [expression.operand];
      case "binaryExpression":
        return ARITHMETIC_OPERATORS.has(expression.operator) || expression.operator === "otherwise"
          ? [expression.left, expression.right]
          : [];
      case "stringLiteral":
        return expression.parts.flatMap((part) =>
          part.kind === "stringInterpolation" ? [part.expression] : [],
        );
      case "listLiteral":
      case "setLiteral":
        return expression.elements;
      case "dictLiteral":
        return expression.entries.flatMap((entry) => [entry.key, entry.value]);
      case "callExpression": {
        const callee = unwrapParentheses(expression.callee);
        const values = expression.arguments.map((argument) => argument.value);
        return callee.kind === "propertyAccessExpression" ? [callee.object, ...values] : values;
      }
      case "identifier": {
        const initializer = this.#initializer(expression);
        return initializer === undefined ? [] : [initializer];
      }
      default:
        return [];
    }
  }

  /** The known value of `expression` from its operands' known values. */
  #value(expression: Expression): KnownValue | undefined {
    recordValidationTestWork("staticFolds");
    const known = (operand: Expression): KnownValue | undefined => this.#values.get(operand);
    switch (expression.kind) {
      // The same value as another expression's, which costs no work.
      case "identifier": {
        const initializer = this.#initializer(expression);
        return initializer === undefined ? undefined : known(initializer);
      }
      case "binaryExpression":
        if (expression.operator === "otherwise") {
          const left = known(expression.left);
          return left === null ? known(expression.right) : left;
        }
        break;
      // Text written without interpolation is the source's own, which costs no work.
      case "stringLiteral":
        if (expression.parts.every((part) => part.kind === "stringText"))
          return expression.parts
            .flatMap((part) => (part.kind === "stringText" ? [part.value] : []))
            .join("");
        break;
      case "booleanLiteral":
        return expression.value;
      case "nullLiteral":
        return null;
      case "regexLiteral":
        return regexFlagProblem(expression.flags) === null
          ? {
              kind: "regex",
              source: expression.source,
              flags: canonicalRegexFlags(expression.flags),
            }
          : undefined;
    }
    const value = this.#built(expression, known);
    if (value === undefined) return undefined;
    // A value that this step built takes work as large as it is.
    const size = this.#size(value);
    if (size === undefined || size > this.#work.remaining) return undefined;
    this.#work.remaining -= size;
    return finite(value)?.value;
  }

  /** The work `value` takes (see `knownSize`), measured once for each list, set, dict, or other object. */
  #size(value: KnownValue): number | undefined {
    if (typeof value === "string") return value.length;
    if (value === null || typeof value !== "object") return 0;
    let size = this.#sizes.get(value);
    if (size === undefined) {
      size = knownSize(value);
      if (size !== undefined) this.#sizes.set(value, size);
    }
    return size;
  }

  /** A value that a step builds from its operands' known values, with the runtime's operations. */
  #built(
    expression: Expression,
    known: (operand: Expression) => KnownValue | undefined,
  ): KnownValue | undefined {
    switch (expression.kind) {
      case "stringLiteral": {
        let text = "";
        for (const part of expression.parts) {
          if (part.kind === "stringText") {
            text += part.value;
            continue;
          }
          const value = known(part.expression);
          if (!isShownScalar(value)) return undefined;
          text += scalarText(value);
          if (text.length > this.#work.remaining) return undefined;
        }
        return text;
      }
      case "binaryExpression": {
        const left = known(expression.left);
        const right = known(expression.right);
        return expression.operator === "+" && typeof left === "string" && typeof right === "string"
          ? this.#run(() => joinedValue(left, right, expression.span))
          : knownValue(expression, known);
      }
      case "listLiteral":
      case "setLiteral": {
        const items: KnownValue[] = [];
        for (const element of expression.elements) {
          const value = known(element);
          if (value === undefined) return undefined;
          items.push(value);
        }
        return expression.kind === "listLiteral"
          ? createCapturedSerializableList(items)
          : createCapturedSerializableSet(items);
      }
      case "dictLiteral": {
        const dict: SerializableRuntimeDict = { kind: "dict", entries: [] };
        for (const entry of expression.entries) {
          const key = known(entry.key);
          const value = known(entry.value);
          // A key that is not text fails the run.
          if (typeof key !== "string" || value === undefined) return undefined;
          // A later entry with an equal key replaces the earlier one in its position.
          setOwnedSerializableDictValue(dict, key, cloneCapturedSerializableValue(value));
        }
        return dict;
      }
      case "callExpression": {
        // A call reads its receiver and arguments, which takes work as large as they are, also when it fails.
        let input = 0;
        for (const operand of this.#operands(expression)) {
          const value = known(operand);
          input += value === undefined ? 0 : (this.#size(value) ?? 0);
        }
        if (input > this.#work.remaining) return undefined;
        this.#work.remaining -= input;
        return this.#run(() => callValue(expression, known));
      }
      default:
        return knownValue(expression, known);
    }
  }

  /**
   * The result of a runtime operation, which may make texts and search only within the work left; `undefined` when it
   * fails, needs the session, or needs more work.
   */
  #run(operation: () => KnownValue | undefined): KnownValue | undefined {
    try {
      return withRegexWorkPool(this.#work, () =>
        withTextLengthLimit(this.#work.remaining, operation),
      );
    } catch {
      return undefined;
    }
  }
}

/**
 * The value of a call that only reads its known arguments (see `KnownValues`), as the runtime computes it, or
 * `undefined`. The runtime's failures, and a read of the session, throw.
 */
function callValue(
  call: CallExpression,
  known: (operand: Expression) => KnownValue | undefined,
): KnownValue | undefined {
  // A `default:` runs only when the call gives it.
  const lazy = lazyDefaultArgument(call);
  const positional: KnownValue[] = [];
  const named: Record<string, KnownValue> = {};
  for (const argument of call.arguments) {
    if (argument === lazy?.argument) continue;
    const value = known(argument.value);
    if (value === undefined) return undefined;
    if (argument.kind === "positionalArgument") positional.push(value);
    else named[argument.name.name] = value;
  }
  const defaulted = lazy !== null;
  const fallback = (): KnownValue | undefined =>
    lazy === null ? undefined : known(lazy.argument.value);
  const span = call.span;
  const callee = unwrapParentheses(call.callee);
  if (callee.kind === "identifier") {
    const name = callee.name;
    if (isConversion(name)) {
      const converted = conversionResult(name, positional, named, defaulted, {
        span,
        text: (value) => visibleText(value, span, NO_SESSION),
        speakerProperties: () => {
          throw NEEDS_SESSION;
        },
      });
      if (converted !== undefined) return converted;
      // A default that the conversion does not take fails the run.
      const value = fallback();
      return value !== undefined && fitsDefault(CONVERSIONS[name], value) ? value : undefined;
    }
    if (isNumericFunction(name)) return numericFunction(name, positional, named, span);
    if (isListFunction(name)) return listFunctionValue(name, positional, named, span);
    return undefined;
  }
  if (callee.kind !== "propertyAccessExpression") return undefined;
  const receiver = known(callee.object);
  const name = callee.property.name;
  // Only a list's `get` takes a named argument, its `default:`.
  if (receiver === undefined || Object.keys(named).length > 0) return undefined;
  if (typeof receiver === "string") return callStringMethod(receiver, name, positional, span);
  if (isTemporal(receiver)) return temporalMethod(receiver, name, positional, {}, NO_SESSION, span);
  if (!isList(receiver) && !isSet(receiver)) return undefined;
  if (!onlyReadsList(name) || !hasListMethod(isList(receiver) ? "list" : "set", name))
    return undefined;
  const method: ListMethod = LIST_METHODS[name];
  const required = method.parameters.filter((parameter) => !parameter.optional).length;
  if (
    method.named === undefined &&
    (positional.length < required || positional.length > method.parameters.length)
  )
    return undefined;
  const value = readCollection(receiver, name, positional, named, defaulted, span, (item) =>
    joinedText(item, span, NO_SESSION),
  );
  return value === undefined ? fallback() : value;
}

/** Thrown by a read of the session, which no value known before the script runs has. */
const NEEDS_SESSION = new Error("This value needs the session.");

/** The session's zone and presentation, which a known value never reads: a read throws `NEEDS_SESSION`. */
const NO_SESSION: TemporalContext = {
  get zone(): never {
    throw NEEDS_SESSION;
  },
  get presentation(): never {
    throw NEEDS_SESSION;
  },
};

/** A value that `${...}` shows as `scalarText` gives it. */
function isShownScalar(value: KnownValue | undefined): value is StaticScalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    isStaticDuration(value) ||
    isStaticAngle(value)
  );
}

/**
 * The work a value takes: the UTF-16 code units of its texts and regex patterns and the entries of its lists, sets, and
 * dicts, or `undefined` for a value that is not a known value (see `KnownValue`), such as an object or a range.
 */
function knownSize(value: KnownValue): number | undefined {
  let size = 0;
  const pending: KnownValue[] = [value];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (typeof item === "string") size += item.length;
    else if (item === null || typeof item !== "object") continue;
    else
      switch (item.kind) {
        case "list":
        case "set":
          size += item.items.length;
          for (const element of item.items) pending.push(element);
          break;
        case "dict":
          size += item.entries.length;
          for (const entry of item.entries) {
            size += entry.key.length;
            pending.push(entry.value);
          }
          break;
        case "regex":
          size += item.source.length;
          break;
        case "duration":
        case "calendarDuration":
        case "angle":
        case "date":
        case "time":
        case "datetime":
        case "absoluteDateTime":
          break;
        default:
          return undefined;
      }
  }
  return size;
}
