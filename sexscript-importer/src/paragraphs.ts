import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import {
  ASKING_STATEMENTS,
  effectBefore,
  hasEffect,
  isAsk,
  withNestedBlocks,
} from "./repeated-text.ts";
import { shortestReadingTime } from "./reading-time.ts";
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
 *   the paragraph before it, except the paragraphs of a beat (withReadingTimes), so that the beat's text shows whole
 *   at once. A kept wait after it (withReadingTimes) keeps only what the reading time of the paragraphs before
 *   the last leaves (shortenedWait); any other `wait` stays as it is.
 * - An ask's question (said before the field opens, also after withAskQuestions made a `say` its question) says the
 *   paragraphs before the one that asks (questionAt), or before the last where none does, before the asking statement,
 *   and keeps the rest as the question.
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
  const trimmed = (statement: IrStatement): void =>
    report(
      "SX_PARAGRAPH_TRIMMED",
      "The blank lines around this text's only paragraph showed nothing, so they go.",
      statement,
    );
  const block = (items: IrStatement[]): IrStatement[] => {
    // The reading time of the paragraphs before the last of the text just split, which the wait after it now follows,
    // and that of its last paragraph.
    let readBefore: number | null = null;
    let readLast = 0;
    return items.flatMap((item, index): IrStatement[] => {
      if (readBefore !== null && item.kind !== "blank" && item.kind !== "comment") {
        const read = readBefore;
        readBefore = null;
        if (item.kind === "wait" && item.afterText === true)
          return shortenedWait(item, read, readLast, readingCovers(next(items, index)));
      }
      const statement = withNestedBlocks(item, block);
      if (statement.kind === "say") {
        if (statement.prose === true || statement.speaker === SYSTEM_SPEAKER) return [statement];
        const split = paragraphs(statement.value);
        if (split === null) return [statement];
        if (keep || (split.layout && split.paragraphs.length > 1)) {
          left(split.layout, statement);
          return [statement];
        }
        if (split.paragraphs.length === 1) {
          trimmed(statement);
          return [{ ...statement, value: split.paragraphs[0]! }];
        }
        report(
          "SX_PARAGRAPHS",
          "The legacy display showed one text, whose paragraphs a blank line separated; each paragraph is a message of its own.",
          statement,
        );
        const { instant, beat, ...paced } = statement;
        readBefore = split.paragraphs
          .slice(0, -1)
          .reduce((total, value) => total + shortestReadingTime(value), 0);
        const last = split.paragraphs.at(-1)!;
        readLast = shortestReadingTime(last);
        const wait = next(items, index);
        const waitMs = wait?.kind === "wait" ? literalWaitMs(wait) : null;
        const after = wait === undefined ? undefined : next(items, items.indexOf(wait));
        // Legacy showed the text whole at once. Where a kept wait after it sets its timing and the last paragraph's
        // reading time would outlast the time the wait leaves it (TSV060), the text keeps showing whole at once, each
        // paragraph said at once, and the wait stays whole: waits that another wait or a timer follows, an author's
        // pause, and a long kept wait before a statement that the reading time does not cover, such as a timer or a
        // text said at once.
        const timed =
          instant === true &&
          wait?.kind === "wait" &&
          wait.afterText !== true &&
          wait.visible !== true &&
          after?.kind === "wait" &&
          waitMs !== null &&
          waitMs < readLast;
        const rest =
          wait?.kind === "wait" && wait.afterText === true && waitMs !== null
            ? Math.round((waitMs - readBefore) / 1000) * 1000
            : Infinity;
        const whole = instant === true && rest > 0 && rest < readLast && !readingCovers(after);
        if (timed || whole) {
          readBefore = null;
          if (timed)
            report(
              "SX_WAIT_TIMED",
              "The legacy waits after this text set its timing, and the first is shorter than the last paragraph's reading time, so every paragraph is said at once and the waits follow, as legacy showed the text.",
              statement,
            );
          else
            report(
              "SX_PARAGRAPH_WAIT_WHOLE",
              "The legacy wait after this text sets its timing, and what it leaves after the paragraphs' reading times is shorter than the last one's, before a statement that this reading time does not cover, so every paragraph is said at once and the wait stays whole, as legacy showed the text.",
              statement,
            );
          return split.paragraphs.map((value) => ({ ...paced, value, instant: true }));
        }
        // A beat's paragraphs keep `instant`, so that the text shows whole at once, as legacy showed it, and its wait
        // keeps the beat.
        return split.paragraphs.map((value) =>
          beat === true ? { ...paced, value, instant: true, beat } : { ...paced, value },
        );
      }
      const ask = ASKING_STATEMENTS.has(statement.kind) ? soleAsk(statement) : null;
      const question = ask === null ? undefined : questionOf(ask);
      const split = question === undefined ? null : paragraphs(question);
      if (ask === null || split === null) return [statement];
      const form = ask.kind === "input" && ask.input === "askForm";
      if (keep || (split.layout && split.paragraphs.length > 1 && !form)) {
        left(split.layout, statement);
        return [statement];
      }
      const [first, ...rest] = split.paragraphs;
      if (rest.length === 0) {
        trimmed(statement);
        return [withAsk(statement, asked(ask, first!))];
      }
      if (form) {
        // The outro is evaluated after the fields and the submit button, the question before them, so the paragraphs
        // move there only where nothing in them or in between can tell the difference.
        if (
          ask.kind !== "input" ||
          ask.outro !== undefined ||
          [ask.fields, ask.submit, ...rest].some((value) => value !== undefined && hasEffect(value))
        )
          return [statement];
        report(
          "SX_FORM_OUTRO",
          "The form's question keeps its first paragraph; the form says the others after it, as its outro.",
          statement,
        );
        return [withAsk(statement, { ...ask, question: first!, outro: joined(rest) })];
      }
      const at = questionAt(split.paragraphs);
      const last = split.paragraphs.length - 1;
      if (at === null)
        report(
          "SX_PARAGRAPH_QUESTION_FALLBACK",
          "The legacy display showed one text, whose paragraphs a blank line separated; each paragraph is a message of its own, and the last one is the question, since no paragraph ends with a question mark or starts with an instruction.",
          statement,
        );
      else if (at < last)
        report(
          "SX_PARAGRAPH_QUESTION_REMARKS",
          "The legacy display showed one text, whose paragraphs a blank line separated; the paragraphs before the question are messages of their own, and the question keeps the remarks after it.",
          statement,
        );
      else
        report(
          "SX_PARAGRAPH_QUESTION",
          "The legacy display showed one text, whose paragraphs a blank line separated; each paragraph is a message of its own, and the last one is the question.",
          statement,
        );
      const start = at ?? last;
      const speaker = ask.kind === "input" ? ask.speaker : undefined;
      return [
        ...split.paragraphs
          .slice(0, start)
          .map((value): IrStatement => ({
            kind: "say",
            value,
            ...(speaker === undefined ? {} : { speaker }),
            span: statement.span,
          })),
        withAsk(statement, asked(ask, joined(split.paragraphs.slice(start)))),
      ];
    });
  };
  /**
   * The legacy wait after a split text started when the whole text appeared, and the paragraphs before the last now
   * take their reading time first, so a kept wait keeps only the rest, in whole seconds, and goes when none is left
   * (owner decision 2026-10-07): the next statement comes as long after the text first appeared as before. The rest
   * also goes where it is shorter than the last paragraph's reading time (`last`) and that reading time covers the next
   * statement (`covered`), as reading time replaces such a wait.
   */
  const shortenedWait = (
    wait: Extract<IrStatement, { kind: "wait" }>,
    read: number,
    last: number,
    covered: boolean,
  ): IrStatement[] => {
    const { duration } = wait;
    if (duration.kind !== "literal" || typeof duration.value !== "number") return [wait];
    const milliseconds = wait.unit === "ms" ? duration.value : duration.value * 1000;
    const seconds = Math.round((milliseconds - read) / 1000);
    if (seconds > 0 && covered && seconds * 1000 < last) {
      report(
        "SX_PARAGRAPH_WAIT_READ",
        "The last paragraph's reading time covers what the legacy wait after the text leaves, so the wait goes.",
        wait,
      );
      return [];
    }
    if (seconds <= 0) {
      report(
        "SX_PARAGRAPH_WAIT_DROPPED",
        "The reading time of the paragraphs before the last covers the legacy wait after the text, so the wait goes.",
        wait,
      );
      return [];
    }
    report(
      "SX_PARAGRAPH_WAIT",
      "The legacy wait after the text started when the whole text appeared; it keeps what the reading time of the paragraphs before the last leaves, in whole seconds.",
      wait,
    );
    const value = wait.unit === "ms" ? seconds * 1000 : seconds;
    return [{ ...wait, duration: { kind: "literal", value } }];
  };
  return block(statements);
}

