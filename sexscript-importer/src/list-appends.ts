import { isRecord } from "./ast.ts";
import { ACTION_DISPATCHER } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { STEP_DRIVER } from "./tail-calls.ts";

/** The helper that turns a value that may be a list or one element into a list (variable typing's `listPart`). */
const LIST_PART = "sexscriptLegacyListPart";

/**
 * Groovy `list += [x]` and `list += value` append: TeaseScript `list += [x]`, `list = list + [x]` on a field or an
 * element, and a computed `[f(x)]` build a new list from a copy, so a loop that appends copies the whole list on every
 * pass. They append in place instead, `list.add(x)` or `list.addAll(value)`, as `<<` already does.
 *
 * `list + [f(x)]` read the list before it called f, so where a function may change the list, which a call in the
 * appended value could run, the append stays as it was.
 */
export function withListAppends(statements: IrStatement[]): IrStatement[] {
  const written = functionWrites(statements);
  const block = (items: readonly IrStatement[]): IrStatement[] =>
    items.map((item) => {
      if (item.kind === "assign") return inPlace(item, written) ?? item;
      return mapBlocks(item, block);
    });
  return block(statements);
}

/** An append as `target.add(x)` or `target.addAll(value)`, or null where the assignment is not one or must stay. */
function inPlace(
  statement: Extract<IrStatement, { kind: "assign" }>,
  written: ReadonlySet<string>,
): IrStatement | null {
  const { target } = statement;
  const appended =
    statement.operator === "+="
      ? statement.value
      : statement.operator === "=" &&
          statement.value.kind === "binary" &&
          statement.value.operator === "+" &&
          sameExpression(statement.value.left, target)
        ? statement.value.right
        : null;
  if (appended === null) return null;
  const isPart = appended.kind === "call" && appended.name === LIST_PART;
  if (!(appended.kind === "list" && appended.items.length > 0 && appended.set !== true) && !isPart)
    return null;
  const base = baseName(target);
  if (base === null || changesBase(appended, base, written.has(base))) return null;
  const call: IrExpression =
    appended.kind === "list" && appended.items.length === 1
      ? { kind: "methodCall", target, name: "add", arguments: [appended.items[0]!] }
      : { kind: "methodCall", target, name: "addAll", arguments: [appended] };
  return { kind: "expression", expression: call, span: statement.span };
}

/** The variable at the root of a target: `list`, `record.items`, `lists[0]`. */
function baseName(target: IrExpression): string | null {
  if (target.kind === "variable") return target.name;
  if (target.kind === "property" || target.kind === "index") return baseName(target.target);
  return null;
}

/**
 * Whether computing the appended value may change the variable it is appended to: a method of that variable's
 * value, or, where a function writes the variable, a call that may run one.
 */
function changesBase(value: unknown, base: string, writtenByFunctions: boolean): boolean {
  if (Array.isArray(value))
    return value.some((item) => changesBase(item, base, writtenByFunctions));
  if (!isRecord(value)) return false;
  if (value.kind === "methodCall" && isRecord(value.target) && baseOf(value.target) === base)
    return true;
  if (
    writtenByFunctions &&
    value.kind === "call" &&
    (value.local === true || value.name === ACTION_DISPATCHER || value.name === STEP_DRIVER)
  )
    return true;
  return Object.values(value).some((child) => changesBase(child, base, writtenByFunctions));
}

function baseOf(value: Record<string, unknown>): string | null {
  if (value.kind === "variable" && typeof value.name === "string") return value.name;
  if ((value.kind === "property" || value.kind === "index") && isRecord(value.target))
    return baseOf(value.target);
  return null;
}

/** The methods of a list, set, dict, or object that change it. */
const CHANGING_METHODS = new Set([
  "add",
  "addAll",
  "clear",
  "remove",
  "removeAt",
  "removeFirst",
  "removeLast",
  "shuffle",
  "sort",
]);

/** The variables that a function's body assigns or changes with a method, which a call may change. */
function functionWrites(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown, inFunction: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inFunction);
      return;
    }
    if (!isRecord(value)) return;
    const inside = inFunction || value.kind === "function";
    if (inside && value.kind === "assign" && isRecord(value.target)) {
      const name = baseOf(value.target);
      if (name !== null) names.add(name);
    }
    if (
      inside &&
      value.kind === "methodCall" &&
      typeof value.name === "string" &&
      CHANGING_METHODS.has(value.name) &&
      isRecord(value.target)
    ) {
      const name = baseOf(value.target);
      if (name !== null) names.add(name);
    }
    for (const child of Object.values(value)) visit(child, inside);
  };
  visit(statements, false);
  return names;
}

function sameExpression(left: IrExpression, right: IrExpression): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The statement with the blocks directly inside it mapped. */
function mapBlocks(
  statement: IrStatement,
  map: (items: readonly IrStatement[]) => IrStatement[],
): IrStatement {
  switch (statement.kind) {
    case "function":
    case "while":
    case "repeat":
    case "for":
      return { ...statement, body: map(statement.body) };
    case "if":
      return { ...statement, then: map(statement.then), else: map(statement.else) };
    case "switch":
      return {
        ...statement,
        cases: statement.cases.map((switchCase) => ({ ...switchCase, body: map(switchCase.body) })),
        default: map(statement.default),
      };
    case "permanentButton":
      return statement.body === undefined ? statement : { ...statement, body: map(statement.body) };
    default:
      return statement;
  }
}
