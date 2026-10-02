import { rootDiagnostics } from "./diagnostics.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";

export function emitTease(program: MigrationProgram): string {
  const lines: string[] = [];
  const errors = rootDiagnostics(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
  ).length;
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
    case "wait": {
      const unit = statement.unit === "ms" ? " ms" : "";
      lines.push(
        `${pad}${statement.visible ? "timer" : "wait"} ${emitExpression(statement.duration)}${unit}`,
      );
      return;
    }
    case "showButton":
      if (statement.timeout === null)
        lines.push(`${pad}showButton ${emitExpression(statement.label)}`);
      else
        lines.push(
          `${pad}showButton(${emitExpression(statement.label)}, ${emitExpression(statement.timeout)})`,
        );
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
        lines.push(
          `${pad}playAudio(file: ${file}, async: ${statement.async}, repeat: ${emitExpression(statement.repeatCount)} times)`,
        );
      }
      return;
    }
    case "save":
      lines.push(
        `${pad}save ${emitExpression(statement.value)} as ${emitExpression(statement.key)}`,
      );
      return;
    case "delete":
      lines.push(`${pad}delete ${emitExpression(statement.key)}`);
      return;
    case "blank":
      if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
      return;
    case "comment": {
      const [first = "", ...rest] = statement.text.split("\n");
      const previous = lines.length - 1;
      if (statement.trailing && previous >= 0 && lines[previous]!.trim() !== "") {
        lines[previous] = `${lines[previous]} ${first}`;
      } else {
        lines.push(`${pad}${first}`);
      }
      for (const line of rest) lines.push(line.trimEnd());
      return;
    }
    case "function": {
      for (const comment of statement.leadingComments ?? []) {
        lines.push(
          ...comment.split("\n").map((line, index) => (index === 0 ? `${pad}${line}` : line)),
        );
      }
      const parameters = statement.parameters.map((parameter) =>
        parameter.defaultValue === null
          ? parameter.name
          : `${parameter.name} = ${emitExpression(parameter.defaultValue)}`,
      );
      lines.push(
        `${pad}function ${statement.name}${parameters.length === 0 ? "" : `(${parameters.join(", ")})`} {`,
      );
      emitStatements(statement.body, lines, depth + 1);
      lines.push(`${pad}}`);
      return;
    }
    case "return":
      lines.push(
        `${pad}return${statement.value === null ? "" : ` ${emitExpression(statement.value)}`}`,
      );
      return;
    case "let":
      lines.push(`${pad}let ${statement.name} = ${emitExpression(statement.value)}`);
      return;
    case "assign":
      lines.push(
        `${pad}${emitExpression(statement.target)} ${statement.operator} ${emitExpression(statement.value)}`,
      );
      return;
    case "expression":
      lines.push(`${pad}${emitExpression(statement.expression)}`);
      return;
    case "if": {
      lines.push(`${pad}if ${emitExpression(statement.condition)} {`);
      emitStatements(statement.then, lines, depth + 1);
      let alternative = statement.else;
      // Flatten Groovy `else if` chains, which the AST represents as nested if statements.
      for (
        let nested = alternative[0];
        alternative.length === 1 && nested?.kind === "if";
        nested = alternative[0]
      ) {
        lines.push(`${pad}} else if ${emitExpression(nested.condition)} {`);
        emitStatements(nested.then, lines, depth + 1);
        alternative = nested.else;
      }
      if (alternative.length > 0) {
        lines.push(`${pad}} else {`);
        emitStatements(alternative, lines, depth + 1);
      }
      lines.push(`${pad}}`);
      return;
    }
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
    case "unsupported":
      for (const line of statement.legacySource) lines.push(`${pad}// | ${line}`.trimEnd());
      return;
  }
}

export function emitExpression(expression: IrExpression): string {
  switch (expression.kind) {
    case "literal":
      return typeof expression.value === "string"
        ? `"${escapeStringText(expression.value)}"`
        : String(expression.value);
    case "template": {
      const parts = expression.parts.map((part) =>
        "text" in part ? escapeStringText(part.text) : `\${${emitExpression(part.value)}}`,
      );
      return `"${parts.join("")}"`;
    }
    case "variable":
      return expression.name;
    case "list":
      return `[${expression.items.map(emitExpression).join(", ")}]`;
    case "object":
      return `{ ${expression.properties.map((property) => `${property.name}: ${emitExpression(property.value)}`).join(", ")} }`;
    case "index":
      return `${parenthesize(expression.target)}[${emitExpression(expression.index)}]`;
    case "property":
      return `${parenthesize(expression.target)}.${expression.name}`;
    case "methodCall":
      return `${parenthesize(expression.target)}.${expression.name}(${expression.arguments.map(emitExpression).join(", ")})`;
    case "load":
      return `load ${parenthesize(expression.key)}`;
    case "choice": {
      const options = expression.options
        .map((option, index) => `  ${index}: ${emitExpression(option)}`)
        .join("\n");
      return `choose ${emitExpression(expression.message)} {\n${options}\n}`;
    }
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
      const named = Object.entries(expression.named).map(
        ([name, value]) => `${name}: ${emitExpression(value)}`,
      );
      return `${expression.name}(${[...positional, ...named].join(", ")})`;
    }
  }
}

/**
 * Encodes literal text for a TeaseScript string. TeaseScript knows only the escapes below, and an
 * unescaped `${` would start interpolation, so legacy literal text must escape it.
 */
function escapeStringText(text: string): string {
  return text
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")
    .replace(/\$\{/gu, "\\${");
}

function parenthesize(expression: IrExpression): string {
  return expression.kind === "binary"
    ? `(${emitExpression(expression)})`
    : emitExpression(expression);
}
