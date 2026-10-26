import { codePointWidth } from "./code-points.js";
import { compileRegexProgram, type RegexProgram } from "./regex-engine.js";
import { groupedDigits, messageText } from "./runtime/values/text-length.js";

/*
 * Regexes (V30 §8): RE2 patterns with the flags `i`, `m`, and `s`, shared by the compiler, plan and data validation,
 * and the runtime. A regex value is plain data, its pattern and flags; a compiled program is only a cache.
 */

/** The flags a regex may have, in their canonical order: ignore case, line anchors, and `.` matching a line break. */
const REGEX_FLAGS = "ims";

/**
 * The most instructions a regex may compile to, and the most groups it may capture. Both bound the work and memory of
 * one search on top of its linear time, and the size is checked before compiling, since repeats such as `a{1000}`
 * expand when a regex compiles. The longest pattern, in UTF-16 code units, bounds what RE2 reads to parse it, which a
 * long character class does not add to the size. See `docs/RESOURCE-LIMITS.md`.
 */
export const MAX_REGEX_SIZE = 10_000;
export const MAX_REGEX_GROUPS = 100;
export const MAX_REGEX_LENGTH = 10_000;

/** RE2 adds two instructions to every program, beyond its estimate of the pattern. */
const PROGRAM_FRAME = 2;

/** The flags in their canonical order, for flags that are valid. */
export function canonicalRegexFlags(flags: string): string {
  let canonical = "";
  for (const flag of REGEX_FLAGS) if (flags.includes(flag)) canonical += flag;
  return canonical;
}

/** Whether `flags` are distinct valid flags in their canonical order, as a regex value holds them. */
export function isCanonicalRegexFlags(flags: string): boolean {
  return regexFlagProblem(flags) === null && canonicalRegexFlags(flags) === flags;
}

/** Why the flags after a regex literal are not valid, or `null`. */
export function regexFlagProblem(flags: string): string | null {
  for (const [index, flag] of [...flags].entries()) {
    if (flag === "g")
      return "A regex has no 'g' flag: it is not needed. findAll finds every match, and replace and split handle every occurrence.";
    if (flag === "u") return "A regex has no 'u' flag: a regex always matches Unicode characters.";
    if (!REGEX_FLAGS.includes(flag))
      return `A regex has no flag '${flag}'. Its flags are 'i' (ignore case), 'm' (^ and $ match at each line), and 's' (. also matches a line break).`;
    if (flags.indexOf(flag) !== index) return `The flag '${flag}' appears twice. Write it once.`;
  }
  return null;
}

export type RegexCompileResult =
  | { readonly ok: true; readonly program: RegexProgram }
  | { readonly ok: false; readonly problem: string };

/** Compiled programs by flags and pattern, the most recently used last. */
const programs = new Map<string, RegexProgram>();
/** The size of the programs in `programs`, which stays within twice the largest a regex may be. */
let cachedSize = 0;
const MAX_CACHED_PROGRAMS = 64;

/**
 * Compiles a pattern with valid flags, or says why it cannot be a regex: RE2 rejects it, or it is larger or has more
 * groups than a regex may. Programs are cached; the cache is not part of any state.
 */
