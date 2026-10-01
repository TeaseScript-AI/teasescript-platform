import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";

export function emitTease(program: MigrationProgram): string {
  const lines: string[] = [];
  const errors = program.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  if (errors > 0) {
    lines.push(`// MIGRATION INCOMPLETE: ${errors} error diagnostic${errors === 1 ? "" : "s"}.`);
    lines.push("// Review diagnostics before treating this file as behaviorally equivalent.");
    lines.push("");
  }
  emitStatements(program.statements, lines, 0);
  return `${lines.join("\n").trimEnd()}\n`;
}

function emitStatements(statements: IrStatement[], lines: string[], depth: number): void {
  for (const statement of statements) emitStatement(statement, lines, depth);
}

function emitStatement(statement: IrStatement, lines: string[], depth: number): void {
  const pad = "  ".repeat(depth);
  switch (statement.kind) {
    case "say":
      lines.push(`${pad}say ${emitExpression(statement.value)}`);
      return;
    case "wait":
      lines.push(`${pad}${statement.visible ? "timer" : "wait"} ${emitExpression(statement.duration)}`);
      return;
    case "showPopup":
      lines.push(`${pad}showPopup ${emitExpression(statement.message)}`);
      return;
    case "showImage":
      lines.push(`${pad}showImage ${emitExpression(statement.file)}`);
      return;
    case "hideImage":
      lines.push(`${pad}hideImage`);
      return;
    case "playAudio": {
      const file = emitExpression(statement.file);
      if (statement.repeatCount === null) {
        lines.push(`${pad}playAudio${statement.async ? " async" : ""} ${file}`);
      } else {
        lines.push(`${pad}playAudio(file: ${file}, async: ${statement.async}, repeat: ${emitExpression(statement.repeatCount)} times)`);
      }
      return;
    }
    case "save":
      lines.push(`${pad}save ${emitExpression(statement.value)} as ${emitExpression(statement.key)}`);
      return;
    case "let":
      lines.push(`${pad}let ${statement.name} = ${emitExpression(statement.value)}`);
      return;
    case "assign":
      lines.push(`${pad}${statement.target} ${statement.operator} ${emitExpression(statement.value)}`);
      return;
    case "expression":
      lines.push(`${pad}${emitExpression(statement.expression)}`);
      return;
    case "if":
      lines.push(`${pad}if ${emitExpression(statement.condition)} {`);
      emitStatements(statement.then, lines, depth + 1);
      if (statement.else.length > 0) {
        lines.push(`${pad}} else {`);
        emitStatements(statement.else, lines, depth + 1);
      }
      lines.push(`${pad}}`);
      return;
    case "while":
      lines.push(`${pad}while ${emitExpression(statement.condition)} {`);
      emitStatements(statement.body, lines, depth + 1);
      lines.push(`${pad}}`);
      return;
    case "for":
      lines.push(`${pad}for ${statement.variable} in ${emitExpression(statement.collection)} {`);
      emitStatements(statement.body, lines, depth + 1);
      lines.push(`${pad}}`);
      return;
    case "switch":
      lines.push(`${pad}switch ${emitExpression(statement.value)} {`);
      for (const item of statement.cases) {
        lines.push(`${pad}  case ${emitExpression(item.match)} {`);
        emitStatements(item.body, lines, depth + 2);
        lines.push(`${pad}  }`);
      }
      if (statement.default.length > 0) {
        lines.push(`${pad}  default {`);
        emitStatements(statement.default, lines, depth + 2);
        lines.push(`${pad}  }`);
      }
      lines.push(`${pad}}`);
      return;
    case "break":
      lines.push(`${pad}break`);
      return;
    case "continue":
      lines.push(`${pad}continue`);
      return;
    case "run":
      lines.push(`${pad}run ${emitExpression(statement.script)}`);
      return;
    case "end":
      lines.push(`${pad}end`);
      return;
    case "exit":
      lines.push(`${pad}exit`);
      return;
    case "unsupported": {
      const line = statement.span?.line;
      const location = line === undefined ? "" : ` line ${line}`;
      lines.push(`${pad}// TODO ${statement.diagnosticCode}${location}: ${statement.summary}`);
      return;
    }
  }
}

export function emitExpression(expression: IrExpression): string {
  switch (expression.kind) {
    case "literal":
      return typeof expression.value === "string" ? JSON.stringify(expression.value) : String(expression.value);
    case "variable":
      return expression.name;
    case "list":
      return `[${expression.items.map(emitExpression).join(", ")}]`;
    case "range":
      return `${parenthesize(expression.from)}${expression.inclusive ? "..=" : ".."}${parenthesize(expression.to)}`;
    case "unary":
      return expression.operator === "not"
        ? `not ${parenthesize(expression.value)}`
        : `${expression.operator}${parenthesize(expression.value)}`;
    case "binary":
      return `${parenthesize(expression.left)} ${expression.operator} ${parenthesize(expression.right)}`;
    case "call": {
      const positional = expression.positional.map(emitExpression);
      const named = Object.entries(expression.named).map(([name, value]) => `${name}: ${emitExpression(value)}`);
      return `${expression.name}(${[...positional, ...named].join(", ")})`;
    }
  }
}

function parenthesize(expression: IrExpression): string {
  return expression.kind === "binary" ? `(${emitExpression(expression)})` : emitExpression(expression);
}
