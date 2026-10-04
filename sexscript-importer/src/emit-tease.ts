import { rootDiagnostics } from "./diagnostics.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";

export function emitTease(program: MigrationProgram): string {
  const lines: string[] = [];
  const errors = rootDiagnostics(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
  ).length;
  lines.push(...metadataComment(program));
  if (errors > 0) {
    lines.push(`// MIGRATION INCOMPLETE: ${errors} error diagnostic${errors === 1 ? "" : "s"}.`);
    lines.push("// Review diagnostics before treating this file as behaviorally equivalent.");
    lines.push("");
  }
  emitStatements(program.statements, lines, 0);
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Legacy setInfos() metadata has no accepted TeaseScript manifest yet, so it is kept as a readable header. */
function metadataComment(program: MigrationProgram): string[] {
  const metadata = program.metadata;
  if (metadata === null) return [];
  const fields: Array<[string, string | null]> = [
    ["Title", metadata.title],
    ["Author", metadata.author],
    ["Summary", metadata.summary],
    ["Language", metadata.language],
    [
      "Tags",
      metadata.tags === null || metadata.tags.length === 0 ? null : metadata.tags.join(", "),
    ],
  ];
  const lines = fields
    .filter((field): field is [string, string] => field[1] !== null && field[1] !== "")
    .map(([name, value]) => `// ${name}: ${value.replace(/[\r\n\u2028\u2029]+/gu, " ")}`);
  return lines.length === 0 ? [] : ["// Legacy SexScript metadata", ...lines, ""];
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
      const handle = statement.handle === undefined ? "" : `let ${statement.handle} = `;
      if (statement.repeatCount === null) {
        lines.push(`${pad}${handle}playAudio${statement.async ? " async" : ""} ${file}`);
      } else {
        lines.push(
          `${pad}${handle}playAudio(file: ${file}, async: ${statement.async}, repeat: ${emitExpression(statement.repeatCount)} times)`,
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
      lines.push(`${pad}return${statement.value === null ? "" : ` ${emitValue(statement.value)}`}`);
      return;
    case "let": {
      const type = statement.type === undefined ? "" : `: ${statement.type}`;
      lines.push(`${pad}let ${statement.name}${type} = ${emitValue(statement.value)}`);
      return;
    }
    case "assign":
      lines.push(
        `${pad}${emitExpression(statement.target)} ${statement.operator} ${emitValue(statement.value)}`,
      );
      return;
    case "expression":
      lines.push(`${pad}${emitValue(statement.expression)}`);
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
    case "repeat":
      lines.push(`${pad}repeat ${emitExpression(statement.count)} {`);
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
      return expression.properties.length === 0
        ? "{}"
        : `{ ${expression.properties
            .map(
              (property) =>
                `${property.key === undefined ? property.name : `[${emitExpression(property.key)}]`}: ${emitExpression(property.value)}`,
            )
            .join(", ")} }`;
    case "index":
      return `${operand(expression.target, POSTFIX)}[${emitExpression(expression.index)}]`;
    case "property":
      return `${operand(expression.target, POSTFIX)}.${expression.name}`;
    case "methodCall":
      return `${operand(expression.target, POSTFIX)}.${expression.name}(${expression.arguments.map(emitExpression).join(", ")})`;
    case "load":
      return expression.defaultValue === undefined
        ? `load ${operand(expression.key, POSTFIX)}`
        : `load ${operand(expression.key, POSTFIX)} default ${operand(expression.defaultValue, POSTFIX)}`;
    case "input":
      return expression.defaultValue === undefined
        ? expression.input
        : `${expression.input} default ${operand(expression.defaultValue, POSTFIX)}`;
    case "choice":
    case "listChoice":
      // `choose a: x, b: y` extends over following commas, so it is parenthesized unless it is a whole
      // statement value (see emitValue).
      return `(${emitChoice(expression)})`;
    case "range": {
      const operator = expression.inclusive ? "..=" : "..";
      return `${operand(expression.from, RANGE + 1)}${operator}${operand(expression.to, RANGE + 1)}`;
    }
    case "unary":
      return expression.operator === "not"
        ? `not ${operand(expression.value, NOT)}`
        : `${expression.operator}${operand(expression.value, UNARY)}`;
    case "binary": {
      const level = precedence(expression);
      // Left-associative operators need parentheses for an equal-precedence right operand, and comparisons
      // may not be chained at all (V30 section 5).
      const rightLevel =
        expression.operator === "and" || expression.operator === "or" ? level : level + 1;
      const leftLevel = level === COMPARISON ? level + 1 : level;
      // `and` binds more tightly than `or`; parentheses keep mixed conditions readable.
      const side = (value: IrExpression, minimum: number): string =>
        expression.operator === "or" && value.kind === "binary" && value.operator === "and"
          ? `(${emitExpression(value)})`
          : operand(value, minimum);
      return `${side(expression.left, leftLevel)} ${expression.operator} ${side(expression.right, rightLevel)}`;
    }
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

// TeaseScript precedence from V30 "Expression precedence and associativity", weakest first.
const OR = 1;
const AND = 2;
const NOT = 3;
const COMPARISON = 4;
const RANGE = 5;
const ADDITIVE = 6;
const MULTIPLICATIVE = 7;
const UNARY = 8;
const POSTFIX = 9;
const PRIMARY = 10;

function precedence(expression: IrExpression): number {
  switch (expression.kind) {
    case "binary":
      switch (expression.operator) {
        case "or":
          return OR;
        case "and":
          return AND;
        case "+":
        case "-":
          return ADDITIVE;
        case "*":
        case "/":
        case "%":
          return MULTIPLICATIVE;
        default:
          return COMPARISON;
      }
    case "unary":
      return expression.operator === "not" ? NOT : UNARY;
    case "range":
      return RANGE;
    case "index":
    case "property":
    case "methodCall":
      return POSTFIX;
    // `load` and a prefilled input extend to the end of their operands, so they are parenthesized as operands.
    case "load":
      return 0;
    case "input":
      return expression.defaultValue === undefined ? PRIMARY : 0;
    default:
      return PRIMARY;
  }
}

function emitChoice(expression: Extract<IrExpression, { kind: "choice" | "listChoice" }>): string {
  if (expression.kind === "listChoice") {
    const options = expression.options.map((option) => {
      if (option.kind === "list") return emitExpression(option.list);
      const text = emitExpression(option.text);
      return option.label === null ? text : `${option.label}: ${text}`;
    });
    return `choose ${options.join(", ")}`;
  }
  const options = expression.options.map(
    (option, index) => `${expression.labels?.[index] ?? index}: ${emitExpression(option)}`,
  );
  return `choose ${options.join(", ")}`;
}

/** A complete statement value, where a compact choice needs no parentheses. */
function emitValue(expression: IrExpression): string {
  return expression.kind === "choice" || expression.kind === "listChoice"
    ? emitChoice(expression)
    : emitExpression(expression);
}

function operand(expression: IrExpression, minimum: number): string {
  const text = emitExpression(expression);
  return precedence(expression) < minimum ? `(${text})` : text;
}
