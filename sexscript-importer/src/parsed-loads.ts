import { helperCall, type HelperName } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { usedNames } from "./message-handles.ts";
import { computes, hasEffect, withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Legacy loadInteger() and loadFloat() parsed the stored text as a number, loadInteger() dropping the fraction toward
 * zero, so a value the script saved as text or with a fraction read as a number (`"5.1"` as 5.1, 100.5 as 100); a
 * missing key read null. A read calls a generated helper that parses a stored value and gives null, or the value the
 * script used instead (`load("points", default: 80)` before), for a missing one: `sexscriptLegacyLoadInteger("points",
 * 80)` (`loadInteger` and `loadFloat` in helpers.ts); a value that may fail or have an effect still runs only for a
 * missing key. A test for a missing key stays a plain read, `load("points") == null`, since parsing keeps null as null.
 * This runs after variable typing, which reads the marked loads (`integer`, `number`), and registers the helpers it
 * uses in `helpers`.
 */
export function withParsedLoads(
  statements: IrStatement[],
  helpers: Set<HelperName>,
): IrStatement[] {
  const parse = (value: IrExpression): IrExpression => {
    // A test for a missing key reads the same whether the value is parsed or not: `load("k") == null`.
    if (value.kind === "binary" && (value.operator === "==" || value.operator === "!=")) {
      const missing = (side: IrExpression): boolean =>
        side.kind === "literal" && side.value === null;
      const raw = (side: IrExpression): IrExpression => {
        if (side.kind !== "load") return parse(side);
        const { integer: _integer, number: _number, ...load } = side;
        return { ...load, key: parse(load.key) };
      };
      if (missing(value.right)) return { ...value, left: raw(value.left) };
      if (missing(value.left)) return { ...value, right: raw(value.right) };
    }
    const next = mapChildren(value, parse);
    if (next.kind !== "load" || (next.integer !== true && next.number !== true)) return next;
    const { integer, defaultValue, key } = next;
    const helper = integer === true ? "loadInteger" : "loadFloat";
    if (
      defaultValue === undefined ||
      (defaultValue.kind === "literal" && defaultValue.value === null)
    ) {
      helpers.add(helper);
      return helperCall(helper, [key]);
    }
    if (settled(defaultValue)) {
      helpers.add(helper);
      return helperCall(helper, [key, defaultValue]);
    }
    helpers.add(helper);
    // A value that may fail or have an effect runs only for a missing key, as the plain read's default does, so the
    // helper gets that read: `sexscriptLegacyLoadInteger("k", load("k", default: 1 / count))`. A key that computes
    // something, read twice so, is computed once before its statement (keyed); a read elsewhere, which no legacy
    // read-then-default code gives, gets the value.
    if (!repeatable(key)) return helperCall(helper, [key, defaultValue]);
    const { integer: _integer, number: _number, ...raw } = next;
    return helperCall(helper, [key, raw]);
  };
  // A key's variable takes a name that nothing in the file uses.
  let taken: Set<string> | null = null;
  let keys = 0;
  const fresh = (): string => {
    taken ??= usedNames(statements);
    let name: string;
    do {
      keys += 1;
      name = `sexscriptLegacyKey${keys}`;
    } while (taken.has(name));
    return name;
  };
  const keyed = (item: IrStatement): IrStatement[] => {
    if ((item.kind !== "let" || item.global === true) && item.kind !== "assign") return [item];
    const read = storedRead(item.value);
    if (
      read === null ||
      (read.integer !== true && read.number !== true) ||
      read.defaultValue === undefined ||
      settled(read.defaultValue) ||
      repeatable(read.key)
    )
      return [item];
    const name = fresh();
    const key: IrStatement = { kind: "let", name, value: read.key, span: item.span };
    return [key, { ...item, value: withKey(item.value, { kind: "variable", name }) }];
  };
  // A number variable that a read starts or is set to reads 0 for a missing key, where legacy's `int` or `double`
  // failed on null: one declared so, or one whose value a whole-number or number conversion stores.
  const counted = (item: IrStatement): IrStatement => {
    if (item.kind !== "let" && (item.kind !== "assign" || item.operator !== "=")) return item;
    const converted =
      item.value.kind === "call" &&
      item.value.local !== true &&
      (item.value.name === "toInteger" || item.value.name === "toNumber") &&
      item.value.positional.length === 1
        ? item.value
        : null;
    const read = converted?.positional[0] ?? item.value;
    const numeric =
      converted !== null ||
      (item.kind === "let" && (item.type === "integer" || item.type === "number"));
    if (
      !numeric ||
      read.kind !== "load" ||
      (read.integer !== true && read.number !== true) ||
      read.defaultValue !== undefined
    )
      return item;
    const decimal =
      converted === null
        ? item.kind === "let" && item.type === "number"
        : converted.name === "toNumber";
    const defaulted: IrExpression = {
      ...read,
      defaultValue: { kind: "literal", value: 0, ...(decimal ? { decimal: true as const } : {}) },
    };
    return {
      ...item,
      value: converted === null ? defaulted : { ...converted, positional: [defaulted] },
    };
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.flatMap(keyed).map((item) => {
      const statement = mapOwnExpressions(withNestedBlocks(counted(item), block), parse);
      return statement.kind === "function"
        ? {
            ...statement,
            parameters: statement.parameters.map((parameter) =>
              parameter.defaultValue === null
                ? parameter
                : { ...parameter, defaultValue: parse(parameter.defaultValue) },
            ),
          }
        : statement;
    });
  return block(statements);
}

/** The read a statement stores, also through a conversion such as `toInteger(read)`; null for another value. */
function storedRead(value: IrExpression): Extract<IrExpression, { kind: "load" }> | null {
  if (value.kind === "load") return value;
  return value.kind === "call" && value.positional.length === 1
    ? storedRead(value.positional[0]!)
    : null;
}

/** The stored value with the key of its read (storedRead) replaced. */
function withKey(value: IrExpression, key: IrExpression): IrExpression {
  if (value.kind === "load") return { ...value, key };
  return value.kind === "call"
    ? { ...value, positional: [withKey(value.positional[0]!, key)] }
    : value;
}

/** Whether evaluating the value twice in a row gives the same value without an effect. */
function repeatable(value: IrExpression): boolean {
  return !computes(value) && !hasEffect(value);
}

/** Whether evaluating the value can neither fail nor have an effect: a literal, a variable, or a list of those. */
function settled(value: IrExpression): boolean {
  if (value.kind === "literal" || value.kind === "variable") return true;
  if (value.kind === "unary") return value.operator !== "not" && value.value.kind === "literal";
  return value.kind === "list" && value.items.every(settled);
}
