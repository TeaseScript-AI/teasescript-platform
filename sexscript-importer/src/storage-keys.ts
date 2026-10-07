import { helperCall, helperDefinitionOrder, helperStatements, type HelperName } from "./helpers.ts";
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
 * A read of a computed key has no type (#690): one that keeps its null gets null of an open type,
 * `default: sexscriptLegacyValue(null)`, as `default: null` would type its value as null, so that it stays as open as
 * legacy's read (`SX_LOAD_COMPUTED_OPEN`, counted).
 */
function withOpenComputedReads(programs: readonly MigrationProgram[]): MigrationProgram[] {
  return programs.map((program) => {
    const diagnostics = [...program.diagnostics];
    let span: IrStatement["span"] = null;
    const opened = (value: IrExpression): IrExpression => {
      const next = mapChildren(value, opened);
      if (next.kind !== "load" || next.defaultValue !== undefined || literalKey(next.key) !== null)
        return next;
      diagnostics.push({
        code: "SX_LOAD_COMPUTED_OPEN",
        severity: "info",
        message: "A read of a computed key has no type; it keeps legacy's null of an open type.",
        span,
      });
      return { ...next, defaultValue: OPEN_NULL };
    };
    // The generated helpers read their keys as they are written (helpers.ts).
    const block = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => {
        if (helperDefinitionOrder(item) >= 0) return item;
        const next = withNestedBlocks(item, block);
        span = next.span;
        return mapOwnExpressions(next, opened);
      });
    return { ...program, statements: block(program.statements), diagnostics };
  });
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
 * global functions reach every file.
 */
export interface PackageLayout {
  published: readonly boolean[];
  main: number;
}

/**
 * Gives each read marked by withFillableLoads the empty value of the type legacy read (`read`) or, for a plain `load`,
 * of the one type the package's saves give its key (an integer and a number make a number); a read without such a type
 * keeps its null. Then declares the keys whose reads keep their null or whose values mix types (withDeclaredKeys).
 */
export function withStorageDefaults(
  programs: readonly MigrationProgram[],
  shared: boolean,
  layout: PackageLayout = { published: programs.map(() => true), main: 0 },
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
  // A legacy loadString or loadBoolean read of a key that values of another type are saved under too reads the value
  // as stored and turns it into the type legacy read (withTypedTextReads).
  const routed = new Set(
    [...read].flatMap(([key, types]) =>
      [...(saved.get(key) ?? [])].some((type) => !types.has(type)) ? [key] : [],
    ),
  );
  for (const key of routed) read.delete(key);
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
    withOpenComputedReads(
      withDeclaredKeys(withEmptyText(filled, textKeys), declaredType, layout.published),
    ),
    shared,
    layout.main,
  );
}

/**
 * The legacy loadString and loadBoolean reads of the keys in `routed`, whose saves store values of another type too:
 * the value is read as stored and becomes text through the text helper, or true only for "true" through the boolean
 * text helper, as the reads of keys saved as literals do already (SX_LOAD_STRING_TEXT, SX_LOAD_BOOLEAN_TEXT).
 */
