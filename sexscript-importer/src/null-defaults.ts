import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren } from "./variable-types.ts";

/**
 * A null test that only gives a variable or a property a default, `if x == null { x = d }`, becomes `otherwise` (#850),
 * which evaluates `d` only where `x` is null, as the test did. Right after an assignment of `x`, the default joins it,
 * `x = e otherwise d`, where `d` neither reads `x` nor runs code that could (a call, or an ask, during which a button's
 * block may run): the test read the null that `e` gave, where `d` now runs before `x` changes; a storage read keeps
 * its own assignment, which gives it the variable's declared type (V30 §25). A test whose default reads storage stays as
 * it is (hasLoad). Elsewhere the test becomes `x = x otherwise d`, also after a `let`, whose variable's type comes from
 * its first value, which `otherwise` would make one without null. A test that returns the default where `x` is null and
 * `x` itself otherwise, `if x == null { return d } return x`, also with `else`, returns `x otherwise d`.
 */
export function withNullDefaults(
  statements: IrStatement[],
  /** Statements of the file to leave as they are, such as generated helpers. */
  keep: (statement: IrStatement) => boolean = () => false,
): IrStatement[] {
  const block = (items: IrStatement[]): IrStatement[] => {
    const result: IrStatement[] = [];
    for (const original of items) {
      if (items === statements && keep(original)) {
        result.push(original);
        continue;
      }
      const item = withNestedBlocks(original, block);
      const returned = nullReturn(item, result.at(-1));
      if (returned !== null) {
        if (item.kind === "return") result.pop();
        result.push(returned);
        continue;
      }
      const found = nullDefault(item);
      if (found === null) {
        result.push(item);
        continue;
      }
      // The assignment before, past any comments.
      let before = result.length - 1;
      while (before >= 0 && result[before]!.kind === "comment") before -= 1;
      const assigned = result[before];
      const after =
        (assigned?.kind === "assign" &&
          assigned.operator === "=" &&
          samePath(assigned.target, found.path)) ||
        (assigned?.kind === "let" &&
          found.path.kind === "variable" &&
          assigned.name === found.path.name);
      // A default that reads storage keeps its test (hasLoad).
      if (hasLoad(found.value)) {
        result.push(item);
        continue;
      }
      // A storage read keeps its own assignment, and its default follows it (hasLoad).
      const stored =
        after && (assigned.kind === "assign" || assigned.kind === "let") && hasLoad(assigned.value);
      if (assigned?.kind === "assign" && after && !stored && !readsPath(found.value, found.path)) {
        result[before] = { ...assigned, value: otherwise(assigned.value, found.value) };
        continue;
      }
      result.push({
        kind: "assign",
        target: found.path,
        operator: "=",
        value: otherwise(found.path, found.value),
        span: item.span,
      });
    }
    return result;
  };
  return block(statements);
}

function otherwise(left: IrExpression, right: IrExpression): IrExpression {
  return { kind: "binary", operator: "otherwise", left, right };
}

/** The path and the default of `if path == null { path = value }`, with nothing else in it; null for another. */
function nullDefault(statement: IrStatement): { path: IrExpression; value: IrExpression } | null {
  if (statement.kind !== "if" || statement.else.length > 0 || statement.then.length !== 1)
    return null;
  const [set] = statement.then;
  const condition = statement.condition;
  if (set?.kind !== "assign" || set.operator !== "=" || condition.kind !== "binary") return null;
  if (condition.operator !== "==") return null;
  const tested = isNull(condition.right)
    ? condition.left
    : isNull(condition.left)
      ? condition.right
      : null;
  return tested !== null && isPath(tested) && samePath(tested, set.target)
    ? { path: set.target, value: set.value }
    : null;
}

/**
 * `return path otherwise value` for `if path == null { return value } else { return path }`, or for `return path` after
 * `if path == null { return value }`, the statement before it; null for another statement.
 */
function nullReturn(statement: IrStatement, before: IrStatement | undefined): IrStatement | null {
  const test = statement.kind === "return" ? before : statement;
  if (test?.kind !== "if" || test.then.length !== 1 || test.condition.kind !== "binary")
    return null;
  const [fallback] = test.then;
  const otherReturn =
    statement.kind === "return" ? (test.else.length === 0 ? statement : undefined) : test.else[0];
  if (
    fallback?.kind !== "return" ||
    fallback.value === null ||
    otherReturn?.kind !== "return" ||
    otherReturn.value === null ||
    (statement.kind !== "return" && test.else.length !== 1) ||
    test.condition.operator !== "=="
  )
    return null;
  const { left, right } = test.condition;
  const tested = isNull(right) ? left : isNull(left) ? right : null;
  if (tested === null || !isPath(tested) || !samePath(tested, otherReturn.value)) return null;
  // A null default leaves the value as it is.
  const value = isNull(fallback.value)
    ? otherReturn.value
    : otherwise(otherReturn.value, fallback.value);
  return { kind: "return", value, span: test.span };
}

function isNull(value: IrExpression): boolean {
  return value.kind === "literal" && value.value === null;
}

/** A variable, or a property of one, `profile.name`. */
function isPath(value: IrExpression): boolean {
  return value.kind === "variable" || (value.kind === "property" && isPath(value.target));
}

function samePath(left: IrExpression, right: IrExpression): boolean {
  if (left.kind === "variable" && right.kind === "variable") return left.name === right.name;
  return (
    left.kind === "property" &&
    right.kind === "property" &&
    left.name === right.name &&
    left.dict === right.dict &&
    samePath(left.target, right.target)
  );
}

/**
 * Whether a value reads storage: a `load` reads its key as the declared type of the variable it is assigned to (V30 §25),
 * which it would no longer be as an operand of `otherwise`.
 */
function hasLoad(value: IrExpression): boolean {
  let found = false;
  const visit = (node: IrExpression): IrExpression => {
    if (node.kind === "load") found = true;
    return mapChildren(node, visit);
  };
  visit(value);
  return found;
}

/**
 * Whether a value reads the variable a path starts at, or may run code that could read it: a call (of the script's
 * functions, also through a helper that dispatches them, or of a helper), or an ask, a choice, a button, or a message,
 * during which a permanent button's block may run.
 */
function readsPath(value: IrExpression, path: IrExpression): boolean {
  let root = path;
  while (root.kind === "property") root = root.target;
  const name = root.kind === "variable" ? root.name : null;
  let found = false;
  const visit = (node: IrExpression): IrExpression => {
    if (
      (node.kind === "variable" && node.name === name) ||
      ["call", "input", "choice", "listChoice", "button", "message"].includes(node.kind)
    )
      found = true;
    return mapChildren(node, visit);
  };
  visit(value);
  return found;
}
