/**
 * Legacy Java regular expressions (java.util.regex, which Groovy's `=~`, `==~`, and String.matches() used) as
 * TeaseScript regex literals (V30 §8 "Regexes", RE2), where both mean the same: a pattern as RE2 writes it between the
 * slashes and its flags, or the reason it does not convert.
 *
 * Only the plain part of Java's syntax that legacy scripts used converts: characters and escaped punctuation, `.`, the
 * classes `\d \D \w \W \s \S`, and `\t \n \r \f`; character classes of characters, escaped punctuation, `\d \w \s`, and
 * ranges of two characters; groups `(...)` and `(?:...)`; alternatives; the quantifiers `*`, `+`, and `?`, also lazy,
 * and after a single character or class `{n}`, `{n,}`, and `{n,m}` up to RE2's limit of 1000; `^` at the start, `$` at
 * the end, and the modes `(?i)` and `(?s)` at the start. Anything else, such as a backreference, lookaround, a word
 * boundary, a property, or another escape, gives its reason.
 *
 * Java's `.` matches no line terminator (\n, \r, U+0085, U+2028, U+2029), RE2's every character but \n: it becomes a
 * class without them, or stays with `(?s)`. Java's `\s` holds the vertical tab, RE2's does not: it becomes the class.
 * Java's `$` also matches before a line terminator at the end, which RE2's does not: for a test of a match anywhere it
 * becomes an optional terminator before the end, after a part that cannot end between a final \r and \n, where Java's
 * `$` does not match. Java ignores the case of ASCII letters only, and RE2 also matches
 * the Kelvin sign with k and the long s with s, so `(?i)` converts only without the letters k and s, characters other
 * than ASCII, `\w`, and ranges.
 */
export type JavaRegex = { pattern: string; flags: string } | { reason: string };

/** Java's line terminators, which its `.` and `$` treat apart. */
const LINE_TERMINATORS = String.raw`\n\r\x{85}\x{2028}\x{2029}`;
/** Java's `\s`. */
const SPACES = String.raw`\t\n\x0B\f\r `;
/** RE2's repetition limit. */
const MAX_REPEAT = 1000;
/**
 * Bounds well inside TeaseScript's regex limits (docs/RESOURCE-LIMITS.md: 10,000 pattern characters and program
 * instructions, 100 capturing groups): the length of the pattern and of its conversion, its groups, and the copies its
 * counted repetitions make together.
 */
const MAX_LENGTH = 1000;
const MAX_GROUPS = 100;
const MAX_COPIES = 1000;
const FOLDS_APART = "a letter that RE2 matches with other characters when it ignores case";
/** ASCII punctuation, which Java escapes as itself. */
const PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/u;

/**
 * How a pattern may end: after a single character or class that may match \r or \n, repeated at least `min` times and
 * maybe without a limit, after a group, or at a start (of the pattern, a group, or an alternative).
 */
type Ending = { cr: boolean; lf: boolean; min: number; unbounded: boolean } | "group" | "start";

function single(cr: boolean, lf: boolean): Ending {
  return { cr, lf, min: 1, unbounded: false };
}

function repeated(ending: Ending, min: number, unbounded: boolean): Ending {
  return typeof ending === "object" ? { ...ending, min: ending.min * min, unbounded } : ending;
}

/**
 * `within` says how the regex is used: `whole` for a match of the whole text (==~, matches()), `find` for a test of a
 * match anywhere (=~ as a condition), where a match may take one more character, but no match's text is used.
 */
