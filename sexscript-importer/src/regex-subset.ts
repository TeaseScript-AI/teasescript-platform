/**
 * The regular expressions legacy scripts used that TeaseScript text operations can express without a regular
 * expression engine: literal text (with escaped metacharacters), alternatives of literal texts, and one character class,
 * plain or negated, optionally repeated with `+`. Anything else, such as groups, flags, anchors, or other quantifiers,
 * is null.
 */
export type RegexSubset =
  | { kind: "literal"; text: string }
  | { kind: "alternatives"; texts: string[] }
  /** Characters of `chars` (or, `negated`, all others); `runs` matches a run of them at once. */
  | { kind: "class"; chars: string; negated: boolean; runs: boolean };

const META = new Set([..."\\^$.|?*+()[]{}"]);
const DIGITS = "0123456789";
const WORD = `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ${DIGITS}_`;
const SPACE = " \t\n\r\f\u000B";
const SHORTHANDS: Readonly<Record<string, { chars: string; negated: boolean }>> = {
  d: { chars: DIGITS, negated: false },
  D: { chars: DIGITS, negated: true },
  w: { chars: WORD, negated: false },
  W: { chars: WORD, negated: true },
  s: { chars: SPACE, negated: false },
  S: { chars: SPACE, negated: true },
};

export function parseRegexSubset(pattern: string): RegexSubset | null {
  if (pattern === "") return null;
  const alternatives = splitAlternatives(pattern);
  if (alternatives === null) return null;
  if (alternatives.length > 1) {
    const texts = alternatives.map(literalText);
    return texts.every((text): text is string => text !== null && text !== "")
      ? { kind: "alternatives", texts }
      : null;
  }
  const literal = literalText(pattern);
  if (literal !== null) return { kind: "literal", text: literal };
  return characterClass(pattern);
}

/**
 * A pattern that a whole text matches by its end (Groovy `==~`): any text, then optionally a run of digits, then fixed
 * text, `.*\d+\.jpg` or `.*\.png`, also case-insensitive with `(?i)`. Null for any other pattern.
 */
export function parseTailPattern(
  pattern: string,
): { insensitive: boolean; digits: boolean; tail: string } | null {
  let rest = pattern;
  const insensitive = rest.startsWith("(?i)");
  if (insensitive) rest = rest.slice(4);
  if (!rest.startsWith(".*")) return null;
  rest = rest.slice(2);
  const digits = rest.startsWith("\\d+");
  if (digits) rest = rest.slice(3);
  const tail = literalText(rest);
  return tail === null || tail === "" ? null : { insensitive, digits, tail };
}

/** A Java replacement text as plain text: `\$` and `\\` are escapes, and an unescaped `$` names a group (null). */
export function javaReplacementText(replacement: string): string | null {
  let result = "";
  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index]!;
    if (character === "$") return null;
    if (character === "\\") {
      index += 1;
      if (index >= replacement.length) return null;
      result += replacement[index]!;
      continue;
    }
    result += character;
  }
  return result;
}

/** The top-level alternatives of a pattern, outside character classes; null for an unbalanced class. */
function splitAlternatives(pattern: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\" && index + 1 < pattern.length) {
      current += character + pattern[index + 1]!;
      index += 1;
      continue;
    }
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    if (character === "|" && !inClass) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (inClass) return null;
  parts.push(current);
  return parts;
}

/** The text a pattern of literal characters and escaped metacharacters matches; null for any other pattern. */
function literalText(pattern: string): string | null {
  let text = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const next = pattern[index + 1];
      if (next === undefined || !META.has(next)) return null;
      text += next;
      index += 1;
      continue;
    }
    if (META.has(character)) return null;
    text += character;
  }
  return text;
}

/** One character class, `[...]`, `[^...]`, or a shorthand such as `\d`, optionally followed by `+`. */
function characterClass(pattern: string): RegexSubset | null {
  const runs = pattern.endsWith("+") && !pattern.endsWith("\\+");
  const body = runs ? pattern.slice(0, -1) : pattern;
  const shorthand = /^\\([dDwWsS])$/u.exec(body)?.[1];
  if (shorthand !== undefined) return { kind: "class", ...SHORTHANDS[shorthand]!, runs };
  const match = /^\[(\^?)(.+)\]$/su.exec(body);
  if (match === null) return null;
  const negated = match[1] === "^";
  const inside = match[2]!;
  let chars = "";
  for (let index = 0; index < inside.length; index += 1) {
    let character = inside[index]!;
    if (character === "\\") {
      const next = inside[index + 1];
      if (next === undefined) return null;
      index += 1;
      const set = SHORTHANDS[next];
      if (set !== undefined) {
        if (set.negated) return null;
        chars += set.chars;
        continue;
      }
      if (/[a-zA-Z0-9]/u.test(next)) return null;
      character = next;
    } else if (character === "[" || (character === "^" && index === 0)) return null;
    // A range of ASCII characters, such as a-z.
    if (inside[index + 1] === "-" && index + 2 < inside.length && inside[index + 2] !== "\\") {
      const end = inside[index + 2]!;
      const from = character.charCodeAt(0);
      const to = end.charCodeAt(0);
      if (from > to || to > 127) return null;
      for (let code = from; code <= to; code += 1) chars += String.fromCharCode(code);
      index += 2;
      continue;
    }
    chars += character;
  }
  return chars === ""
    ? null
    : { kind: "class", chars: [...new Set(chars)].join(""), negated, runs };
}
