import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Code no author would write, which the compiler lists as never running (#946: TSV065 "This code never runs", TSV066
 * "This exit never runs"), is not written (readability, owner 2026-10-16; coordinator part M, 2026-10-17):
 * - a test the converter decided, such as a file that exists (`if true`) or a connection (`not true`), keeps only the
 *   branch that runs: in its place where it declares nothing, or else alone in its `if true`;
 * - the `default` of a switch over an `askChoice`, or over a variable just set to one, whose cases take every option's
 *   value; a loop over an empty list (`for file in []`, a folder the package does not hold);
 * - what follows, in its block, a statement after which nothing runs: an `exit`, `goto`, `return`, `break` or
 *   `continue`, an `if` or `switch` none of whose ways goes on, or a `while true` that nothing breaks. A function, a
 *   declaration, or a `return` with a value there stays: other code may use the first two, and the last gives its
 *   function's result type.
 * The legacy code could not reach any of these either.
 */
export function withoutDeadCode(statements: IrStatement[]): IrStatement[] {
  const block = (items: IrStatement[]): IrStatement[] => {
    const out: IrStatement[] = [];
    // The `askChoice` each variable was just set to in this block, while nothing since could change it.
    const choices = new Map<string, Choice>();
    for (const item of items) {
      let statement = mapOwnExpressions(withNestedBlocks(item, block), folded);
      if (statement.kind === "switch") {
        const tested = statement.value;
        const choice =
          tested.kind === "choice"
            ? tested
            : tested.kind === "variable"
              ? choices.get(tested.name)
              : undefined;
        if (choice !== undefined && takesEvery(statement, choice)) {
          statement = { ...statement, default: [] };
          covering.add(statement);
        }
      }
      track(statement, choices);
      out.push(...decided(statement));
    }
    return afterEnd(out);
  };
  return block(statements);
}

type Choice = IrExpression & { kind: "choice" };

/** Switches whose cases take every value of the `askChoice` they test. */
const covering = new WeakSet<IrStatement>();

/** Notes a variable set to an `askChoice`; forgets the ones a statement may change: by name, or through a call. */
function track(statement: IrStatement, choices: Map<string, Choice>): void {
  const text = JSON.stringify(statement);
  if (text.includes('"kind":"call"')) choices.clear();
  for (const name of [...choices.keys()])
    if (text.includes(`"name":${JSON.stringify(name)}`)) choices.delete(name);
  if (statement.kind === "let" && statement.value.kind === "choice")
    choices.set(statement.name, statement.value);
  if (
    statement.kind === "assign" &&
    statement.operator === "=" &&
    statement.target.kind === "variable" &&
    statement.value.kind === "choice"
  )
    choices.set(statement.target.name, statement.value);
}

/** A test whose value the converter wrote as a literal, folded: `not true`, `x and false`, `true or x`. */
function folded(value: IrExpression): IrExpression {
  const next = mapChildren(value, folded);
  if (next.kind === "unary" && next.operator === "not" && isBoolean(next.value))
    return literal(!next.value.value);
  if (next.kind !== "binary" || (next.operator !== "and" && next.operator !== "or")) return next;
  // `and` gives the other side where one is true, false where one is false; `or` the reverse. A side that is dropped
  // has to be one whose reading has no effect and cannot fail, as a division by zero would.
  const absorbing = next.operator === "or";
  for (const [side, other] of [
    [next.left, next.right],
    [next.right, next.left],
  ] as const) {
    if (!isBoolean(side)) continue;
    if (side.value !== absorbing) return other;
    if (cannotFail(other)) return literal(absorbing);
  }
  return next;
}

/** An `if` or `while` on a literal, as the branch that runs; a loop over an empty list, as nothing. */
function decided(statement: IrStatement): IrStatement[] {
  if (statement.kind === "while" && isBoolean(statement.condition) && !statement.condition.value)
    return [];
  if (
    statement.kind === "for" &&
    statement.collection.kind === "list" &&
    statement.collection.items.length === 0
  )
    return [];
  if (statement.kind !== "if" || !isBoolean(statement.condition)) return [statement];
  const runs = statement.condition.value ? statement.then : statement.else;
  if (runs.length === 0) return [];
  // A block that declares a name keeps its scope.
  if (runs.some((item) => item.kind === "let" || item.kind === "function"))
    return [{ ...statement, condition: literal(true), then: runs, else: [] }];
  return runs;
}

