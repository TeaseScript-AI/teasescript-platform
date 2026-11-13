// Scanning a message's markup source by UTF-16 unit: a line's units and its block kind, and the bracket, link and
// delimiter tokens the inline parser reads.

import { codePointWidth } from "./code-points.js";
import { canonicalWebUrl } from "./web-url.js";

export interface InputUnit {
  readonly character: string;
  readonly escaped: boolean;
}

export type LineClassification =
  | { readonly kind: "paragraph"; readonly contentStart: number }
  | { readonly kind: "heading"; readonly contentStart: number; readonly level: 1 | 2 | 3 }
  | { readonly kind: "quote"; readonly contentStart: number }
  | {
      readonly kind: "list";
      readonly contentStart: number;
      readonly ordered: boolean;
      readonly ordinal: string | null;
    };

export const ESCAPABLE_CHARACTERS = new Set([
  "\\",
  "*",
  "~",
  "`",
  "[",
  "]",
  "(",
  ")",
  "#",
  ">",
  "-",
  ".",
  ":",
]);
export const WEIGHTS = new Set(["thin", "light", "normal", "medium", "semibold", "bold", "black"]);
export const SIZES = new Set(["small", "normal", "large", "x-large"]);
const URL_BOUNDARY_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;
const URL_STOP_CHARACTER = /[\s\u0000-\u001f\u007f<>"'`*~\[\]]/u;
export const NON_WHITESPACE = /\S/u;

export function tokenizeLine(text: string): InputUnit[] {
  const units: InputUnit[] = [];
  for (let index = 0; index < text.length;) {
    const character = text.slice(index, index + codePointWidth(text, index));
    if (character === "\\" && index + 1 < text.length) {
      const next = text.slice(index + 1, index + 1 + codePointWidth(text, index + 1));
      if (ESCAPABLE_CHARACTERS.has(next)) {
        units.push({ character: next, escaped: true });
        index += 1 + next.length;
        continue;
      }
    }
    units.push({ character, escaped: false });
    index += character.length;
  }
  return units;
}

export function classifyLine(units: readonly InputUnit[]): LineClassification {
  let hashes = 0;
  while (hashes < units.length && unitIs(units[hashes], "#")) hashes += 1;
  const level = headingLevel(hashes);
  if (level !== null && unitIs(units[hashes], " ")) {
    return { kind: "heading", level, contentStart: hashes + 1 };
  }
  if (unitIs(units[0], ">") && unitIs(units[1], " ")) {
    return { kind: "quote", contentStart: 2 };
  }
  if (unitIs(units[0], "-") && unitIs(units[1], " ")) {
    return { kind: "list", ordered: false, ordinal: null, contentStart: 2 };
  }
  if (unitIsAsciiNonzeroDigit(units[0])) {
    let index = 1;
    while (unitIsAsciiDigit(units[index])) index += 1;
    if (unitIs(units[index], ".") && unitIs(units[index + 1], " ")) {
      return {
        kind: "list",
        ordered: true,
        ordinal: unitsText(units, 0, index),
        contentStart: index + 2,
      };
    }
  }
  return { kind: "paragraph", contentStart: 0 };
}

/** A colour tag, `[color=...]` or `[bg=...]`, with its name and its colour. */
export const COLOR_TAG = /^\[(color|bg)=([^\]]*)\]$/u;

export function shortBracketToken(
  units: readonly InputUnit[],
  index: number,
  end: number,
): string | null {
  if (!unitIs(units[index], "[")) return null;
  const maximumEnd = end;
  const characters: string[] = [];
  for (let cursor = index; cursor < maximumEnd; cursor += 1) {
    const unit = units[cursor]!;
    if (unit.escaped || (cursor > index && unit.character === "[")) return null;
    characters.push(unit.character);
    if (unit.character === "]") return characters.join("");
  }
  return null;
}