function withTypedTextReads(
  programs: readonly MigrationProgram[],
  routed: ReadonlySet<string>,
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
          if (next.kind !== "load" || key === null || next.read === undefined || !routed.has(key))
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
  "loadString() read the stored value as text, and the package saves values of another type under this key too, so the value is read as stored and turned into text; a missing value is the empty text.";
const BOOLEAN_TEXT =
  'loadBoolean() read the stored value as text, true only for "true", and the package saves values of another type under this key too, so the value is read the same way; a missing value reads as false.';

/**
 * A missing text reads as the empty text (owner decision 2026-10-07): every read of a key that only text is read from
 * and saved under, and a legacy text read of a computed key, gets `default: ""` (of an open type for a computed key,
 * which stays untyped), also where the script tests it for null, and those tests test for the empty text instead,
 * `x == null` as `x == ""`, of the read itself or of the variable it is read into, also through copies, parameters,
 * and results it reaches; where the variable may hold null from another value too, the test takes both,
 * `x == null or x == ""`. A null that the script saves under the key or sets the variable to is the empty text too. A
 * variable is the binding its name resolves to: a function's own variable or parameter, or else the file's, or a
 * global's in every file. A stored empty text so counts as missing.
 */
function withEmptyText(
  programs: readonly MigrationProgram[],
  textKeys: ReadonlySet<string>,
): MigrationProgram[] {
  const EMPTY: IrExpression = { kind: "literal", value: "" };
  const computedText = (value: IrExpression): boolean =>
    value.kind === "load" && literalKey(value.key) === null && value.read === "string";
  const textRead = (value: IrExpression): boolean => {
    if (value.kind !== "load") return false;
    const key = literalKey(value.key);
    return key === null ? value.read === "string" : textKeys.has(key);
  };
  const text = (value: IrExpression): boolean =>
    textRead(value) ||
    (value.kind === "template" &&
      value.parts.length === 1 &&
      "value" in value.parts[0]! &&
      value.parts[0].value.kind === "load");
  const textual = (value: IrExpression): boolean =>
    text(value) ||
    value.kind === "template" ||
    (value.kind === "literal" && typeof value.value === "string") ||
    (value.kind === "input" && value.input === "askText");
  // Each program's bindings: `function:name` for a function's own variable or parameter, `:name` for the file's.
  const scopes = programs.map((program) => functionLocals(program.statements));
  const resolve = (index: number, fn: string | null, name: string): string =>
    fn !== null && scopes[index]!.get(fn)?.has(name) === true ? `${fn}:${name}` : `:${name}`;
  const receivers = programs.map(() => new Set<string>());
  const reached = programs.map(() => new Set<string>());
  const mixed = programs.map(() => new Set<string>());
  const nulled = programs.map(() => new Set<string>());
  const others = programs.map(() => new Map<string, Set<string>>());
  const globals = new Set<string>();
  const declaredGlobal = new Set(
    programs.flatMap((program) =>
      program.statements.flatMap((statement) =>
        statement.kind === "let" && statement.global === true ? [statement.name] : [],
      ),
    ),
  );
  programs.forEach((program, index) => {
    const copies: Array<[string, IrExpression, string | null]> = [];
    const functions = new Map<string, Extract<IrStatement, { kind: "function" }>>();
    const returning = new Set<string>();
    const calls: Array<[Extract<IrExpression, { kind: "call" }>, string | null]> = [];
    const visit = (items: readonly IrStatement[], fn: string | null): void => {
      const collectCalls = (value: IrExpression): IrExpression => {
        if (value.kind === "call" && value.local === true) calls.push([value, fn]);
        return mapChildren(value, collectCalls);
      };
      for (const item of items) {
        const name =
          item.kind === "let"
            ? item.name
            : item.kind === "assign" && item.operator === "=" && item.target.kind === "variable"
              ? item.target.name
              : null;
        if (name !== null && (item.kind === "let" || item.kind === "assign")) {
          const target = resolve(index, fn, name);
          if (text(item.value)) receivers[index]!.add(target);
          if (isNullLiteral(item.value)) nulled[index]!.add(target);
          else if (!textual(item.value)) mixed[index]!.add(target);
          if (!text(item.value)) {
            const types = others[index]!.get(target) ?? new Set<string>();
            types.add(
              isNullLiteral(item.value)
                ? "null"
                : item.value.kind === "load"
                  ? "unknown"
                  : (valueType(item.value) ?? "unknown"),
            );
            others[index]!.set(target, types);
          }
          copies.push([target, item.value, fn]);
        }
        if (item.kind === "return" && item.value !== null && fn !== null)
          copies.push([`return:${fn}`, item.value, fn]);
        mapOwnExpressions(item, collectCalls);
        if (item.kind === "function") {
          functions.set(item.name, item);
          visit(item.body, item.name);
          continue;
        }
        withNestedBlocks(item, (body) => {
          visit(body, fn);
          return body;
        });
      }
    };
    visit(program.statements, null);
    const holds = (value: IrExpression, fn: string | null): boolean => {
      if (text(value)) return true;
      if (value.kind === "variable") {
        const binding = resolve(index, fn, value.name);
        return receivers[index]!.has(binding) || reached[index]!.has(binding);
      }
      return value.kind === "call" && value.local === true && returning.has(value.name);
    };
    for (let changed = true; changed;) {
      changed = false;
      const reach = (binding: string): void => {
        if (binding.startsWith("return:")) {
          const fn = binding.slice("return:".length);
          if (!returning.has(fn)) {
            returning.add(fn);
            changed = true;
          }
        } else if (!receivers[index]!.has(binding) && !reached[index]!.has(binding)) {
          reached[index]!.add(binding);
          changed = true;
        }
      };
      for (const [target, value, fn] of copies) if (holds(value, fn)) reach(target);
      for (const [call, fn] of calls) {
        const callee = functions.get(call.name);
        call.positional.forEach((argument, position) => {
          const parameter = callee?.parameters[position];
          if (parameter !== undefined && holds(argument, fn))
            reach(`${call.name}:${parameter.name}`);
        });
      }
    }
    for (const binding of receivers[index]!)
      if (binding.startsWith(":") && declaredGlobal.has(binding.slice(1)))
        globals.add(binding.slice(1));
  });
  return programs.map((program, index) => {
    const diagnostics = [...program.diagnostics];
    const note = (code: string, message: string, span: IrStatement["span"]): void => {
      diagnostics.push({ code, severity: "info", message, span });
    };
    const isReceiver = (binding: string): boolean =>
      receivers[index]!.has(binding) || (binding.startsWith(":") && globals.has(binding.slice(1)));
    // A text variable holds null only where the script sets it so and no text is read into it, or other values.
    const holdsNull = (binding: string): boolean =>
      mixed[index]!.has(binding) || (nulled[index]!.has(binding) && !isReceiver(binding));
    const typeOf = (binding: string): { type?: string; open?: true } => {
      const given = [...(others[index]!.get(binding) ?? [])].filter(
        (type) => type !== "string" && !(type === "null" && isReceiver(binding)),
      );
      if (given.length === 0) return {};
      if (given.includes("unknown")) return { open: true };
      const held = unionType(["string", ...given.filter((type) => type !== "null")])!;
      if (!given.includes("null")) return { type: held };
      return { type: held.includes(" | ") ? `${held} | null` : `${held}?` };
    };
    const widened = new Set<string>();
    const block = (items: IrStatement[], fn: string | null): IrStatement[] =>
      items.flatMap((item): IrStatement[] => {
        const nested =
          item.kind === "function"
            ? { ...item, body: block(item.body, item.name) }
            : withNestedBlocks(item, (body) => block(body, fn));
        const span = nested.span;
        const tested = (value: IrExpression): boolean => {
          if (text(value)) return true;
          if (value.kind !== "variable") return false;
          const binding = resolve(index, fn, value.name);
          return isReceiver(binding) || reached[index]!.has(binding);
        };
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
            // A computed key has no type, so its default keeps an open one.
            return {
              ...load,
              defaultValue: computedText(load) ? helperCall("value", [EMPTY]) : EMPTY,
            };
          }
          if (next.kind !== "binary" || (next.operator !== "==" && next.operator !== "!="))
            return next;
          const side = isNullLiteral(next.right)
            ? next.left
            : isNullLiteral(next.left)
              ? next.right
              : null;
          if (side === null || !tested(side)) return next;
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
          if (side.kind !== "variable") return empty;
          const binding = resolve(index, fn, side.name);
          const both = holdsNull(binding) || (reached[index]!.has(binding) && !isReceiver(binding));
          return both
            ? {
                kind: "binary",
                operator: next.operator === "==" ? "or" : "and",
                left: next,
                right: empty,
              }
            : empty;
        };
        let next = mapOwnExpressions(nested, rewrite);
        const key = next.kind === "save" ? literalKey(next.key) : null;
        if (next.kind === "save" && key !== null && textKeys.has(key) && isNullLiteral(next.value))
          return [{ ...next, value: EMPTY }];
        const name =
          next.kind === "let"
            ? next.name
            : next.kind === "assign" && next.operator === "=" && next.target.kind === "variable"
              ? next.target.name
              : null;
        if (name === null || (next.kind !== "let" && next.kind !== "assign")) return [next];
        const binding = resolve(index, fn, name);
        // Null set to a variable that text is read into is the empty text, which its tests test for.
        if (isNullLiteral(next.value) && isReceiver(binding)) {
          note(
            "SX_LOAD_TEXT_NULL_SET",
            "Legacy set this text to null, missing; it is the empty text now.",
            span,
          );
          return [{ ...next, value: EMPTY }];
        }
        if (next.kind === "assign" && text(next.value)) widened.add(binding);
        if (next.kind !== "let" || !text(next.value) || next.type !== undefined) return [next];
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
    const statements = block(program.statements, null);
    // A variable that text is read into after another value started it holds both; one that holds only text, whose
    // null tests test for the empty text now, holds no null.
    const widen = (items: IrStatement[], fn: string | null): IrStatement[] =>
      items.map((item) => {
        if (item.kind === "function") return { ...item, body: widen(item.body, item.name) };
        const next = withNestedBlocks(item, (body) => widen(body, fn));
        if (next.kind !== "let") return next;
        const binding = resolve(index, fn, next.name);
        const reads = widened.has(binding) || text(next.value);
        if (next.type === "string?" && reads && !holdsNull(binding))
          return { ...next, type: "string" };
        if (next.type !== undefined || !widened.has(binding)) return next;
        const start = valueType(next.value);
        if (start === null || start === "string") return next;
        return { ...next, type: `${unionType([start, "string"])!} | null` };
      });
    return { ...program, statements: widen(statements, null), diagnostics };
  });
}

/** Each function's own variables and parameters, by the function's name. */
function functionLocals(statements: readonly IrStatement[]): Map<string, Set<string>> {
  const locals = new Map<string, Set<string>>();
  const visit = (items: readonly IrStatement[], names: Set<string> | null): void => {
    for (const item of items) {
      if (item.kind === "function") {
        const own = new Set(item.parameters.map((parameter) => parameter.name));
        locals.set(item.name, own);
        visit(item.body, own);
        continue;
      }
      if (item.kind === "let" && names !== null) names.add(item.name);
      if (item.kind === "for" && names !== null) names.add(item.variable);
      withNestedBlocks(item, (body) => {
        visit(body, names);
        return body;
      });
    }
  };
  visit(statements, null);
  return locals;
}

const OPEN_TEXT =
  "Legacy read null for a missing text, the empty text here; the script gives this variable values of a type the compiler cannot tell too, so the read keeps an open type, checked where it is used.";

function isNullLiteral(value: IrExpression): boolean {
  return value.kind === "literal" && value.value === null;
}

/**
 * A read that keeps its null (`default: null`), and a read of a key whose values mix types, needs its key's type
 * declared at one of its loads (#690), which the key's other loads take; the same declaration may repeat. In each
 * published file the first `let` that reads the key gets it (`let level: integer? = load "game.level", default: null`,
 * optional where its read keeps its null), widened by the other values the script gives that variable, or in a file
 * where no `let` reads the key, the first read inside a statement that runs once, where nothing with an effect runs
 * before it and no `and` or `or` may skip it, moves into one just before that statement, so that each file declares
 * the keys it reads itself and compiles on its own (`let savedLevel: integer? =
 * load "game.level", default: null`). A key that no published file can declare so, or whose type nothing tells, keeps
 * its null of an open type instead, `default: sexscriptLegacyValue(null)`, which needs no declaration.
 */
function withDeclaredKeys(
  programs: readonly MigrationProgram[],
  declaredType: (key: string) => string | null,
  published: readonly boolean[],
): MigrationProgram[] {
  const nullRead = new Set<string>();
  const declared = new Set<string>();
  const letRead = new Set<string>();
  const filledIn = new Set<string>();
  programs.forEach((program, index) => {
    const reads = (value: IrExpression): IrExpression => {
      const key = value.kind === "load" ? literalKey(value.key) : null;
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
  const optional = (type: string): string => (type.includes(" | ") ? `${type} | null` : `${type}?`);
  // Names generated here stay clear of every name of the package, which globals share.
  const packageNames = new Set(programs.flatMap((program) => [...usedNames(program.statements)]));
  const done = new Set<string>();
  const declaredPrograms = programs.map((program, index) => {
    const taken = new Set(packageNames);
    const fresh = (key: string): string => {
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
    const others = otherValueTypes(program.statements);
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
        // The variable also takes the other values the script gives it, which an unknown one rules out.
        const given = others.get(next.name) ?? new Set<string>();
        if (given.has("unknown")) return next;
        const held = unionType([type, ...[...given].filter((member) => member !== "null")])!;
        atLet.add(key);
        if (published[index] === true) done.add(key);
        return {
          ...next,
          type: next.value.defaultValue === undefined || given.has("null") ? optional(held) : held,
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
            const name = fresh(key);
            lifted.add(key);
            if (published[index] === true) done.add(key);
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
  // A key that no published file could declare, as its reads sit only in loops or after effects, keeps an open null.
  for (const key of types.keys()) if (!done.has(key)) open.add(key);
  if (open.size === 0) return declaredPrograms.map(withoutOpenMarks);
  return declaredPrograms.map((program) => {
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
 * The types of the values the statements give each variable besides storage reads, by name: `null`, a type the
 * importer knows here, or `unknown`.
 */
function otherValueTypes(statements: readonly IrStatement[]): Map<string, Set<string>> {
  const types = new Map<string, Set<string>>();
  const add = (name: string, value: IrExpression): void => {
    if (value.kind === "load") return;
    const set = types.get(name) ?? new Set<string>();
    set.add(isNullLiteral(value) ? "null" : (valueType(value) ?? "unknown"));
    types.set(name, set);
  };
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "let") add(item.name, item.value);
      if (item.kind === "assign" && item.operator === "=" && item.target.kind === "variable")
        add(item.target.name, item.value);
      withNestedBlocks(item, (body) => {
        block(body);
        return body;
      });
    }
  };
  block(statements);
  return types;
}

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
 * reach every file of a package (`shared`), else each file has its own. Added this late, after the names of the package
 * were made apart, a helper's parameters take names that no file uses.
 */
function withUsedHelpers(
  programs: readonly MigrationProgram[],
  shared: boolean,
  main: number,
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
  for (const helper of ["value", "text", "booleanText"] as const) {
    const name = helperName(helper);
    const defines = (program: MigrationProgram): boolean =>
      program.statements.some(
        (statement) => statement.kind === "function" && statement.name === name,
      );
    const uses = (program: MigrationProgram): boolean =>
      JSON.stringify(program.statements).includes(`"name":"${name}"`);
    if (!result.some(uses)) continue;
    const definition = helperStatements(new Set([helper]))
      .filter((statement) => statement.kind === "function" && statement.name === name)
      .map((statement) => withFreshParameters(statement, names));
    const anyDefines = result.some(defines);
    result = result.map((program, index) => {
      const needs = shared
        ? (index === 0 || index === main) && !anyDefines
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
