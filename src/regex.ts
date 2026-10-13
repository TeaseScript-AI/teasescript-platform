import { compileRegexProgram, type RegexProgram } from "./regex-engine.js";
import { groupedDigits, messageText } from "./runtime/text-length.js";

/*
 * Regexes (V30 §8): RE2 patterns with the flags `i`, `m`, and `s`, shared by the compiler, plan and data validation,
 * and the runtime. A regex value is plain data, its pattern and flags; a compiled program is only a cache.
 */

/** The flags a regex may have, in their canonical order: ignore case, line anchors, and `.` matching a line break. */
const REGEX_FLAGS = "ims";

/**
 * The most instructions a regex may compile to, and the most groups it may capture. Both bound the work and memory of
 * one search on top of its linear time, and the size is checked before compiling, since repeats such as `a{1000}`
 * expand when a regex compiles. See `docs/RESOURCE-LIMITS.md`.
 */
export const MAX_REGEX_SIZE = 10_000;
export const MAX_REGEX_GROUPS = 100;

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
      return "A regex has no 'g' flag: it is not needed. Finding every match will be findAll, which comes later, and replace and split with text already handle every occurrence.";
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
  const estimate = regexSizeEstimate(source);
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
  return `This regex is too large: with its repeats written out it has about ${groupedDigits(size)} steps, and a regex may have at most ${groupedDigits(MAX_REGEX_SIZE)}. Use smaller or fewer repeat counts such as '{100}'.`;
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
    /** The sizes of the finished alternatives, and how many there are. */
    alternatives: number;
    bars: number;
    /** The size of the current alternative and of its last item, which a repeat applies to. */
    sequence: number;
    last: number;
    readonly capturing: boolean;
  }
  const open = (capturing: boolean): Group => ({
    alternatives: 0,
    bars: 0,
    sequence: 0,
    last: 0,
    capturing,
  });
  const groups: Group[] = [open(false)];
  let group = groups[0]!;
  const item = (size: number): void => {
    group.sequence += size;
    group.last = size;
  };
  const repeat = (size: number): void => {
    group.sequence += size - group.last;
    group.last = size;
  };
  const total = (finished: Group): number =>
    finished.alternatives + Math.max(1, finished.sequence) + finished.bars;
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
        item(total(closed) + (closed.capturing ? 2 : 0));
      }
      index += 1;
      continue;
    }
    if (character === "|") {
      group.alternatives += Math.max(1, group.sequence);
      group.bars += 1;
      group.sequence = 0;
      group.last = 0;
      index += 1;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      repeat(group.last + (character === "*" ? 2 : 1));
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
              ? group.last + 2
              : min * group.last + 1
            : max * group.last + (max - min),
        );
      index += counts[0].length;
      index += source[index] === "?" ? 1 : 0;
      continue;
    }
    if (character === "[") {
      const end = classEnd(source, index);
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
  while (groups.length > 1) {
    const closed = groups.pop()!;
    groups.at(-1)!.sequence += total(closed) + 2;
  }
  return total(groups[0]!);
}

/** The end of the class that starts with `[` at `start`, as RE2 reads it, or -1 when it does not end. */
function classEnd(source: string, start: number): number {
  let index = start + 1;
  if (source[index] === "^") index += 1;
  // A `]` right after the opening `[` or `[^` is a character of the class.
  let first = true;
  while (index < source.length) {
    if (source[index] === "]" && !first) return index + 1;
    first = false;
    if (source.startsWith("[:", index)) {
      const named = source.indexOf(":]", index);
      if (named >= 0) {
        index = named + 2;
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

function codePointWidth(text: string, index: number): number {
  return text.codePointAt(index)! > 0xffff ? 2 : 1;
}
