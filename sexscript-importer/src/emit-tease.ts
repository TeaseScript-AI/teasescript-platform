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

/**
 * The indentation of the line being written, from which a block string, a multiline menu, or a table continues one level
 * deeper (blockString, menuOptions, laidOut); null outside statements and inside an interpolation, where text stays on
 * one line.
 */
let blockPad: string | null = null;

function emitStatement(statement: IrStatement, lines: string[], depth: number): void {
  const outer = blockPad;
  blockPad = "  ".repeat(depth);
  try {
    emitStatementAt(statement, lines, depth);
  } finally {
    blockPad = outer;
  }
}

function emitStatementAt(statement: IrStatement, lines: string[], depth: number): void {
  const pad = "  ".repeat(depth);
  switch (statement.kind) {
    case "say":
      lines.push(
        `${pad}say ${statement.speaker === undefined ? "" : `as ${statement.speaker} `}${statement.prose === true ? "prose " : ""}${emitExpression(statement.value)}${statement.instant === true ? ", instant" : ""}`,
      );
      return;
    case "speaker":
      lines.push(`${pad}speaker ${statement.name} {`);
      for (const property of statement.properties)
        lines.push(`${pad}  ${property.name}: ${emitExpression(property.value)}`);
      lines.push(`${pad}}`);
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
        `${pad}${emitExpression(statement.target)} = showPermanentButton ${emitExpression(statement.label)}${statement.persist ? ", persist: true" : ""} {`,
      );
      emitStatements(statement.body ?? [], lines, depth + 1);
      lines.push(`${pad}}`);
      return;
    case "showImage":
      lines.push(`${pad}showImage ${emitExpression(statement.file)}`);
      return;
    case "hideImage":
      lines.push(`${pad}hideImage`);
      return;
    case "playAudio": {
      const file = emitExpression(statement.file);
      const play = statement.video === true ? "playVideo" : "playAudio";
      if (statement.repeatCount === null) {
        lines.push(`${pad}${play}${statement.async ? " async" : ""} ${file}`);
      } else {
        lines.push(
          `${pad}${play}(file: ${file}, async: ${statement.async}, repeat: ${emitExpression(statement.repeatCount)} times)`,
        );
      }
      return;
    }
    case "stopAudio":
      lines.push(`${pad}stopAudio`);
      return;
    case "save": {
      // An ask keeps its compact form, grouped with its own speaker clause: `save (askText as system) as "key"`
      // (V30 §23).
      const value =
        statement.value.kind === "input"
          ? compactInput(statement.value)
          : emitExpression(statement.value);
      const grouped =
        statement.value.kind === "input" && statement.value.speaker !== undefined
          ? `(${value})`
          : value;
      lines.push(`${pad}save ${grouped} as ${emitExpression(statement.key)}`);
      return;
    }
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
      const parameters = statement.parameters.map((parameter) => {
        const name =
          parameter.type === undefined ? parameter.name : `${parameter.name}: ${parameter.type}`;
        return parameter.defaultValue === null
          ? name
          : `${name} = ${emitExpression(parameter.defaultValue)}`;
      });
      lines.push(
        `${pad}${statement.global === true ? "global " : ""}function ${statement.name}${parameters.length === 0 ? "" : `(${parameters.join(", ")})`}${statement.returnType === undefined ? "" : `: ${statement.returnType}`} {`,
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
    case "assign": {
      // `x = x + e` is `x += e` when the left operand is the variable itself, so nothing regroups.
      const value = statement.value;
      const compound =
        statement.operator === "=" &&
        statement.target.kind === "variable" &&
        value.kind === "binary" &&
        (value.operator === "+" || value.operator === "-") &&
        value.left.kind === "variable" &&
        value.left.name === statement.target.name;
      lines.push(
        compound
          ? `${pad}${emitExpression(statement.target)} ${value.operator}= ${emitValue(value.right)}`
          : `${pad}${emitExpression(statement.target)} ${statement.operator} ${emitValue(value)}`,
      );
      return;
    }
    case "expression":
      lines.push(`${pad}${emitValue(statement.expression)}`);
      return;
    case "if": {
      // `if p { return true } else { return false }` returns the predicate itself.
      if (
        isPredicate(statement.condition) &&
        returnsLiteral(statement.then, true) &&
        returnsLiteral(statement.else, false)
      ) {
        lines.push(`${pad}return ${emitExpression(statement.condition)}`);
        return;
      }
      lines.push(`${pad}if ${emitHead(statement.condition)} {`);
      emitStatements(statement.then, lines, depth + 1);
      let alternative = statement.else;
      // Flatten Groovy `else if` chains, which the AST represents as nested if statements.
      for (
        let nested = alternative[0];
        alternative.length === 1 && nested?.kind === "if";
        nested = alternative[0]
      ) {
        lines.push(`${pad}} else if ${emitHead(nested.condition)} {`);
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
      lines.push(`${pad}while ${emitHead(statement.condition)} {`);
      emitStatements(statement.body, lines, depth + 1);
      lines.push(`${pad}}`);
      return;
    case "repeat":
      lines.push(`${pad}repeat ${emitExpression(statement.count)} {`);
      emitStatements(statement.body, lines, depth + 1);
      lines.push(`${pad}}`);
      return;
    case "for":
      lines.push(
        `${pad}for ${statement.variable}${statement.valueVariable === undefined ? "" : `, ${statement.valueVariable}`} in ${emitExpression(statement.collection)} {`,
      );
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
        ? (blockString([{ text: expression.value }]) ?? `"${escapeStringText(expression.value)}"`)
        : expression.decimal === true && /^-?\d+$/u.test(String(expression.value))
          ? `${expression.value}.0`
          : String(expression.value);
    case "duration":
      return `${expression.value} ${expression.unit}`;
    case "template": {
      const flat = flatParts(expression.parts);
      if (flat.every((part) => "text" in part))
        return emitExpression({
          kind: "literal",
          value: flat.map((part) => ("text" in part ? part.text : "")).join(""),
        });
      const block = blockString(flat);
      if (block !== null) return block;
      const parts = flat.map((part) =>
        "text" in part ? escapeStringText(part.text) : `\${${interpolated(part.value)}}`,
      );
      return `"${parts.join("")}"`;
    }
    case "variable":
      return expression.name;
    case "list": {
      const prefix = expression.set === true ? "set" : "";
      // A table, a list of rows, has a row on each line.
      if (expression.items.length >= 2 && expression.items.every(isRow)) {
        const rows = laidOut(expression.items.map((item) => () => emitExpression(item)));
        if (rows !== null) return `${prefix}[${rows}]`;
      }
      const single = `${prefix}[${expression.items.map(emitExpression).join(", ")}]`;
      if (expression.lines === true && single.length > 80) {
        const lines = laidOut(expression.items.map((item) => () => emitExpression(item)));
        if (lines !== null) return `${prefix}[${lines}]`;
      }
      return single;
    }
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
      // An object or dict of rows has a row on each line.
      const rows =
        expression.properties.length >= 2 &&
        expression.properties.every((property) => isRow(property.value))
          ? laidOut(
              expression.properties.map(
                (property) => () => `${key(property)}: ${emitExpression(property.value)}`,
              ),
            )
          : null;
      if (rows !== null) return `${prefix}{${rows}}`;
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
      // Inside a larger expression a read takes its bounded form, `load("k", default: null) == null` (V30 §25); a
      // whole statement value keeps the compact one (see emitValue).
      return `load(${emitExpression(expression.key)}, default: ${loadDefault(expression)})`;
    case "input": {
      // Inside a larger expression an ask takes its parenthesized form, `askInteger(prefill: 0) + 1` (V30 §20); a
      // whole statement value keeps the compact one (see emitValue).
      const asked =
        expression.speaker === undefined
          ? expression.input
          : `${expression.input} as ${expression.speaker} `;
      return `${asked}(${askArguments(expression).join(", ")})`;
    }
    case "choice":
    case "listChoice":
      // `choose a: x, b: y` extends over following commas, so it is parenthesized unless it is a whole
      // statement value (see emitValue).
      return `(${emitChoice(expression)})`;
    case "button":
      return `(${emitButton(expression.label, expression.timeout)})`;
    case "message":
      // Inside an expression a `say` value takes the bounded form (V30 "Updatable messages").
      return `say${expression.speaker === undefined ? "" : ` as ${expression.speaker}`}(${emitExpression(expression.value)}${expression.instant === true ? ", instant" : ""})`;
    case "range": {
      const operator = expression.inclusive ? "..=" : "..";
      return `${operand(expression.from, RANGE + 1)}${operator}${operand(expression.to, RANGE + 1)}`;
    }
    case "unary":
      return expression.operator === "not"
        ? `not ${operand(expression.value, NOT)}`
        : `${expression.operator}${operand(expression.value, UNARY)}`;
    case "typeTest":
      return `${operand(expression.value, COMPARISON + 1)} is ${expression.type}`;
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
      // askBooleans takes its message first without a name, as the other asks do (V30 §20).
      if (isBooleansAsk(expression))
        return `askBooleans(${booleansArguments(expression).join(", ")})`;
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

/** Whether a condition is a comparison, a logical combination, a negation, or a type test, which give true or false. */
function isPredicate(condition: IrExpression): boolean {
  if (condition.kind === "typeTest") return true;
  if (condition.kind === "unary") return condition.operator === "not";
  if (condition.kind === "literal") return typeof condition.value === "boolean";
  return (
    condition.kind === "binary" &&
    ["==", "!=", "<", ">", "<=", ">=", "and", "or"].includes(condition.operator)
  );
}

function returnsLiteral(statements: readonly IrStatement[], value: boolean): boolean {
  const [only] = statements;
  return (
    statements.length === 1 &&
    only?.kind === "return" &&
    only.value?.kind === "literal" &&
    only.value.value === value
  );
}

/**
 * Template parts without interpolation scaffolding: an interpolated literal text is text, and an interpolated
 * template contributes its own parts (`"${"toy.${i}"}"` is `"toy.${i}"`).
 */
function flatParts(parts: readonly TextPart[]): TextPart[] {
  const result: TextPart[] = [];
  const add = (part: TextPart): void => {
    const last = result.at(-1);
    if ("text" in part && last !== undefined && "text" in last)
      result[result.length - 1] = { text: last.text + part.text };
    else result.push(part);
  };
  for (const part of parts) {
    if ("text" in part) add(part);
    else if (part.value.kind === "literal" && typeof part.value.value === "string")
      add({ text: part.value.value });
    else if (part.value.kind === "template")
      for (const inner of flatParts(part.value.parts)) add(inner);
    else add(part);
  }
  return result;
}

/** A list or object literal with content, a row of a table. */
function isRow(value: IrExpression): boolean {
  return (
    (value.kind === "list" && value.items.length > 0) ||
    (value.kind === "object" && value.properties.length > 0)
  );
}

/** Items one per line, one level deeper than the current line, between the delimiters; null where text is single-line. */
function laidOut(items: ReadonlyArray<() => string>): string | null {
  if (blockPad === null) return null;
  const outer = blockPad;
  const inner = `${outer}  `;
  const lines = within(inner, () => items.map((item) => `${inner}${item()}`));
  return `\n${lines.join(",\n")}\n${outer}`;
}

/** The result of emitting with lines that continue at `pad`. */
function within<T>(pad: string, emit: () => T): T {
  const outer = blockPad;
  blockPad = pad;
  try {
    return emit();
  } finally {
    blockPad = outer;
  }
}

/** An interpolated value, written single-line: a string inside `${...}` may not span lines (V30 §8). */
function interpolated(value: IrExpression): string {
  const outer = blockPad;
  blockPad = null;
  try {
    return emitExpression(value);
  } finally {
    blockPad = outer;
  }
}

type TextPart = { text: string } | { value: IrExpression };

/**
 * Text with line breaks as a block string (V30 §8): `"""` and a line break, each line one level deeper than the
 * statement, and the closing `"""` on its own line at the statement's indentation, so dedent removes exactly the added
 * indentation and the value stays the same. Null for text without a line break, outside a statement, and where the
 * block form would change or hide the value: no line with text, a line of only whitespace, a line that ends in a
 * space or tab (which editors strip), or text lines that all start with a space or tab (which dedent would remove).
 */
function blockString(parts: readonly TextPart[]): string | null {
  if (blockPad === null || !parts.some((part) => "text" in part && part.text.includes("\n")))
    return null;
  const lines: TextPart[][] = [[]];
  for (const part of parts) {
    if (!("text" in part)) {
      lines.at(-1)!.push(part);
      continue;
    }
    part.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([]);
      const line = lines.at(-1)!;
      const last = line.at(-1);
      if (last !== undefined && "text" in last) line[line.length - 1] = { text: last.text + piece };
      else if (piece !== "") line.push({ text: piece });
    });
  }
  // An interpolation counts as text that is no space.
  const shapes = lines.map((line) =>
    line.map((segment) => ("text" in segment ? segment.text : "x")).join(""),
  );
  const filled = shapes.filter((shape) => shape !== "");
  if (
    filled.length === 0 ||
    filled.some((shape) => /^\s+$/u.test(shape) || /[ \t]$/u.test(shape)) ||
    filled.every((shape) => /^[ \t]/u.test(shape))
  )
    return null;
  const pad = blockPad;
  const content = lines.map((line, index) =>
    shapes[index] === ""
      ? ""
      : `${pad}  ${line
          .map((segment) =>
            "text" in segment
              ? escapeBlockText(segment.text)
              : `\${${interpolated(segment.value)}}`,
          )
          .join("")}`,
  );
  return `"""\n${content.join("\n")}\n${pad}"""`;
}

/** Literal text inside a block string: the escapes of single-line text, except line breaks and lone quotes. */
function escapeBlockText(text: string): string {
  return text
    .replace(/\\/gu, "\\\\")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")
    .replace(/\$\{/gu, "\\${")
    .replace(/"{3,}/gu, (quotes) => quotes.replace(/"/gu, '\\"'));
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
    case "typeTest":
      return COMPARISON;
    case "range":
      return RANGE;
    case "index":
    case "property":
    case "methodCall":
      return POSTFIX;
    default:
      return PRIMARY;
  }
}

function emitChoice(expression: Extract<IrExpression, { kind: "choice" | "listChoice" }>): string {
  if (expression.kind === "listChoice") {
    const options = expression.options.map((option) => () => {
      if (option.kind === "list") return emitExpression(option.list);
      const text = emitExpression(option.text);
      return option.value === null ? text : `${option.value}: ${text}`;
    });
    return `choose ${menuOptions(options)}`;
  }
  const options = expression.options.map(
    (option, index) => () => `${expression.labels?.[index] ?? index}: ${emitExpression(option)}`,
  );
  return `choose ${menuOptions(options)}`;
}

/** A menu's options, from three on with each option after the first on its own line, one level deeper. */
function menuOptions(options: ReadonlyArray<() => string>): string {
  if (blockPad === null || options.length < 3) return options.map((option) => option()).join(", ");
  const inner = `${blockPad}  `;
  const [first, ...rest] = within(inner, () => options.map((option) => option()));
  return [first, ...rest.map((option) => `${inner}${option}`)].join(",\n");
}

/** Compact `showButton` with its optional timeout option (#531). */
function emitButton(label: IrExpression, timeout: IrExpression | null): string {
  return `showButton ${emitExpression(label)}${timeout === null ? "" : `, timeout: ${emitExpression(timeout)}`}`;
}

/** A complete statement value, where a compact choice, button, read, or ask needs no parentheses. */
function emitValue(expression: IrExpression): string {
  if (expression.kind === "button") return emitButton(expression.label, expression.timeout);
  // A whole statement value takes the compact form, its pacing up to the end of the statement.
  if (expression.kind === "message")
    return `say ${expression.speaker === undefined ? "" : `as ${expression.speaker} `}${emitExpression(expression.value)}${expression.instant === true ? ", instant" : ""}`;
  if (expression.kind === "load")
    return `load ${operand(expression.key, POSTFIX)}, default: ${loadDefault(expression)}`;
  if (expression.kind === "input") return compactInput(expression);
  if (expression.kind === "call" && isBooleansAsk(expression))
    return `askBooleans ${booleansArguments(expression).join(", ")}`;
  return expression.kind === "choice" || expression.kind === "listChoice"
    ? emitChoice(expression)
    : emitExpression(expression);
}

/** `askText`, `askInteger default: 3`, `askText as system` (V30 §20). */
function compactInput(expression: Extract<IrExpression, { kind: "input" }>): string {
  const asked =
    expression.speaker === undefined
      ? expression.input
      : `${expression.input} as ${expression.speaker}`;
  const args = askArguments(expression);
  // Without a question, `askInteger prefill: 3` has no comma (V30 §20).
  return args.length === 0 ? asked : `${asked} ${args.join(", ")}`;
}

/**
 * The head of an `if`, `else if`, or `while`, where the `{` of the block ends a compact ask (V30 §20), so an ask
 * that is the whole condition, or its negation, keeps its compact form: `if askBoolean "Ready?" {`.
 */
function emitHead(condition: IrExpression): string {
  if (condition.kind === "input") return compactInput(condition);
  if (
    condition.kind === "unary" &&
    condition.operator === "not" &&
    condition.value.kind === "input"
  )
    return `not ${compactInput(condition.value)}`;
  return emitExpression(condition);
}

/** An `askBooleans` call with its message named, as the converter writes it. */
function isBooleansAsk(expression: Extract<IrExpression, { kind: "call" }>): boolean {
  return (
    expression.name === "askBooleans" &&
    expression.local !== true &&
    expression.positional.length === 0 &&
    expression.named.message !== undefined
  );
}

/** An `askBooleans` call's message first, then its other arguments by name. */
function booleansArguments(expression: Extract<IrExpression, { kind: "call" }>): string[] {
  const { message, ...named } = expression.named;
  return [
    emitExpression(message!),
    ...Object.entries(named).map(([name, value]) => `${name}: ${emitExpression(value)}`),
  ];
}

/**
 * An ask's question, an `askBoolean`'s button texts, a form's `fields:`, `submit:`, and `outro:`, and an ask's
 * `prefill:` (#713), in that order.
 */
function askArguments(expression: Extract<IrExpression, { kind: "input" }>): string[] {
  return [
    ...(expression.question === undefined ? [] : [emitExpression(expression.question)]),
    ...(expression.yesText === undefined ? [] : [`yesText: ${emitExpression(expression.yesText)}`]),
    ...(expression.noText === undefined ? [] : [`noText: ${emitExpression(expression.noText)}`]),
    ...(expression.fields === undefined ? [] : [`fields: ${emitExpression(expression.fields)}`]),
    ...(expression.submit === undefined ? [] : [`submit: ${emitExpression(expression.submit)}`]),
    ...(expression.outro === undefined ? [] : [`outro: ${emitExpression(expression.outro)}`]),
    ...(expression.defaultValue === undefined
      ? []
      : [`prefill: ${emitExpression(expression.defaultValue)}`]),
  ];
}

/**
 * A read's `default:`, which every `load` has (#690): its own, or null, which a missing key read in legacy, where the
 * script may tell it from a value (storage-keys.ts).
 */
function loadDefault(expression: Extract<IrExpression, { kind: "load" }>): string {
  return expression.defaultValue === undefined ? "null" : emitExpression(expression.defaultValue);
}

function operand(expression: IrExpression, minimum: number): string {
  const text = emitExpression(expression);
  return precedence(expression) < minimum ? `(${text})` : text;
}
