/**
 * Legacy Java regular expressions (java.util.regex, which Groovy's `=~`, `==~`, and String.matches() used) as
 * TeaseScript regex literals (V30 §8 "Regexes", RE2), where both mean the same: a pattern as RE2 writes it between the
 * slashes and its flags, or the reason it does not convert.
 *
 * Java's `.` matches no line terminator (\n, \r, U+0085, U+2028, U+2029), RE2's every character but \n: it becomes a
 * class without them, or stays with `(?s)`. Java's `\s` holds the vertical tab, RE2's does not: it becomes the class.
 * Java's `$` also matches before a line terminator at the end, which RE2's does not: it converts only as the pattern's
 * last character, for a test of a match anywhere as an optional terminator before the end. That test differs only
 * where Java's match had to end between a final \r and \n, which its `$` refused, as `\r$` in "a\r\n". Backreferences,
 * lookaround, atomic groups, possessive quantifiers, word boundaries (Unicode-aware in Java), Unicode and POSIX
 * properties (ASCII-only in Java), class intersections, and the m, x, and u modes have no exact RE2 form here; the i
 * mode has one only without the letters k and s, characters other than ASCII, and ranges, since Java ignores the case
 * of ASCII letters only, and RE2 also matches the Kelvin sign with k and the long s with s.
 */
export type JavaRegex = { pattern: string; flags: string } | { reason: string };

/** Java's line terminators, which its `.` and `$` treat apart. */
const LINE_TERMINATORS = String.raw`\n\r\x{85}\x{2028}\x{2029}`;
/** Java's `\s`. */
const SPACES = String.raw`\t\n\x0B\f\r `;
/** RE2's repetition limit. */
const MAX_REPEAT = 1000;

/**
 * `within` says how the regex is used: `whole` for a match of the whole text (==~, matches()), `find` for a test of a
 * match anywhere (=~ as a condition), where a match may take one more character, but no match's text is used.
 */
