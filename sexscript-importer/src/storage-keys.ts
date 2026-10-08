import { helperCall, helperDefinitionOrder, helperStatements, type HelperName } from "./helpers.ts";
import type { SourceSpan } from "./ast.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { usedNames } from "./message-handles.ts";
import { effectBefore, withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions as mapOwnValues } from "./variable-types.ts";

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
 * in arithmetic, an order comparison, or a built-in that computes with a number (`toInteger`, `floor`, ...), as a
 * condition, as the receiver of a member, method, or index, and compared
 * with a literal that is neither null nor empty. A read into a variable is marked where every use of the variable, by
 * name in the whole file, is such a use; a read or variable compared with null or an empty literal, or passed on,
 * returned, saved, or held in a list or another variable, keeps its null.
 */
export function withFillableLoads(statements: IrStatement[], shared: boolean): IrStatement[] {
  const passed = new Set<string>();
  const usedUpNames = new Set<string>();
  const usedUp = new Set<IrExpression>();
  const into = new Map<IrExpression, string>();
  const visit = (value: IrExpression, use: Use): void => {
    if (value.kind === "variable") (use === "passed" ? passed : usedUpNames).add(value.name);
    if (value.kind === "load" && use === "usedUp") usedUp.add(value);
  };
  const assigned = assignmentCounts(statements);
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
    if (usedUp.has(value) || (target !== undefined && !passed.has(target)))
      return { ...next, fill: true };
    // A variable read so that the script sets again and uses as a value: legacy filled it in before using it, which
    // the compiler cannot prove for a declared optional type (withDeclaredKeys).
    const variable = into.get(value);
    return variable !== undefined && (assigned.get(variable) ?? 0) > 1 && usedUpNames.has(variable)
      ? { ...next, open: true }
      : next;
  };
  const marked = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, marked), mark));
  return marked(statements);
}

/** How often each name is declared or set with `=`, by name in the whole file. */
function assignmentCounts(statements: readonly IrStatement[]): Map<string, number> {
  const counts = new Map<string, number>();
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "let") count(item.name);
      if (item.kind === "assign" && item.operator === "=" && item.target.kind === "variable")
        count(item.target.name);
      withNestedBlocks(item, (body) => {
        block(body);
        return body;
      });
    }
  };
  block(statements);
  return counts;
}

/** How a value is used: up, where null acted as an empty value would, or passed on, where it may be told apart. */
type Use = "usedUp" | "passed";

const USED_UP_OPERATORS = new Set(["+", "-", "*", "/", "%", "<", ">", "<=", ">=", "and", "or"]);
const NUMERIC_CALLS = new Set([
  "toInteger",
  "toNumber",
  "floor",
  "ceil",
  "round",
  "abs",
  "sqrt",
  "pow",
  "min",
  "max",
]);

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
    case "call":
      // A built-in that computes with a number failed for null, as legacy's arithmetic and casts did.
      for (const argument of value.positional)
        uses(argument, value.local !== true && NUMERIC_CALLS.has(value.name) ? "usedUp" : "passed");
      for (const argument of Object.values(value.named)) uses(argument, "passed");
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
 * A read of a computed key has no type (#690), but its default must fit the place it goes to: into a variable of a known
 * type, a read whose null is used up gets that type's empty value (`load "toys.${id}", default: false`), and one that
 * keeps its null makes the variable optional (`let level: integer? = ...`); into an item of a list of a known type, also
 * of a list in a list or one that `add()` appends, a read gets the item type's empty value, as does a read that keeps an
 * open null there; a read anywhere else keeps `default: null`. The marks of used-up reads (`fill`) end here.
 */
function withTypedComputedReads(programs: readonly MigrationProgram[]): MigrationProgram[] {
  return programs.map((program) => {
    // Each binding's declared type: its annotation, or the type of the value it starts with.
    const declared = new Map<string, string>();
    const collect = (items: readonly IrStatement[], scope: Scope): void => {
      for (const item of items) {
        if (item.kind === "let") {
          const type = item.type ?? (item.value.kind === "load" ? null : valueType(item.value));
          const binding = scope.declare(item.name, item.span);
          if (type !== null) declared.set(binding, type);
        }
        withNestedBlocks(item, (body) => {
          collect(body, scope.inner(item));
          return body;
        });
      }
    };
    collect(program.statements, Scope.file());
    const nullable = (type: string): boolean => /\?$|\bnull\b/u.test(type);
    // Variables a read that keeps its null makes optional.
    const optionals = new Set<string>();
    const itemType = (type: string | null): string | null =>
      type?.endsWith("[]") === true ? type.slice(0, -2) : null;
    // The type of a place `depth` items deeper than `value`, a variable or an item of one.
    const typeOf = (value: IrExpression, scope: Scope, depth = 0): string | null => {
      if (value.kind === "index") return typeOf(value.target, scope, depth + 1);
      if (value.kind !== "variable") return null;
      let type: string | null = declared.get(scope.resolve(value.name)) ?? null;
      for (let level = 0; level < depth; level += 1) type = itemType(type);
      return type;
    };
    const strip = (value: IrExpression): IrExpression => {
      const next = mapChildren(value, strip);
      if (next.kind !== "load" || next.fill !== true) return next;
      const { fill: _fill, ...load } = next;
      return load;
    };
    // Statements whose open-null read now reads the empty value of a list's items, whose notes say so.
    const itemDefaults = new Set<IrStatement>();
    const block = (items: IrStatement[], scope: Scope): IrStatement[] =>
      withItemNotes(
        items.map((item) => {
          if (item.kind === "function")
            return { ...item, body: block(item.body, scope.inner(item)) };
          let next = withNestedBlocks(item, (body) => block(body, scope.inner(item)));
          let itemDefault = false;
          const read =
            (next.kind === "let" || (next.kind === "assign" && next.operator === "=")) &&
            next.value.kind === "load" &&
            next.value.defaultValue === undefined &&
            literalKey(next.value.key) === null
              ? next.value
              : null;
          if (read !== null && (next.kind === "let" || next.kind === "assign")) {
            const { fill, ...load } = read;
            if (next.kind === "assign" && next.target.kind === "index") {
              const type = typeOf(next.target, scope);
              const empty = type === null || nullable(type) ? null : emptyValue(type);
              if (empty !== null) next = { ...next, value: { ...load, defaultValue: empty } };
            } else {
              const binding =
                next.kind === "assign" && next.target.kind === "variable"
                  ? scope.resolve(next.target.name)
                  : null;
              const type = next.kind === "let" ? (next.type ?? null) : declared.get(binding ?? "");
              if (type !== undefined && type !== null && !nullable(type)) {
                const empty = emptyValue(type);
                if (fill === true && empty !== null)
                  next = { ...next, value: { ...load, defaultValue: empty } };
                else if (next.kind === "let") next = { ...next, type: optional(type), value: load };
                else if (binding !== null) optionals.add(binding);
              }
            }
          }
          // A read that a list of a known type takes as a new item: a computed key's, or one that keeps an open null.
          const added =
            next.kind === "expression" &&
            next.expression.kind === "methodCall" &&
            next.expression.name === "add" &&
            next.expression.arguments.length === 1
              ? next.expression
              : null;
          const taken = added?.arguments[0];
          if (
            added !== null &&
            next.kind === "expression" &&
            taken?.kind === "load" &&
            (literalKey(taken.key) === null
              ? taken.defaultValue === undefined
              : taken.defaultValue !== undefined && isOpenNull(taken.defaultValue))
          ) {
            const type = typeOf(added.target, scope, 1);
            const empty = type === null || nullable(type) ? null : emptyValue(type);
            if (empty !== null) {
              const { fill: _fill, ...load } = taken;
              const defaultValue =
                literalKey(load.key) === null ? empty : helperCall("value", [empty]);
              itemDefault = literalKey(load.key) !== null;
              next = { ...next, expression: { ...added, arguments: [{ ...load, defaultValue }] } };
            }
          }
          if (next.kind === "let") scope.declare(next.name, next.span);
          const result = mapOwnExpressions(next, strip);
          if (itemDefault) itemDefaults.add(result);
          return result;
        }),
        itemDefaults,
      );
    const statements = block(program.statements, Scope.file());
    if (optionals.size === 0) return { ...program, statements };
    const optionalize = (items: IrStatement[], scope: Scope): IrStatement[] =>
      items.map((item) => {
        if (item.kind === "function")
          return { ...item, body: optionalize(item.body, scope.inner(item)) };
        const next = withNestedBlocks(item, (body) => optionalize(body, scope.inner(item)));
        if (next.kind !== "let") return next;
        const binding = scope.declare(next.name, next.span);
        const type = next.type ?? valueType(next.value);
        return type === null || !optionals.has(binding) || nullable(type)
          ? next
          : { ...next, type: optional(type) };
      });
    return { ...program, statements: optionalize(statements, Scope.file()) };
  });
}

/**
 * The statements, where the open-null note before one of `itemDefaults` says that its read reads the empty value of a
 * list's items.
 */
function withItemNotes(
  statements: IrStatement[],
  itemDefaults: ReadonlySet<IrStatement>,
): IrStatement[] {
  return statements.map((statement, index) => {
    const next = statements[index + 1];
    return next !== undefined &&
      itemDefaults.has(next) &&
      statement.kind === "comment" &&
      statement.text.startsWith("// NOTE SX_LOAD_OPEN_NULL")
      ? { ...statement, text: statement.text.replace(/: .*$/su, `: ${OPEN_ITEM}`) }
      : statement;
  });
}

const OPEN_ITEM =
  "Legacy read null for a missing key; nothing tells this key's type where a load could declare it, so this read keeps an open type, and a missing value is the empty value of the list's items, which cannot hold null.";

/** The type that also holds null: `integer?`, or `integer | string | null` for a union. */
function optional(type: string): string {
  return type.includes(" | ") ? `${type} | null` : `${type}?`;
}

/** The variables that a legacy text read (`loadString`) starts or is set to, by name. */
function textVariables(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      const value = item.kind === "let" || item.kind === "assign" ? item.value : null;
      const name =
        item.kind === "let"
          ? item.name
          : item.kind === "assign" && item.target.kind === "variable"
            ? item.target.name
            : null;
      if (name !== null && value?.kind === "load" && value.read === "string") names.add(name);
      withNestedBlocks(item, (body) => {
        block(body);
        return body;
      });
    }
  };
  block(statements);
  return names;
}

