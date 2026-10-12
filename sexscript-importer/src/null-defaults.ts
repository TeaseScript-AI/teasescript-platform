import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren } from "./variable-types.ts";

/**
 * A null test that only gives a variable or a property a default, `if x == null { x = d }`, becomes `otherwise` (#850),
 * which evaluates `d` only where `x` is null, as the test did. Right after an assignment of `x`, the default joins it,
 * `x = e otherwise d`, where `d` reads neither `x` nor a function of the script, which could read it: the test read the
 * null that `e` gave, where `d` now runs before `x` changes. Elsewhere the test becomes `x = x otherwise d`, also after
 * a `let`, whose variable's type comes from its first value, which `otherwise` would make one without null.
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
      const found = nullDefault(item);
      if (found === null) {
        result.push(item);
        continue;
      }
      // The assignment before, past any comments.
      let before = result.length - 1;
      while (before >= 0 && result[before]!.kind === "comment") before -= 1;
      const assigned = result[before];
      if (
        assigned?.kind === "assign" &&
        assigned.operator === "=" &&
        samePath(assigned.target, found.path) &&
        !readsPath(found.value, found.path)
      ) {
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

/** Whether a value reads the variable a path starts at, or calls a function of the script, which may read it. */
function readsPath(value: IrExpression, path: IrExpression): boolean {
  let root = path;
  while (root.kind === "property") root = root.target;
  const name = root.kind === "variable" ? root.name : null;
  let found = false;
  const visit = (node: IrExpression): IrExpression => {
    if (
      (node.kind === "variable" && node.name === name) ||
      (node.kind === "call" && node.local === true)
    )
      found = true;
    return mapChildren(node, visit);
  };
  visit(value);
  return found;
}
