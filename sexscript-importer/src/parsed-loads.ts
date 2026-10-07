import { helperCall, type HelperName } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Legacy loadInteger() and loadFloat() parsed the stored text as a number, loadInteger() dropping the fraction toward
 * zero, so a value the script saved as text or with a fraction read as a number (`"5.1"` as 5.1, 100.5 as 100); a
 * missing key read null. A read calls a generated helper that parses a stored value and gives null, or the value the
 * script used instead (`load("points", default: 80)` before), for a missing one: `sexscriptLegacyLoadInteger("points",
 * 80)` (`loadInteger` and `loadFloat` in helpers.ts). A test for a missing key stays a plain read,
 * `load("points") == null`, since parsing keeps null as null. This runs after
 * variable typing, which reads the marked loads (`integer`, `number`), and registers the helpers it uses in `helpers`.
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
    const { integer, defaultValue } = next;
    const helper = integer === true ? "loadInteger" : "loadFloat";
    helpers.add(helper);
    const missing =
      defaultValue === undefined ||
      (defaultValue.kind === "literal" && defaultValue.value === null);
    return helperCall(helper, missing ? [next.key] : [next.key, defaultValue]);
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      const statement = mapOwnExpressions(withNestedBlocks(item, block), parse);
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
