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
  const file = fileCode(source);
  const { starts } = file;
  if (site.line < 1 || site.line > starts.length) return null;
  const mark = {
    from: starts[site.line - 1]! + site.column - 1,
    to: (starts[site.endLine - 1] ?? source.length) + site.endColumn - 1,
  };
  // Only the lines from one end of the draw to the other change: their segments split at its ends.
  const lines = [...file.lines];
  const ends = [lineAt(starts, mark.from), lineAt(starts, mark.to)];
  for (let number = Math.min(...ends); number <= Math.max(...ends); number += 1)
    lines[number - 1] = markLine(lines[number - 1]!, starts[number - 1]!, mark);
  const half = (CONTEXT_ROWS - 1) / 2;
  const context = [Math.max(1, site.line - half), Math.min(starts.length, site.line + half)];
  const range = enclosingRange(file.spans, site, starts.length);
  return {
    lines,
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
    return { ...renderLines(text, [0], tokens, 1, 1)[0]!, number: first + index };
  });
}

/** The offset where each line starts. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1))
    starts.push(index + 1);
  return starts;
}

/** The one-based line `offset` is on: the last line starting at or before it. */
function lineAt(starts: readonly number[], offset: number): number {
  let [low, high] = [1, starts.length];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle - 1]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** What every draw in a file shows alike: its lines, unmarked, and the spans "Show whole" fits. */
interface FileCode {
  readonly source: string;
  readonly starts: readonly number[];
  readonly lines: readonly CodeLine[];
  readonly spans: EnclosingSpans | null;
}

// The file of the latest draw: lexing and parsing a long file is slow, and a file's draws often follow each other, as
// in a loop.
let latestFile: FileCode | null = null;

function fileCode(source: string): FileCode {
  if (latestFile?.source !== source) {
    const starts = lineStarts(source);
    const lexed = lex(source);
    const tokens = lexed.diagnostics.length === 0 ? lexed.tokens : [];
    latestFile = {
      source,
      starts,
      lines: renderLines(source, starts, tokens, 1, starts.length),
      spans: enclosingSpans(source),
    };
  }
  return latestFile;
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

/** Lines `from` through `to`, one-based, split into segments by token and comment. */
function renderLines(
  source: string,
  starts: readonly number[],
  tokens: readonly Token[],
  from: number,
  to: number,
): CodeLine[] {
  // The first token that can reach line `from`; tokens are in source order.
  let next = tokens.findIndex((token) => token.span.end.offset > starts[from - 1]!);
  if (next < 0) next = tokens.length;
  const lines: CodeLine[] = [];
  for (let number = from; number <= to; number += 1) {
    const lineStart = starts[number - 1]!;
    let lineEnd = number < starts.length ? starts[number]! - 1 : source.length;
    if (source[lineEnd - 1] === "\r") lineEnd -= 1;
    const segments: CodeSegment[] = [];
    let cursor = lineStart;
    const piece = (end: number, kind: CodeTokenClass | null) => {
      segments.push({ text: source.slice(cursor, end), kind, mark: false });
      cursor = end;
    };
    const gap = (end: number) => {
      if (end <= cursor) return;
      // The lexer skips only whitespace and comments.
      piece(end, source.slice(cursor, end).trim() === "" || tokens.length === 0 ? null : "comment");
    };
    for (let index = next; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.span.start.offset >= lineEnd) break;
      if (token.kind === "newline" || token.kind === "endOfFile") continue;
      const start = Math.max(token.span.start.offset, lineStart);
      const end = Math.min(token.span.end.offset, lineEnd);
      if (end <= start) continue;
      gap(start);
      piece(end, tokenClass(token.kind));
      if (token.span.end.offset <= lineEnd) next = index + 1;
    }
    gap(lineEnd);
    lines.push({ number, segments });
  }
  return lines;
}

/**
 * `line`, which starts at offset `lineStart`, with its segments split at the draw's ends, so the draw is marked over its
 * tokens' own colours.
 */
function markLine(
  line: CodeLine,
  lineStart: number,
  mark: { readonly from: number; readonly to: number },
): CodeLine {
  const segments: CodeSegment[] = [];
  let from = lineStart;
  for (const segment of line.segments) {
    const to = from + segment.text.length;
    const cuts = [from, mark.from, mark.to, to]
      .filter((cut) => cut >= from && cut <= to)
      .sort((left, right) => left - right);
    for (let index = 0; index + 1 < cuts.length; index += 1) {
      const [start, end] = [cuts[index]!, cuts[index + 1]!];
      if (end > start)
        segments.push({
          text: segment.text.slice(start - from, end - from),
          kind: segment.kind,
          mark: start >= mark.from && end <= mark.to,
        });
    }
    from = to;
  }
  return { number: line.number, segments };
}

/** Every function's span and every top-level statement's, in the parser's zero-based lines and columns. */
interface EnclosingSpans {
  readonly functions: readonly SourceSpan[];
  readonly statements: readonly SourceSpan[];
}

/** The spans `enclosingRange` chooses from, or `null` when the file does not parse. */
function enclosingSpans(source: string): EnclosingSpans | null {
  const parsed = parse(source);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return null;
  // The tree is walked with a list rather than by recursion, as valid source may nest deeper than the call stack
  // reaches.
  const functions: SourceSpan[] = [];
  const pending: unknown[] = [parsed.program.statements];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    // EVIDENCE: the parser's syntax tree holds plain nodes, arrays, and values, and a node's `span` is its SourceSpan.
    const record = node as {
      readonly [key: string]: unknown;
      readonly kind?: unknown;
      readonly span?: SourceSpan;
    };
    if (record.kind === "functionDeclaration" && record.span !== undefined)
      functions.push(record.span);
    for (const key in record) if (key !== "span") pending.push(record[key]);
  }
  return { functions, statements: parsed.program.statements.map((statement) => statement.span) };
}

/**
 * The lines of the function the draw is in, the innermost; outside functions, of the top-level statement it is in
 * when that spans several lines, otherwise of the whole file. `null` when the file does not parse.
 */
function enclosingRange(
  spans: EnclosingSpans | null,
  site: RandomSite,
  lineCount: number,
): {
  readonly kind: "function" | "block" | "file";
  readonly from: number;
  readonly to: number;
} | null {
  if (spans === null) return null;
  const line = site.line - 1;
  const column = site.column - 1;
  const contains = (span: SourceSpan) =>
    (span.start.line < line || (span.start.line === line && span.start.column <= column)) &&
    (span.end.line > line || (span.end.line === line && span.end.column > column));
  // The innermost function around the draw: the one that starts last.
  let found: SourceSpan | undefined;
  for (const span of spans.functions)
    if (
      contains(span) &&
      (found === undefined ||
        span.start.line > found.start.line ||
        (span.start.line === found.start.line && span.start.column > found.start.column))
    )
      found = span;
  if (found !== undefined)
    return { kind: "function", from: found.start.line + 1, to: found.end.line + 1 };
  const statement = spans.statements.find(contains);
  if (statement !== undefined && statement.end.line > statement.start.line)
    return { kind: "block", from: statement.start.line + 1, to: statement.end.line + 1 };
  return { kind: "file", from: 1, to: lineCount };
}
