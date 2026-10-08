/**
 * Legacy `show()` text rendered HTML, which TeaseScript `say` shows as written; its markup is TeaseScript message
 * markup (docs/specifications/message-markup.md). Bold, italic, underline, strikethrough, colour, headings, list items,
 * and line breaks keep their meaning; layout-only tags such as TEXTFORMAT, FONT FACE and SIZE, and ALIGN are dropped;
 * entities are decoded, also without their semicolon.
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
};

const HTML_TAG = /<\/?([a-z][a-z0-9]*)\b[^<>]*>/giu;
const ENTITY = /&(?:#(\d{1,6});?|#x([0-9a-f]{1,6});?|(nbsp|quot|amp|lt|gt|apos);?)/giu;

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
  // Each span keeps its markup and closes with the tag that opened it; a FONT without a colour opens nothing.
  const open: Array<{ tag: string; close: string }> = [];
  let text = source.replace(HTML_TAG, (tag, rawName: string) => {
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
    if (name === "u") return closing ? "[/u]" : "[u]";
    if (name === "font" || name === "span") {
      if (closing) {
        const index = open.findLastIndex((item) => item.tag === name);
        return index < 0 ? "" : open.splice(index, 1)[0]!.close;
      }
      const colour = /\bcolou?r\s*[=:]\s*["']?(#[0-9a-f]{3,8}|[a-z]+)/iu.exec(tag)?.[1];
      if (/\b(face|size|style|align)\b/iu.test(tag)) dropped = true;
      open.push({ tag: name, close: colour === undefined ? "" : "[/color]" });
      return colour === undefined ? "" : `[color=${colour.toLowerCase()}]`;
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
  const result: TextPart[] = [];
  let next = 0;
  for (const piece of text.split(VALUE)) {
    if (next > 0) result.push({ value: values[next - 1]! });
    if (piece !== "") result.push({ text: piece });
    next += 1;
  }
  return { parts: result, changed: true, dropped };
}

/**
 * Markup spans need text right inside their delimiters and end at a line break, so spaces inside move out, a span
 * closes before each line break and opens again on the next line that has text, and an empty span disappears; a line
 * without text, such as the blank line between paragraphs, gets no delimiters. A span inside one of its own kind adds
 * nothing, as in HTML, so only the outer one has delimiters, also where a legacy text never closed it.
 */
function settleSpans(text: string): string {
  const pattern = new RegExp(`([${OPEN}${CLOSE}])(\\*\\*|\\*|~~)`, "gu");
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
  // How many more spans of a kind are open inside the one on the stack.
  const inner = new Map<string, number>();
  for (const token of tokens) {
    if (typeof token === "string") {
      const lines = token.split("\n");
      lines.forEach((line, index) => {
        if (index > 0) {
          // Close the spans this line opened at the line break and reopen them on the next line with text.
          output += [...written()].reverse().join("") + "\n";
          pending = [...stack];
        }
        if (line === "") return;
        const leading = /^\s*/u.exec(line)![0];
        output += leading + pending.join("") + line.slice(leading.length);
        pending = [];
      });
      continue;
    }
    if (token.open) {
      if (stack.includes(token.mark)) inner.set(token.mark, (inner.get(token.mark) ?? 0) + 1);
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
    stack.splice(index, 1);
    const unwritten = pending.lastIndexOf(token.mark);
    if (unwritten >= 0) {
      // The span held no text.
      pending.splice(unwritten, 1);
      continue;
    }
    const trailing = /\s*$/u.exec(output)![0];
    output = output.slice(0, output.length - trailing.length) + token.mark + trailing;
  }
  return output + [...written()].reverse().join("");
}
