import { classifyTokens, parse, type ParseResult } from "../../src/index.js";
import { isNativeStackExhaustion } from "../../src/compiler.js";
import type { RandomSite } from "../../src/playback.js";
import type { SourceDebugFile, SourceDebugSpan } from "../../src/runtime/debug/source-sidecar.js";
import {
  CONTEXT_ROWS,
  type CodeLine,
  type CodeSegment,
  type CodeTokenClass,
  type DrawCode,
} from "./draw-code.js";

/*
 * The code Debug's random-draw picker shows (DEBUGGER.md "Random draws"), made in the engine's Worker: the draw's file
 * from the plan's source debug sidecar, and earlier outcomes classified as code. The Player's page loads neither the
 * parser nor the compiler for it. This module loads the authoring entry, so the Worker imports it only when Debug asks.
 */

/** A stretch of a file with its class: a token or comment, by offsets. */
interface ClassedRange {
  readonly kind: CodeTokenClass;
  readonly start: number;
  readonly end: number;
}

/** What every draw in a file shows alike: its lines, unmarked. The caller keeps it while the file's draws follow. */
export interface FileCode {
  readonly file: SourceDebugFile;
  readonly starts: readonly number[];
  readonly lines: readonly CodeLine[];
}

export function fileCode(file: SourceDebugFile): FileCode {
  const starts = lineStarts(file.source);
  return { file, starts, lines: renderLines(file.source, starts, file.tokens, 1, starts.length) };
}

/**
 * The code of the file a draw at `site` is in (`code`, from `fileCode`), highlighted with the compiler's own token classes: every line, with the
 * draw marked; `enclosing` is the range "Show whole" fits: the default lines around the draw together with the function
 * the draw is in, or for code outside functions, the smallest statement or block of several lines around it that the
 * default lines do not show whole, or the whole file when none of several lines is around it. `enclosing` is `null`
 * when the default lines already show it. `null` for a site outside the file.
 */
export function drawCode(code: FileCode, site: RandomSite): DrawCode | null {
  const { file, starts, lines: shown } = code;
  const { source } = file;
  if (site.line < 1 || site.line > starts.length) return null;
  const mark = {
    from: starts[site.line - 1]! + site.column - 1,
    to: (starts[site.endLine - 1] ?? source.length) + site.endColumn - 1,
  };
  // Only the lines from one end of the draw to the other change: their segments split at its ends.
  const lines = [...shown];
  const ends = [lineAt(starts, mark.from), lineAt(starts, mark.to)];
  for (let number = Math.min(...ends); number <= Math.max(...ends); number += 1)
    lines[number - 1] = markLine(lines[number - 1]!, starts[number - 1]!, mark);
  const half = (CONTEXT_ROWS - 1) / 2;
  const context = [Math.max(1, site.line - half), Math.min(starts.length, site.line + half)];
  const range = enclosingRange(file.enclosing, site, starts.length, context);
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
 * Earlier outcomes as code lines, numbered from `first`: each is classified on its own, so a list or text reads like
 * code.
 */
export function outcomeLines(outcomes: readonly string[], first = 1): readonly CodeLine[] {
  return outcomes.map((outcome, index) => {
    const text = outcome.replace(/\r?\n/g, " ");
    const tokens = classifyTokens(text, parseOutcome(text)).map(({ kind, span }) => ({
      kind,
      start: span.start.offset,
      end: span.end.offset,
    }));
    return { ...renderLines(text, [0], tokens, 1, 1)[0]!, number: first + index };
  });
}

/**
 * The parse an outcome is classified by: its own, not the editor's cached last parse, which would keep a session's
 * outcome past its connection's teardown. As the editor's, none when parsing exhausted the call stack.
 */
function parseOutcome(text: string): ParseResult {
  try {
    return parse(text);
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    return parse("");
  }
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

/** Lines `from` through `to`, one-based, split into segments by token and comment. */
function renderLines(
  source: string,
  starts: readonly number[],
  tokens: readonly ClassedRange[],
  from: number,
  to: number,
): CodeLine[] {
  // The first token that can reach line `from`; tokens are in source order.
  let next = tokens.findIndex((token) => token.end > starts[from - 1]!);
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
    // Between tokens is whitespace, or a character the lexer could not read.
    const gap = (end: number) => {
      if (end > cursor) piece(end, null);
    };
    for (let index = next; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.start >= lineEnd) break;
      const start = Math.max(token.start, lineStart);
      const end = Math.min(token.end, lineEnd);
      if (end <= start) continue;
      gap(start);
      piece(end, token.kind);
      if (token.end <= lineEnd) next = index + 1;
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

/**
 * The lines of the function the draw is in, the innermost; outside functions, of the smallest statement or block of
 * several lines around it that the `context` lines do not show whole, or of the whole file when none of several lines
 * is around it. `null` when the `context` lines show every one around it.
 */
function enclosingRange(
  spans: SourceDebugFile["enclosing"],
  site: RandomSite,
  lineCount: number,
  context: readonly number[],
): {
  readonly kind: "function" | "block" | "file";
  readonly from: number;
  readonly to: number;
} | null {
  const line = site.line - 1;
  const column = site.column - 1;
  const contains = (span: SourceDebugSpan) =>
    (span.startLine < line || (span.startLine === line && span.startColumn <= column)) &&
    (span.endLine > line || (span.endLine === line && span.endColumn > column));
  // The innermost function around the draw: the one that starts last.
  let found: SourceDebugSpan | undefined;
  for (const span of spans.functions)
    if (
      contains(span) &&
      (found === undefined ||
        span.startLine > found.startLine ||
        (span.startLine === found.startLine && span.startColumn > found.startColumn))
    )
      found = span;
  if (found !== undefined)
    return { kind: "function", from: found.startLine + 1, to: found.endLine + 1 };
  // Spans around the draw nest, so the one of the fewest lines is the innermost.
  let block: SourceDebugSpan | undefined;
  let severalLines = false;
  for (const span of spans.blocks) {
    if (!contains(span) || span.endLine === span.startLine) continue;
    severalLines = true;
    if (span.startLine + 1 >= context[0]! && span.endLine + 1 <= context[1]!) continue;
    if (block === undefined || span.endLine - span.startLine < block.endLine - block.startLine)
      block = span;
  }
  if (block !== undefined)
    return { kind: "block", from: block.startLine + 1, to: block.endLine + 1 };
  return severalLines ? null : { kind: "file", from: 1, to: lineCount };
}