/**
 * Which of the package's programs become output files (`published`), and which of them is main.tease (`main`), whose
 * global functions reach every file; none where each file is converted to stand on its own.
 */
export interface PackageLayout {
  published: readonly boolean[];
  main: number | null;
}

/**
 * Gives each read marked by withFillableLoads the empty value of the type legacy read (`read`) or, for a plain `load`,
 * of the one type the package's saves give its key (an integer and a number make a number); a read without such a type
 * keeps its null. Then declares the keys whose reads keep their null or whose values mix types (withDeclaredKeys).
 */
export function withStorageDefaults(
  programs: readonly MigrationProgram[],
  shared: boolean,
  layout: PackageLayout = { published: programs.map(() => true), main: null },
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
  for (const program of programs) {
    // A variable that a legacy text read starts or is set to holds text, which a save of it saves.
    const texts = textVariables(program.statements);
    const scan = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => {
        const key = item.kind === "save" ? literalKey(item.key) : null;
        if (key !== null && item.kind === "save")
          note(
            saved,
            key,
            item.valueType?.replace(/\?$/u, "") ??
              valueType(item.value) ??
              (item.value.kind === "variable" && texts.has(item.value.name) ? "string" : null),
          );
        return mapOwnExpressions(withNestedBlocks(item, scan), collect);
      });
    scan(program.statements);
  }
  // A legacy loadString or loadBoolean read of a key that values of another type are saved under too, or, where the
  // package saves nothing under it, that reads of the other type read too, reads the value as stored and turns it into
  // the type legacy read (withTypedTextReads).
  const routed = new Map<string, Set<string>>();
  for (const [key, types] of read) {
    const held = saved.has(key) ? [...saved.get(key)!] : [...types];
    const kept = [...types].filter((type) => held.every((other) => other === type));
    if (kept.length === types.size) continue;
    routed.set(key, new Set([...types].filter((type) => !kept.includes(type))));
    if (kept.length === 0) read.delete(key);
    else read.set(key, new Set(kept));
  }
  const keyType = (key: string): string | null =>
    keptType(saved.get(key)) ?? (saved.has(key) ? null : keptType(defaulted.get(key)));

  const fill = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, fill);
    if (next.kind !== "load" || next.fill !== true) return next;
    const { fill: _fill, ...load } = next;
    const key = literalKey(load.key);
    const type = load.read ?? (key === null ? null : keyType(key));
    const empty = type === null ? null : emptyValue(type);
    // A computed key's read takes its receiver's type instead (withTypedComputedReads).
    if (empty === null) return key === null ? next : load;
    if (key !== null) note(defaulted, key, type);
    return { ...load, defaultValue: empty };
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), fill));
  const filled = withTypedTextReads(programs, routed).map((program) => ({
    ...program,
    statements: block(program.statements),
  }));
  // The type a key holds: what its reads read and default to and what is saved under it, a union where they mix.
  const declaredType = (key: string): string | null =>
    unionType([...(read.get(key) ?? []), ...(defaulted.get(key) ?? []), ...(saved.get(key) ?? [])]);
  const textKeys = new Set(
    [...new Set([...read.keys(), ...saved.keys(), ...defaulted.keys()])].filter(
      (key) => declaredType(key) === "string",
    ),
  );
  return withUsedHelpers(
    withTypedComputedReads(withDeclaredKeys(withEmptyText(filled, textKeys), declaredType, layout)),
    shared,
    layout,
  );
}

