import { isRecord } from "./ast.ts";
import { ACTION_DISPATCHER } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";

/** The helper that turns a value that may be a list or one element into a list (variable typing's `listPart`). */
const LIST_PART = "sexscriptLegacyListPart";

/**
 * Groovy `list += [x]` and `list += value` append: TeaseScript `list += [x]`, `list = list + [x]` on a field or an
 * element, and a computed `[f(x)]` build a new list from a copy, so a loop that appends copies the whole list on every
 * pass. They append in place instead, `list.add(x)` or `list.addAll(value)`, as `<<` already does.
 *
 * `list + [f(x)]` read the list before it called f, so where a call in the appended value may change the list, the
 * append stays as it was: a function of this file that writes it, or, for a list that is not a function's own local
 * (the script's, which may become a global, or a variable of the script that a module's function sets), a function of
 * another file, or one of this file that calls into another file.
 */
export function withListAppends(statements: IrStatement[]): IrStatement[] {
  const written = functionWrites(statements);
  const scopes = declarationScopes(statements);
  const defined = new Set(
    statements.flatMap((statement) => (statement.kind === "function" ? [statement.name] : [])),
  );
  const foreign = foreignCallers(statements, defined);
  const risky =
    (base: string) =>
    (call: Record<string, unknown>): boolean => {
      const local = scopes.local.has(base) && !scopes.script.has(base);
      const name = typeof call.name === "string" ? call.name : "";
      // The dispatcher may run any closure the script keeps, which may call another file.
      if (call.name === ACTION_DISPATCHER) return written.has(base) || !local;
      if (call.local !== true) return false;
      if (!defined.has(name) || foreign.has(name)) return !local;
      return written.has(base);
    };
  const block = (items: readonly IrStatement[]): IrStatement[] =>
    items.map((item) => {
      if (item.kind === "assign") return inPlace(item, risky) ?? item;
      return mapBlocks(item, block);
    });
  return block(statements);
}

/** The names declared inside functions (locals, parameters, loop variables) and those declared outside any. */
function declarationScopes(statements: readonly IrStatement[]): {
  local: Set<string>;
  script: Set<string>;
} {
  const local = new Set<string>();
  const script = new Set<string>();
  const visit = (value: unknown, inFunction: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inFunction);
      return;
    }
    if (!isRecord(value)) return;
    const names = inFunction ? local : script;
    if (value.kind === "let" && typeof value.name === "string") names.add(value.name);
    if (value.kind === "for") {
      if (typeof value.variable === "string") names.add(value.variable);
      if (typeof value.valueVariable === "string") names.add(value.valueVariable);
    }
    if (value.kind === "function" && Array.isArray(value.parameters))
      for (const parameter of value.parameters)
        if (isRecord(parameter) && typeof parameter.name === "string") local.add(parameter.name);
    for (const child of Object.values(value)) visit(child, inFunction || value.kind === "function");
  };
  visit(statements, false);
  return { local, script };
}

/** This file's functions that may run another file's code: they call a function not defined here, or such a function. */
function foreignCallers(
  statements: readonly IrStatement[],
  defined: ReadonlySet<string>,
): Set<string> {
  const calls = new Map<string, Set<string>>();
  for (const statement of statements) {
    if (statement.kind !== "function") continue;
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!isRecord(value)) return;
      // The action dispatcher may run any closure the script keeps, which may call another file.
      if (
        value.kind === "call" &&
        (value.local === true || value.name === ACTION_DISPATCHER) &&
        typeof value.name === "string"
      )
        names.add(value.name);
      for (const child of Object.values(value)) visit(child);
    };
    visit(statement.parameters);
    visit(statement.body);
    calls.set(statement.name, names);
  }
  const foreign = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, callees] of calls)
      if (
        !foreign.has(name) &&
        [...callees].some((callee) => !defined.has(callee) || foreign.has(callee))
      ) {
        foreign.add(name);
        changed = true;
      }
  }
  return foreign;
}

/** An append as `target.add(x)` or `target.addAll(value)`, or null where the assignment is not one or must stay. */
function inPlace(
  statement: Extract<IrStatement, { kind: "assign" }>,
  risky: (base: string) => (call: Record<string, unknown>) => boolean,
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
  if (base === null || changesBase(appended, base, risky(base))) return null;
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
 * value, or a call that may run code that writes it (`risky`).
 */
function changesBase(
  value: unknown,
  base: string,
  risky: (call: Record<string, unknown>) => boolean,
): boolean {
  if (Array.isArray(value)) return value.some((item) => changesBase(item, base, risky));
  if (!isRecord(value)) return false;
  if (value.kind === "methodCall" && isRecord(value.target) && baseOf(value.target) === base)
    return true;
  if (value.kind === "call" && risky(value)) return true;
  return Object.values(value).some((child) => changesBase(child, base, risky));
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
