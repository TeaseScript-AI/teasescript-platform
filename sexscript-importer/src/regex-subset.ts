const META = new Set([..."\\^$.|?*+()[]{}"]);
/** ASCII punctuation, which Java escapes as itself. */
const PUNCTUATION = /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/u;

/**
 * The text a legacy regular expression of literal characters and escaped metacharacters matches, which text
 * operations search without a regex; null for an empty or any other pattern (java-regex.ts converts those).
 */
export function literalPattern(pattern: string): string | null {
  return pattern === "" ? null : literalText(pattern);
}

/**
 * A pattern that a whole text matches by its end (Groovy `==~`): any text, then fixed text, `.*\.png`, also
 * case-insensitive with `(?i)`. Null for any other pattern.
 */
export function parseTailPattern(pattern: string): { insensitive: boolean; tail: string } | null {
  let rest = pattern;
  const insensitive = rest.startsWith("(?i)");
  if (insensitive) rest = rest.slice(4);
  if (!rest.startsWith(".*")) return null;
  // A test of the end also passes a line terminator, which Java's `.*` did not: an approximation kept, as before regexes
  // converted, for a tail of plain characters and escaped metacharacters, such as a file extension `\.png`; any other
  // tail converts as a regex.
  const tail = literalText(rest.slice(2), false);
  return tail === null || tail === "" ? null : { insensitive, tail };
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

/**
 * The text a pattern of literal characters and escaped punctuation, such as `\\|` or `\\#`, or with `punctuation`
 * false escaped metacharacters only, matches; null for any other pattern.
 */
function literalText(pattern: string, punctuation = true): string | null {
  let text = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const next = pattern[index + 1];
      if (next === undefined || !(punctuation ? PUNCTUATION.test(next) : META.has(next)))
        return null;
      text += next;
      index += 1;
      continue;
    }
    if (META.has(character)) return null;
    text += character;
  }
  return text;
}