/**
 * The legacy loadString and loadBoolean reads of the types that `routed` gives for their keys, whose saves or other
 * reads store values of another type too: the value is read as stored and becomes text through the text helper, or
 * true only for "true" through the boolean text helper, as the reads of keys saved as literals do already
 * (SX_LOAD_STRING_TEXT, SX_LOAD_BOOLEAN_TEXT).
 */
function withTypedTextReads(
  programs: readonly MigrationProgram[],
  routed: ReadonlyMap<string, ReadonlySet<string>>,
): MigrationProgram[] {
  const textHelper = helperName("text");
  return programs.map((program) => {
    const diagnostics = [...program.diagnostics];
    const block = (items: IrStatement[]): IrStatement[] =>
      items.flatMap((item): IrStatement[] => {
        const nested = withNestedBlocks(item, block);
        let code: string | null = null;
        const route = (value: IrExpression): IrExpression => {
          const next = mapChildren(value, route);
          // The text helper's read of a key saved as numbers or booleans (lowered so already) reads as stored text too.
          const wrapped =
            next.kind === "call" && next.name === textHelper && next.positional.length === 1
              ? next.positional[0]!
              : null;
          if (wrapped?.kind === "load" && literalKey(wrapped.key) !== null)
            return storedText(wrapped);
          const key = next.kind === "load" ? literalKey(next.key) : null;
          if (
            next.kind !== "load" ||
            key === null ||
            next.read === undefined ||
            routed.get(key)?.has(next.read) !== true
          )
            return next;
          const { read, fill: _fill, open: _open, ...load } = next;
          code = read === "string" ? "SX_LOAD_STRING_TEXT" : "SX_LOAD_BOOLEAN_TEXT";
          if (read === "string") return storedText(load);
          // A missing value reads as false through the helper, as a default of false or null did.
          const fallback = load.defaultValue;
          const kept =
            fallback === undefined ||
            (fallback.kind === "literal" && (fallback.value === false || fallback.value === null))
              ? { ...load, defaultValue: undefined }
              : { ...load, defaultValue: helperCall("value", [fallback]) };
          const { defaultValue, ...bare } = kept;
          return helperCall("booleanText", [defaultValue === undefined ? bare : kept]);
        };
        const next = mapOwnExpressions(nested, route);
        if (code === null) return [next];
        const message = code === "SX_LOAD_STRING_TEXT" ? STRING_TEXT : BOOLEAN_TEXT;
        diagnostics.push({ code, severity: "warning", message, span: next.span });
        const line = next.span === null ? "" : ` line ${next.span.line}`;
        const note: IrStatement = {
          kind: "comment",
          text: `// NOTE ${code}${line}: ${message}`,
          trailing: false,
          span: next.span,
        };
        return [note, next];
      });
    return { ...program, statements: block(program.statements), diagnostics };
  });
}

/**
 * A text read of a key that values of another type are saved under too, as the stored value's text: a missing one is
 * the empty text (withEmptyText), or the value the script gave instead, through a default of an open type, which fits
 * whatever the key's loads read: `"${load "k", default: sexscriptLegacyValue("")}"`.
 */
function storedText(load: Extract<IrExpression, { kind: "load" }>): IrExpression {
  const { read: _read, fill: _fill, open: _open, ...bare } = load;
  const fallback =
    bare.defaultValue === undefined ||
    (bare.defaultValue.kind === "literal" && bare.defaultValue.value === null)
      ? { kind: "literal" as const, value: "" }
      : bare.defaultValue;
  return {
    kind: "template",
    parts: [{ value: { ...bare, defaultValue: helperCall("value", [fallback]) } }],
  };
}

const STRING_TEXT =
  "loadString() read the stored value as text, and the package saves values of another type under this key too, or reads it as one, so the value is read as stored and turned into text; a missing value is the empty text.";
const BOOLEAN_TEXT =
  'loadBoolean() read the stored value as text, true only for "true", and the package saves values of another type under this key too, or reads it as one, so the value is read the same way; a missing value reads as false.';

/**
 * A missing text reads as the empty text (owner decision 2026-10-07): every read of a key that only text is read from
 * and saved under, and a legacy text read of a computed key, gets `default: ""`, also where the script tests it for
 * null, and those tests test for the empty text instead, `x == null` as `x == ""`, of the read itself or of a variable,
 * parameter, or function result that it reaches, also through copies; where that holds values of another type too, the
 * test takes both, `x == null or x == ""`, through a helper for a function's result, which then runs once. A null that
 * the script saves under the key, or sets, passes, or returns as a text that holds no other values, is the empty text
 * too. A variable is the binding its name resolves to (Scope), or a global's in every file. A stored empty text so
 * counts as missing.
 */
