import { isRecord } from "./ast.ts";
import type { IrExpression, IrStatement } from "./ir.ts";

/**
 * Legacy waitWithGauge counted its gauge up to the seconds in whole milliseconds, `(int) (seconds * 1000)`
 * (ss.desktop.MainFrame.waitWithGaugeFromScript), and so did not wait at all for a negative number, or for a remainder
 * below a millisecond that decimal arithmetic left, where a TeaseScript timer stops the script or, late in a session,
 * cannot place a deadline that close (TSR050). Seconds not certain to be at least 0 count in whole milliseconds from 0,
 * `toInteger(max(seconds, 0) * 1000) ms` (debbie2's `10 * (size - 0.3) - nr`); legacy's steps of 40 milliseconds are
 * not kept.
 *
 * Certain are a literal at least 0, `randomInteger(a..b)` with such an `a`, a random number below such a bound, the
 * sum, product, rounding, absolute value, or maximum with such numbers, and a variable that every write of the file sets
 * to such a number (withProvenGaugeWaits); a load, an answer, a parameter, or a loop variable is not.
 */
export function gaugeDuration(seconds: IrExpression): { duration: IrExpression; unit: "s" | "ms" } {
  if (certain(seconds, new Set())) return { duration: seconds, unit: "s" };
  const counted: IrExpression = {
    kind: "call",
    name: "max",
    positional: [seconds, { kind: "literal", value: 0 }],
    named: {},
  };
  return {
    duration: {
      kind: "call",
      name: "toInteger",
      positional: [
        { kind: "binary", operator: "*", left: counted, right: { kind: "literal", value: 1000 } },
      ],
      named: {},
    },
    unit: "ms",
  };
}

/** The seconds of a gauge wait in whole milliseconds, `toInteger(max(seconds, 0) * 1000)`; null for another value. */
export function countedSeconds(duration: IrExpression): IrExpression | null {
  if (duration.kind !== "call" || duration.name !== "toInteger") return null;
  const [product] = duration.positional;
  if (product?.kind !== "binary" || product.operator !== "*") return null;
  const [counted, thousand] = [product.left, product.right];
  if (thousand.kind !== "literal" || thousand.value !== 1000) return null;
  if (counted.kind !== "call" || counted.name !== "max") return null;
  const [seconds, zero] = counted.positional;
  return seconds !== undefined && zero?.kind === "literal" && zero.value === 0 ? seconds : null;
}

function certain(value: IrExpression, variables: ReadonlySet<string>): boolean {
  const known = (item: IrExpression): boolean => certain(item, variables);
  if (value.kind === "literal") return typeof value.value === "number" && value.value >= 0;
  if (value.kind === "variable") return variables.has(value.name);
  if (value.kind === "binary")
    return (
      (value.operator === "+" || value.operator === "*") && known(value.left) && known(value.right)
    );
  if (value.kind !== "call" || value.local === true) return false;
  const [first] = value.positional;
  if (value.name === "abs") return value.positional.length === 1;
  if (value.name === "max") return value.positional.some(known);
  if (value.name === "randomInteger") return first?.kind === "range" && known(first.from);
  if (["round", "floor", "ceil", "sexscriptLegacyRandom"].includes(value.name))
    return value.positional.length === 1 && first !== undefined && known(first);
  return false;
}

/**
 * The gauge waits whose `toInteger(max(seconds, 0) * 1000) ms` reads only variables that every write of the file sets to
 * a number certain to be at least 0, which then wait for the seconds as they are. A variable counts where each of its writes is such a
 * number given the others (`let lineWait = 2`, `lineWait += 1`), and it is not a parameter or a loop variable. A
 * variable of the script, outside every function, does not count where the file calls a function of another file,
 * which may set it as a global.
 */
