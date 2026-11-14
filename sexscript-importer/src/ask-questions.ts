import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";

type Input = Extract<IrExpression, { kind: "input" }>;

/**
 * The asks the converter writes that take a question (V30 §20) and say it as a `say` does; `askImage` also shows its
 * question with the picture's input, so a question said before it stays a `say`.
 */
const QUESTION_ASKS = new Set(["askText", "askNumber", "askInteger", "askBoolean"]);

/**
 * A legacy input's text, said at once as prose right before its ask (pushPrompt), becomes the ask's question in prose:
 * `say prose "Name?", instant` and then `let name = askText` read `let name = askText prose "Name?"` (#852). An ask's
 * question is said as `say` says it, by the asking speaker and with no reading time of its own (V30 §20), so the two
 * are the same where nothing comes between them: the ask is the first value its statement evaluates, and its other
 * arguments, which it evaluates before saying the question, only read constants and variables.
 */
export function withAskQuestions(statements: IrStatement[]): IrStatement[] {
  const block = (items: IrStatement[]): IrStatement[] => {
    const result: IrStatement[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = withNestedBlocks(items[index]!, block);
      const next = items[index + 1];
      if (
        item.kind === "say" &&
        item.prompt === true &&
        item.speaker === undefined &&
        next !== undefined
      ) {
        const folded = withQuestion(withNestedBlocks(next, block), item.value);
        if (folded !== null) {
          result.push(folded);
          index += 1;
          continue;
        }
      }
      result.push(item);
    }
    return result;
  };
  return block(statements);
}

/** A statement whose first evaluated value is an ask without a question, with the question given; null otherwise. */
function withQuestion(statement: IrStatement, question: IrExpression): IrStatement | null {
  const ask = (value: IrExpression): IrExpression | null => {
    if (value.kind === "input") {
      if (
        !QUESTION_ASKS.has(value.input) ||
        value.question !== undefined ||
        value.speaker !== undefined
      )
        return null;
      if (![value.defaultValue, value.yesText, value.noText].every(constant)) return null;
      const asked: Input = { ...value, question, prose: true };
      return asked;
    }
    if (
      value.kind === "call" &&
      value.name === "askBooleans" &&
      value.local !== true &&
      value.positional.length === 0 &&
      value.named.message === undefined &&
      Object.values(value.named).every(constant)
    )
      return { ...value, named: { message: question, ...value.named }, prose: true };
    // A receiver, a left operand, and an operand are evaluated first.
    if (value.kind === "methodCall" || value.kind === "property" || value.kind === "index") {
      const target = ask(value.target);
      return target === null ? null : { ...value, target };
    }
    if (value.kind === "binary") {
      const left = ask(value.left);
      return left === null ? null : { ...value, left };
    }
    if (value.kind === "unary") {
      const operand = ask(value.value);
      return operand === null ? null : { ...value, value: operand };
    }
    return null;
  };
  switch (statement.kind) {
    case "let": {
      const value = ask(statement.value);
      return value === null ? null : { ...statement, value };
    }
    case "assign": {
      // A target that only names a variable, or a constant or variable position of one, evaluates nothing before.
      const target = statement.target;
      const plain =
        target.kind === "variable" ||
        ((target.kind === "index" || target.kind === "property") &&
          target.target.kind === "variable" &&
          (target.kind === "property" || constant(target.index)));
      const value = plain ? ask(statement.value) : null;
      return value === null ? null : { ...statement, value };
    }
    case "expression": {
      const expression = ask(statement.expression);
      return expression === null ? null : { ...statement, expression };
    }
    case "if": {
      const condition = ask(statement.condition);
      return condition === null ? null : { ...statement, condition };
    }
    default:
      return null;
  }
}

/** Whether a value only reads constants and variables, or is absent: evaluating it has no effect. */
function constant(value: IrExpression | undefined): boolean {
  if (value === undefined) return true;
  switch (value.kind) {
    case "literal":
    case "variable":
      return true;
    case "template":
      return value.parts.every((part) => "text" in part || constant(part.value));
    case "list":
      return value.items.every(constant);
    case "unary":
      return value.operator === "-" && value.value.kind === "literal";
    default:
      return false;
  }
}
