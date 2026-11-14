import { isRecord } from "./ast.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";

/**
 * Legacy `int ms = seconds * 1000` followed by `sleep(ms)` waited the seconds in whole milliseconds: where the variable
 * serves only such waits, they wait the seconds, `wait seconds s` (V30 keeps a wait's fraction), and the variable goes.
 * The seconds are a parameter of the function, or a variable declared once in it (or in the file's top level), that
 * nothing assigns again, not even a function declared inside, which may run between the computation and a wait; so each
 * wait reads the value the variable was computed from. A remainder below a millisecond, which legacy dropped, is kept.
 */
export function withSecondWaits(statements: IrStatement[]): IrStatement[] {
  return scope(statements, []).map((statement) =>
    statement.kind === "function"
      ? {
          ...statement,
          body: scope(
            statement.body,
            statement.parameters.map(({ name }) => name),
          ),
        }
      : statement,
  );
}

/**
 * The waits of one function body or top level with its `parameters`; the functions declared in it count where they
 * read or assign a variable, and their own waits stay.
 */
function scope(body: IrStatement[], parameters: readonly string[]): IrStatement[] {
  const replaced = new Map<string, IrExpression>();
  each(body, (statement) => {
    if (statement.kind !== "let") return;
    const seconds = secondsOf(statement.value);
    const name = statement.name;
    if (seconds === null || count(body, isDeclaration(name)) !== 1) return;
    const declared =
      count(body, isDeclaration(seconds.name)) + (parameters.includes(seconds.name) ? 1 : 0);
    if (declared !== 1) return;
    if (count(body, isAssignment(name)) > 0 || count(body, isAssignment(seconds.name)) > 0) return;
    // Every reference is a wait that the rewrite reaches, each holding one.
    let waits = 0;
    each(body, (item) => {
      if (item.kind === "wait" && millisecondsOf(item) === name) waits += 1;
    });
    if (count(body, isReference(name)) === waits) replaced.set(name, seconds);
  });
  if (replaced.size === 0) return body;
  const rewrite = (items: IrStatement[]): IrStatement[] =>
    items.flatMap((item): IrStatement[] => {
      if (item.kind === "function") return [item];
      if (item.kind === "let" && replaced.has(item.name)) return [];
      const next = withNestedBlocks(item, rewrite);
      const seconds = next.kind === "wait" ? replaced.get(millisecondsOf(next) ?? "") : undefined;
      return [
        seconds !== undefined && next.kind === "wait"
          ? { ...next, duration: seconds, unit: "s" }
          : next,
      ];
    });
  return rewrite(body);
}

/** `toInteger(seconds * 1000)` of a variable; null for another value. */
function secondsOf(value: IrExpression): Extract<IrExpression, { kind: "variable" }> | null {
  if (value.kind !== "call" || value.name !== "toInteger") return null;
  const [product] = value.positional;
  if (product?.kind !== "binary" || product.operator !== "*") return null;
  return product.left.kind === "variable" &&
    product.right.kind === "literal" &&
    product.right.value === 1000
    ? product.left
    : null;
}

/** The variable a wait of milliseconds waits, `wait ms ms`; null for another wait. */
function millisecondsOf(statement: Extract<IrStatement, { kind: "wait" }>): string | null {
  return statement.unit === "ms" && statement.duration.kind === "variable"
    ? statement.duration.name
    : null;
}

/** Visits every statement of the blocks, nested ones too, outside the functions they declare. */
function each(items: IrStatement[], visit: (statement: IrStatement) => void): void {
  for (const item of items) {
    if (item.kind === "function") continue;
    visit(item);
    withNestedBlocks(item, (body) => {
      each(body, visit);
      return body;
    });
  }
}

/** The IR nodes below a value, statements and expressions alike, also of nested functions, that `test` accepts. */
function count(value: unknown, test: (node: Record<string, unknown>) => boolean): number {
  if (Array.isArray(value))
    return value.reduce((total: number, item) => total + count(item, test), 0);
  if (!isRecord(value)) return 0;
  return Object.values(value).reduce(
    (total: number, child) => total + count(child, test),
    test(value) ? 1 : 0,
  );
}

const isDeclaration =
  (name: string) =>
  (node: Record<string, unknown>): boolean =>
    (node.kind === "let" && node.name === name) ||
    (node.kind === "for" && node.variable === name) ||
    (node.kind === "function" &&
      Array.isArray(node.parameters) &&
      node.parameters.some((parameter) => isRecord(parameter) && parameter.name === name));

const isAssignment =
  (name: string) =>
  (node: Record<string, unknown>): boolean =>
    node.kind === "assign" && isRecord(node.target) && isReference(name)(node.target);

const isReference =
  (name: string) =>
  (node: Record<string, unknown>): boolean =>
    node.kind === "variable" && node.name === name;