export function compileRegex(source: string, flags: string): RegexCompileResult {
  const key = `${flags}/${source}`;
  const cached = programs.get(key);
  if (cached !== undefined) {
    programs.delete(key);
    programs.set(key, cached);
    return { ok: true, program: cached };
  }
  if (source.length > MAX_REGEX_LENGTH)
    return {
      ok: false,
      problem: `This regex is too long: a regex may have at most ${groupedDigits(MAX_REGEX_LENGTH)} characters. Use a shorter pattern.`,
    };
  const surrogate = surrogateInPattern(source);
  if (surrogate !== null)
    return {
      ok: false,
      problem: `A regex cannot hold half of a character: '\\x{${surrogate.toString(16).toUpperCase()}}' is a surrogate, which stands for half of a character such as an emoji. Write the whole character, as in '\\x{1F600}'.`,
    };
  const estimate = regexSizeEstimate(source) + PROGRAM_FRAME;
  if (estimate > MAX_REGEX_SIZE) return { ok: false, problem: tooLargeMessage(estimate) };
  const compiled = compileRegexProgram(source, flags);
  if (!compiled.ok)
    return {
      ok: false,
      problem:
        compiled.reason === "caseRanges"
          ? "This regex is too large: ignoring case for its character ranges takes too much work. Use smaller ranges such as [a-z], or match both cases without the 'i' flag."
          : syntaxMessage(compiled.error, compiled.fragment),
    };
  const program = compiled.program;
  if (program.size > MAX_REGEX_SIZE) return { ok: false, problem: tooLargeMessage(program.size) };
  if (program.groups > MAX_REGEX_GROUPS)
    return {
      ok: false,
      problem: `This regex has ${groupedDigits(program.groups)} groups, and a regex may have at most ${MAX_REGEX_GROUPS}. Write '(?:...)' for a group that only groups.`,
    };
  programs.set(key, program);
  cachedSize += program.size;
  while (programs.size > MAX_CACHED_PROGRAMS || cachedSize > 2 * MAX_REGEX_SIZE) {
    const [oldestKey, oldest] = programs.entries().next().value!;
    programs.delete(oldestKey);
    cachedSize -= oldest.size;
  }
  return { ok: true, program };
}

function tooLargeMessage(size: number): string {
  return `This regex is too large: with its repeats written out it has ${size >= ESTIMATE_CEILING ? "more than a million" : `about ${groupedDigits(size)}`} steps, and a regex may have at most ${groupedDigits(MAX_REGEX_SIZE)}. Use smaller or fewer repeat counts such as '{100}'.`;
}

/**
 * The first surrogate, U+D800 to U+DFFF, that the pattern holds as a character of its own: alone in its text, also in
 * `\Q...\E`, or written as `\x{D800}` to `\x{DFFF}`; `null` when there is none. Text holds a surrogate as half of a
 * character, or alone, and RE2's search for a pattern's leading text can start inside a pair, so such a pattern would
 * match half of a character in some searches and not in others.
 */
function surrogateInPattern(source: string): number | null {
  const width = (at: number): number => (pairedAt(source, at) ? 2 : 1);
  const lone = (at: number): number | null => {
    const unit = source.charCodeAt(at);
    return isSurrogate(unit) && !pairedAt(source, at) ? unit : null;
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("\\Q", index)) {
      // Quoted text holds no escapes, up to `\E` or the end.
      const close = source.indexOf("\\E", index + 2);
      const end = close < 0 ? source.length : close;
      for (let at = index + 2; at < end; at += width(at)) if (lone(at) !== null) return lone(at);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith("\\x{", index)) {
      const close = source.indexOf("}", index + 3);
      if (close < 0) return null;
      const digits = source.slice(index + 3, close);
      // RE2 takes any number of hex digits, also leading zeros.
      const value = /^[0-9A-Fa-f]+$/u.test(digits) ? Number.parseInt(digits, 16) : -1;
      if (value >= 0xd800 && value <= 0xdfff) return value;
      index = close + 1;
      continue;
    }
    // An escaped character is checked as itself.
    if (source[index] === "\\") index += 1;
    if (index >= source.length) break;
    if (lone(index) !== null) return lone(index);
    index += width(index);
  }
  return null;
}

function isSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdfff;
}

