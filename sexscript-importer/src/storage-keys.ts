import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * A storage key written as one literal keeps one type for the whole script, and a `load` of it without `default:` may
 * be null, which a value cannot be used as (ADR 0021 §6, V30 §25). Legacy `load()` read null for a missing key: a read
 * whose null reaches nothing that could tell it from an empty value gets the empty value of its type as its default
 * (`load "level", default: 0`), and any other read keeps its null, the script's own test of it.
 *
 * withFillableLoads marks those reads in a file (`fill`), after variable typing, which writes the type of each value
 * saved under a literal key on its `save` (`valueType`); withStorageDefaults gives the marked reads their defaults, of
 * the type legacy read (`read`) or, for a plain `load`, of the type the saves of the whole package give the key.
 *
 * A read's value is used up where null and the empty value act alike or the script failed or showed `null`: as text,
 * in arithmetic or an order comparison, as a condition, as the receiver of a member, method, or index, and compared
 * with a literal that is neither null nor empty. A read into a variable is marked where every use of the variable, by
 * name in the whole file, is such a use; a read or variable compared with null or an empty literal, or passed on,
 * returned, saved, or held in a list or another variable, keeps its null.
 */
export function withFillableLoads(statements: IrStatement[]): IrStatement[] {
  const passed = new Set<string>();
  const usedUp = new Set<IrExpression>();
  const into = new Map<IrExpression, string>();
  const visit = (value: IrExpression, use: Use): void => {
    if (value.kind === "variable" && use === "passed") passed.add(value.name);
    if (value.kind === "load" && use === "usedUp") usedUp.add(value);
  };
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      statementUses(item, visit, into);
      withNestedBlocks(item, (body) => {
        block(body);
        return body;
      });
    }
  };
  block(statements);
  const mark = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, mark);
    const target = into.get(value);
    const fills = usedUp.has(value) || (target !== undefined && !passed.has(target));
    return fills && fillable(next) ? { ...next, fill: true } : next;
  };
  const marked = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, marked), mark));
  return marked(statements);
}

/** How a value is used: up, where null acted as an empty value would, or passed on, where it may be told apart. */
type Use = "usedUp" | "passed";

const USED_UP_OPERATORS = new Set(["+", "-", "*", "/", "%", "<", ">", "<=", ">=", "and", "or"]);

/** Visits the values a statement evaluates with their uses; a read a variable is set to goes in `into`. */
function statementUses(
  item: IrStatement,
  visit: (value: IrExpression, use: Use) => void,
  into: Map<IrExpression, string>,
): void {
  const uses = (value: IrExpression, use: Use): void => valueUses(value, use, visit);
  switch (item.kind) {
    case "let":
      if (item.value.kind === "load") into.set(item.value, item.name);
      uses(item.value, "passed");
      return;
    case "assign":
      if (item.target.kind === "variable") {
        if (item.operator === "=" && item.value.kind === "load")
          into.set(item.value, item.target.name);
        if (item.operator !== "=") uses(item.target, "usedUp");
      } else uses(item.target, "usedUp");
      uses(item.value, item.operator === "=" ? "passed" : "usedUp");
      return;
    case "say":
    case "if":
    case "while":
    case "repeat":
    case "for":
    case "wait":
    case "expression":
      mapOwnExpressions(item, (value) => {
        uses(value, "usedUp");
        return value;
      });
      return;
    case "save":
      uses(item.key, "usedUp");
      uses(item.value, "passed");
      return;
    default:
      mapOwnExpressions(item, (value) => {
        uses(value, "passed");
        return value;
      });
  }
}

function valueUses(
  value: IrExpression,
  use: Use,
  visit: (value: IrExpression, use: Use) => void,
): void {
  visit(value, use);
  const uses = (child: IrExpression, childUse: Use): void => valueUses(child, childUse, visit);
  switch (value.kind) {
    case "template":
      for (const part of value.parts) if ("value" in part) uses(part.value, "usedUp");
      return;
    case "binary":
      if (value.operator === "==" || value.operator === "!=") {
        uses(value.left, telling(value.right) ? "passed" : "usedUp");
        uses(value.right, telling(value.left) ? "passed" : "usedUp");
        return;
      }
      uses(value.left, USED_UP_OPERATORS.has(value.operator) ? "usedUp" : "passed");
      uses(value.right, USED_UP_OPERATORS.has(value.operator) ? "usedUp" : "passed");
      return;
    case "unary":
      uses(value.value, "usedUp");
      return;
    case "property":
      uses(value.target, "usedUp");
      return;
    case "methodCall":
      uses(value.target, "usedUp");
      for (const argument of value.arguments) uses(argument, "passed");
      return;
    case "index":
      uses(value.target, "usedUp");
      uses(value.index, "usedUp");
      return;
    default:
      mapChildren(value, (child) => {
        uses(child, "passed");
        return child;
      });
  }
}

