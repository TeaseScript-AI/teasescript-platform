import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

type Binary = Extract<IrExpression, { kind: "binary" }>;
type Button = Extract<IrExpression, { kind: "button" }>;

const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "!="]);
// The operator with the number on the right: `15 > t` is `t < 15`.
const MIRRORED: Readonly<Record<string, string>> = {
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

/** A variable of the program, as far as its seconds could become a duration. */
interface Variable {
  /** False once something reads or writes it where a number is needed; loop variables, parameters, and handles. */
  duration: boolean;
  /** Whether it held whole seconds: a Groovy integer variable, which truncated the button's seconds. */
  integer: boolean;
  /** Writes of a button's seconds; a variable without one keeps its numbers. */
  buttons: number;
  /** Comparisons with a number, as `variable operator number`. */
  comparisons: Array<{ operator: string; number: number }>;
  /** Waits and button timeouts that read it. */
  waits: number;
}

/**
 * Legacy showButton() returned the seconds until the click; TeaseScript's returns the elapsed duration (V30 §21), which
 * the converter divides by `1 s`. Where those seconds are only compared with numbers, the duration stays and the
 * numbers become seconds (owner decision 2026-10-07): `(showButton "Done") / 1 s < 15` becomes `(showButton "Done") <
 * 15 s`, and a variable that only buttons' seconds and number literals write, and that only comparisons with number
 * literals, waits, and button timeouts read, holds the duration, `let t = showButton "Done"` and `while t < 15 s`. A
 * variable that held whole seconds (a Groovy integer) does so only where truncation changes nothing: compared with a
 * whole number by `<` or `>=`. Where a plain number is needed, in arithmetic, text, storage, a function's result, a
 * comparison with a computed number, a parameter's default, or a script variable that other files may use (`shared`:
 * a module's, a class's fields, and those of a script that loads modules), the seconds stay.
 */
export function withElapsedDurations(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
  shared: boolean,
): IrStatement[] {
  const writes = new Map<IrStatement, Variable>();
  const comparisons = new Map<Binary, Variable>();
  const direct = new Set<Binary>();
  const root = new Scope(null);
  const functions: Array<Extract<IrStatement, { kind: "function" }>> = [];
  const numberOnly = (): Variable => ({
    duration: false,
    integer: false,
    buttons: 0,
    comparisons: [],
    waits: 0,
  });

  const expression = (value: IrExpression, scope: Scope): void => {
    if (value.kind === "binary" && COMPARISONS.has(value.operator)) {
      const right = numberValue(value.right);
      const left = numberValue(value.left);
      const side = right !== null ? value.left : left !== null ? value.right : null;
      if (side?.kind === "variable") {
        const found = scope.resolve(side.name);
        if (found !== undefined) {
          found.comparisons.push(
            right !== null
              ? { operator: value.operator, number: right }
              : { operator: MIRRORED[value.operator]!, number: left! },
          );
          comparisons.set(value, found);
          return;
        }
      }
      const button = side === null ? null : buttonSeconds(side);
      if (button !== null) {
        direct.add(value);
        expression(button, scope);
        return;
      }
    }
    if (value.kind === "variable") {
      const found = scope.resolve(value.name);
      if (found !== undefined) found.duration = false;
      return;
    }
    if (value.kind === "button" && value.timeout?.kind === "variable") {
      const found = scope.resolve(value.timeout.name);
      if (found !== undefined) found.waits += 1;
      expression(value.label, scope);
      return;
    }
    mapChildren(value, (child) => {
      expression(child, scope);
      return child;
    });
  };
  const write = (target: Variable, value: IrExpression, scope: Scope): void => {
    const truncated =
      value.kind === "call" && value.name === "toInteger" && value.positional.length === 1
        ? value.positional[0]!
        : null;
    const button = buttonSeconds(truncated ?? value);
    if (button !== null) {
      target.buttons += 1;
      if (truncated !== null) target.integer = true;
      expression(button, scope);
      return;
    }
    if (numberValue(value) === null) {
      target.duration = false;
      expression(value, scope);
    }
  };
  const statement = (item: IrStatement, scope: Scope): void => {
    switch (item.kind) {
      case "let": {
        const variable: Variable = {
          ...numberOnly(),
          duration:
            item.global !== true &&
            item.maybeText !== true &&
            !(shared && scope === root) &&
            (item.type === undefined || item.type === "number" || item.type === "integer"),
          integer: item.integer === true,
        };
        write(variable, item.value, scope);
        scope.names.set(item.name, variable);
        writes.set(item, variable);
        return;
      }
      case "assign": {
        const found = item.target.kind === "variable" ? scope.resolve(item.target.name) : undefined;
        if (found === undefined) break;
        if (item.operator === "=") {
          write(found, item.value, scope);
          writes.set(item, found);
        } else {
          found.duration = false;
          expression(item.value, scope);
        }
        return;
      }
      case "wait":
      case "showButton": {
        const read = item.kind === "wait" ? item.duration : item.timeout;
        const found =
          read?.kind === "variable" && (item.kind !== "wait" || item.unit === "s")
            ? scope.resolve(read.name)
            : undefined;
        if (found === undefined) break;
        found.waits += 1;
        if (item.kind === "showButton") expression(item.label, scope);
        return;
      }
      case "function":
        // A script's functions see all its variables, also those declared after them; a nested one sees its own.
        if (scope === root) functions.push(item);
        else body(item, new Scope(scope));
        return;
      case "for": {
        expression(item.collection, scope);
        const inner = new Scope(scope);
        inner.names.set(item.variable, numberOnly());
        if (item.valueVariable !== undefined) inner.names.set(item.valueVariable, numberOnly());
        walk(item.body, inner);
        return;
      }
      case "speaker":
        for (const property of item.properties) expression(property.value, scope);
        return;
      default:
        break;
    }
    mapOwnExpressions(item, (value) => {
      expression(value, scope);
      return value;
    });
    withNestedBlocks(item, (items) => {
      walk(items, new Scope(scope));
      return items;
    });
  };
  const walk = (items: readonly IrStatement[], scope: Scope): void => {
    for (const item of items) statement(item, scope);
  };
  // A parameter's default stays as it is, so every variable it reads keeps its numbers.
  const keepNumbers = (value: IrExpression, scope: Scope): void => {
    if (value.kind === "variable") {
      const found = scope.resolve(value.name);
      if (found !== undefined) found.duration = false;
    }
    mapChildren(value, (child) => {
      keepNumbers(child, scope);
      return child;
    });
  };
  const body = (item: Extract<IrStatement, { kind: "function" }>, scope: Scope): void => {
    for (const parameter of item.parameters) {
      if (parameter.defaultValue !== null) keepNumbers(parameter.defaultValue, scope);
      scope.names.set(parameter.name, numberOnly());
    }
    walk(item.body, scope);
  };
  walk(statements, root);
  for (const item of functions) body(item, new Scope(root));

  const converted = (variable: Variable): boolean =>
    variable.duration &&
    variable.buttons > 0 &&
    (!variable.integer ||
      (variable.waits === 0 &&
        variable.comparisons.every(
          ({ operator, number }) =>
            Number.isInteger(number) && (operator === "<" || operator === ">="),
        )));
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  let current: IrStatement | null = null;
  const rewriteExpression = (value: IrExpression): IrExpression => {
    let next = value;
    if (value.kind === "binary") {
      const variable = comparisons.get(value);
      if ((variable !== undefined && converted(variable)) || direct.has(value)) {
        next = { ...value, left: durationValue(value.left), right: durationValue(value.right) };
        if (direct.has(value))
          report(
            "SX_BUTTON_DURATION",
            "The button's waiting time is compared with seconds, so it stays a duration, compared with a duration.",
            current!,
          );
      }
    }
    return mapChildren(next, rewriteExpression);
  };
  const rewrite = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      let next = withNestedBlocks(item, rewrite);
      const target = writes.get(item);
      if (target !== undefined && converted(target)) {
        if (next.kind === "let") {
          const { type: _type, integer: _integer, ...declared } = next;
          next = { ...declared, value: durationValue(next.value) };
          report(
            "SX_BUTTON_DURATION_VARIABLE",
            "This variable holds the time a button waited, which it is only compared with as seconds, waited for, or used as a timeout, so it stays a duration.",
            item,
          );
        } else if (next.kind === "assign") next = { ...next, value: durationValue(next.value) };
      }
      current = item;
      return mapOwnExpressions(next, rewriteExpression);
    });
  return rewrite(statements);
}

class Scope {
  readonly names = new Map<string, Variable>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  resolve(name: string): Variable | undefined {
    return this.names.get(name) ?? this.parent?.resolve(name);
  }
}

/** The button whose seconds `value` divides out, `(showButton ...) / 1 s`; null for any other value. */
function buttonSeconds(value: IrExpression): Button | null {
  return value.kind === "binary" &&
    value.operator === "/" &&
    value.left.kind === "button" &&
    value.right.kind === "duration" &&
    value.right.value === 1 &&
    value.right.unit === "s"
    ? value.left
    : null;
}

function numberValue(value: IrExpression): number | null {
  return value.kind === "literal" && typeof value.value === "number" && Number.isFinite(value.value)
    ? value.value
    : null;
}

function seconds(value: number): IrExpression {
  return { kind: "duration", value, unit: "s" };
}

/** A written value as a duration: the button itself, or a number as seconds. */
function durationValue(value: IrExpression): IrExpression {
  const inner = value.kind === "call" && value.name === "toInteger" ? value.positional[0]! : value;
  const number = numberValue(inner);
  return number !== null ? seconds(number) : (buttonSeconds(inner) ?? value);
}