function withEmptyText(
  programs: readonly MigrationProgram[],
  textKeys: ReadonlySet<string>,
): MigrationProgram[] {
  const EMPTY: IrExpression = { kind: "literal", value: "" };
  const textRead = (value: IrExpression): boolean => {
    if (value.kind !== "load") return false;
    const key = literalKey(value.key);
    return key === null ? value.read === "string" : textKeys.has(key);
  };
  const declaredGlobal = new Set(
    programs.flatMap((program) =>
      program.statements.flatMap((statement) =>
        statement.kind === "let" && statement.global === true ? [statement.name] : [],
      ),
    ),
  );
  const global = (binding: string): string | null =>
    binding.startsWith(":") && declaredGlobal.has(binding.slice(1)) ? binding.slice(1) : null;
  // Lists that text reads are written into, whose items are text, by binding; a global's by name.
  const textLists = programs.map(() => new Set<string>());
  const globalTextLists = new Set<string>();
  programs.forEach((program, index) => {
    const visit = (items: readonly IrStatement[], scope: Scope): void => {
      for (const item of items) {
        if (item.kind === "let") scope.declare(item.name, item.span);
        if (
          item.kind === "assign" &&
          item.target.kind === "index" &&
          item.target.target.kind === "variable" &&
          textRead(item.value)
        ) {
          const binding = scope.resolve(item.target.target.name);
          textLists[index]!.add(binding);
          if (global(binding) !== null) globalTextLists.add(global(binding)!);
        }
        if (item.kind === "function") visit(item.body, scope.inner(item));
        else
          withNestedBlocks(item, (body) => {
            visit(body, scope.inner(item));
            return body;
          });
      }
    };
    visit(program.statements, Scope.file());
  });
  const text = (index: number, value: IrExpression, scope: Scope): boolean => {
    if (textRead(value)) return true;
    if (value.kind === "index" && value.target.kind === "variable") {
      const binding = scope.resolve(value.target.name);
      return textLists[index]!.has(binding) || globalTextLists.has(global(binding) ?? "");
    }
    return (
      value.kind === "template" &&
      value.parts.length === 1 &&
      "value" in value.parts[0]! &&
      value.parts[0].value.kind === "load"
    );
  };
  // The values each binding takes, by program: a variable's, a parameter's from each call and its default, and a
  // function's result's (`return:name`) from each return.
  type Flow = { binding: string; value: IrExpression; scope: Scope };
  const flows = programs.map((): Flow[] => []);
  const functions = programs.map(
    () => new Map<string, Extract<IrStatement, { kind: "function" }>>(),
  );
  const receivers = programs.map(() => new Set<string>());
  const assigned = (item: IrStatement, scope: Scope): string | null =>
    item.kind === "let"
      ? scope.declare(item.name, item.span)
      : item.kind === "assign" && item.operator === "=" && item.target.kind === "variable"
        ? scope.resolve(item.target.name)
        : null;
  programs.forEach((program, index) => {
    const flow = flows[index]!;
    const calls: Array<[Extract<IrExpression, { kind: "call" }>, Scope]> = [];
    const callsIn = (scope: Scope) => {
      const collect = (value: IrExpression): IrExpression => {
        if (value.kind === "call" && value.local === true) calls.push([value, scope]);
        return mapChildren(value, collect);
      };
      return collect;
    };
    const visit = (items: readonly IrStatement[], scope: Scope): void => {
      for (const item of items) {
        if (item.kind === "function") {
          functions[index]!.set(item.name, item);
          const inner = scope.inner(item);
          for (const parameter of item.parameters) {
            if (parameter.defaultValue === null) continue;
            callsIn(inner)(parameter.defaultValue);
            flow.push({
              binding: `${item.name}:${parameter.name}`,
              value: parameter.defaultValue,
              scope: inner,
            });
          }
          visit(item.body, inner);
          continue;
        }
        mapOwnExpressions(item, callsIn(scope));
        const binding = assigned(item, scope);
        if (binding !== null && (item.kind === "let" || item.kind === "assign")) {
          flow.push({ binding, value: item.value, scope });
          if (text(index, item.value, scope)) receivers[index]!.add(binding);
        }
        if (item.kind === "return" && item.value !== null && scope.fn !== null)
          flow.push({ binding: `return:${scope.fn}`, value: item.value, scope });
        withNestedBlocks(item, (body) => {
          visit(body, scope.inner(item));
          return body;
        });
      }
    };
    visit(program.statements, Scope.file());
    for (const [call, scope] of calls) {
      const callee = functions[index]!.get(call.name);
      call.positional.forEach((argument, position) => {
        const parameter = callee?.parameters[position];
        if (parameter !== undefined)
          flow.push({ binding: `${call.name}:${parameter.name}`, value: argument, scope });
      });
    }
  });
  // The globals that text is read into, and those that such a text reaches, in any file.
  const globals = new Set(
    receivers.flatMap((bindings) => [...bindings].flatMap((binding) => global(binding) ?? [])),
  );
  const globalsReached = new Set<string>();
  const reached = programs.map(() => new Set<string>());
  // Whether a binding holds a text read: its own, a global's, or one that reaches it.
  const holdsRead = (index: number, binding: string): boolean =>
    receivers[index]!.has(binding) ||
    reached[index]!.has(binding) ||
    globals.has(global(binding) ?? "") ||
    globalsReached.has(global(binding) ?? "");
  const holds = (index: number, value: IrExpression, scope: Scope): boolean =>
    text(index, value, scope) ||
    (value.kind === "variable" && holdsRead(index, scope.resolve(value.name))) ||
    (value.kind === "call" && value.local === true && holdsRead(index, `return:${value.name}`));
  for (let changed = true; changed;) {
    changed = false;
    flows.forEach((flow, index) => {
      for (const { binding, value, scope } of flow)
        if (!holdsRead(index, binding) && holds(index, value, scope)) {
          reached[index]!.add(binding);
          const name = global(binding);
          if (name !== null) globalsReached.add(name);
          changed = true;
        }
    });
  }
  // What each binding takes besides text: `null`, the types of other values the importer knows here, or `unknown`,
  // also through the text it copies; a global's, from every file.
  const others = programs.map(() => new Map<string, Set<string>>());
  const globalOthers = new Map<string, Set<string>>();
  const othersOf = (index: number, binding: string): Set<string> => {
    const name = global(binding);
    const map = name === null ? others[index]! : globalOthers;
    const types = map.get(name ?? binding) ?? new Set<string>();
    map.set(name ?? binding, types);
    return types;
  };
  flows.forEach((flow, index) => {
    for (const { binding, value, scope } of flow) {
      if (holds(index, value, scope)) continue;
      othersOf(index, binding).add(
        isNullLiteral(value)
          ? "null"
          : value.kind === "load"
            ? "unknown"
            : (valueType(value) ?? "unknown"),
      );
    }
  });
  for (let changed = true; changed;) {
    changed = false;
    flows.forEach((flow, index) => {
      for (const { binding, value, scope } of flow) {
        const source =
          value.kind === "variable"
            ? scope.resolve(value.name)
            : value.kind === "call" && value.local === true
              ? `return:${value.name}`
              : null;
        if (source === null || !holdsRead(index, source)) continue;
        const types = othersOf(index, binding);
        for (const type of othersOf(index, source))
          if (!types.has(type)) {
            types.add(type);
            changed = true;
          }
      }
    });
  }
  return programs.map((program, index) => {
    const diagnostics = [...program.diagnostics];
    const note = (code: string, message: string, span: IrStatement["span"]): void => {
      diagnostics.push({ code, severity: "info", message, span });
    };
    const isReceiver = (binding: string): boolean =>
      receivers[index]!.has(binding) || globals.has(global(binding) ?? "");
    // A text that holds values of another type too, whose null tests take both.
    const mixed = (binding: string): boolean =>
      [...othersOf(index, binding)].some((type) => type !== "string" && type !== "null");
    // A null set to a text is the empty text, unless it holds values of another type too and is no read's own.
    const emptied = (binding: string): boolean =>
      isReceiver(binding) || (holdsRead(index, binding) && !mixed(binding));
    const typeOf = (binding: string): { type?: string; open?: true } => {
      const given = [...othersOf(index, binding)].filter(
        (type) => type !== "string" && !(type === "null" && emptied(binding)),
      );
      if (given.length === 0) return {};
      if (given.includes("unknown")) return { open: true };
      const held = unionType(["string", ...given.filter((type) => type !== "null")])!;
      if (!given.includes("null")) return { type: held };
      return { type: optional(held) };
    };
    const nullSet = (span: IrStatement["span"]): IrExpression => {
      note(
        "SX_LOAD_TEXT_NULL_SET",
        "Legacy set this text to null, missing; it is the empty text now.",
        span,
      );
      return EMPTY;
    };
    const widened = new Set<string>();
    const rewriteIn = (scope: Scope, span: IrStatement["span"]) => {
      const rewrite = (value: IrExpression): IrExpression => {
        const next = mapChildren(value, rewrite);
        if (next.kind === "load" && textRead(next)) {
          const { open: _open, ...load } = next;
          if (load.defaultValue !== undefined) return load;
          note(
            "SX_LOAD_TEXT_EMPTY",
            "Legacy read null for a missing text, which reads as the empty text now.",
            span,
          );
          return { ...load, defaultValue: EMPTY };
        }
        // A null passed to a text parameter is the empty text.
        if (next.kind === "call" && next.local === true) {
          const callee = functions[index]!.get(next.name);
          const positional = next.positional.map((argument, position) => {
            const parameter = callee?.parameters[position];
            return parameter !== undefined &&
              isNullLiteral(argument) &&
              emptied(`${next.name}:${parameter.name}`)
              ? nullSet(span)
              : argument;
          });
          if (positional.some((argument, position) => argument !== next.positional[position]))
            return { ...next, positional };
        }
        if (next.kind !== "binary" || (next.operator !== "==" && next.operator !== "!="))
          return next;
        const side = isNullLiteral(next.right)
          ? next.left
          : isNullLiteral(next.left)
            ? next.right
            : null;
        const binding =
          side === null
            ? null
            : side.kind === "variable"
              ? scope.resolve(side.name)
              : side.kind === "call" && side.local === true
                ? `return:${side.name}`
                : null;
        if (
          side === null ||
          (!text(index, side, scope) && (binding === null || !holdsRead(index, binding)))
        )
          return next;
        note(
          "SX_LOAD_TEXT_NULL_TEST",
          "Legacy tested this text for null, which a missing text was; it tests for the empty text now.",
          span,
        );
        const empty: IrExpression = {
          kind: "binary",
          operator: next.operator,
          left: side,
          right: EMPTY,
        };
        if (binding === null || !mixed(binding)) return empty;
        if (side.kind === "call") {
          // A result is tested once, as legacy called the function once.
          const missing = helperCall("missingText", [side]);
          return next.operator === "=="
            ? missing
            : { kind: "unary", operator: "not", value: missing };
        }
        return {
          kind: "binary",
          operator: next.operator === "==" ? "or" : "and",
          left: next,
          right: empty,
        };
      };
      return rewrite;
    };
    const block = (items: IrStatement[], scope: Scope): IrStatement[] =>
      items.flatMap((item): IrStatement[] => {
        const span = item.span;
        if (item.kind === "function") {
          const inner = scope.inner(item);
          const parameters = item.parameters.map((parameter) => {
            if (parameter.defaultValue === null) return parameter;
            const binding = `${item.name}:${parameter.name}`;
            const defaultValue =
              isNullLiteral(parameter.defaultValue) && emptied(binding)
                ? nullSet(span)
                : rewriteIn(inner, span)(parameter.defaultValue);
            // A text parameter that calls pass values of other types to holds them all, which its default's type
            // alone would not.
            const given = othersOf(index, binding);
            if (parameter.type !== undefined || !holdsRead(index, binding) || emptied(binding))
              return { ...parameter, defaultValue };
            if (given.has("unknown"))
              return { ...parameter, defaultValue: helperCall("value", [defaultValue]) };
            const type = unionType([
              "string",
              ...[...given].filter((member) => member !== "null"),
            ])!;
            return { ...parameter, defaultValue, type: given.has("null") ? optional(type) : type };
          });
          return [{ ...item, parameters, body: block(item.body, inner) }];
        }
        const nested = withNestedBlocks(item, (body) => block(body, scope.inner(item)));
        let next = mapOwnValues(nested, rewriteIn(scope, span));
        const key = next.kind === "save" ? literalKey(next.key) : null;
        if (next.kind === "save" && key !== null && textKeys.has(key) && isNullLiteral(next.value))
          return [{ ...next, value: EMPTY }];
        if (
          next.kind === "return" &&
          next.value !== null &&
          isNullLiteral(next.value) &&
          scope.fn !== null &&
          emptied(`return:${scope.fn}`)
        )
          return [{ ...next, value: nullSet(span) }];
        const binding = assigned(next, scope);
        if (binding === null || (next.kind !== "let" && next.kind !== "assign")) return [next];
        // Null set to a variable that text is read into is the empty text, which its tests test for.
        if (isNullLiteral(next.value) && emptied(binding))
          return [{ ...next, value: nullSet(span) }];
        if (next.kind === "assign" && holds(index, next.value, scope)) widened.add(binding);
        if (next.kind !== "let" || !holds(index, next.value, scope) || next.type !== undefined)
          return [next];
        const held = typeOf(binding);
        if (held.type !== undefined) return [{ ...next, type: held.type }];
        if (held.open !== true) return [next];
        next = { ...next, value: helperCall("value", [next.value]) };
        diagnostics.push({
          code: "SX_LOAD_OPEN_NULL",
          severity: "warning",
          message: OPEN_TEXT,
          span,
        });
        const line = span === null ? "" : ` line ${span.line}`;
        return [
          {
            kind: "comment",
            text: `// NOTE SX_LOAD_OPEN_NULL${line}: ${OPEN_TEXT}`,
            trailing: false,
            span,
          },
          next,
        ];
      });
    const statements = block(program.statements, Scope.file());
    // A variable that text is read into after another value started it holds both; one that holds only text, whose
    // null tests test for the empty text now, holds no null.
    const widen = (items: IrStatement[], scope: Scope): IrStatement[] =>
      items.map((item) => {
        if (item.kind === "function") {
          const inner = scope.inner(item);
          return { ...item, body: widen(item.body, inner) };
        }
        const next = withNestedBlocks(item, (body) => widen(body, scope.inner(item)));
        if (next.kind !== "let") return next;
        const binding = scope.declare(next.name, next.span);
        const reads = widened.has(binding) || holds(index, next.value, scope);
        if (next.type === "string?" && reads && emptied(binding))
          return { ...next, type: "string" };
        if (next.type !== undefined) {
          // A declared type that text is read into later takes text too.
          if (!widened.has(binding) || /\bstring\b/u.test(next.type)) return next;
          const declared = next.type.replace(/\?$/u, "").replace(/ \| null$/u, "");
          return { ...next, type: `${unionType([declared, "string"])!} | null` };
        }
        if (!widened.has(binding)) return next;
        const start = valueType(next.value);
        if (start === null || start === "string") return next;
        return { ...next, type: `${unionType([start, "string"])!} | null` };
      });
    return { ...program, statements: widen(statements, Scope.file()), diagnostics };
  });
}

