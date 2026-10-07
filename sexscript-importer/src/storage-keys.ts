import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * A storage key written as one literal keeps one type for the whole script, which the values saved under it decide,
 * and a `load` of it without `default:` may be null, which a value cannot be used as (ADR 0021 §6, V30 §25). Legacy
 * `load()` read null for a missing key, which most scripts never tested: a read whose null nothing tests gets the
 * empty value of its key's type as its default (`load "level", default: 0`), what a script that read null then mostly
 * showed or counted with, and where the script tests the value it read for null, the read stays as it is.
 *
 * withFillableLoads marks those reads in a file (`fill`), after variable typing, which writes the type of each value
 * saved under a literal key on its `save` (`valueType`); withStorageDefaults decides each key's type from the saves of
 * the whole package and gives the marked reads their defaults.
 */
export function withFillableLoads(statements: IrStatement[]): IrStatement[] {
  const tested = nullTestedNames(statements);
  const mark = (value: IrExpression): IrExpression => {
    // A read that a test for null compares stays as it is: `load("k") == null`.
    if (value.kind === "binary" && (value.operator === "==" || value.operator === "!=")) {
      const left =
        isNull(value.right) && value.left.kind === "load" ? value.left : mark(value.left);
      const right =
        isNull(value.left) && value.right.kind === "load" ? value.right : mark(value.right);
      return { ...value, left, right };
    }
    const next = mapChildren(value, mark);
    return fillable(next) ? { ...next, fill: true } : next;
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      const statement = withNestedBlocks(item, block);
      // A read into a variable that the script tests for null keeps its null.
      const target =
        statement.kind === "let"
          ? statement.name
          : statement.kind === "assign" &&
              statement.operator === "=" &&
              statement.target.kind === "variable"
            ? statement.target.name
            : null;
      if (
        target !== null &&
        (statement.kind === "let" || statement.kind === "assign") &&
        statement.value.kind === "load" &&
        tested.has(target)
      )
        return statement;
      return mapOwnExpressions(statement, mark);
    });
  return block(statements);
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

function isNull(value: IrExpression): boolean {
  return value.kind === "literal" && value.value === null;
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
  if (/^[\w ]+\[\]$/u.test(type)) return { kind: "list", items: [] };
  return null;
}

/** Names of the variables the program compares with null (`x == null`, `x != null`). */
function nullTestedNames(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const visit = (value: IrExpression): IrExpression => {
    if (value.kind === "binary" && (value.operator === "==" || value.operator === "!=")) {
      if (value.left.kind === "variable" && isNull(value.right)) names.add(value.left.name);
      if (value.right.kind === "variable" && isNull(value.left)) names.add(value.right.name);
    }
    return mapChildren(value, visit);
  };
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      mapOwnExpressions(item, visit);
      withNestedBlocks(item, (body) => {
        block(body);
        return body;
      });
    }
  };
  block(statements);
  return names;
}