export function javaRegex(source: string, within: "whole" | "find"): JavaRegex {
  if (source.length > MAX_LENGTH)
    return { reason: `a pattern longer than ${MAX_LENGTH} characters` };
  // Modes at the start, `(?s)`, `(?i)`, or both, are the regex's flags.
  const modes = /^\(\?([is]+)\)/u.exec(source)?.[1] ?? "";
  const characters = [...source.slice(modes === "" ? 0 : modes.length + 3)];
  const dotAll = modes.includes("s");
  const insensitive = modes.includes("i");
  const fail = (reason: string): JavaRegex => ({ reason });
  const foldsApart = (character: string): boolean =>
    insensitive && (/[ksKS]/u.test(character) || character.codePointAt(0)! > 0x7f);
  // A character as RE2 literal text: a metacharacter, the slash, and in a class `-` escaped, a control character or
  // line break by its code, and null for a lone surrogate, which a TeaseScript pattern cannot hold.
  const literal = (character: string, inClass = false): string | null => {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    if ("\\.+*?()|[]{}^$/".includes(character) || (inClass && character === "-"))
      return `\\${character}`;
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029)
      return `\\x{${code.toString(16)}}`;
    return character;
  };
  const out: string[] = [];
  let index = 0;
  let depth = 0;
  let groups = 0;
  let copies = 0;
  // What the last token lets a quantifier repeat: a single character or class, a group, or nothing.
  let last: "atom" | "group" | null = null;
  // How the pattern so far may end (Ending).
  let ending: Ending = "start";
  // An escape after `\` outside a class, or why it does not convert.
  const escape = (character: string | undefined): string | { reason: string } => {
    if (character === undefined) return { reason: "a trailing backslash" };
    if (/[1-9k]/u.test(character)) return { reason: "a backreference" };
    if (character === "b" || character === "B") return { reason: "a word boundary" };
    if ((character === "w" || character === "W") && insensitive) return { reason: FOLDS_APART };
    if ("dDwWtnrf".includes(character)) return `\\${character}`;
    if (character === "s") return `[${SPACES}]`;
    if (character === "S") return `[^${SPACES}]`;
    // Escaped punctuation is the character itself.
    if (PUNCTUATION.test(character)) return literal(character)!;
    return { reason: `the escape \\${character}` };
  };
  // A quantifier's lazy form, or why a possessive one does not convert.
  const quantifier = (text: string): string | { reason: string } => {
    if (characters[index] === "+") return { reason: "a possessive quantifier" };
    if (characters[index] !== "?") return text;
    index += 1;
    return `${text}?`;
  };
  while (index < characters.length) {
    const character = characters[index++]!;
    if (character === "\\") {
      const escaped = characters[index++];
      const text = escape(escaped);
      if (typeof text !== "string") return text;
      out.push(text);
      last = "atom";
      ending = single("rDWs".includes(escaped!), "nDWs".includes(escaped!));
    } else if (character === ".") {
      out.push(dotAll ? "." : `[^${LINE_TERMINATORS}]`);
      last = "atom";
      ending = single(dotAll, dotAll);
    } else if (character === "^") {
      if (index !== 1) return fail("^ after the start of the pattern");
      out.push("^");
      last = null;
    } else if (character === "$") {
      if (index !== characters.length) return fail("$ before the end of the pattern");
      // Java's `$` also matched before a line terminator at the end, which a test may take into the match: the same
      // where no match ends between a final \r and \n, where Java's `$` did not match, so after a part whose last
      // character is no \r, or that can take the \n as well.
      if (within === "find") {
        const safe =
          ending === "start" ||
          (typeof ending === "object" &&
            ((ending.unbounded && ending.lf) || (!ending.cr && ending.min >= 1)));
        if (!safe) return fail("$ after a part that may end with a carriage return");
      }
      out.push(within === "whole" ? "$" : `(?:\\r\\n|[${LINE_TERMINATORS}])?$`);
      last = null;
    } else if (character === "(") {
      let open = "(";
      if (characters[index] === "?") {
        if (characters[index + 1] !== ":")
          return fail("a lookaround, a named or atomic group, or a mode inside the pattern");
        index += 2;
        open = "(?:";
      }
      if (open === "(" && ++groups > MAX_GROUPS) return fail(`more than ${MAX_GROUPS} groups`);
      out.push(open);
      depth += 1;
      last = null;
      ending = "start";
    } else if (character === ")") {
      if (depth === 0) return fail("an unbalanced parenthesis");
      out.push(")");
      depth -= 1;
      last = "group";
      ending = "group";
    } else if (character === "|") {
      out.push("|");
      last = null;
      ending = "start";
    } else if (character === "*" || character === "+" || character === "?") {
      if (last === null) return fail("a quantifier without anything to repeat");
      const quantified = quantifier(character);
      if (typeof quantified !== "string") return quantified;
      out.push(quantified);
      ending = repeated(ending, character === "+" ? 1 : 0, character !== "?");
      last = null;
    } else if (character === "{") {
      const end = characters.indexOf("}", index);
      const bounds = /^(\d+)(?:(,)(\d*))?$/u.exec(
        end < 0 ? "" : characters.slice(index, end).join(""),
      );
      if (bounds === null) return fail("a brace that is no repetition");
      // A count of a group repeats the counts inside it, which RE2 limits together.
      if (last !== "atom") return fail("a counted repetition of a group or of nothing");
      const low = Number(bounds[1]);
      const high = bounds[3] === undefined || bounds[3] === "" ? null : Number(bounds[3]);
      if (low > MAX_REPEAT || (high !== null && (high > MAX_REPEAT || high < low)))
        return fail(`a repetition over ${MAX_REPEAT} or with its bounds reversed`);
      copies += Math.max(low, high ?? 0);
      if (copies > MAX_COPIES) return fail(`counted repetitions of more than ${MAX_COPIES} copies`);
      index = end + 1;
      // Written without leading zeros, which RE2 does not read as a count.
      const quantified = quantifier(
        bounds[2] === undefined ? `{${low}}` : `{${low},${high ?? ""}}`,
      );
      if (typeof quantified !== "string") return quantified;
      out.push(quantified);
      ending = repeated(ending, low, bounds[2] !== undefined && high === null);
      last = null;
    } else if (character === "[") {
      const set = characterClass();
      if ("reason" in set) return set;
      out.push(set.text);
      last = "atom";
      ending = single(set.cr, set.lf);
    } else {
      if (foldsApart(character)) return fail(FOLDS_APART);
      const text = literal(character);
      if (text === null) return fail("a lone surrogate");
      out.push(text);
      last = "atom";
      ending = single(character === "\r", character === "\n");
    }
  }
  if (depth !== 0) return fail("an unbalanced parenthesis");
  // RE2 has no empty literal.
  const pattern = out.length === 0 ? "(?:)" : out.join("");
  // Also the length the expansions of `.`, `\s`, and `$` give.
  if (pattern.length > MAX_LENGTH)
    return fail(`a regex longer than ${MAX_LENGTH} characters once converted`);
  return { pattern, flags: `${insensitive ? "i" : ""}${dotAll ? "s" : ""}` };

  // A character class after its `[`: single characters, escaped punctuation, `\d \w \s`, and ranges of two single
  // characters; its `-` elsewhere only first or last.
  function characterClass(): { text: string; cr: boolean; lf: boolean } | { reason: string } {
    let set = "[";
    const negated = characters[index] === "^";
    if (negated) {
      set += "^";
      index += 1;
    }
    // The code points of its members, which tell whether it matches \r or \n.
    const codes: Array<[number, number]> = [];
    const code = (character: string): number => character.codePointAt(0)!;
    const matches = (point: number): boolean =>
      negated !== codes.some(([low, high]) => low <= point && point <= high);
    if (characters[index] === "]") return { reason: "a class that starts with ]" };
    let first = true;
    // The last member, when it was a single character that may start a range.
    let single: string | null = null;
    while (index < characters.length) {
      const member = characters[index++]!;
      if (member === "]") return { text: `${set}]`, cr: matches(13), lf: matches(10) };
      const leading = first;
      first = false;
      if (member === "[") return { reason: "a nested class" };
      if (member === "&" && characters[index] === "&") return { reason: "a class intersection" };
      if (member === "-" && single !== null && characters[index] !== "]") {
        const end = characters[index++];
        if (end === undefined) return { reason: "an unclosed class" };
        if (insensitive) return { reason: FOLDS_APART };
        if (end === "\\" || end === "[" || end.codePointAt(0)! < single.codePointAt(0)!)
          return { reason: "a range that is not of two characters in order" };
        const text = literal(end, true);
        if (text === null) return { reason: "a lone surrogate" };
        set += `-${text}`;
        codes.push([code(single), code(end)]);
        single = null;
        continue;
      }
      if (member === "-" && !leading && single === null && characters[index] !== "]")
        return { reason: "a - between a class and another member" };
      if (member === "\\") {
        const escaped = characters[index++];
        if (escaped === undefined) return { reason: "a trailing backslash" };
        if (
          (escaped === "w" && insensitive) ||
          escaped === "W" ||
          escaped === "D" ||
          escaped === "S"
        )
          return { reason: escaped === "w" ? FOLDS_APART : `\\${escaped} in a class` };
        if ("dwtnrf".includes(escaped)) set += `\\${escaped}`;
        else if (escaped === "s") set += SPACES;
        else if (PUNCTUATION.test(escaped)) {
          set += literal(escaped, true)!;
          codes.push([code(escaped), code(escaped)]);
          single = escaped;
          continue;
        } else return { reason: `the escape \\${escaped} in a class` };
        // Of these, \n, \r, and \s hold line breaks.
        if (escaped === "n" || escaped === "s") codes.push([10, 10]);
        if (escaped === "r" || escaped === "s") codes.push([13, 13]);
        single = null;
        continue;
      }
      if (foldsApart(member)) return { reason: FOLDS_APART };
      const text = literal(member, true);
      if (text === null) return { reason: "a lone surrogate" };
      set += text;
      codes.push([code(member), code(member)]);
      single = member;
    }
    return { reason: "an unclosed class" };
  }
}
