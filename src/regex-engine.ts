import { RE2JS, RE2JSSyntaxException } from "re2js";

import { REGEX_CASE_PAIR_RUNS } from "./regex-case-pairs.js";

/*
 * The regex engine: RE2 semantics through `re2js@2.8.6` (MIT, no runtime dependencies), with RE2's own syntax and its
 * leftmost-first matching. This is the only module that imports re2js, and `compileRegexProgram` its only entry point,
 * so that the engine can later be loaded on demand: the host then loads it before it compiles source, validates a plan
 * or data, or runs a session that may hold a regex, and no instruction ever waits for it.
 */

/** A compiled regex. Offsets are UTF-16 code units of the searched text. */
export interface RegexProgram {
  /** How many instructions RE2 compiled the regex into. */
  readonly size: number;
  /** The number of capturing groups. */
  readonly groups: number;
  /** Whether the regex matches the whole text. */
  matchesWhole(text: string): boolean;
  /** Whether the regex matches somewhere in the text. */
  matchesPart(text: string): boolean;
  /**
   * The first leftmost match, as the start and end of the whole match, followed with `groups` by the start and end of
   * each group in opening-parenthesis order, -1 for one that did not take part; `null` when nothing matches.
   */
  firstMatch(text: string, groups: boolean): number[] | null;
}

export type RegexCompilation =
  | { readonly ok: true; readonly program: RegexProgram }
  /** RE2's description of what is wrong, such as "missing closing )", and the part of the pattern it names. */
  | {
      readonly ok: false;
      readonly reason: "syntax";
      readonly error: string;
      readonly fragment: string;
    }
  /** Ignoring case for the character ranges of the pattern takes more than `MAX_CASE_LOOKUPS`. */
  | { readonly ok: false; readonly reason: "caseRanges" };

/**
 * The most case lookups compiling one regex may make: re2js folds a character range that ignores case one character
 * at a time, about four lookups each, so this is about 250,000 characters, twice every character that has a case.
 */
const MAX_CASE_LOOKUPS = 1_000_000;

/**
 * Compiles `source` with RE2's syntax and the flags of `flags`, any of `i`, `m`, and `s`. RE2's optional lookbehind and
 * longest-match modes stay off.
 */
export function compileRegexProgram(source: string, flags: string): RegexCompilation {
  let options = 0;
  if (flags.includes("i")) options |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes("m")) options |= RE2JS.MULTILINE;
  if (flags.includes("s")) options |= RE2JS.DOTALL;
  // A pattern can switch ignoring case on inside itself, as in `(?i)` or `(?si:`.
  const folds = flags.includes("i") || /\(\?[A-Za-z-]*i/u.test(source);
  let compiled: RE2JS;
  try {
    compiled = folds
      ? withPinnedCase(MAX_CASE_LOOKUPS, () => RE2JS.compile(source, options))
      : RE2JS.compile(source, options);
  } catch (error) {
    if (error === CASE_LOOKUPS_EXCEEDED) return { ok: false, reason: "caseRanges" };
    if (!(error instanceof RE2JSSyntaxException)) throw error;
    return { ok: false, reason: "syntax", error: error.error, fragment: error.input ?? source };
  }
  return { ok: true, program: new Re2Program(compiled, folds) };
}

class Re2Program implements RegexProgram {
  readonly size: number;
  readonly groups: number;

  constructor(
    private readonly compiled: RE2JS,
    /** Whether matching may fold case, which then reads the pinned case pairs. */
    private readonly folds: boolean,
  ) {
    this.size = compiled.programSize();
    this.groups = compiled.groupCount();
  }

  matchesWhole(text: string): boolean {
    return this.#run(() => this.compiled.testExact(text));
  }

  matchesPart(text: string): boolean {
    return this.#run(() => this.compiled.test(text));
  }

  firstMatch(text: string, groups: boolean): number[] | null {
    return this.#run(() => {
      const matcher = this.compiled.matcher(text);
      if (!matcher.find()) return null;
      const offsets = [matcher.start(), matcher.end()];
      // Groups are numbered; a named group keeps its number, and re2js's map of names is not read.
      if (groups)
        for (let group = 1; group <= this.groups; group += 1)
          offsets.push(matcher.start(group), matcher.end(group));
      return offsets;
    });
  }

  #run<T>(search: () => T): T {
    return this.folds ? withPinnedCase(Infinity, search) : search();
  }
}

/** Thrown out of re2js when compiling a regex makes more case lookups than it may. */
const CASE_LOOKUPS_EXCEEDED = new Error("A regex made more case lookups than it may.");

const nativeToLowerCase = String.prototype.toLowerCase;
const nativeToUpperCase = String.prototype.toUpperCase;

/** The lower case of each upper-case character of a pair, and the upper case of each lower-case one. */
let casePairs: { readonly lower: Map<number, number>; readonly upper: Map<number, number> } | null =
  null;

function pinnedCasePairs(): NonNullable<typeof casePairs> {
  if (casePairs !== null) return casePairs;
  const lower = new Map<number, number>();
  const upper = new Map<number, number>();
  for (let index = 0; index < REGEX_CASE_PAIR_RUNS.length; index += 4) {
    const start = REGEX_CASE_PAIR_RUNS[index]!;
    const count = REGEX_CASE_PAIR_RUNS[index + 1]!;
    const stride = REGEX_CASE_PAIR_RUNS[index + 2]!;
    const delta = REGEX_CASE_PAIR_RUNS[index + 3]!;
    for (let character = start; character < start + count * stride; character += stride) {
      lower.set(character, character + delta);
      upper.set(character + delta, character);
    }
  }
  casePairs = { lower, upper };
  return casePairs;
}

/**
 * Runs `work` while the case of one character from U+0080 on comes from the pinned pairs instead of the host. re2js
 * folds a character outside its own table with the host's `toLowerCase` and `toUpperCase`, whose Unicode version
 * differs between browsers and their versions; it calls them on one character at a time, and only then. Every other
 * text keeps the host's methods, which are back in place when `work` returns or throws. At most `lookups` pinned
 * lookups are made: the count depends only on the pattern, so stopping there gives the same result everywhere.
 */
function withPinnedCase<T>(lookups: number, work: () => T): T {
  const { lower, upper } = pinnedCasePairs();
  let remaining = lookups;
  const pinned = (pairs: Map<number, number>, native: () => string) =>
    function (this: string): string {
      const text = `${this}`;
      const character = text.codePointAt(0);
      if (character === undefined || character < 0x80 || text.length > (character > 0xffff ? 2 : 1))
        return native.call(text);
      remaining -= 1;
      if (remaining < 0) throw CASE_LOOKUPS_EXCEEDED;
      const partner = pairs.get(character);
      return partner === undefined ? text : String.fromCodePoint(partner);
    };
  const prototype = String.prototype;
  prototype.toLowerCase = pinned(lower, nativeToLowerCase);
  prototype.toUpperCase = pinned(upper, nativeToUpperCase);
  try {
    return work();
  } finally {
    prototype.toLowerCase = nativeToLowerCase;
    prototype.toUpperCase = nativeToUpperCase;
  }
}
