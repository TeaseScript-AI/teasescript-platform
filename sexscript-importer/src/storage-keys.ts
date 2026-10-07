import { helperCall, helperStatements } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { usedNames } from "./message-handles.ts";
import { effectBefore, withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * A storage key written as one literal keeps one type for the whole script, and a `load` of it without `default:` may
 * be null, which a value cannot be used as (ADR 0021 §6, V30 §25). Legacy `load()` read null for a missing key: a read
 * whose null reaches nothing that could tell it from an empty value gets the empty value of its type as its default
 * (`load "level", default: 0`), and any other read keeps its null, the script's own test of it.
 *
 * Every `load` has `default:` (#690): a read that keeps its null has `default: null` (emit-tease.ts), and its key, where
 * written as one literal, a declared type at one of its loads (withDeclaredKeys).
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
export function withFillableLoads(statements: IrStatement[], shared: boolean): IrStatement[] {
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
    if (!fillable(next)) return next;
    // Variables that other files use too (`shared`: a mixin module's, a script's that loads modules, or a helper
    // class's) may be tested there, so only a read used up where it is gets a default.
    const target = shared ? undefined : into.get(value);
    return usedUp.has(value) || (target !== undefined && !passed.has(target))
      ? { ...next, fill: true }
      : next;
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
 * Gives each read marked by withFillableLoads the empty value of the type legacy read (`read`) or, for a plain `load`,
 * of the one type the package's saves give its key (an integer and a number make a number); a read without such a type
 * keeps its null. Then declares the keys whose reads keep their null or whose values mix types (withDeclaredKeys).
 */
export function withStorageDefaults(
  programs: readonly MigrationProgram[],
  shared: boolean,
): MigrationProgram[] {
  const saved = new Map<string, Set<string>>();
  const defaulted = new Map<string, Set<string>>();
  const read = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, key: string, type: string | null): void => {
    if (type === null) return;
    const types = map.get(key) ?? new Set<string>();
    types.add(type);
    map.set(key, types);
  };
  const collect = (value: IrExpression): IrExpression => {
    const key = value.kind === "load" ? literalKey(value.key) : null;
    if (key !== null && value.kind === "load") {
      if (value.defaultValue !== undefined) note(defaulted, key, valueType(value.defaultValue));
      if (value.read !== undefined) note(read, key, value.read);
    }
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
    const type = load.read ?? (key === null ? null : keyType(key));
    const empty = type === null ? null : emptyValue(type);
    if (empty === null) return load;
    if (key !== null) note(defaulted, key, type);
    return { ...load, defaultValue: empty };
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), fill));
  const filled = programs.map((program) => ({ ...program, statements: block(program.statements) }));
  // The type a key holds: what its reads read and default to and what is saved under it, a union where they mix.
  const declaredType = (key: string): string | null =>
    unionType([...(read.get(key) ?? []), ...(defaulted.get(key) ?? []), ...(saved.get(key) ?? [])]);
  return withDeclaredKeys(filled, declaredType, shared);
}

/**
 * A read that keeps its null (`default: null`), and a read of a key whose values mix types, needs its key's type
 * declared at one of its loads (#690), which the key's other loads take; the same declaration may repeat. In each file
 * the first `let` that reads the key gets it (`let level: string? = load "game.level", default: null`, optional where its
 * read keeps its null), or where no `let` reads the key, the first read in each file inside a statement that runs once,
 * where nothing with an effect runs before it, moves into one just before that statement (`let savedMode: string? = load "game.mode",
 * default: null`, then `if savedMode == "" { ... }`). A key that no file can declare so, or whose type nothing tells,
 * keeps its null of an open type instead, `default: sexscriptLegacyValue(null)`, which needs no declaration.
 */