/**
 * The variables in scope at a point of a walk over a file: each `let`, parameter, and loop variable is a binding of its
 * own, which its name resolves to in the rest of its block, nested blocks included. A variable of the file's top level
 * is `:name`, as a name is that nothing in scope declares, a global's included; a parameter is `function:name`.
 */
class Scope {
  private readonly names = new Map<string, string>();
  private readonly parent: Scope | null;
  /** The function whose body the scope is in. */
  readonly fn: string | null;

  private constructor(parent: Scope | null, fn: string | null) {
    this.parent = parent;
    this.fn = fn;
  }

  static file(): Scope {
    return new Scope(null, null);
  }

  /** The scope of a block that the statement holds, with a function's parameters or a loop's variables. */
  inner(item: IrStatement): Scope {
    if (item.kind !== "function") {
      const scope = new Scope(this, this.fn);
      if (item.kind === "for") {
        scope.declare(item.variable, item.span);
        if (item.valueVariable !== undefined) scope.declare(item.valueVariable, item.span);
      }
      return scope;
    }
    const scope = new Scope(this, item.name);
    for (const parameter of item.parameters)
      scope.names.set(parameter.name, `${item.name}:${parameter.name}`);
    return scope;
  }

  /** Declares a variable in this block; its binding is apart from every other's of the file. */
  declare(name: string, span: SourceSpan | null): string {
    const binding =
      this.parent === null
        ? `:${name}`
        : `${this.fn ?? ""}:${name}@${span === null ? "" : `${span.line}:${span.column}`}`;
    this.names.set(name, binding);
    return binding;
  }

