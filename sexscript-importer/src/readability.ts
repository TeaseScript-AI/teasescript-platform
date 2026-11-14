import { emitTease } from "./emit-tease.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic, MigrationProgram } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Legacy chance helpers, the scripts' own `percentChance(percent)`, are TeaseScript's `chance(percent)` (V30
 * "Randomness"): a function whose body draws a number from 0 through 99, or from 1 through 99, and tests it against
 * its parameter. `percent > n` over 0 through 99 gives the percentage; `n <= percent` gave one point more over 0
 * through 99, and percent/99, up to one point more, over 1 through 99, which the owner treats as unintended
 * (2026-10-16, as Groovy's count-down ranges). A call with a whole number from 0 through 100
 * becomes `chance(n)`; another argument, which may be null or out of range where `chance` fails, keeps the helper. A
 * global helper's calls in every file take the builtin, a local one's in its own file; a definition that nothing names
 * any more goes. Each call of a helper over 1 through 99 is noted in the conversion report (`SX_CHANCE_ODDS`,
 * coordinator 2026-10-16).
 */
export function withChanceCalls(programs: readonly MigrationProgram[]): MigrationProgram[] {
  // The template body of each helper by name: global ones for every file, and each file's own functions, which a call
  // in that file names before a global one (null for a function that is no helper).
  const global = new Map<string, string>();
  const local = programs.map((program) => {
    const bodies = new Map<string, string | null>();
    for (const statement of program.statements) {
      if (statement.kind !== "function") continue;
      const body = chanceHelperBody(statement);
      if (statement.global !== true) bodies.set(statement.name, body);
      else if (body !== null) global.set(statement.name, body);
    }
    return bodies;
  });
  if (
    global.size === 0 &&
    local.every((bodies) => [...bodies.values()].every((body) => body === null))
  )
    return [...programs];
  const replaced = programs.map((program, index) => {
    const bodies = local[index]!;
    const helper = (name: string): string | null =>
      bodies.has(name) ? bodies.get(name)! : (global.get(name) ?? null);
    const diagnostics: MigrationDiagnostic[] = [];
    const call = (value: IrExpression): IrExpression => {
      const next = mapChildren(value, call);
      const body = next.kind === "call" ? helper(next.name) : null;
      if (
        next.kind !== "call" ||
        body === null ||
        next.positional.length !== 1 ||
        !isPercentage(next.positional[0]!)
      )
        return next;
      // A helper that drew from 1 through 99, whose odds were percent/99.
      if (body.includes(NINETY_NINE))
        diagnostics.push({
          code: "SX_CHANCE_ODDS",
          severity: "info",
          message: CHANCE_ODDS_NOTE,
          span: null,
        });
      return { kind: "call", name: "chance", positional: next.positional, named: {} };
    };
    const block = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), call));
    const statements = block(program.statements);
    return { ...program, statements, diagnostics: [...program.diagnostics, ...diagnostics] };
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
          : local[index]!.get(statement.name) != null && !names(program, statement.name)),
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

/** The draw of the helpers over 1 through 99. */
const NINETY_NINE = "randomInteger(0..99) + 1";

/** The conversion report's note on the calls of such a helper (coordinator 2026-10-16). */
export const CHANCE_ODDS_NOTE =
  "legacy percentChance drew 1–99 (odds percent/99); converted to chance(percent)";

/** The converted forms of the legacy chance helpers, with the parameter as `P` and the drawn number as `V`. */
const CHANCE_BODIES = new Set(
  [
    "return P > randomInteger(0..100)",
    "let V = randomInteger(0..100)\nreturn (V >= 0 and V <= P) or (V <= 0 and V >= P)",
    `let V = ${NINETY_NINE}\nreturn (V >= 0 and V <= P) or (V <= 0 and V >= P)`,
  ].flatMap((body) => [body, `P = P otherwise 0\n${body}`]),
);