export function withProvenGaugeWaits(statements: IrStatement[]): IrStatement[] {
  const proven = provenVariables(statements);
  if (proven.size === 0) return statements;
  const block = (items: readonly IrStatement[]): IrStatement[] =>
    items.map((item): IrStatement => {
      if (item.kind === "wait" && item.visible && item.unit === "ms") {
        const seconds = countedSeconds(item.duration);
        return seconds !== null && certain(seconds, proven)
          ? { ...item, duration: seconds, unit: "s" }
          : item;
      }
      switch (item.kind) {
        case "function":
        case "while":
        case "repeat":
        case "for":
          return { ...item, body: block(item.body) };
        case "if":
          return { ...item, then: block(item.then), else: block(item.else) };
        case "switch":
          return {
            ...item,
            cases: item.cases.map((switchCase) => ({
              ...switchCase,
              body: block(switchCase.body),
            })),
            default: block(item.default),
          };
        case "permanentButton":
          return item.body === undefined ? item : { ...item, body: block(item.body) };
        default:
          return item;
      }
    });
  return block(statements);
}

/** The variables that every write of the file sets to a number certain to be at least 0. */
function provenVariables(statements: readonly IrStatement[]): Set<string> {
  const writes = new Map<string, Array<{ operator: string; value: IrExpression }>>();
  const excluded = new Set<string>();
  const local = new Set<string>();
  const script = new Set<string>();
  const defined = new Set(
    statements.flatMap((statement) => (statement.kind === "function" ? [statement.name] : [])),
  );
  let callsOut = false;
  const write = (name: string, operator: string, value: IrExpression): void => {
    writes.set(name, [...(writes.get(name) ?? []), { operator, value }]);
  };
  const visit = (value: unknown, inFunction: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inFunction);
      return;
    }
    if (!isRecord(value)) return;
    if (
      value.kind === "call" &&
      value.local === true &&
      typeof value.name === "string" &&
      !defined.has(value.name)
    )
      callsOut = true;
    if (value.kind === "let" && typeof value.name === "string" && isExpression(value.value)) {
      write(value.name, "=", value.value);
      (inFunction ? local : script).add(value.name);
    }
    if (value.kind === "assign" && isRecord(value.target) && isExpression(value.value)) {
      const target = value.target;
      if (target.kind === "variable" && typeof target.name === "string")
        write(target.name, String(value.operator), value.value);
    }
    if (value.kind === "for") {
      if (typeof value.variable === "string") excluded.add(value.variable);
      if (typeof value.valueVariable === "string") excluded.add(value.valueVariable);
    }
    if (value.kind === "function" && Array.isArray(value.parameters))
      for (const parameter of value.parameters)
        if (isRecord(parameter) && typeof parameter.name === "string") excluded.add(parameter.name);
    for (const child of Object.values(value)) visit(child, inFunction || value.kind === "function");
  };
  visit(statements, false);
  // Every variable starts proven, and one with a write that is not certain given the others drops out, until none
  // does: each write keeps a variable at least 0 where the variables it reads are.
  const proven = new Set(
    [...writes.keys()].filter(
      (name) =>
        !excluded.has(name) &&
        (local.has(name) || script.has(name)) &&
        !(callsOut && script.has(name)),
    ),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const name of proven) {
      const kept = writes
        .get(name)!
        .every(
          ({ operator, value }) =>
            (operator === "=" || operator === "+=" || operator === "*=") && certain(value, proven),
        );
      if (!kept) {
        proven.delete(name);
        changed = true;
      }
    }
  }
  return proven;
}

const EXPRESSION_KINDS = new Set([
  "literal",
  "variable",
  "list",
  "object",
  "index",
  "property",
  "typeTest",
  "methodCall",
  "load",
  "choice",
  "listChoice",
  "input",
  "range",
  "duration",
  "message",
  "button",
  "unary",
  "binary",
  "call",
  "template",
]);

function isExpression(value: unknown): value is IrExpression {
  return isRecord(value) && typeof value.kind === "string" && EXPRESSION_KINDS.has(value.kind);
}