/** Whether a comparison with this value could tell null from an empty value: anything but a literal that is neither. */
function telling(value: IrExpression): boolean {
  if (value.kind !== "literal") return true;
  return value.value === null || value.value === "" || value.value === 0 || value.value === false;
}

/**
 * The package's literal keys typed from what is saved under them, as the compiler types them: the saves decide, an
 * integer widens to a number, and other mixed types decide no type here; with no typed save, the literal defaults
 * decide. Each read marked by withFillableLoads gets the empty value of its key's type as its default.
 */
export function withStorageDefaults(programs: readonly MigrationProgram[]): MigrationProgram[] {
  const saved = new Map<string, Set<string>>();
  const defaulted = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, key: string, type: string | null): void => {
    if (type === null) return;
    const types = map.get(key) ?? new Set<string>();
    types.add(type);
    map.set(key, types);
  };
  const collect = (value: IrExpression): IrExpression => {
    const key = value.kind === "load" ? literalKey(value.key) : null;
    if (key !== null && value.kind === "load" && value.defaultValue !== undefined)
      note(defaulted, key, valueType(value.defaultValue));
    return mapChildren(value, collect);
  };
  const scan = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      const key = item.kind === "save" ? literalKey(item.key) : null;
      if (key !== null && item.kind === "save")
        note(saved, key, item.valueType?.replace(/\?$/u, "") ?? valueType(item.value));
      return mapOwnExpressions(withNestedBlocks(item, scan), collect);
    });
  for (const program of programs) scan(program.statements);
  const keyType = (key: string): string | null =>
    keptType(saved.get(key)) ?? (saved.has(key) ? null : keptType(defaulted.get(key)));

  const fill = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, fill);
    if (next.kind !== "load" || next.fill !== true) return next;
    const { fill: _fill, ...load } = next;
    const key = literalKey(load.key);
    // A legacy loadString or loadBoolean read has its own type; a plain load, the type the saves give its key.
    const type = load.read ?? (key === null ? null : keyType(key));
    const empty = type === null ? null : emptyValue(type);
    return empty === null ? load : { ...load, defaultValue: empty };
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), fill));
  return programs.map((program) => ({ ...program, statements: block(program.statements) }));
}

function fillable(value: IrExpression): value is Extract<IrExpression, { kind: "load" }> {
  return (
    value.kind === "load" &&
    value.defaultValue === undefined &&
    value.integer !== true &&
    value.number !== true &&
    literalKey(value.key) !== null
  );
}

function literalKey(key: IrExpression): string | null {
  return key.kind === "literal" && typeof key.value === "string" ? key.value : null;
}

/** The one type of a key's values: an integer and a number make a number; other mixes, none. */
function keptType(types: ReadonlySet<string> | undefined): string | null {
  if (types === undefined || types.size === 0) return null;
  if (types.size === 1) return [...types][0]!;
  return types.size === 2 && types.has("integer") && types.has("number") ? "number" : null;
}

/** The type of a value the importer generates or a literal; null where it is not known here. */
function valueType(value: IrExpression): string | null {
  switch (value.kind) {
    case "literal":
      if (typeof value.value === "string") return "string";
      if (typeof value.value === "boolean") return "boolean";
      if (typeof value.value === "number")
        return value.decimal !== true && Number.isInteger(value.value) ? "integer" : "number";
      return null;
    case "template":
      return "string";
    case "list": {
      const types = new Set(value.items.map(valueType));
      const [only] = types;
      return types.size === 1 && only !== null && only !== undefined ? `${only}[]` : null;
    }
    case "binary":
      return ["==", "!=", "<", "<=", ">", ">=", "and", "or"].includes(value.operator)
        ? "boolean"
        : null;
    case "input":
      return value.input === "askText" ? "string" : null;
    default:
      return null;
  }
}

/** The value a missing key reads as, by the key's type, the first member's of a union; null for a type without one. */
function emptyValue(type: string): IrExpression | null {
  if (type.includes(" | ")) {
    for (const member of type.split(" | ")) {
      const empty = emptyValue(member);
      if (empty !== null) return empty;
    }
    return null;
  }
  if (type === "integer" || type === "number") return { kind: "literal", value: 0 };
  if (type === "string") return { kind: "literal", value: "" };
  if (type === "boolean") return { kind: "literal", value: false };
  if (type.endsWith("[]")) return { kind: "list", items: [] };
  return null;
}