  resolve(name: string): string {
    for (let scope: Scope | null = this; scope !== null; scope = scope.parent) {
      const binding = scope.names.get(name);
      if (binding !== undefined) return binding;
    }
    return `:${name}`;
  }
}

const OPEN_TEXT =
  "Legacy read null for a missing text, the empty text here; the script gives this variable values of a type the compiler cannot tell too, so the read keeps an open type, checked where it is used.";

function isNullLiteral(value: IrExpression): boolean {
  return value.kind === "literal" && value.value === null;
}

/**
 * A read that keeps its null (`default: null`), and a read of a key whose values mix types, needs its key's type
 * declared at one of its loads (#690), which the key's other loads take; the declaration may repeat, with the same
 * type apart from null. Every `let` that reads the key gets it (`let level: integer? = load "game.level", default:
 * null`, optional where its read keeps its null), widened by the other values the script gives such variables in the
 * whole package, so that it is the same everywhere; a variable that the script also gives a value of a type the
 * importer cannot tell holds the read through `sexscriptLegacyValue` instead, open to that value. In a published file
 * where no `let` declares the key, the first read inside a statement that runs once, where nothing with an effect runs
 * before it and no `and` or `or` may skip it, moves into one just before that statement, so that each file declares
 * the keys it reads itself and compiles on its own (`let savedLevel: integer? = load "game.level", default: null`). A
 * key that no published file can declare so, as its reads sit only in loops, after effects, or where a condition may
 * skip them, is declared once at the top of main.tease, by a read in a function that nothing calls. A key whose type
 * nothing tells, or whose variable the script fills in later, which the compiler cannot prove, keeps its null of an open
 * type instead, `default: sexscriptLegacyValue(null)`, which needs no declaration.
 */