function withDeclaredKeys(
  programs: readonly MigrationProgram[],
  declaredType: (key: string) => string | null,
  shared: boolean,
): MigrationProgram[] {
  const nullRead = new Set<string>();
  const declared = new Set<string>();
  const letRead = new Set<string>();
  const reads = (value: IrExpression): IrExpression => {
    const key = value.kind === "load" ? literalKey(value.key) : null;
    if (key !== null && value.kind === "load" && value.defaultValue === undefined)
      nullRead.add(key);
    return mapChildren(value, reads);
  };
  const scan = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      const key =
        item.kind === "let" && item.value.kind === "load" ? literalKey(item.value.key) : null;
      if (key !== null && item.kind === "let")
        (item.type === undefined ? letRead : declared).add(key);
      return mapOwnExpressions(withNestedBlocks(item, scan), reads);
    });
  for (const program of programs) scan(program.statements);
  // The keys to declare, with their types.
  const types = new Map<string, string>();
  const open = new Set<string>();
  for (const key of new Set([...nullRead, ...letRead])) {
    if (declared.has(key)) continue;
    const type = declaredType(key);
    if (!nullRead.has(key) && !(type?.includes(" | ") ?? false)) continue;
    if (type === null) open.add(key);
    else types.set(key, type);
  }
  const optional = (type: string): string => (type.includes(" | ") ? `${type} | null` : `${type}?`);
  const done = new Set<string>();
  const declaredPrograms = programs.map((program) => {
    let taken: Set<string> | null = null;
    const fresh = (key: string): string => {
      taken ??= usedNames(program.statements);
      const last = key
        .split(".")
        .at(-1)!
        .replace(/[^\p{L}\p{N}_]/gu, "");
      const base = /^\p{L}/u.test(last)
        ? `saved${last.charAt(0).toUpperCase()}${last.slice(1)}`
        : "savedValue";
      let name = base;
      for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${suffix}`;
      taken.add(name);
      return name;
    };
    // Keys this file declares at a `let`, then keys it declares by moving a read.
    const atLet = new Set<string>();
    const declare = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => {
        const next = withNestedBlocks(item, declare);
        const key =
          next.kind === "let" && next.value.kind === "load" ? literalKey(next.value.key) : null;
        const type = key === null ? undefined : types.get(key);
        if (
          key === null ||
          type === undefined ||
          atLet.has(key) ||
          next.kind !== "let" ||
          next.value.kind !== "load"
        )
          return next;
        atLet.add(key);
        done.add(key);
        return { ...next, type: next.value.defaultValue === undefined ? optional(type) : type };
      });
    const lifted = new Set<string>();
    const lift = (items: IrStatement[]): IrStatement[] =>
      items.flatMap((item): IrStatement[] => {
        const next = withNestedBlocks(item, lift);
        if (!LIFTABLE.has(next.kind)) return [next];
        let moved: IrStatement | null = null;
        const take = (value: IrExpression): IrExpression => {
          if (moved !== null) return value;
          const key = value.kind === "load" ? literalKey(value.key) : null;
          const type = key === null ? undefined : types.get(key);
          if (
            key !== null &&
            value.kind === "load" &&
            value.defaultValue === undefined &&
            type !== undefined &&
            !letRead.has(key) &&
            !lifted.has(key) &&
            !effectBefore(next, value)
          ) {
            const name = fresh(key);
            lifted.add(key);
            done.add(key);
            moved = { kind: "let", name, value, type: optional(type), span: next.span };
            return { kind: "variable", name };
          }
          return mapChildren(value, take);
        };
        const rewritten = mapOwnExpressions(next, take);
        return moved === null ? [next] : [moved, rewritten];
      });
    return { ...program, statements: lift(declare(program.statements)) };
  });
  // A key that no file could declare, as its reads sit only in loops or after effects, keeps an open null too.
  for (const key of types.keys()) if (!done.has(key)) open.add(key);
  if (open.size === 0) return declaredPrograms;
  const opened = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, opened);
    const key = next.kind === "load" ? literalKey(next.key) : null;
    return key !== null && next.kind === "load" && next.defaultValue === undefined && open.has(key)
      ? { ...next, defaultValue: OPEN_NULL }
      : next;
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), opened));
  return withOpenNullHelper(
    declaredPrograms.map((program) => ({ ...program, statements: block(program.statements) })),
    shared,
  );
}

// Statements whose own values are evaluated once, before anything else of theirs runs.
const LIFTABLE: ReadonlySet<string> = new Set([
  "if",
  "say",
  "let",
  "assign",
  "save",
  "expression",
  "return",
]);

/**
 * The open null's helper goes where a read uses it and no definition reaches: main.tease's global functions reach every
 * file of a package (`shared`), else each file has its own.
 */
function withOpenNullHelper(
  programs: readonly MigrationProgram[],
  shared: boolean,
): MigrationProgram[] {
  const defines = (program: MigrationProgram): boolean =>
    program.statements.some(
      (statement) => statement.kind === "function" && statement.name === OPEN_NULL_HELPER,
    );
  const uses = (program: MigrationProgram): boolean =>
    JSON.stringify(program.statements).includes(`"name":"${OPEN_NULL_HELPER}"`);
  const used = programs.some(uses);
  const definition = helperStatements(new Set(["value"]));
  return programs.map((program, index) => {
    const needs = shared
      ? index === 0 && used && !programs.some(defines)
      : uses(program) && !defines(program);
    if (!needs) return program;
    const helper = definition.map((statement): IrStatement =>
      shared && statement.kind === "function" ? { ...statement, global: true } : statement,
    );
    return { ...program, statements: [...helper, ...program.statements] };
  });
}

/** Null of a type the compiler cannot know, which needs no declared type. */
const OPEN_NULL: IrExpression = helperCall("value", [{ kind: "literal", value: null }]);
const OPEN_NULL_HELPER = OPEN_NULL.kind === "call" ? OPEN_NULL.name : "";

/** The types as one: an integer and a number make a number; several others, their union; none, null. */
function unionType(types: readonly string[]): string | null {
  const members = [...new Set(types.flatMap((type) => type.split(" | ")))];
  const kept = members.includes("number") ? members.filter((type) => type !== "integer") : members;
  return kept.length === 0 ? null : kept.join(" | ");
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
