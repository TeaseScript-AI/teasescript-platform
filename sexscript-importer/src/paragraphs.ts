import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { ASKING_STATEMENTS, withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

type Part = { text: string } | { value: IrExpression };

// A value of a template stands in the text as one private-use character while the text is split.
const FIRST_VALUE = 0xf0000;
const VALUES = /[\u{F0000}-\u{FFFFD}]/u;
// A line break followed by one or more lines of only whitespace.
const BLANK_LINES = /\n(?:[^\S\n]*\n)+/u;

/**
 * The legacy player showed one text at a time in one display, so authors separated what a chat shows as separate
 * messages with a blank line. A shown text whose own words hold a blank line becomes one message per paragraph, in order
 * and with the same speaker; a blank line inside an interpolated value stays.
 * - A `say` becomes one `say` per paragraph, each with the Player's reading time (owner decision 2026-10-07): a text
 *   that was `instant` because a legacy `wait` follows loses it, since `instant` would also skip the reading time of
 *   the paragraph before it, and the `wait` stays as it is.
 * - An ask's question (said before the field opens, also after withAskQuestions made a `say` its question) says its
 *   earlier paragraphs before the asking statement and keeps the last as the question.
 * - A form's question keeps its first paragraph, the intro, and the form says the others after it, in its `outro:`
 *   prose block (V30 §20 Forms), unsplit.
 * Text laid out with blank lines (aligned columns, ruled lines, tables, stat blocks; isLayout) and the units that keep
 * paragraphs (`keep`) stay as they are, as do the system speaker's texts and prose, which the importer adds.
 */
export function withParagraphs(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
  keep: boolean,
): IrStatement[] {
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  const left = (layout: boolean, statement: IrStatement): void =>
    layout
      ? report(
          "SX_PARAGRAPHS_LAYOUT",
          "This text uses blank lines for layout (aligned columns, ruled lines, a table, or a block of values), so it stays one message.",
          statement,
        )
      : report(
          "SX_PARAGRAPHS_KEPT",
          "This unit keeps texts with blank lines as one message (its patches.json sets keepParagraphs).",
          statement,
        );
  const block = (items: IrStatement[]): IrStatement[] =>
    items.flatMap((item): IrStatement[] => {
      const statement = withNestedBlocks(item, block);
      if (statement.kind === "say") {
        if (statement.prose === true || statement.speaker === SYSTEM_SPEAKER) return [statement];
        const split = paragraphs(statement.value);
        if (split === null) return [statement];
        if (keep || split.layout) {
          left(split.layout, statement);
          return [statement];
        }
        report(
          "SX_PARAGRAPHS",
          "The legacy display showed one text, whose paragraphs a blank line separated; each paragraph is a message of its own.",
          statement,
        );
        const { instant: _instant, ...paced } = statement;
        return split.paragraphs.map((value) => ({ ...paced, value }));
      }
      const ask = ASKING_STATEMENTS.has(statement.kind) ? soleAsk(statement) : null;
      const split = ask?.question === undefined ? null : paragraphs(ask.question);
      if (ask === null || split === null) return [statement];
      if (keep || (split.layout && ask.input !== "askForm")) {
        left(split.layout, statement);
        return [statement];
      }
      const [first, ...rest] = split.paragraphs;
      if (ask.input === "askForm") {
        if (ask.outro !== undefined) return [statement];
        report(
          "SX_FORM_OUTRO",
          "The form's question keeps its first paragraph; the form says the others after it, as its outro.",
          statement,
        );
        return [withAsk(statement, { ...ask, question: first!, outro: joined(rest) })];
      }
      report(
        "SX_PARAGRAPH_QUESTION",
        "The legacy display showed one text, whose paragraphs a blank line separated; each paragraph is a message of its own, and the last one is the question.",
        statement,
      );
      return [
        ...split.paragraphs
          .slice(0, -1)
          .map((value): IrStatement => ({
            kind: "say",
            value,
            ...(ask.speaker === undefined ? {} : { speaker: ask.speaker }),
            span: statement.span,
          })),
        withAsk(statement, { ...ask, question: split.paragraphs.at(-1)! }),
      ];
    });
  return block(statements);
}

type Input = Extract<IrExpression, { kind: "input" }>;

/** The statement's one ask, where no condition may skip it; null for none or several. */
function soleAsk(statement: IrStatement): Input | null {
  const found: Input[] = [];
  let sure = true;
  const visit = (value: IrExpression, guarded: boolean): void => {
    if (value.kind === "input") {
      found.push(value);
      if (guarded) sure = false;
    }
    if (value.kind === "call" && value.name === "askImage") sure = false;
    if (value.kind === "binary" && (value.operator === "and" || value.operator === "or")) {
      visit(value.left, guarded);
      visit(value.right, true);
      return;
    }
    mapChildren(value, (child) => {
      visit(child, guarded);
      return child;
    });
  };
  mapOwnExpressions(statement, (value) => {
    visit(value, false);
    return value;
  });
  return found.length === 1 && sure ? found[0]! : null;
}

/** The statement with its one ask replaced. */
function withAsk(statement: IrStatement, ask: Input): IrStatement {
  const replace = (value: IrExpression): IrExpression =>
    value.kind === "input" ? ask : mapChildren(value, replace);
  return mapOwnExpressions(statement, replace);
}

/** Paragraphs joined by a blank line, as one text. */
function joined(paragraphs: readonly IrExpression[]): IrExpression {
  const parts: Part[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) parts.push({ text: "\n\n" });
    parts.push(...partsOf(paragraph)!);
  });
  return expressionOf(parts);
}

