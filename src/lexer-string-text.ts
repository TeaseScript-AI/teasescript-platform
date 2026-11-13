// A string literal's text as the lexer reads it: escapes decoded, and a block string's indentation and newlines
// normalized.

import { codePointWidth } from "./code-points.js";
import { type Token } from "./token.js";

export interface StringScanTextPart {
  readonly kind: "text";
  readonly tokenIndex: number;
}

export type StringScanPart = StringScanTextPart | { readonly kind: "interpolation" };

interface BlockTextPart extends StringScanTextPart {
  readonly token: Token;
}

export function normalizeBlockStringText(
  parts: readonly (BlockTextPart | { readonly kind: "interpolation" })[],
): readonly string[] {
  const textParts = parts.filter((part): part is BlockTextPart => part.kind === "text");
  const removed = textParts.map(() => new Set<number>());
  const textIndex = new Map(textParts.map((part, index) => [part, index]));
  const first = parts[0];
  if (first?.kind === "text") {
    const length = physicalNewlineLength(first.token.lexeme, 0);
    if (length > 0) markRemoved(removed[textIndex.get(first)!]!, 0, length);
  }
  const last = parts.at(-1);
  if (last?.kind === "text") {
    const match = /(?:\r\n|\n)[ \t]*$/u.exec(last.token.lexeme);
    if (match?.index !== undefined) {
      markRemoved(
        removed[textIndex.get(last)!]!,
        match.index,
        last.token.lexeme.length - match.index,
      );
    }
  }

  type IndentUnit = { readonly text: number; readonly offset: number; readonly character: string };
  type ContentLine = { readonly indent: readonly IndentUnit[]; readonly nonblank: boolean };
  const lines: ContentLine[] = [];
  let indent: IndentUnit[] = [];
  let nonblank = false;
  const finishLine = () => {
    lines.push({ indent, nonblank });
    indent = [];
    nonblank = false;
  };

  for (const part of parts) {
    if (part.kind === "interpolation") {
      nonblank = true;
      continue;
    }
    const index = textIndex.get(part)!;
    const raw = part.token.lexeme;
    for (let offset = 0; offset < raw.length;) {
      const newlineLength = physicalNewlineLength(raw, offset);
      if (newlineLength > 0) {
        const isRemoved = removed[index]!.has(offset);
        offset += newlineLength;
        if (!isRemoved) finishLine();
        continue;
      }
      if (removed[index]!.has(offset)) {
        offset += 1;
        continue;
      }
      const character = raw[offset]!;
      if (!nonblank && isHorizontalWhitespace(character)) {
        indent.push({ text: index, offset, character });
      } else {
        nonblank = true;
      }
      offset += 1;
    }
  }
  if (indent.length > 0 || nonblank) finishLine();

  const nonblankLines = lines.filter((line) => line.nonblank);
  let common = nonblankLines[0]?.indent.map((unit) => unit.character).join("") ?? "";
  for (let index = 1; index < nonblankLines.length && common.length > 0; index += 1) {
    const candidate = nonblankLines[index]!.indent.map((unit) => unit.character).join("");
    let shared = 0;
    while (shared < common.length && common[shared] === candidate[shared]) shared += 1;
    common = common.slice(0, shared);
  }
  for (const line of lines) {
    const count = line.nonblank ? common.length : line.indent.length;
    for (let index = 0; index < count; index += 1) {
      const unit = line.indent[index]!;
      removed[unit.text]!.add(unit.offset);
    }
  }

  return textParts.map((part, index) => decodeStringText(part.token.lexeme, removed[index]!));
}

function markRemoved(target: Set<number>, start: number, length: number): void {
  for (let offset = start; offset < start + length; offset += 1) target.add(offset);
}

function physicalNewlineLength(raw: string, offset: number): number {
  if (raw[offset] === "\n") return 1;
  return raw[offset] === "\r" && raw[offset + 1] === "\n" ? 2 : 0;
}

function decodeStringText(raw: string, removed: ReadonlySet<number>): string {
  let value = "";
  for (let offset = 0; offset < raw.length;) {
    const newlineLength = physicalNewlineLength(raw, offset);
    if (newlineLength > 0) {
      if (!removed.has(offset)) value += "\n";
      offset += newlineLength;
      continue;
    }
    if (removed.has(offset)) {
      offset += 1;
      continue;
    }
    if (raw[offset] !== "\\") {
      const width = codePointWidth(raw, offset);
      value += raw.slice(offset, offset + width);
      offset += width;
      continue;
    }
    offset += 1;
    if (raw[offset] === "$" && raw[offset + 1] === "{") {
      value += "${";
      offset += 2;
      continue;
    }
    const newlineAfterEscape = physicalNewlineLength(raw, offset);
    if (newlineAfterEscape > 0) continue;
    if (offset >= raw.length) continue;
    const escaped = raw.slice(offset, offset + codePointWidth(raw, offset));
    value += escapeValue(escaped) ?? escaped;
    offset += escaped.length;
  }
  return value;
}

export function escapeValue(escaped: string): string | undefined {
  switch (escaped) {
    case "\\":
      return "\\";
    case '"':
      return '"';
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return undefined;
  }
}

export function isHorizontalWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}
