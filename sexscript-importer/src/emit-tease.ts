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

/**
 * Legacy setInfos() metadata as the file header (V30 §41, ADR 0023): the title, author, and summary as `title`,
 * `author`, and `description`, and the legacy tags, which named the script in the legacy catalog, as `keywords`. The
 * version, status, color, language, and any computed field have no header field and stay a comment after it.
 */
function metadataComment(program: MigrationProgram): string[] {
  const metadata = program.metadata;
  if (metadata === null) return [];
  const text = (value: string | null): string | null =>
    value === null || value.trim() === "" ? null : `"${escapeStringText(value)}"`;
  const keywords = (metadata.tags ?? []).filter((tag) => tag.trim() !== "");
  const fields: Array<[string, string | null]> = [
    ["title", text(metadata.title)],
    ["author", text(metadata.author)],
    ["description", text(metadata.summary)],
    ["keywords", keywords.length === 0 ? null : keywords.map((tag) => text(tag)).join(", ")],
  ];
  const header = fields
    .filter((field): field is [string, string] => field[1] !== null)
    .map(([name, value]) => `${name}: ${value}`);
  const legacy = [
    metadata.apiVersion === null ? null : `API version ${metadata.apiVersion}`,
    metadata.status === null || metadata.status === "" ? null : `status "${metadata.status}"`,
    metadata.color === null
      ? null
      : `color 0x${metadata.color.toString(16).toUpperCase().padStart(6, "0")}`,
    metadata.language === null || metadata.language === ""
      ? null
      : `language "${metadata.language}"`,
  ].filter((item) => item !== null);
  return [
    ...(header.length === 0 ? [] : ["---", ...header, "---"]),
    ...(legacy.length === 0 ? [] : [`// Legacy setInfos(): ${legacy.join(", ")}`]),
    ...(metadata.computed ?? []).map(
      ({ field, source }) =>
        `// Legacy setInfos() ${field}, computed when the script ran: ${source}`,
    ),
    "",
  ];
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
      lines.push(`${pad}${emitButton(statement.label, statement.timeout)}`);
      return;
    case "showPopup":
      lines.push(`${pad}showPopup ${emitExpression(statement.message)}`);
      return;
    case "permanentButton":
      lines.push(
        `${pad}${emitExpression(statement.target)} = showPermanentButton ${emitExpression(statement.label)} {`,
        ...(statement.persist ? [`${pad}  persist: true`] : []),
        `${pad}}`,
      );
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
        `${pad}${statement.global === true ? "global " : ""}function ${statement.name}${parameters.length === 0 ? "" : `(${parameters.join(", ")})`} {`,
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
      lines.push(
        `${pad}${statement.global === true ? "global" : "let"} ${statement.name}${type} = ${emitValue(statement.value)}`,
      );
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
        lines.push(`${pad}  case ${item.matches.map(emitExpression).join(", ")} {`);
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
    case "goto":
      lines.push(
        `${pad}goto ${statement.target.kind === "file" ? JSON.stringify(statement.target.path) : `script(${emitExpression(statement.target.path)})`}`,
      );
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
    case "duration":
      return `${expression.value} ${expression.unit}`;
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
    case "object": {
      const prefix = expression.dict === true ? "dict" : "";
      const key = (property: (typeof expression.properties)[number]): string => {
        if (property.key === undefined) return property.name;
        // A dict key written as a name or as quoted text; any other key is computed.
        if (property.key.kind === "literal" && typeof property.key.value === "string")
          return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(property.key.value)
            ? property.key.value
            : emitExpression(property.key);
        return `[${emitExpression(property.key)}]`;
      };
      return expression.properties.length === 0
        ? `${prefix}{}`
        : `${prefix}{ ${expression.properties
            .map((property) => `${key(property)}: ${emitExpression(property.value)}`)
            .join(", ")} }`;
    }
    case "index":
      return `${operand(expression.target, POSTFIX)}[${emitExpression(expression.index)}]`;
    case "property":
      return `${operand(expression.target, POSTFIX)}.${expression.name}`;
    case "methodCall": {
      const args = expression.arguments.map(emitExpression);
      // A dict read with a default (#536).
      if (expression.dict === true && expression.name === "get" && args.length === 2)
        return `${operand(expression.target, POSTFIX)}.get(${args[0]}, default: ${args[1]})`;
      return `${operand(expression.target, POSTFIX)}.${expression.name}(${args.join(", ")})`;
    }
    case "load":
      // A read with a default is parenthesized unless it is a whole statement value (see emitValue).
      return expression.defaultValue === undefined
        ? `load ${operand(expression.key, POSTFIX)}`
        : `(${emitLoadDefault(expression)})`;
    case "input":
      return expression.defaultValue === undefined
        ? expression.input
        : `${expression.input} default: ${emitExpression(expression.defaultValue)}`;
    case "choice":
    case "listChoice":
      // `choose a: x, b: y` extends over following commas, so it is parenthesized unless it is a whole
      // statement value (see emitValue).
      return `(${emitChoice(expression)})`;
    case "button":
      return `(${emitButton(expression.label, expression.timeout)})`;
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
      return expression.defaultValue === undefined ? 0 : PRIMARY;
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
      return option.value === null ? text : `${option.value}: ${text}`;
    });
    return `choose ${options.join(", ")}`;
  }
  const options = expression.options.map(
    (option, index) => `${expression.labels?.[index] ?? index}: ${emitExpression(option)}`,
  );
  return `choose ${options.join(", ")}`;
}

/** Compact `showButton` with its optional timeout option (#531). */
function emitButton(label: IrExpression, timeout: IrExpression | null): string {
  return `showButton ${emitExpression(label)}${timeout === null ? "" : `, timeout: ${emitExpression(timeout)}`}`;
}

/** A complete statement value, where a compact choice or button needs no parentheses. */
function emitValue(expression: IrExpression): string {
  if (expression.kind === "button") return emitButton(expression.label, expression.timeout);
  if (expression.kind === "load" && expression.defaultValue !== undefined)
    return emitLoadDefault(expression);
  return expression.kind === "choice" || expression.kind === "listChoice"
    ? emitChoice(expression)
    : emitExpression(expression);
}

/** `load key, default: value` (#541). */
function emitLoadDefault(expression: Extract<IrExpression, { kind: "load" }>): string {
  return `load ${operand(expression.key, POSTFIX)}, default: ${emitExpression(expression.defaultValue!)}`;
}

function operand(expression: IrExpression, minimum: number): string {
  const text = emitExpression(expression);
  return precedence(expression) < minimum ? `(${text})` : text;
}