export function bareLinkAt(
  units: readonly InputUnit[],
  index: number,
  candidateEnd: number,
): { readonly target: string; readonly text: string; readonly end: number } | null {
  if (
    (index > 0 && URL_BOUNDARY_CHARACTER.test(units[index - 1]!.character)) ||
    (!unitsMatchCaseInsensitive(units, index, "http://") &&
      !unitsMatchCaseInsensitive(units, index, "https://"))
  ) {
    return null;
  }

  const schemeEnd = index + (unitsMatchCaseInsensitive(units, index, "https://") ? 8 : 7);
  let authorityEnd = schemeEnd;
  while (authorityEnd < candidateEnd && !/[/?#]/u.test(units[authorityEnd]!.character)) {
    authorityEnd += 1;
  }
  if (
    authorityEnd < candidateEnd &&
    canonicalWebUrl(unitsText(units, index, authorityEnd)) === null
  )
    return null;

  let targetEnd = candidateEnd;
  let parenthesisBalance = delimiterBalance(units, index, targetEnd, "(", ")");
  let braceBalance = delimiterBalance(units, index, targetEnd, "{", "}");
  while (targetEnd > index) {
    const terminal = units[targetEnd - 1]!.character;
    if (/[.,;:!?]/u.test(terminal)) targetEnd -= 1;
    else if (terminal === ")" && parenthesisBalance < 0) {
      parenthesisBalance += 1;
      targetEnd -= 1;
    } else if (terminal === "}" && braceBalance < 0) {
      braceBalance += 1;
      targetEnd -= 1;
    } else break;
  }
  if (targetEnd === index) return null;

  const text = unitsText(units, index, targetEnd);
  const target = canonicalWebUrl(text);
  return target === null ? null : { target, text, end: targetEnd };
}

export function nextBareLinkEnds(
  units: readonly InputUnit[],
  start: number,
  end: number,
): readonly number[] {
  const ends = new Array<number>(end - start + 1).fill(end);
  let nextEnd = end;
  for (let index = end - 1; index >= start; index -= 1) {
    const unit = units[index]!;
    if (unit.escaped || unit.character === "\\" || URL_STOP_CHARACTER.test(unit.character)) {
      nextEnd = index;
    }
    ends[index - start] = nextEnd;
  }
  return ends;
}

function delimiterBalance(
  units: readonly InputUnit[],
  start: number,
  end: number,
  opener: string,
  closer: string,
): number {
  let balance = 0;
  for (let index = start; index < end; index += 1) {
    if (units[index]!.character === opener) balance += 1;
    else if (units[index]!.character === closer) balance -= 1;
  }
  return balance;
}

export function validLinkTarget(units: readonly InputUnit[]): string | null {
  if (
    units.length === 0 ||
    units.some(
      (unit) =>
        unit.escaped ||
        unit.character === "(" ||
        unit.character === ")" ||
        unit.character === "\\" ||
        /[\s\u0000-\u001f\u007f]/u.test(unit.character),
    )
  )
    return null;
  return canonicalWebUrl(unitsText(units, 0, units.length));
}

export function nextUnescapedIndexes(
  units: readonly InputUnit[],
  character: string,
  start: number,
  end: number,
): readonly number[] {
  const indexes = new Array<number>(end - start + 1).fill(-1);
  let next = -1;
  for (let index = end - 1; index >= start; index -= 1) {
    if (unitIs(units[index], character)) next = index;
    indexes[index - start] = next;
  }
  return indexes;
}

export function matchClosingParentheses(
  units: readonly InputUnit[],
  start: number,
  end: number,
): readonly number[] {
  const closers = new Array<number>(end - start + 1).fill(-1);
  const openers: number[] = [];
  for (let index = start; index < end; index += 1) {
    if (unitIs(units[index], "(")) {
      openers.push(index);
    } else if (unitIs(units[index], ")")) {
      const opener = openers.pop();
      if (opener !== undefined) closers[opener - start] = index;
    }
  }
  return closers;
}

export function unitsText(units: readonly InputUnit[], start: number, end: number): string {
  const characters: string[] = [];
  for (let index = start; index < end; index += 1) characters.push(units[index]!.character);
  return characters.join("");
}

function unitsMatchCaseInsensitive(
  units: readonly InputUnit[],
  start: number,
  expected: string,
): boolean {
  const characters = [...expected];
  if (start + characters.length > units.length) return false;
  return characters.every((character, offset) => {
    const unit = units[start + offset]!;
    return !unit.escaped && unit.character.toLowerCase() === character;
  });
}

export function unitIs(unit: InputUnit | undefined, character: string): boolean {
  return unit !== undefined && !unit.escaped && unit.character === character;
}

function unitIsAsciiDigit(unit: InputUnit | undefined): boolean {
  return unit !== undefined && !unit.escaped && /^[0-9]$/u.test(unit.character);
}

function unitIsAsciiNonzeroDigit(unit: InputUnit | undefined): boolean {
  return unit !== undefined && !unit.escaped && /^[1-9]$/u.test(unit.character);
}

export function isWhitespace(character: string): boolean {
  return /^\s$/u.test(character);
}

function headingLevel(value: number): 1 | 2 | 3 | null {
  if (value === 1 || value === 2 || value === 3) return value;
  return null;
}
