import {
  lex,
  parse,
  runtimeDebugPreview,
  type RandomDrawView,
  type RandomOutcome,
  type RandomSite,
  type SourceSpan,
  type Token,
} from "../../../src/index.js";

/**
 * How the random draw picker (DEBUGGER.md "Random draws") offers a draw's outcomes: a button for each when the draw has
 * few, a number field for a continuous draw or a large range, and a list to reorder for a shuffle.
 */
export type RandomDrawChoices =
  | { readonly kind: "buttons"; readonly outcomes: readonly RandomDrawButton[] }
  | {
      readonly kind: "number";
      readonly integer: boolean;
      readonly hint: string;
      readonly accepts: (value: number) => boolean;
    }
  | { readonly kind: "order"; readonly items: readonly string[] };

export interface RandomDrawButton {
  readonly outcome: RandomOutcome;
  readonly label: string;
}

export function randomDrawChoices(draw: RandomDrawView): RandomDrawChoices {
  const { support } = draw;
  const buttons = (outcomes: readonly RandomDrawButton[]): RandomDrawChoices => ({
    kind: "buttons",
    outcomes,
  });
  const numbers = (values: readonly number[]) =>
    buttons(values.map((value) => ({ outcome: { kind: "number", value }, label: text(value) })));
  const field = (
    hint: string,
    accepts: (value: number) => boolean,
    integer = false,
  ): RandomDrawChoices => ({
    kind: "number",
    integer,
    hint,
    accepts: (value) => Number.isFinite(value) && accepts(value),
  });
  switch (support.kind) {
    case "chance": {
      const values =
        support.percent <= 0 ? [false] : support.percent >= 100 ? [true] : [true, false];
      return buttons(
        values.map((value) => ({ outcome: { kind: "boolean", value }, label: String(value) })),
      );
    }
    case "integer": {
      const { min, max } = support;
      // A range with as few values as `randomDrawAlternatives` enumerates gets a button for each.
      if (max - min <= 16)
        return numbers(Array.from({ length: max - min + 1 }, (_, offset) => min + offset));
      const seconds = draw.kind === "duration" || draw.kind === "timerRepeat";
      return field(
        `Whole number${seconds ? " of seconds" : ""} from ${text(min)} through ${text(max)}.`,
        (value) => Number.isSafeInteger(value) && value >= min && value <= max,
        true,
      );
    }
    case "candidates":
    case "weighted":
      return buttons(
        support.candidates.flatMap((candidate, index) =>
          support.kind === "weighted" && !(support.weights[index]! > 0)
            ? []
            : [{ outcome: { kind: "index", index }, label: runtimeDebugPreview(candidate).text }],
        ),
      );
    case "unit":
      return field("From 0 up to, but not including, 1.", (value) => value >= 0 && value < 1);
    case "normal": {
      const { mean, spread } = support;
      if (spread === 0) return numbers([mean]);
      return field(
        `Any finite number. Suggested: ${text(mean - 3 * spread)} to ${text(mean + 3 * spread)}.`,
        () => true,
      );
    }
    case "beta":
      return field("From 0 through 1.", (value) => value >= 0 && value <= 1);
    case "pert": {
      const { min, max } = support;
      if (min === max) return numbers([min]);
      return field(
        `From ${text(min)} through ${text(max)}.`,
        (value) => value >= min && value <= max,
      );
    }
    case "order":
      return { kind: "order", items: support.items.map((item) => runtimeDebugPreview(item).text) };
  }
}