/** The next statement after `items[index]` that is no blank line or comment. */
function next(items: readonly IrStatement[], index: number): IrStatement | undefined {
  return items.slice(index + 1).find((item) => item.kind !== "blank" && item.kind !== "comment");
}

/** A wait's milliseconds where it is a number literal. */
function literalWaitMs(wait: Extract<IrStatement, { kind: "wait" }>): number | null {
  const { duration } = wait;
  if (duration.kind !== "literal" || typeof duration.value !== "number") return null;
  return wait.unit === "ms" ? duration.value : duration.value * 1000;
}

/**
 * Whether the reading time of the text before a statement covers a wait between them: a text not said at once and
 * media wait for that reading time, and before a button or an ask a reading wait goes, as the player decides when to go
 * on (owner decision 2026-10-07). Before anything else the wait adds time: a wait or a timer runs alongside the reading
 * time, and a call may say a text at once, which ends it.
 */
function readingCovers(statement: IrStatement | undefined): boolean {
  if (statement === undefined) return false;
  if (statement.kind === "say") return statement.instant !== true;
  if (["showButton", "showImage", "hideImage", "playAudio"].includes(statement.kind)) return true;
  const value =
    statement.kind === "let" || statement.kind === "assign" || statement.kind === "save"
      ? statement.value
      : statement.kind === "expression"
        ? statement.expression
        : null;
  return value !== null && (value.kind === "choice" || isAsk(value));
}

