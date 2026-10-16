import { emitTease } from "./emit-tease.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Legacy chance helpers, the scripts' own `percentChance(percent)`, are TeaseScript's `chance(percent)` (V30
 * "Randomness"): a function whose body draws a number from 1 through 100, or from 0 through 99, and tests it against
 * its parameter. Drawing from 0 through 99 and testing `<= percent` gave one point more than the percentage, which the
 * owner treats as unintended (2026-10-16, as Groovy's count-down ranges). A call with a whole number from 0 through 100
 * becomes `chance(n)`; another argument, which may be null or out of range where `chance` fails, keeps the helper. A
 * global helper's calls in every file take the builtin, a local one's in its own file; a definition that nothing names
 * any more goes.
 */
export function withChanceCalls(programs: readonly MigrationProgram[]): MigrationProgram[] {
  const global = new Set<string>();
  const local = programs.map((program) => {
    const names = new Set<string>();
    for (const statement of program.statements)
      if (statement.kind === "function" && isChanceHelper(statement))
        (statement.global === true ? global : names).add(statement.name);
    return names;
  });
  if (global.size === 0 && local.every((names) => names.size === 0)) return [...programs];
  const replaced = programs.map((program, index) => {
    const names = new Set([...global, ...local[index]!]);
    if (names.size === 0) return program;
    const call = (value: IrExpression): IrExpression => {
      const next = mapChildren(value, call);
      if (
        next.kind !== "call" ||
        !names.has(next.name) ||
        next.positional.length !== 1 ||
        !isPercentage(next.positional[0]!)
      )
        return next;
      return { kind: "call", name: "chance", positional: next.positional, named: {} };
    };
    const block = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), call));
    return { ...program, statements: block(program.statements) };
  });
  // Whether code other than the definition names a function, as a call or an action.
  const names = (program: MigrationProgram, name: string): boolean =>
    program.actions?.includes(name) === true ||
    program.statements.some(
      (statement) =>
        !(statement.kind === "function" && statement.name === name) &&
        JSON.stringify(statement).includes(`"${name}"`),
    );
  return replaced.map((program, index) => ({
    ...program,
    statements: program.statements.filter(
      (statement) =>
        statement.kind !== "function" ||
        !(global.has(statement.name)
          ? !replaced.some((other) => names(other, statement.name))
          : local[index]!.has(statement.name) && !names(program, statement.name)),
    ),
  }));
}

/** A whole number from 0 through 100 written as such, the percentage `chance` takes. */
function isPercentage(value: IrExpression): boolean {
  return (
    value.kind === "literal" &&
    typeof value.value === "number" &&
    Number.isInteger(value.value) &&
    value.value >= 0 &&
    value.value <= 100
  );
}

/** The converted forms of the legacy chance helpers, with the parameter as `P` and the drawn number as `V`. */
const CHANCE_BODIES = new Set(
  [
    "return P > randomInteger(0..100)",
    "let V = randomInteger(0..100)\nreturn (V >= 0 and V <= P) or (V <= 0 and V >= P)",
    "let V = randomInteger(0..99) + 1\nreturn (V >= 0 and V <= P) or (V <= 0 and V >= P)",
  ].flatMap((body) => [body, `P = P otherwise 0\n${body}`]),
);

function isChanceHelper(statement: IrStatement & { kind: "function" }): boolean {
  const [parameter, ...others] = statement.parameters;
  if (parameter === undefined || others.length > 0 || parameter.defaultValue != null) return false;
  const drawn = statement.body.find((item) => item.kind === "let");
  const words = (text: string): string => {
    const named = text.replace(new RegExp(`\\b${parameter.name}\\b`, "gu"), "P");
    return drawn?.kind === "let"
      ? named.replace(new RegExp(`\\b${drawn.name}\\b`, "gu"), "V")
      : named;
  };
  const body = emitTease({
    sourceName: "",
    metadata: null,
    statements: statement.body.filter((item) => item.kind !== "comment"),
    diagnostics: [],
  });
  return CHANCE_BODIES.has(words(body).trim());
}
