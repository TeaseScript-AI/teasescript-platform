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

/**
 * A loop that runs until a test at its top breaks it, `while true { if done { break } … }`, is a loop on the opposite
 * test, `while not done { … }`, or `while n < 3 { … }` for `if n >= 3 { break }`: the test runs before each pass as the
 * loop's condition does, and `continue` comes back to it either way.
 */
export function withLoopConditions(statements: IrStatement[]): IrStatement[] {
  return statements.map((item) => {
    const statement = withNestedBlocks(item, withLoopConditions);
    if (
      statement.kind !== "while" ||
      statement.condition.kind !== "literal" ||
      statement.condition.value !== true
    )
      return statement;
    const [first, ...rest] = statement.body;
    if (
      first?.kind !== "if" ||
      first.else.length > 0 ||
      first.then.length !== 1 ||
      first.then[0]!.kind !== "break"
    )
      return statement;
    return { ...statement, condition: opposite(first.condition), body: rest };
  });
}

/** Comparisons and their opposites; TeaseScript numbers are never NaN, so `not (a < b)` is `a >= b`. */
const OPPOSITES: Readonly<Record<string, string>> = {
  "==": "!=",
  "!=": "==",
  "<": ">=",
  ">=": "<",
  ">": "<=",
  "<=": ">",
};

/** The opposite of a test: a negation's operand, a comparison with the opposite operator, or `not` the test. */
function opposite(test: IrExpression): IrExpression {
  if (test.kind === "unary" && test.operator === "not") return test.value;
  const operator = test.kind === "binary" ? OPPOSITES[test.operator] : undefined;
  return test.kind === "binary" && operator !== undefined
    ? { ...test, operator }
    : { kind: "unary", operator: "not", value: test };
}

/**
 * Groovy truth of a value that may be null, written as two tests of one variable, reads as one test with a fallback:
 * `x == null or x == 0` is `(x otherwise 0) == 0`, `x != null and x != ""` is `(x otherwise "") != ""`, and
 * `x != null and x == true` is `x == true`, which a null never equals (V30 §18 "Fallback with otherwise"). The
 * variable, or a member of one, is read twice either way, so it has no effect. The null test of a condition whose
 * blocks read the variable stays: it narrows the variable there, which a fallback does not.
 */
export function withPlainNullTests(statements: IrStatement[]): IrStatement[] {
  let guarded = "";
  const plain = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, plain);
    if (next.kind !== "binary" || (next.operator !== "or" && next.operator !== "and")) return next;
    const { left, right } = next;
    const nullTest = next.operator === "or" ? "==" : "!=";
    if (
      left.kind !== "binary" ||
      right.kind !== "binary" ||
      left.operator !== nullTest ||
      left.right.kind !== "literal" ||
      left.right.value !== null ||
      right.right.kind !== "literal" ||
      right.right.value === null ||
      !isPlainRead(left.left) ||
      JSON.stringify(left.left) !== JSON.stringify(right.left) ||
      guarded.includes(JSON.stringify(rootName(left.left)))
    )
      return next;
    // A null never equals a value, so the null test before an equality adds nothing.
    if (next.operator === "and" && right.operator === "==") return right;
    if (right.operator !== nullTest) return next;
    return {
      kind: "binary",
      operator: right.operator,
      left: { kind: "binary", operator: "otherwise", left: right.left, right: right.right },
      right: right.right,
    };
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      const nested = withNestedBlocks(item, block);
      // The text of the blocks a condition governs, where a variable it tests may be narrowed.
      guarded =
        nested.kind === "if"
          ? JSON.stringify([nested.then, nested.else])
          : nested.kind === "while"
            ? JSON.stringify(nested.body)
            : "";
      const result = mapOwnExpressions(nested, plain);
      guarded = "";
      return result;
    });
  return block(statements);
}

/** The name of the variable a read starts from. */
function rootName(value: IrExpression): string {
  return value.kind === "property"
    ? rootName(value.target)
    : value.kind === "variable"
      ? value.name
      : "";
}

/** A variable, or a member of one, which reading again gives again. */
function isPlainRead(value: IrExpression): boolean {
  if (value.kind === "variable") return true;
  return value.kind === "property" && value.dict !== true && isPlainRead(value.target);
}