type Ask = Extract<IrExpression, { kind: "input" | "call" }>;

/**
 * The statement's one ask, where no condition may skip it and nothing with an effect runs before it, so that what it
 * says may be said before the statement; null for none or several.
 */
function soleAsk(statement: IrStatement): Ask | null {
  const found: Ask[] = [];
  let sure = true;
  const visit = (value: IrExpression, guarded: boolean): void => {
    if ((value.kind === "input" || value.kind === "call") && isAsk(value)) {
      found.push(value);
      if (guarded) sure = false;
    }
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
  const ask = found.length === 1 && sure ? found[0]! : null;
  return ask === null || effectBefore(statement, ask) ? null : ask;
}

/** An ask's question, or the message `askImage` says; undefined for none. */
function questionOf(ask: Ask): IrExpression | undefined {
  if (ask.kind === "input") return ask.question;
  const message = ask.positional[0];
  return message?.kind === "literal" && message.value === null ? undefined : message;
}

/** The ask with another question or message. */
function asked(ask: Ask, question: IrExpression): Ask {
  return ask.kind === "input"
    ? { ...ask, question }
    : { ...ask, positional: [question, ...ask.positional.slice(1)] };
}

/** The statement with its one ask replaced. */
function withAsk(statement: IrStatement, ask: Ask): IrStatement {
  const replace = (value: IrExpression): IrExpression =>
    (value.kind === "input" || value.kind === "call") && isAsk(value)
      ? ask
      : mapChildren(value, replace);
  return mapOwnExpressions(statement, replace);
}

// A question mark at the end, before closing brackets, quotes, closing markup, and whitespace.
const QUESTION_END = /\?(?:[\s)\]}"'`’”»*_~]|\[\/[^\]]*\]|<\/[^>]*>)*$/u;
// Opening markup and quotes before a paragraph's first word.
const OPENING = /^(?:[\s*_~#>"'`‘“«]|\[[^\]/][^\]]*\]|<[^>/][^>]*>)*/u;
const INSTRUCTION =
  /^(?:Enter|Type|Choose|Select|Pick|Write|Tell|Give|Name|How|What|Which|Please|Input|Insert|Answer|Click|Press|Set)(?![\p{L}\p{M}\p{N}_\u{F0000}-\u{FFFFD}])/iu;

/**
 * The paragraph that asks (owner decision 2026-10-07, option E): the last one that ends with a question mark, or else
 * the last one that starts with an instruction or question word, such as `Enter` or `How`; null for none. The
 * paragraphs after it are remarks on it, such as `(default is 2, current is 3)`, which the question keeps.
 */
function questionAt(paragraphs: readonly IrExpression[]): number | null {
  const texts = paragraphs.map((paragraph) =>
    partsOf(paragraph)!
      .map((part) => ("text" in part ? part.text : String.fromCodePoint(FIRST_VALUE)))
      .join(""),
  );
  const asked = texts.findLastIndex((text) => QUESTION_END.test(text));
  if (asked >= 0) return asked;
  const instructed = texts.findLastIndex((text) => INSTRUCTION.test(text.replace(OPENING, "")));
  return instructed >= 0 ? instructed : null;
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
 * lines and with its common indentation removed; null for a text without a blank line in its literal parts, one built
 * at runtime, or one without words. A single paragraph is the text without the blank lines around it. `layout` tells
 * whether the blank lines lay the text out rather than separate paragraphs.
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
  if (pieces.length === 0) return null;
  const decode = (piece: string): IrExpression => {
    const decoded: Part[] = [];
    for (const segment of piece.split(/([\u{F0000}-\u{FFFFD}])/u)) {
      if (segment === "") continue;
      const index = segment.codePointAt(0)! - FIRST_VALUE;
      decoded.push(
        VALUES.test(segment) && [...segment].length === 1 && index < values.length
          ? { value: values[index]! }
          : { text: segment },
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
 * runs of spaces or tabs, a ruled line of `-`, `=`, `*`, and the like, also in bold or italic, an empty box, a table row with two or more `|`,
 * or a block of value rows (isValueRow), three or more, or two that make up half of the text, as in a heading over
 * scores or settings. The tags of underline, colour, and size spans, `[size=x-large]**.......**[/size]`, are no part of
 * a line.
 */
function isLayout(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) =>
      line.replace(/\[(?:u|(?:color|size)=[#0-9a-z-]+)\]|\[\/(?:u|color|size)\]/gu, "").trim(),
    )
    .filter((line) => line !== "");
  const aligned = lines.filter(
    (line) => /\S {3,}\S/u.test(line) || /: {2,}\S/u.test(line) || /\S\t+\S/u.test(line),
  );
  if (aligned.length >= 2) return true;
  // A ruled line in a span, `**------**`, is one too; the delimiters of a span around a whole line are no rule.
  const ruled = lines
    .map((line) => /^(\*\*|\*|~~)(.+)\1$/u.exec(line)?.[2] ?? line)
    .some(
      (line) =>
        /^[-=_*#~+|<>/\\. ]+$/u.test(line) &&
        /[-=_*#~+|]/u.test(line) &&
        line.replace(/[ .<>/\\]/gu, "").length >= 4,
    );
  // An empty box, `[  ]`, stands for a place on the screen.
  const box = lines.some((line) => /^[[(]\s*[\])]$/u.test(line));
  if (ruled || box || lines.some((line) => (line.match(/\|/gu) ?? []).length >= 2)) return true;
  const rows = lines.filter(isValueRow).length;
  return rows >= 3 || (rows >= 2 && rows * 2 >= lines.length);
}

/**
 * Whether a line shows one value under a short label, `label: value` or `label = value`, as in `Score: 12`, `Players:
 * ${list}.`, or `Your time unit = ${unit}`: a label of at most six words, with a letter or a value and no sentence
 * before it, and a value that is a value, a number, or at most three words. A URL is no such row.
 */
function isValueRow(line: string): boolean {
  if (/\w:\/\//u.test(line)) return false;
  const row = /^(?<label>[^:=]{1,40}?)[ \t]*[:=][ \t]*(?<value>\S.{0,59})$/u.exec(line);
  if (row === null) return false;
  const label = row.groups!.label!.trim();
  const value = row.groups!.value!.trim();
  if (!/\p{L}/u.test(label) && !VALUES.test(label)) return false;
  if (label.split(/\s+/u).length > 6 || /[.!?]\s+\S/u.test(label)) return false;
  if (!/[\p{L}\p{N}]/u.test(value) && !VALUES.test(value)) return false;
  return VALUES.test(value) || /^[-+]?\d/u.test(value) || value.split(/\s+/u).length <= 3;
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