export function javaRegex(source: string, within: "whole" | "find"): JavaRegex {
  // Modes at the start, `(?s)`, `(?i)`, or both, are the regex's flags.
  const modes = /^\(\?([is]+)\)/u.exec(source)?.[1] ?? "";
  const pattern = source.slice(modes === "" ? 0 : modes.length + 3);
  const dotAll = modes.includes("s");
  const insensitive = modes.includes("i");
  const out: string[] = [];
  const fail = (reason: string): JavaRegex => ({ reason });
  // Java ignores the case of ASCII letters only, and RE2 also matches the Kelvin sign with k and the long s with s.
  const FOLDS_APART = "a letter that RE2 matches with other characters when it ignores case";
  const foldsApart = (character: string): boolean =>
    insensitive && (/[ksKS]/u.test(character) || character.codePointAt(0)! > 0x7f);
  // A raw character as RE2 literal text: a slash or a line break cannot stand in a literal.
  const raw = (character: string): string => {
    const code = character.codePointAt(0)!;
    if (character === "/") return "\\/";
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029)
      return `\\x{${code.toString(16)}}`;
    return character;
  };
  const characters = [...pattern];
  let index = 0;
  const next = (): string | undefined => characters[index++];
  // An escape after `\`, outside a class or in one, or why it has no exact RE2 form.
  const escape = (inClass: boolean): string | { reason: string } => {
    const character = next();
    if (character === undefined) return { reason: "a trailing backslash" };
    if (/[1-9]/u.test(character) || character === "k") return { reason: "a backreference" };
    if ("bB".includes(character) && !inClass) return { reason: "a word boundary" };
    if ("wW".includes(character) && insensitive) return { reason: FOLDS_APART };
    if ("dDwW".includes(character)) return `\\${character}`;
    if (character === "s") return inClass ? SPACES : `[${SPACES}]`;
    if (character === "S") return inClass ? { reason: "\\S in a class" } : `[^${SPACES}]`;
    if ("tnrfa".includes(character)) return `\\${character}`;
    if (character === "e") return "\\x{1b}";
    if (character === "A" && !inClass) return "\\A";
    if (character === "z" && !inClass) return "\\z";
    if ((character === "x" || character === "u") && insensitive) return { reason: FOLDS_APART };
    if (character === "x") {
      if (characters[index] === "{") {
        const end = characters.indexOf("}", index);
        if (end < 0) return { reason: "an unfinished \\x{...}" };
        const digits = characters.slice(index + 1, end).join("");
        index = end + 1;
        return /^[0-9a-fA-F]+$/u.test(digits) ? `\\x{${digits}}` : { reason: "a bad \\x{...}" };
      }
      const digits = characters.slice(index, index + 2).join("");
      index += 2;
      return /^[0-9a-fA-F]{2}$/u.test(digits) ? `\\x{${digits}}` : { reason: "a bad \\x" };
    }
    if (character === "u") {
      const digits = characters.slice(index, index + 4).join("");
      index += 4;
      return /^[0-9a-fA-F]{4}$/u.test(digits) ? `\\x{${digits}}` : { reason: "a bad \\u" };
    }
    if (character === "Q") {
      // Quoted text up to `\E`, each character literal.
      let quoted = "";
      while (index < characters.length) {
        if (characters[index] === "\\" && characters[index + 1] === "E") {
          index += 2;
          return quoted;
        }
        const literal = characters[index++]!;
        if (foldsApart(literal)) return { reason: FOLDS_APART };
        quoted += /[A-Za-z0-9 ]/u.test(literal)
          ? literal
          : /[\x21-\x7e]/u.test(literal)
            ? `\\${literal}`
            : raw(literal);
      }
      return quoted;
    }
    // Escaped punctuation is the character itself in both.
    if (/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/u.test(character)) return `\\${character}`;
    return { reason: `the escape \\${character}` };
  };
  // A quantifier with its lazy form, or why a possessive one does not convert.
  const quantifier = (text: string): string | { reason: string } => {
    if (characters[index] === "+") return { reason: "a possessive quantifier" };
    if (characters[index] === "?") {
      index += 1;
      return `${text}?`;
    }
    return text;
  };
  while (index < characters.length) {
    const character = next()!;
    if (character === "\\") {
      const escaped = escape(false);
      if (typeof escaped !== "string") return escaped;
      out.push(escaped);
      continue;
    }
    if (character === ".") {
      out.push(dotAll ? "." : `[^${LINE_TERMINATORS}]`);
      continue;
    }
    if (character === "$") {
      if (index !== characters.length) return fail("$ before the end of the pattern");
      // Java's `$` also matched before a line terminator at the end, which a test may take into the match.
      out.push(within === "whole" ? "$" : `(?:\\r\\n|[${LINE_TERMINATORS}])?$`);
      continue;
    }
    if (character === "(") {
      if (characters[index] === "?") {
        const after = characters.slice(index + 1, index + 3).join("");
        if (after.startsWith(":")) {
          out.push("(?:");
          index += 2;
          continue;
        }
        if (after.startsWith("<") && /[A-Za-z]/u.test(after[1] ?? "")) {
          out.push("(?<");
          index += 2;
          continue;
        }
        return fail("a lookaround, an atomic group, or a mode inside the pattern");
      }
      out.push("(");
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      const quantified = quantifier(character);
      if (typeof quantified !== "string") return quantified;
      out.push(quantified);
      continue;
    }
    if (character === "{") {
      const end = characters.indexOf("}", index);
      const body = end < 0 ? "" : characters.slice(index, end).join("");
      const bounds = /^(\d+)(,(\d*))?$/u.exec(body);
      if (bounds === null) return fail("a brace that is no repetition");
      if (
        Number(bounds[1]) > MAX_REPEAT ||
        (bounds[3] !== undefined && Number(bounds[3]) > MAX_REPEAT)
      )
        return fail(`a repetition over ${MAX_REPEAT}`);
      index = end + 1;
      const quantified = quantifier(`{${body}}`);
      if (typeof quantified !== "string") return quantified;
      out.push(quantified);
      continue;
    }
    if (character === "[") {
      let set = "[";
      if (characters[index] === "^") {
        set += "^";
        index += 1;
      }
      // A `]` right at the start is a character of the class.
      if (characters[index] === "]") {
        set += "\\]";
        index += 1;
      }
      let closed = false;
      while (index < characters.length) {
        const member = next()!;
        if (member === "]") {
          closed = true;
          break;
        }
        if (member === "[") return fail("a nested class");
        if (member === "&" && characters[index] === "&") return fail("a class intersection");
        // A range may hold such letters.
        if (
          foldsApart(member) ||
          (insensitive && member === "-" && set.length > 1 && characters[index] !== "]")
        )
          return fail(FOLDS_APART);
        if (member === "\\") {
          const escaped = escape(true);
          if (typeof escaped !== "string") return escaped;
          set += escaped;
          continue;
        }
        set += member === "/" ? "\\/" : raw(member);
      }
      if (!closed) return fail("an unclosed class");
      out.push(`${set}]`);
      continue;
    }
    if (character === ")" || character === "|" || character === "^") {
      out.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      out.push(`\\${character}`);
      continue;
    }
    if (foldsApart(character)) return fail(FOLDS_APART);
    out.push(raw(character));
  }
  return { pattern: out.join(""), flags: `${insensitive ? "i" : ""}${dotAll ? "s" : ""}` };
}
