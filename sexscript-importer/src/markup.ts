/**
 * Legacy `show()` text rendered HTML, which TeaseScript `say` shows as written; its markup is TeaseScript message
 * markup (docs/specifications/message-markup.md). Bold, italic, underline, strikethrough, colour, font size, headings,
 * list items, and line breaks keep their meaning; layout-only tags such as TEXTFORMAT, FONT FACE, and ALIGN, and the
 * size of an editor's text format (fontSize), are dropped; entities are decoded, also without their semicolon.
 */
import type { IrExpression } from "./ir.ts";

export type TextPart = { text: string } | { value: IrExpression };

export interface MarkupResult {
  parts: TextPart[];
  /** Whether the text held HTML. */
  changed: boolean;
  /** Whether layout tags that markup cannot express were dropped. */
  dropped: boolean;
}

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
};

// Private-use characters mark values and span delimiters while the text is rewritten.
const VALUE = "\u{F0000}";
const OPEN = "\u{F0001}";
const CLOSE = "\u{F0002}";

const SPANS: Readonly<Record<string, string>> = {
  b: "**",
  strong: "**",
  i: "*",
  em: "*",
  strike: "~~",
  s: "~~",
  del: "~~",
  u: "[u]",
};

const HTML_TAG = /<\/?([a-z][a-z0-9]*)\b[^<>]*>/giu;
// The block markers of message markup, which only count at the start of a line.
const BLOCK_MARKER = /^(?:#{1,3} |> |- |[1-9]\d*\. )/u;
const ENTITY = /&(?:#(\d{1,6});?|#x([0-9a-f]{1,6});?|(nbsp|quot|amp|lt|gt|apos);?)/giu;

/**
 * The message markup size of a FONT tag's legacy SIZE: 1 and 2 small, 3 normal, 4 large, and 5 or more x-large (legacy
 * showed a larger size as 7). Null for a size that is no whole number, such as `34px`, which legacy ignored, or a
 * value set at runtime, and for the size of a FONT that names a FACE: a rich-text editor's text format, which the Flash
 * editor's htmlText (Countdown Game, Milovana) writes around every paragraph with its default size, where hand-written
 * HTML names only what it changes.
 */
export function fontSize(tag: string): string | null {
  const match = /\bsize\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+)(?![^\s>]))/iu.exec(tag);
  const size = match?.[1] ?? match?.[2] ?? match?.[3];
  if (size === undefined || /\bface\s*=/iu.test(tag)) return null;
  const level = Number(size);
  return level <= 2 ? "small" : level === 3 ? "normal" : level === 4 ? "large" : "x-large";
}

/**
 * `fragment` is for text that may become part of a longer text, such as a title that the script puts before a
 * message: it keeps its own surrounding whitespace, and only drops whitespace that a tag at its start introduced.
 */
