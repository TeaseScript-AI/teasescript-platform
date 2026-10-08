import type { IrExpression, IrStatement, IrSwitchCase } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";

/**
 * Idiomatic output (owner direction 2026-10-08): an `if`/`else if` ladder of at least three tests that each compare the
 * same value with literals, `if mood == "angry" { } else if mood == "calm" { } ...`, is a `switch` on that value with a
 * case for each test, `case "angry" { }`, and its last `else` as `default`. A case matches where the value `==` its
 * literal, as the tests did; the switch reads the value once where the ladder read it for each test, which is the same
 * where reading it has no effect and nothing between the tests changes it: a variable, or a member or an item of one
 * read by a variable or a literal. The literals are all numbers or all texts, and none repeats, which a switch
 * rejects.
 */
export function withSwitchLadders(statements: IrStatement[]): IrStatement[] {
  return statements.map((statement): IrStatement => {
    const nested = withNestedBlocks(statement, withSwitchLadders);
    const ladder = nested.kind === "if" ? switchLadder(nested) : null;
    return ladder ?? nested;
  });
}

/** The switch an `if` ladder is, or null. */
function switchLadder(statement: Extract<IrStatement, { kind: "if" }>): IrStatement | null {
  const cases: IrSwitchCase[] = [];
  let subject: IrExpression | null = null;
  let node: IrStatement = statement;
  let otherwise: IrStatement[];
  for (;;) {
    const tested = node.kind === "if" ? testedLiterals(node.condition) : null;
    // The ladder ends at a test of something else, which the default keeps.
    if (
      node.kind !== "if" ||
      tested === null ||
      (subject !== null && !sameValue(subject, tested.subject))
    ) {
      otherwise = [node];
      break;
    }
    subject ??= tested.subject;
    cases.push({ span: node.span, matches: tested.literals, body: node.then });
    const [only, ...rest]: IrStatement[] = node.else;
    if (only?.kind === "if" && rest.length === 0) {
      node = only;
      continue;
    }
    otherwise = node.else;
    break;
  }
  if (subject === null || cases.length < 3 || !isSteadyValue(subject)) return null;
  const literals = cases.flatMap((item) => item.matches);
  const kinds = new Set(
    literals.map((literal) => (literal.kind === "literal" ? typeof literal.value : "other")),
  );
  if (kinds.size !== 1 || (!kinds.has("number") && !kinds.has("string"))) return null;
  const seen = new Set<string>();
  for (const literal of literals) {
    const key = literal.kind === "literal" ? String(literal.value) : "";
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return { kind: "switch", value: subject, cases, default: otherwise, span: statement.span };
}

/** `x == literal`, `literal == x`, or an `or` of such tests of the same `x`, as the value and its literals. */
function testedLiterals(
  condition: IrExpression,
): { subject: IrExpression; literals: IrExpression[] } | null {
  if (condition.kind !== "binary") return null;
  if (condition.operator === "or") {
    const left = testedLiterals(condition.left);
    const right = testedLiterals(condition.right);
    if (left === null || right === null || !sameValue(left.subject, right.subject)) return null;
    return { subject: left.subject, literals: [...left.literals, ...right.literals] };
  }
  if (condition.operator !== "==") return null;
  if (isCaseLiteral(condition.right) && !isCaseLiteral(condition.left))
    return { subject: condition.left, literals: [condition.right] };
  if (isCaseLiteral(condition.left) && !isCaseLiteral(condition.right))
    return { subject: condition.right, literals: [condition.left] };
  return null;
}

/** A literal a case may list: a number or a text. */
function isCaseLiteral(value: IrExpression): boolean {
  return (
    value.kind === "literal" &&
    value.action !== true &&
    (typeof value.value === "number" || typeof value.value === "string")
  );
}

/** A value whose reading has no effect: a variable, or a member or item of one, read by a variable or a literal. */
function isSteadyValue(value: IrExpression): boolean {
  switch (value.kind) {
    case "variable":
      return true;
    case "property":
      return isSteadyValue(value.target);
    case "index":
      return (
        isSteadyValue(value.target) &&
        (value.index.kind === "literal" || value.index.kind === "variable")
      );
    default:
      return false;
  }
}

function sameValue(left: IrExpression, right: IrExpression): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