/** A number as the picker shows it: a whole number in full, any other to six significant digits. */
function text(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

/** An outcome of `draw` as the picker shows it: the value it gives, a candidate's value, or a shuffle's new order. */
export function randomOutcomeLabel(draw: RandomDrawView, outcome: RandomOutcome): string {
  const { support } = draw;
  switch (outcome.kind) {
    case "boolean":
      return String(outcome.value);
    case "number":
      return text(outcome.value);
    case "index": {
      const candidates =
        support.kind === "candidates" || support.kind === "weighted" ? support.candidates : [];
      const candidate = candidates[outcome.index];
      return candidate === undefined ? `#${outcome.index}` : runtimeDebugPreview(candidate).text;
    }
    case "order": {
      const items = support.kind === "order" ? support.items : [];
      return `[${outcome.order.map((index) => (items[index] === undefined ? `#${index}` : runtimeDebugPreview(items[index]).text)).join(", ")}]`;
    }
  }
}

/** What a stretch of code is, for its colour: the classes of the compiler's own tokens, or a comment between them. */
export type CodeTokenClass = "keyword" | "string" | "number" | "comment" | "name" | "operator";

export interface CodeSegment {
  readonly text: string;
  readonly kind: CodeTokenClass | null;
  /** Whether the segment is marked, as the draw is. */
  readonly mark: boolean;
}

export interface CodeLine {
  /** One-based. */
  readonly number: number;
  readonly segments: readonly CodeSegment[];
}

/** How many lines the code around a draw shows by default: the draw's line in the middle. */
export const CONTEXT_ROWS = 7;

/**
 * The code of the file a draw at `site` is in, highlighted with the compiler's own lexer: every line, with the draw
 * marked; `enclosing` is the range "Show whole" fits: the default lines around the draw together with the function the
 * draw is in, or for code outside functions, the top-level statement it is in, or the whole file when that is a single
 * line. `enclosing` is `null` when the default lines already show it. The whole file is lexed, never a fragment, so a
 * partial function is no problem; a file the lexer reports problems in shows as plain text.
 */
export function randomDrawCode(
  source: string,
  site: RandomSite,
): {
  readonly lines: readonly CodeLine[];
  readonly enclosing: {
    readonly kind: "function" | "block" | "file";
    readonly from: number;
    readonly to: number;
  } | null;
} | null {
  const starts = lineStarts(source);
  if (site.line < 1 || site.line > starts.length) return null;
  const lexed = lex(source);
  const tokens = lexed.diagnostics.length === 0 ? lexed.tokens : [];
  const mark = {
    from: starts[site.line - 1]! + site.column - 1,
    to: (starts[site.endLine - 1] ?? source.length) + site.endColumn - 1,
  };
  const half = (CONTEXT_ROWS - 1) / 2;
  const context = [Math.max(1, site.line - half), Math.min(starts.length, site.line + half)];
  const range = enclosingRange(source, site, starts.length);
  return {
    lines: renderLines(source, starts, tokens, mark, 1, starts.length),
    enclosing:
      range === null || (range.from >= context[0]! && range.to <= context[1]!)
        ? null
        : {
            kind: range.kind,
            from: Math.min(range.from, context[0]!),
            to: Math.max(range.to, context[1]!),
          },
  };
}

/**
 * Earlier outcomes as code lines, numbered from `first`: each is lexed on its own, so a list or text reads like code;
 * one the lexer reports problems in is plain text.
 */
export function outcomeLines(outcomes: readonly string[], first = 1): readonly CodeLine[] {
  return outcomes.map((outcome, index) => {
    const text = outcome.replace(/\r?\n/g, " ");
    const lexed = lex(text);
    const tokens = lexed.diagnostics.length === 0 ? lexed.tokens : [];
    return { ...renderLines(text, [0], tokens, null, 1, 1)[0]!, number: first + index };
  });
}

/** The offset where each line starts. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1))
    starts.push(index + 1);
  return starts;
}

const tokenClasses: Partial<Record<Token["kind"], CodeTokenClass>> = {
  identifier: "name",
  numberLiteral: "number",
  stringStart: "string",
  stringText: "string",
  stringEnd: "string",
};

function tokenClass(kind: Token["kind"]): CodeTokenClass {
  return tokenClasses[kind] ?? (kind.startsWith("keyword") ? "keyword" : "operator");
}

/** Lines `from` through `to`, one-based, split into segments by token, comment, and the mark. */
function renderLines(
  source: string,
  starts: readonly number[],
  tokens: readonly Token[],
  mark: { readonly from: number; readonly to: number } | null,
  from: number,
  to: number,
): CodeLine[] {
  const drawStart = mark?.from ?? -1;
  const drawEnd = mark?.to ?? -1;
  // The first token that can reach line `from`; tokens are in source order.
  let next = tokens.findIndex((token) => token.span.end.offset > starts[from - 1]!);
  if (next < 0) next = tokens.length;
  const lines: CodeLine[] = [];
  for (let number = from; number <= to; number += 1) {
    const lineStart = starts[number - 1]!;
    let lineEnd = number < starts.length ? starts[number]! - 1 : source.length;
    if (source[lineEnd - 1] === "\r") lineEnd -= 1;
    const pieces: { from: number; to: number; kind: CodeTokenClass | null }[] = [];
    let cursor = lineStart;
    const gap = (end: number) => {
      if (end <= cursor) return;
      // The lexer skips only whitespace and comments.
      const text = source.slice(cursor, end);
      pieces.push({
        from: cursor,
        to: end,
        kind: text.trim() === "" || tokens.length === 0 ? null : "comment",
      });
      cursor = end;
    };
    for (let index = next; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.span.start.offset >= lineEnd) break;
      if (token.kind === "newline" || token.kind === "endOfFile") continue;
      const start = Math.max(token.span.start.offset, lineStart);
      const end = Math.min(token.span.end.offset, lineEnd);
      if (end <= start) continue;
      gap(start);
      pieces.push({ from: start, to: end, kind: tokenClass(token.kind) });
      cursor = end;
      if (token.span.end.offset <= lineEnd) next = index + 1;
    }
    gap(lineEnd);
    // Split at the draw's ends, so the draw is marked over its tokens' own colours.
    const segments: CodeSegment[] = [];
    for (const piece of pieces) {
      const cuts = [piece.from, drawStart, drawEnd, piece.to]
        .filter((cut) => cut >= piece.from && cut <= piece.to)
        .sort((left, right) => left - right);
      for (let index = 0; index + 1 < cuts.length; index += 1) {
        const [start, end] = [cuts[index]!, cuts[index + 1]!];
        if (end > start)
          segments.push({
            text: source.slice(start, end),
            kind: piece.kind,
            mark: start >= drawStart && end <= drawEnd,
          });
      }
    }
    lines.push({ number, segments });
  }
  return lines;
}