/**
 * The paragraphs of a shown text, split at the blank lines of its literal parts, each without its surrounding blank
 * lines and with its common indentation removed; null for a text with fewer than two paragraphs or one built at runtime.
 * `layout` tells whether the blank lines lay the text out rather than separate paragraphs.
 */
export function paragraphs(
  value: IrExpression,
): { paragraphs: IrExpression[]; layout: boolean } | null {
  const parts = partsOf(value);
  if (parts === null) return null;
  const values: IrExpression[] = [];
  let encoded = "";
  for (const part of parts) {
    if ("value" in part) {
      encoded += String.fromCodePoint(FIRST_VALUE + values.length);
      values.push(part.value);
    } else if (VALUES.test(part.text)) return null;
    else encoded += part.text;
  }
  if (values.length > 0xfffd || !BLANK_LINES.test(encoded)) return null;
  const pieces = encoded
    .replaceAll("\r\n", "\n")
    .split(BLANK_LINES)
    .map(dedent)
    .filter((piece) => piece !== "");
  if (pieces.length < 2) return null;
  const decode = (piece: string): IrExpression => {
    const decoded: Part[] = [];
    for (const segment of piece.split(/([\u{F0000}-\u{FFFFD}])/u)) {
      if (segment === "") continue;
      const index = segment.codePointAt(0)! - FIRST_VALUE;
      decoded.push(
        segment.length <= 2 && index >= 0 ? { value: values[index]! } : { text: segment },
      );
    }
    return expressionOf(decoded);
  };
  return { paragraphs: pieces.map(decode), layout: isLayout(encoded) };
}

/** A paragraph without surrounding blank lines and trailing whitespace, and without the indentation all its lines share. */
function dedent(piece: string): string {
  const lines = piece
    .replace(/^(?:[^\S\n]*\n)+/u, "")
    .trimEnd()
    .split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/u.exec(line)![0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines
    .map((line) => line.slice(Math.min(common, /^[ \t]*/u.exec(line)![0].length)))
    .join("\n");
}

/**
 * Whether a text's blank lines lay it out rather than separate paragraphs: two or more lines with columns aligned by
 * runs of spaces or tabs, a ruled line of `-`, `=`, `*`, and the like, an empty box, a table row with two or more `|`,
 * or three or more short `label: value` lines, as in a block of scores or settings.
 */
function isLayout(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const aligned = lines.filter(
    (line) => /\S {3,}\S/u.test(line) || /: {2,}\S/u.test(line) || /\S\t+\S/u.test(line),
  );
  if (aligned.length >= 2) return true;
  const ruled = lines.some(
    (line) =>
      /^[-=_*#~+|<>/\\. ]+$/u.test(line) &&
      /[-=_*#~+|]/u.test(line) &&
      line.replace(/[ .<>/\\]/gu, "").length >= 4,
  );
  // An empty box, `[  ]`, stands for a place on the screen.
  const box = lines.some((line) => /^[[(]\s*[\])]$/u.test(line));
  if (ruled || box || lines.some((line) => (line.match(/\|/gu) ?? []).length >= 2)) return true;
  const labelled = lines.filter((line) => /^[^\s:.!?][^:.!?]{0,29}:[ \t]*\S.{0,40}$/u.test(line));
  return labelled.length >= 3;
}

function partsOf(value: IrExpression): Part[] | null {
  if (value.kind === "literal")
    return typeof value.value === "string" ? [{ text: value.value }] : null;
  return value.kind === "template" ? value.parts : null;
}

function expressionOf(parts: Part[]): IrExpression {
  return parts.length === 1 && "text" in parts[0]!
    ? { kind: "literal", value: parts[0].text }
    : { kind: "template", parts };
}