/** Whether a switch's cases take every option's value of an `askChoice`. */
function takesEvery(statement: IrStatement & { kind: "switch" }, choice: Choice): boolean {
  const taken = new Set(
    statement.cases.flatMap((item) =>
      item.matches.flatMap((match) => (match.kind === "literal" ? [match.value] : [])),
    ),
  );
  const values =
    choice.labels === undefined ? choice.options.map((_, index) => index) : choice.labels;
  return values.every((option) => taken.has(option));
}

/** The block without what follows a statement after which nothing runs, but for what stays (withoutDeadCode). */
function afterEnd(items: IrStatement[]): IrStatement[] {
  const end = items.findIndex(ends);
  if (end < 0) return items;
  const stays = (item: IrStatement): boolean =>
    item.kind === "function" ||
    item.kind === "let" ||
    (item.kind === "return" && item.value !== null);
  const kept = items.slice(end + 1).filter((item, index, rest) => {
    if (stays(item)) return true;
    // A comment or a blank line before what stays stays with it.
    if (item.kind !== "comment" && item.kind !== "blank") return false;
    const next = rest
      .slice(index + 1)
      .find((other) => other.kind !== "comment" && other.kind !== "blank");
    return next !== undefined && stays(next);
  });
  return [...items.slice(0, end + 1), ...kept];
}

/** Whether nothing after the statement in its block runs. */
export function ends(statement: IrStatement): boolean {
  switch (statement.kind) {
    case "exit":
    case "goto":
    case "return":
    case "break":
    case "continue":
      return true;
    case "if":
      return statement.else.length > 0 && statement.then.some(ends) && statement.else.some(ends);
    case "switch": {
      const exhaustive = statement.default.length > 0 || covering.has(statement);
      return (
        exhaustive &&
        statement.cases.every((item) => item.body.some(ends)) &&
        (statement.default.length === 0 || statement.default.some(ends))
      );
    }
    case "while":
      return isBoolean(statement.condition) && statement.condition.value && !breaks(statement.body);
    default:
      return false;
  }
}

/** Whether a loop body has a `break` of its own loop: not one in a nested loop, nor in a function. */
function breaks(items: readonly IrStatement[]): boolean {
  return items.some((item) => {
    if (item.kind === "break") return true;
    if (
      item.kind === "while" ||
      item.kind === "for" ||
      item.kind === "repeat" ||
      item.kind === "function"
    )
      return false;
    let found = false;
    withNestedBlocks(item, (body) => {
      found ||= breaks(body);
      return body;
    });
    return found;
  });
}

function isBoolean(
  value: IrExpression,
): value is IrExpression & { kind: "literal"; value: boolean } {
  return value.kind === "literal" && typeof value.value === "boolean";
}

function literal(value: boolean): IrExpression {
  return { kind: "literal", value };
}

/** A value whose reading has no effect and cannot fail: a literal, a variable, a load, and equality tests of them. */
function cannotFail(value: IrExpression): boolean {
  switch (value.kind) {
    case "literal":
    case "variable":
      return true;
    case "load":
      return (
        cannotFail(value.key) &&
        (value.defaultValue === undefined || cannotFail(value.defaultValue))
      );
    case "binary":
      return (
        (value.operator === "==" || value.operator === "!=") &&
        cannotFail(value.left) &&
        cannotFail(value.right)
      );
    default:
      return false;
  }
}

/** A value that reading again gives again, with no effect: literals, variables, members, loads and tests of them. */
export function isPure(value: IrExpression): boolean {
  switch (value.kind) {
    case "literal":
    case "variable":
      return true;
    case "property":
      return value.name !== "random" && isPure(value.target);
    case "load":
      return isPure(value.key) && (value.defaultValue === undefined || isPure(value.defaultValue));
    case "unary":
      return isPure(value.value);
    case "binary":
      return isPure(value.left) && isPure(value.right);
    default:
      return false;
  }
}