/**
 * The lines of the function the draw is in, the innermost; outside functions, of the top-level statement it is in
 * when that spans several lines, otherwise of the whole file. `null` when the file does not parse.
 */
function enclosingRange(
  source: string,
  site: RandomSite,
  lineCount: number,
): {
  readonly kind: "function" | "block" | "file";
  readonly from: number;
  readonly to: number;
} | null {
  const parsed = parse(source);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return null;
  const line = site.line - 1;
  const column = site.column - 1;
  const contains = (span: SourceSpan) =>
    (span.start.line < line || (span.start.line === line && span.start.column <= column)) &&
    (span.end.line > line || (span.end.line === line && span.end.column > column));
  // The functions around the draw, outermost first.
  const functions: SourceSpan[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) return node.forEach(visit);
    // EVIDENCE: the parser's syntax tree holds plain nodes, arrays, and values, and a node's `span` is its SourceSpan.
    const record = node as { readonly kind?: unknown; readonly span?: SourceSpan };
    if (record.span !== undefined && !contains(record.span)) return;
    if (record.kind === "functionDeclaration" && record.span !== undefined)
      functions.push(record.span);
    for (const [key, value] of Object.entries(record)) if (key !== "span") visit(value);
  };
  visit(parsed.program.statements);
  const found = functions.at(-1);
  if (found !== undefined)
    return { kind: "function", from: found.start.line + 1, to: found.end.line + 1 };
  const statement = parsed.program.statements.find((candidate) => contains(candidate.span));
  if (statement !== undefined && statement.span.end.line > statement.span.start.line)
    return { kind: "block", from: statement.span.start.line + 1, to: statement.span.end.line + 1 };
  return { kind: "file", from: 1, to: lineCount };
}