/** The body of a legacy chance helper as its template gives it, or null for another function. */
function chanceHelperBody(statement: IrStatement & { kind: "function" }): string | null {
  const [parameter, ...others] = statement.parameters;
  if (parameter === undefined || others.length > 0 || parameter.defaultValue != null) return null;
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
  // A name P or V of the body's own, such as a global it reads, is not the parameter or the drawn number.
  const other = (placeholder: string, name: string | undefined): boolean =>
    name !== placeholder && new RegExp(`\\b${placeholder}\\b`, "u").test(body);
  if (other("P", parameter.name) || other("V", drawn?.kind === "let" ? drawn.name : undefined))
    return null;
  const template = words(body).trim();
  return CHANCE_BODIES.has(template) ? template : null;
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
 * variable, or a member of one other than `.random`, gives the same value at each read, so reading it once where the
 * tests read it twice changes nothing. The null test of a condition whose blocks read the variable stays: it narrows
 * the variable there, which a fallback does not.
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

/**
 * A test of a boolean variable against true or false is the variable or its negation, as for the booleans variable
 * typing proves (variable-types.ts). A variable keeps the type it is declared with, `boolean` or the type of a first
 * value `true` or `false`: the compiler refuses another value, and a value of unknown type, such as a read of a key
 * built at run time, stops the script where it is stored (TSR058), so every read gives true or false. The storage
 * defaults declare such variables after typing ran, as for a flag read from a key that holds only booleans. Only a name
 * the file binds once, by that declaration (not a global, which other files may assign), and only after it in its
 * block, so that every such read is that variable.
 */
export function withTypedBooleanTests(statements: IrStatement[]): IrStatement[] {
  const bindings = new Map<string, number>();
  const bind = (name: string): void => void bindings.set(name, (bindings.get(name) ?? 0) + 1);
  const count = (items: IrStatement[]): IrStatement[] => {
    for (const item of items) {
      if (item.kind === "let") bind(item.name);
      if (item.kind === "function") for (const parameter of item.parameters) bind(parameter.name);
      if (item.kind === "for") {
        bind(item.variable);
        if (item.valueVariable !== undefined) bind(item.valueVariable);
      }
      withNestedBlocks(item, count);
    }
    return items;
  };
  count(statements);
  const block = (items: IrStatement[], known: ReadonlySet<string>): IrStatement[] => {
    const typed = new Set(known);
    const plain = (value: IrExpression): IrExpression => {
      const next = mapChildren(value, plain);
      if (
        next.kind !== "binary" ||
        (next.operator !== "==" && next.operator !== "!=") ||
        next.left.kind !== "variable" ||
        !typed.has(next.left.name) ||
        next.right.kind !== "literal" ||
        typeof next.right.value !== "boolean"
      )
        return next;
      return (next.operator === "==") === next.right.value
        ? next.left
        : { kind: "unary", operator: "not", value: next.left };
    };
    return items.map((item) => {
      const result = mapOwnExpressions(
        withNestedBlocks(item, (body) => block(body, typed)),
        plain,
      );
      if (
        item.kind === "let" &&
        item.global !== true &&
        bindings.get(item.name) === 1 &&
        (item.type === "boolean" ||
          (item.type === undefined &&
            item.value.kind === "literal" &&
            typeof item.value.value === "boolean"))
      )
        typed.add(item.name);
      return result;
    });
  };
  return block(statements, new Set());
}

/** The name of the variable a read starts from. */
function rootName(value: IrExpression): string {
  return value.kind === "property"
    ? rootName(value.target)
    : value.kind === "variable"
      ? value.name
      : "";
}

/** A variable, or a member of one, which reading again gives again; `.random` draws anew at each read. */
function isPlainRead(value: IrExpression): boolean {
  if (value.kind === "variable") return true;
  return (
    value.kind === "property" &&
    value.dict !== true &&
    value.name !== "random" &&
    isPlainRead(value.target)
  );
}
