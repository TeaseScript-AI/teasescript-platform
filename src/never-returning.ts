import type { Expression, FunctionDeclaration, Statement } from "./ast.js";

/**
 * The functions of a program whose every way through ends in `exit`, `end`, or `goto`, so that a statement calling
 * one never continues. Loops, `switch`, and anything unknown count as continuing; a `return` anywhere counts as
 * returning.
 */
export function neverReturningFunctions(statements: readonly Statement[]): ReadonlySet<string> {
  const declarations = statements.filter(
    (statement): statement is FunctionDeclaration => statement.kind === "functionDeclaration",
  );
  const never = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const declaration of declarations) {
      if (never.has(declaration.name.name)) continue;
      const flow = blockFlow(declaration.body.statements, never);
      if (!flow.continues && !flow.returns) {
        never.add(declaration.name.name);
        changed = true;
      }
    }
  }
  return never;
}

/** Whether a statement calls a function that never returns, as its whole expression. */
export function callsNeverReturning(statement: Statement, never: ReadonlySet<string>): boolean {
  if (statement.kind !== "expressionStatement") return false;
  const expression = unwrapParentheses(statement.expression);
  return (
    expression.kind === "callExpression" &&
    expression.callee.kind === "identifier" &&
    never.has(expression.callee.name)
  );
}

interface Flow {
  readonly continues: boolean;
  readonly returns: boolean;
}

function blockFlow(statements: readonly Statement[], never: ReadonlySet<string>): Flow {
  let returns = false;
  for (const statement of statements) {
    const flow = statementFlow(statement, never);
    returns ||= flow.returns;
    if (!flow.continues) return { continues: false, returns };
  }
  return { continues: true, returns };
}

function statementFlow(statement: Statement, never: ReadonlySet<string>): Flow {
  switch (statement.kind) {
    case "returnStatement":
      return { continues: false, returns: true };
    case "exitStatement":
    case "endStatement":
    case "gotoStatement":
      return { continues: false, returns: false };
    case "expressionStatement":
      return { continues: !callsNeverReturning(statement, never), returns: false };
    case "ifStatement": {
      const then = blockFlow(statement.thenBlock.statements, never);
      if (statement.elseBlock === null) return { continues: true, returns: then.returns };
      const otherwise =
        statement.elseBlock.kind === "block"
          ? blockFlow(statement.elseBlock.statements, never)
          : statementFlow(statement.elseBlock, never);
      return {
        continues: then.continues || otherwise.continues,
        returns: then.returns || otherwise.returns,
      };
    }
    case "repeatStatement":
    case "forStatement":
    case "whileStatement":
      return { continues: true, returns: blockFlow(statement.body.statements, never).returns };
    case "switchStatement":
      return {
        continues: true,
        returns:
          statement.cases.some((item) => blockFlow(item.body.statements, never).returns) ||
          (statement.defaultBlock !== null &&
            blockFlow(statement.defaultBlock.statements, never).returns),
      };
    default:
      return { continues: true, returns: false };
  }
}

function unwrapParentheses(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}