/** Whether the high surrogate at `index` starts a pair; a low surrogate there never does. */
function pairedAt(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  const next = text.charCodeAt(index + 1);
  return unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** A message for RE2's description of a pattern it rejects, explaining the features that RE2 leaves out on purpose. */
function syntaxMessage(error: string, fragment: string): string {
  const slow = "because a regex must match in time proportional to the text";
  if (error === "invalid escape sequence" && /^\\[1-9]/u.test(fragment))
    return `A regex cannot refer back to a group with '${fragment}', ${slow}. Repeat the group's pattern instead.`;
  for (const [opener, direction] of [
    ["(?=", "ahead"],
    ["(?!", "ahead"],
    ["(?<=", "behind"],
    ["(?<!", "behind"],
  ] as const)
    if (fragment.startsWith(opener))
      return `A regex cannot look ${direction} with '${opener}', ${slow}. Match that text as part of the regex, or check it with a second regex.`;
  return `This regex is not valid: ${error} in '${messageText(fragment)}'.`;
}

/** A part of the replacement for a regex search: text, or the number of the group whose text goes there, 0 the match. */
export type ReplacementPart = string | number;

/**
 * The parts of `replacement` for a regex search (V30 §8), with the regex's pattern `source` and its number of
 * `groups`: `$0` is the whole match, `$` and more digits the group they number, `$<name>` the named group, and `$$` one
 * `$`; any other `$` is text. A reference to a group the regex does not have is a problem. One pass reads the
 * replacement, and the search for each `>` goes on from the last one.
 */
export function replacementParts(
  replacement: string,
  source: string,
  groups: number,
):
  | { readonly ok: true; readonly parts: readonly ReplacementPart[] }
  | { readonly ok: false; readonly problem: string } {
  const parts: ReplacementPart[] = [];
  let text = "";
  let names: ReadonlyMap<string, number> | undefined;
  let close = -2;
  let index = 0;
  for (
    let dollar = replacement.indexOf("$");
    dollar >= 0;
    dollar = replacement.indexOf("$", index)
  ) {
    text += replacement.slice(index, dollar);
    const next = replacement.charCodeAt(dollar + 1);
    let end = dollar + 1;
    let group: number | undefined;
    if (next === 0x24) {
      text += "$";
      end += 1;
    } else if (isDigit(next)) {
      while (isDigit(replacement.charCodeAt(end))) end += 1;
      const digits = replacement.slice(dollar + 1, end);
      group = Number(digits);
      if (group > groups) return { ok: false, problem: missingGroupMessage(digits, groups) };
    } else if (next === 0x3c) {
      if (close !== -1 && close < dollar + 2) close = replacement.indexOf(">", dollar + 2);
      if (close >= 0) {
        const name = replacement.slice(dollar + 2, close);
        names ??= regexGroupNames(source);
        group = names.get(name);
        if (group === undefined)
          return {
            ok: false,
            problem: `'$<${messageText(name)}>' in the replacement refers to a group named '${messageText(name)}', but this regex has no group of that name. Name a group with '(?<${messageText(name)}>...)', or write '$$' for a '$'.`,
          };
        end = close + 1;
      } else text += "$";
    } else {
      text += "$";
    }
    if (group !== undefined) {
      if (text !== "") parts.push(text);
      text = "";
      parts.push(group);
    }
    index = end;
  }
  text += replacement.slice(index);
  if (text !== "") parts.push(text);
  return { ok: true, parts };
}

function isDigit(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39;
}

function missingGroupMessage(digits: string, groups: number): string {
  const has =
    groups === 0 ? "no groups" : groups === 1 ? "1 group" : `${groupedDigits(groups)} groups`;
  const use =
    groups === 0
      ? "'$0' for the whole match"
      : `'$0' for the whole match or ${groups === 1 ? "'$1' for its group" : `'$1' to '$${groups}' for its groups`}`;
  return `'$${messageText(digits)}' in the replacement refers to group ${messageText(digits)}, but this regex has ${has}. Write ${use}, or '$$' for a '$'.`;
}

/**
 * The number of each named group of a pattern RE2 compiled, `(?<name>...)` or `(?P<name>...)`, by its opening
 * parenthesis among all groups that capture. RE2 numbers groups the same way; re2js's own map of names can miss a name
 * when it simplifies the pattern, as in `(a){0}(?<v>b)`.
 */
function regexGroupNames(source: string): ReadonlyMap<string, number> {
  const names = new Map<string, number>();
  const namedClassEnds = { next: -2 };
  let groups = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "[") {
      const end = classEnd(source, index, namedClassEnds);
      if (end < 0) break;
      index = end;
    } else if (character === "\\" && source[index + 1] === "Q") {
      const end = source.indexOf("\\E", index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (character === "\\") {
      index = escapeEnd(source, index);
    } else if (character === "(") {
      const named = /^\(\?P?<(?![=!])/u.exec(source.slice(index, index + 4));
      if (named !== null) {
        const close = source.indexOf(">", index);
        if (close < 0) break;
        groups += 1;
        names.set(source.slice(index + named[0].length, close), groups);
        index = close + 1;
      } else {
        if (source[index + 1] !== "?") groups += 1;
        index += 1;
      }
    } else {
      index += codePointWidth(source, index);
    }
  }
  return names;
}

/**
 * An upper bound, before compiling, of the instructions RE2 compiles `source` into, by the size RE2's parser estimates
 * for the pattern it reads: a character, a class, or an anchor counts 1, a capturing group 2 more than its content,
 * `x*` 2 and `x+` and `x?` 1 more than `x`, `x{n}` n times `x`, `x{n,m}` m times `x` and m - n more, `x{n,}` n times
 * `x` and 1 more, and alternatives their sum and 1 more for each `|`. It reads the pattern as RE2 does, so it knows
 * what each repeat applies to; text RE2 rejects may be estimated loosely, as compiling it fails before any repeat is
 * written out. One pass with an explicit stack of open groups keeps it linear for any nesting.
 */
export function regexSizeEstimate(source: string): number {
  interface Group {
    /** The size of the finished alternatives, with 1 for each `|`. */
    alternatives: number;
    /** The size of the current alternative before its last item, and of that item, which a repeat applies to. */
    before: number;
    last: number;
    readonly capturing: boolean;
  }
  const open = (capturing: boolean): Group => ({ alternatives: 0, before: 0, last: 0, capturing });
  const groups: Group[] = [open(false)];
  let group = groups[0]!;
  const namedClassEnds = { next: -2 };
  // Sizes stop growing at a ceiling far above any limit, so that nested repeats never overflow a number, and every
  // step only adds and multiplies, so a size over a limit stays over it.
  const sum = (left: number, right: number): number => Math.min(left + right, ESTIMATE_CEILING);
  const times = (count: number, size: number): number => Math.min(count * size, ESTIMATE_CEILING);
  const sequence = (current: Group): number => Math.max(1, sum(current.before, current.last));
  const item = (size: number): void => {
    group.before = sum(group.before, group.last);
    group.last = size;
  };
  const repeat = (size: number): void => {
    group.last = size;
  };
  const total = (finished: Group): number => sum(finished.alternatives, sequence(finished));
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "(") {
      if (source.startsWith("(?", index)) {
        const named = /^\(\?P?<(?![=!])/u.exec(source.slice(index, index + 4));
        if (named !== null) {
          const close = source.indexOf(">", index);
          if (close < 0) break;
          groups.push((group = open(true)));
          index = close + 1;
          continue;
        }
        let end = index + 2;
        while (end < source.length && /[imsU-]/u.test(source[end]!)) end += 1;
        // `(?i)` only sets flags; `(?i:` opens a group that does not capture.
        if (source[end] === ")") {
          index = end + 1;
          continue;
        }
        groups.push((group = open(false)));
        index = source[end] === ":" ? end + 1 : index + 2;
        continue;
      }
      groups.push((group = open(true)));
      index += 1;
      continue;
    }
    if (character === ")") {
      if (groups.length > 1) {
        const closed = groups.pop()!;
        group = groups.at(-1)!;
        item(sum(total(closed), closed.capturing ? 2 : 0));
      }
      index += 1;
      continue;
    }
    if (character === "|") {
      group.alternatives = sum(group.alternatives, sum(sequence(group), 1));
      group.before = 0;
      group.last = 0;
      index += 1;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      repeat(sum(group.last, character === "*" ? 2 : 1));
      index += source[index + 1] === "?" ? 2 : 1;
      continue;
    }
    if (character === "{") {
      const counts = /^\{(0|[1-9]\d{0,7})(?:(,)(0|[1-9]\d{0,7})?)?\}/u.exec(
        source.slice(index, index + 20),
      );
      if (counts === null) {
        item(1);
        index += 1;
        continue;
      }
      const min = Number(counts[1]);
      const max = counts[2] === undefined ? min : counts[3] === undefined ? -1 : Number(counts[3]);
      // RE2 rejects a count above 1,000 before it writes out any repeat.
      if (min <= 1000 && max <= 1000)
        repeat(
          max === -1
            ? min === 0
              ? sum(group.last, 2)
              : sum(times(min, group.last), 1)
            : sum(times(max, group.last), max - min),
        );
      index += counts[0].length;
      index += source[index] === "?" ? 1 : 0;
      continue;
    }
    if (character === "[") {
      const end = classEnd(source, index, namedClassEnds);
      if (end < 0) break;
      item(1);
      index = end;
      continue;
    }
    if (character === "\\" && source[index + 1] === "Q") {
      // Literal text up to `\E`: each character is an item.
      const end = source.indexOf("\\E", index + 2);
      for (const _ of source.slice(index + 2, end < 0 ? source.length : end)) item(1);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    item(1);
    index = character === "\\" ? escapeEnd(source, index) : index + codePointWidth(source, index);
  }
  // An unclosed group counts as a capturing one; RE2 rejects it anyway.
  while (groups.length > 1) {
    const closed = groups.pop()!;
    group = groups.at(-1)!;
    item(sum(total(closed), 2));
  }
  return total(groups[0]!);
}

/** Where size estimates stop growing: far above any limit, and small enough to multiply exactly. */
const ESTIMATE_CEILING = 1_000_000;

/**
 * The end of the class that starts with `[` at `start`, as RE2 reads it, or -1 when it does not end. `named` holds the
 * next `:]` of the pattern, -1 when there is none and -2 before the first search, which all classes of one pattern share,
 * so that the search goes over the pattern once.
 */
function classEnd(source: string, start: number, named: { next: number }): number {
  let index = start + 1;
  if (source[index] === "^") index += 1;
  // A `]` right after the opening `[` or `[^` is a character of the class.
  let first = true;
  while (index < source.length) {
    if (source[index] === "]" && !first) return index + 1;
    first = false;
    if (source.startsWith("[:", index)) {
      if (named.next !== -1 && named.next < index) named.next = source.indexOf(":]", index);
      if (named.next >= 0) {
        index = named.next + 2;
        continue;
      }
    }
    index =
      source[index] === "\\" ? escapeEnd(source, index) : index + codePointWidth(source, index);
  }
  return -1;
}

/** The end of the escape that starts with `\` at `start`: `\x{...}`, `\p{...}`, `\xFF`, `\pL`, octal, or one character. */
function escapeEnd(source: string, start: number): number {
  const next = source[start + 1];
  if (next === undefined) return start + 1;
  if ((next === "x" || next === "p" || next === "P") && source[start + 2] === "{") {
    const close = source.indexOf("}", start + 3);
    return close < 0 ? source.length : close + 1;
  }
  if (next === "x") return Math.min(source.length, start + 4);
  if (next === "p" || next === "P")
    return start + 2 + (start + 2 < source.length ? codePointWidth(source, start + 2) : 0);
  if (next >= "0" && next <= "7") {
    let end = start + 2;
    while (end < start + 4 && source[end]! >= "0" && source[end]! <= "7") end += 1;
    return end;
  }
  return start + 1 + codePointWidth(source, start + 1);
}