function withDeclaredKeys(
  programs: readonly MigrationProgram[],
  declaredType: (key: string) => string | null,
  layout: PackageLayout,
): MigrationProgram[] {
  const { published } = layout;
  const nullRead = new Set<string>();
  const declared = new Set<string>();
  const letRead = new Set<string>();
  const filledIn = new Set<string>();
  // The keys that each file reads.
  const fileReads = programs.map(() => new Set<string>());
  programs.forEach((program, index) => {
    const reads = (value: IrExpression): IrExpression => {
      const key = value.kind === "load" ? literalKey(value.key) : null;
      if (key !== null) fileReads[index]!.add(key);
      if (key !== null && value.kind === "load" && value.defaultValue === undefined) {
        nullRead.add(key);
        if (value.open === true) filledIn.add(key);
      }
      return mapChildren(value, reads);
    };
    const scan = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => {
        const key =
          item.kind === "let" && item.value.kind === "load" ? literalKey(item.value.key) : null;
        // Only a published file's declaration reaches the others.
        if (key !== null && item.kind === "let" && published[index] === true)
          (item.type === undefined ? letRead : declared).add(key);
        return mapOwnExpressions(withNestedBlocks(item, scan), reads);
      });
    scan(program.statements);
  });
  // The keys to declare, with their types.
  const types = new Map<string, string>();
  const open = new Set<string>();
  for (const key of new Set([...nullRead, ...letRead])) {
    if (declared.has(key)) continue;
    const type = declaredType(key);
    if (!nullRead.has(key) && !(type?.includes(" | ") ?? false)) continue;
    // A declaration would type the filled-in read too, so its key keeps open nulls.
    if (type === null || filledIn.has(key)) open.add(key);
    else types.set(key, type);
  }
  // Names generated here stay clear of every name of the package, which globals share.
  const packageNames = new Set(programs.flatMap((program) => [...usedNames(program.statements)]));
  const fresh = (key: string, taken: Set<string>): string => {
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
    packageNames.add(name);
    return name;
  };
  // The variables that the reads start, with the other values the script gives them in their file.
  const others = programs.map((program) => otherValueTypes(program.statements));
  const keyedLet = (item: IrStatement): string | null =>
    item.kind === "let" && item.value.kind === "load" ? literalKey(item.value.key) : null;
  // A key's one declared type takes the other values that the script gives the variables reading it too.
  programs.forEach((program, index) => {
    const visit = (items: readonly IrStatement[], scope: Scope): void => {
      for (const item of items) {
        const key = keyedLet(item);
        const type = key === null ? undefined : types.get(key);
        if (item.kind === "let") {
          const binding = scope.declare(item.name, item.span);
          const given = [...(others[index]!.get(binding) ?? [])];
          if (key !== null && type !== undefined && !given.includes("unknown"))
            types.set(key, unionType([type, ...given.filter((member) => member !== "null")])!);
        }
        withNestedBlocks(item, (body) => {
          visit(body, scope.inner(item));
          return body;
        });
      }
    };
    visit(program.statements, Scope.file());
  });
  const done = new Set<string>();
  // The keys each file declares itself.
  const fileDeclares = programs.map(() => new Set<string>());
  const declaredPrograms = programs.map((program, index) => {
    const taken = new Set(packageNames);
    // Keys this file declares at a `let`, then keys it declares by moving a read.
    const atLet = fileDeclares[index]!;
    const declare = (items: IrStatement[], scope: Scope): IrStatement[] =>
      items.map((item) => {
        const next = withNestedBlocks(item, (body) => declare(body, scope.inner(item)));
        if (next.kind !== "let") return next;
        const binding = scope.declare(next.name, next.span);
        const key = keyedLet(next);
        const type = key === null ? undefined : types.get(key);
        if (key === null) return next;
        // A variable that also takes a value of a type the importer cannot tell holds the read open to it.
        const given = others[index]!.get(binding) ?? new Set<string>();
        if (type === undefined) {
          // A variable that a read of a key with a default starts, and that takes values of other types too, holds the
          // read open to them, so that its declaration does not change the key's type.
          const held = open.has(key) || next.type !== undefined ? null : declaredType(key);
          const members = held?.split(" | ") ?? [];
          const fits = (member: string): boolean =>
            members.includes(member) || (member === "integer" && members.includes("number"));
          if (held === null || [...given].every(fits)) return next;
          const value = helperCall("value", [next.value]);
          if (given.has("unknown")) return { ...next, value };
          const union = unionType([held, ...[...given].filter((member) => member !== "null")])!;
          return { ...next, value, type: given.has("null") ? optional(union) : union };
        }
        if (given.has("unknown")) return { ...next, value: helperCall("value", [next.value]) };
        atLet.add(key);
        if (published[index] === true) done.add(key);
        const read = next.value.kind === "load" ? next.value : null;
        return {
          ...next,
          type: read?.defaultValue === undefined || given.has("null") ? optional(type) : type,
        };
      });
    const lifted = new Set<string>();
    const lift = (items: IrStatement[]): IrStatement[] =>
      items.flatMap((item): IrStatement[] => {
        const next = withNestedBlocks(item, lift);
        if (!LIFTABLE.has(next.kind)) return [next];
        let moved: IrStatement | null = null;
        const take = (value: IrExpression): IrExpression => {
          if (moved !== null) return value;
          // The right side of `and` and `or` may not run, so its reads stay where they are.
          if (value.kind === "binary" && (value.operator === "and" || value.operator === "or"))
            return { ...value, left: take(value.left) };
          const key = value.kind === "load" ? literalKey(value.key) : null;
          const type = key === null ? undefined : types.get(key);
          if (
            key !== null &&
            value.kind === "load" &&
            value.defaultValue === undefined &&
            type !== undefined &&
            !atLet.has(key) &&
            !lifted.has(key) &&
            !effectBefore(next, value)
          ) {
            const name = fresh(key, taken);
            lifted.add(key);
            atLet.add(key);
            if (published[index] === true) done.add(key);
            moved = { kind: "let", name, value, type: optional(type), span: next.span };
            return { kind: "variable", name };
          }
          return mapChildren(value, take);
        };
        const rewritten = mapOwnExpressions(next, take);
        return moved === null ? [next] : [moved, rewritten];
      });
    return { ...program, statements: lift(declare(program.statements, Scope.file())) };
  });
  // A key that no published file could declare, as its reads sit only in loops, after effects, or where a condition
  // may skip them, is declared at the top of main.tease, by a read in a function that nothing calls; where each file
  // stands on its own, at the top of each file that reads a key it does not declare.
  const undeclared = (index: number): string[] =>
    [...types.keys()].filter((key) =>
      layout.main === null
        ? fileReads[index]!.has(key) && !fileDeclares[index]!.has(key)
        : index === layout.main &&
          !done.has(key) &&
          programs.some((_, other) => published[other] === true && fileReads[other]!.has(key)),
    );
  const withMain = declaredPrograms.map((program, index): MigrationProgram => {
    const keys = undeclared(index);
    if (keys.length === 0) return program;
    const names = new Set(packageNames);
    const keyTypes: IrStatement[] = keys.map((key) => ({
      kind: "let",
      name: fresh(key, names),
      value: { kind: "load", key: { kind: "literal", value: key } },
      type: optional(types.get(key)!),
      span: null,
    }));
    let holder = "sexscriptLegacyKeyTypes";
    for (let suffix = 2; names.has(holder); suffix += 1)
      holder = `sexscriptLegacyKeyTypes${suffix}`;
    const declaring: IrStatement[] = [
      {
        kind: "comment",
        text: `// NOTE SX_LOAD_KEY_DECLARED: ${MAIN_DECLARED}`,
        trailing: false,
        span: null,
      },
      // The declaring reads sit in a function that nothing calls, so they never run.
      { kind: "function", name: holder, parameters: [], body: keyTypes, global: true, span: null },
    ];
    return {
      ...program,
      statements: [...declaring, ...program.statements],
      diagnostics: [
        ...program.diagnostics,
        ...keys.map(() => ({
          code: "SX_LOAD_KEY_DECLARED",
          severity: "info" as const,
          message: MAIN_DECLARED,
          span: null,
        })),
      ],
    };
  });
  if (open.size === 0) return withMain.map(withoutOpenMarks);
  return withMain.map((program) => {
    const diagnostics = [...program.diagnostics];
    const block = (items: IrStatement[]): IrStatement[] =>
      items.flatMap((item): IrStatement[] => {
        const nested = withNestedBlocks(item, block);
        let reason: string | null = null;
        const opened = (value: IrExpression): IrExpression => {
          const next = mapChildren(value, opened);
          if (next.kind !== "load") return next;
          const { open: _open, ...load } = next;
          const key = literalKey(load.key);
          if (key === null || load.defaultValue !== undefined || !open.has(key)) return load;
          reason ??= filledIn.has(key) ? FILLED_IN : UNDECLARED;
          return { ...load, defaultValue: OPEN_NULL };
        };
        const next = mapOwnExpressions(nested, opened);
        if (reason === null) return [next];
        diagnostics.push({
          code: "SX_LOAD_OPEN_NULL",
          severity: "warning",
          message: reason,
          span: next.span,
        });
        const line = next.span === null ? "" : ` line ${next.span.line}`;
        const note: IrStatement = {
          kind: "comment",
          text: `// NOTE SX_LOAD_OPEN_NULL${line}: ${reason}`,
          trailing: false,
          span: next.span,
        };
        return [note, next];
      });
    return { ...program, statements: block(program.statements), diagnostics };
  });
}