export function legacyHtmlToMarkup(
  parts: readonly TextPart[],
  options: { fragment?: boolean } = {},
): MarkupResult {
  const values = parts.flatMap((part) => ("value" in part ? [part.value] : []));
  const source = parts.map((part) => ("value" in part ? VALUE : part.text)).join("");
  HTML_TAG.lastIndex = 0;
  ENTITY.lastIndex = 0;
  if (!HTML_TAG.test(source) && !ENTITY.test(source))
    return { parts: [...parts], changed: false, dropped: false };
  let dropped = false;
  // The values inside dropped tags, such as a size computed at runtime, by their place among the values.
  const droppedValues = new Set<number>();
  // Each span keeps its markup and closes with the tag that opened it; a FONT without a colour or size opens nothing.
  // A size that the text around it already has adds nothing.
  const open: Array<{ tag: string; close: string; size: string | null }> = [];
  let text = source.replace(HTML_TAG, (tag, rawName: string, offset: number) => {
    if (tag.includes(VALUE)) {
      const before = source.slice(0, offset).split(VALUE).length - 1;
      for (let index = 0; index < tag.split(VALUE).length - 1; index += 1)
        droppedValues.add(before + index);
    }
    const name = rawName.toLowerCase();
    const closing = tag.startsWith("</");
    if (name === "br") return "\n";
    if (
      name === "p" ||
      name === "div" ||
      name === "tr" ||
      name === "ul" ||
      name === "ol" ||
      name === "table"
    )
      return closing ? "\n" : "";
    if (name === "li") return closing ? "" : "\n- ";
    if (/^h[1-6]$/u.test(name))
      return closing ? "\n" : `\n${"#".repeat(Math.min(Number(name[1]), 3))} `;
    const span = SPANS[name];
    if (span !== undefined) return `${closing ? CLOSE : OPEN}${span}`;
    if (name === "font" || name === "span") {
      if (closing) {
        const index = open.findLastIndex((item) => item.tag === name);
        return index < 0 ? "" : open.splice(index, 1)[0]!.close;
      }
      const colour = /\bcolou?r\s*[=:]\s*["']?(#[0-9a-f]{3,8}|[a-z]+)/iu.exec(tag)?.[1];
      const coloured = colour === undefined ? "" : `[color=${colour.toLowerCase()}]`;
      const size = name === "font" ? fontSize(tag) : null;
      const around = open.findLast((item) => item.size !== null)?.size ?? "normal";
      const sized = size !== null && size !== around ? `[size=${size}]` : "";
      if (/\b(face|style|align)\b/iu.test(tag) || (size === null && /\bsize\b/iu.test(tag)))
        dropped = true;
      open.push({
        tag: name,
        close:
          (sized === "" ? "" : `${CLOSE}${sized}`) + (coloured === "" ? "" : `${CLOSE}${coloured}`),
        size,
      });
      return (
        (coloured === "" ? "" : `${OPEN}${coloured}`) + (sized === "" ? "" : `${OPEN}${sized}`)
      );
    }
    dropped = true;
    return "";
  });
  text = text.replace(ENTITY, (_, decimal?: string, hex?: string, name?: string) =>
    decimal !== undefined
      ? String.fromCodePoint(Number(decimal))
      : hex !== undefined
        ? String.fromCodePoint(Number.parseInt(hex, 16))
        : ENTITIES[name!.toLowerCase()]!,
  );
  text = settleSpans(text)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n");
  text =
    options.fragment !== true
      ? text.replace(/^\s+|\s+$/gu, "")
      : /^\s/u.test(source)
        ? text
        : text.replace(/^\s+/u, "");
  // Values return in order where their markers stand.
  const kept = values.filter((_, index) => !droppedValues.has(index));
  const result: TextPart[] = [];
  let next = 0;
  for (const piece of text.split(VALUE)) {
    if (next > 0) result.push({ value: kept[next - 1]! });
    if (piece !== "") result.push({ text: piece });
    next += 1;
  }
  return { parts: result, changed: true, dropped };
}

/**
 * The closing delimiter of a span: the same delimiter for bold, italic, and strikethrough, `[/u]`, `[/color]`, or
 * `[/size]` for a tag.
 */
function closer(mark: string): string {
  return mark.startsWith("[") ? mark.replace(/^\[([a-z]+).*$/u, "[/$1]") : mark;
}

/**
 * Markup spans need text right inside their delimiters, end at a line break, and cannot cross, so spaces inside move
 * out, a span closes before each line break and opens again on the next line that has text, a span that closes while
 * one opened inside it is still open closes that one first and opens it again before the next text, and an empty span
 * disappears; a line without text, such as the blank line between paragraphs, gets no delimiters, and a span carried
 * over a line break opens again after the block marker that starts the next line, such as the `- ` of a list item. A
 * bold, italic, strikethrough, or underline span inside one of its own kind adds nothing, as in HTML, so only the outer
 * one has delimiters, also where a legacy text never closed it; a colour or size inside another changes it.
 */
function settleSpans(text: string): string {
  const pattern = new RegExp(
    `([${OPEN}${CLOSE}])(\\*\\*|\\*|~~|\\[u\\]|\\[(?:color|size)=[#0-9a-z-]+\\])`,
    "gu",
  );
  const tokens: Array<{ open: boolean; mark: string } | string> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    tokens.push(text.slice(last, match.index));
    tokens.push({ open: match[1] === OPEN, mark: match[2]! });
    last = match.index + match[0].length;
  }
  tokens.push(text.slice(last));
  let output = "";
  // The open spans, and those of them not written yet on the current line, which open before its next text.
  const stack: string[] = [];
  let pending: string[] = [];
  const written = (): string[] => stack.slice(0, stack.length - pending.length);
  // How many of the pending spans were open at the last line break.
  let carried = 0;
  // The output with the given spans closed, innermost first, before its trailing spaces.
  const closed = (spans: readonly string[]): string => {
    const trailing = /\s*$/u.exec(output)![0];
    return (
      output.slice(0, output.length - trailing.length) +
      [...spans].reverse().map(closer).join("") +
      trailing
    );
  };
  // How many more spans of a kind are open inside the one on the stack.
  const inner = new Map<string, number>();
  for (const token of tokens) {
    if (typeof token === "string") {
      const lines = token.split("\n");
      lines.forEach((line, index) => {
        if (index > 0) {
          // Close the spans this line opened at the line break and reopen them on the next line with text.
          output = closed(written()) + "\n";
          pending = [...stack];
          carried = pending.length;
        }
        const leading = /^\s*/u.exec(line)![0];
        output += leading;
        if (leading === line) return;
        const marker =
          carried > 0 && output.endsWith("\n") ? (BLOCK_MARKER.exec(line)?.[0] ?? "") : "";
        output += marker + pending.join("") + line.slice(leading.length + marker.length);
        pending = [];
        carried = 0;
      });
      continue;
    }
    if (token.open) {
      if (stack.includes(token.mark) && !token.mark.includes("="))
        inner.set(token.mark, (inner.get(token.mark) ?? 0) + 1);
      else {
        stack.push(token.mark);
        pending.push(token.mark);
      }
      continue;
    }
    const nested = inner.get(token.mark) ?? 0;
    if (nested > 0) {
      inner.set(token.mark, nested - 1);
      continue;
    }
    const index = stack.lastIndexOf(token.mark);
    if (index < 0) continue;
    const unwritten = pending.lastIndexOf(token.mark);
    if (unwritten >= 0) {
      // The span held no text.
      stack.splice(index, 1);
      pending.splice(unwritten, 1);
      if (unwritten < carried) carried -= 1;
      continue;
    }
    // The spans opened inside it close with it and open again before the next text.
    output = closed(written().slice(index));
    stack.splice(index, 1);
    pending = stack.slice(index);
  }
  return closed(written());
}