/**
 * The types of the values the statements give each variable besides storage reads, by binding (Scope): `null`, a type
 * the importer knows here, or `unknown`.
 */
function otherValueTypes(statements: readonly IrStatement[]): Map<string, Set<string>> {
  const types = new Map<string, Set<string>>();
  const add = (binding: string, value: IrExpression): void => {
    if (value.kind === "load") return;
    const set = types.get(binding) ?? new Set<string>();
    set.add(isNullLiteral(value) ? "null" : (valueType(value) ?? "unknown"));
    types.set(binding, set);
  };
  const block = (items: readonly IrStatement[], scope: Scope): void => {
    for (const item of items) {
      if (item.kind === "let") add(scope.declare(item.name, item.span), item.value);
      if (item.kind === "assign" && item.operator === "=" && item.target.kind === "variable")
        add(scope.resolve(item.target.name), item.value);
      withNestedBlocks(item, (body) => {
        block(body, scope.inner(item));
        return body;
      });
    }
  };
  block(statements, Scope.file());
  return types;
}

const MAIN_DECLARED =
  "Declares the types of storage keys whose reads keep null where none of them could declare it; nothing calls this function, so its reads never run.";
const FILLED_IN =
  "Legacy read null for a missing key and filled the value in before using it, which the compiler cannot prove, so this read keeps that null of an open type, checked where it is used, and its key has no declared type.";
const UNDECLARED =
  "Legacy read null for a missing key; nothing tells this key's type where a load could declare it, so this read keeps that null of an open type, checked where it is used.";

/** The program without the marks of filled-in reads, whose keys are declared after all. */
function withoutOpenMarks(program: MigrationProgram): MigrationProgram {
  const unmark = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, unmark);
    if (next.kind !== "load" || next.open !== true) return next;
    const { open: _open, ...load } = next;
    return load;
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), unmark));
  return { ...program, statements: block(program.statements) };
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
 * The helpers that the reads use go where a read uses one and no definition reaches: main.tease's global functions
 * reach every file of a package (`shared`), and so do the global functions of the other files the package publishes,
 * else each file has its own. Added this late, after the names of the package were made apart, a helper's parameters
 * take names that no file uses.
 */
function withUsedHelpers(
  programs: readonly MigrationProgram[],
  shared: boolean,
  layout: PackageLayout,
): MigrationProgram[] {
  let result = [...programs];
  // A parameter may not take the name of a file's own variable or function, nor of a global.
  const names = new Set(
    result.flatMap((program) =>
      program.statements.flatMap((statement) =>
        statement.kind === "let" || statement.kind === "function" ? [statement.name] : [],
      ),
    ),
  );
  for (const helper of ["value", "text", "booleanText", "missingText"] as const) {
    const name = helperName(helper);
    const defines = (program: MigrationProgram, global = false): boolean =>
      program.statements.some(
        (statement) =>
          statement.kind === "function" &&
          statement.name === name &&
          (!global || statement.global === true),
      );
    const uses = (program: MigrationProgram): boolean =>
      JSON.stringify(program.statements).includes(`"name":"${name}"`);
    if (!result.some(uses)) continue;
    const definition = helperStatements(new Set([helper]))
      .filter((statement) => statement.kind === "function" && statement.name === name)
      .map((statement) => withFreshParameters(statement, names));
    const reaches = result.some(
      (program, index) => layout.published[index] === true && defines(program, true),
    );
    result = result.map((program, index) => {
      const needs = shared
        ? (index === 0 || index === layout.main) && !reaches && !defines(program)
        : uses(program) && !defines(program);
      if (!needs) return program;
      const added = definition.map((statement): IrStatement =>
        shared && statement.kind === "function" ? { ...statement, global: true } : statement,
      );
      return { ...program, statements: [...added, ...program.statements] };
    });
  }
  return result;
}

/** A function whose parameters that one of the `taken` names has are renamed apart from them, also in its body. */
function withFreshParameters(statement: IrStatement, taken: Set<string>): IrStatement {
  if (statement.kind !== "function") return statement;
  const renamed = new Map<string, string>();
  for (const parameter of statement.parameters) {
    if (!taken.has(parameter.name)) continue;
    let name = `${parameter.name}Value`;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${parameter.name}Value${suffix}`;
    taken.add(name);
    renamed.set(parameter.name, name);
  }
  if (renamed.size === 0) return statement;
  const rename = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, rename);
    return next.kind === "variable" && renamed.has(next.name)
      ? { ...next, name: renamed.get(next.name)! }
      : next;
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), rename));
  return {
    ...statement,
    parameters: statement.parameters.map((parameter) => ({
      ...parameter,
      name: renamed.get(parameter.name) ?? parameter.name,
    })),
    body: block(statement.body),
  };
}

function helperName(helper: HelperName): string {
  const call = helperCall(helper, []);
  return call.kind === "call" ? call.name : "";
}

/** Null of a type the compiler cannot know, which needs no declared type. */
const OPEN_NULL: IrExpression = helperCall("value", [{ kind: "literal", value: null }]);

/** Whether a default is the null of an open type that withDeclaredKeys gives (OPEN_NULL). */
function isOpenNull(value: IrExpression): boolean {
  return (
    value.kind === "call" &&
    value.name === helperName("value") &&
    value.positional.length === 1 &&
    isNullLiteral(value.positional[0]!)
  );
}

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
    value.number !== true
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
  if (type === "integer") return { kind: "literal", value: 0 };
  // A number key's default is a number too, so that a saved fraction fits the key's type.
  if (type === "number") return { kind: "literal", value: 0, decimal: true };
  if (type === "string") return { kind: "literal", value: "" };
  if (type === "boolean") return { kind: "literal", value: false };
  if (type.endsWith("[]")) return { kind: "list", items: [] };
  return null;
}

/** A copy of a statement with `map` applied to the values it evaluates itself, also its parameters' defaults. */
function mapOwnExpressions<T extends IrStatement>(
  statement: T,
  map: (value: IrExpression) => IrExpression,
): T {
  const own = mapOwnValues(statement, map);
  if (own.kind !== "function") return own;
  return {
    ...own,
    parameters: own.parameters.map((parameter) =>
      parameter.defaultValue === null
        ? parameter
        : { ...parameter, defaultValue: map(parameter.defaultValue) },
    ),
  };
}
