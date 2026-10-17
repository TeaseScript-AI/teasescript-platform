import { RE2JS, RE2JSSyntaxException } from "re2js";

import { REGEX_CASE_PAIR_RUNS } from "./regex-case-pairs.js";

/*
 * The regex engine: RE2 semantics through `re2js@2.8.6` (MIT, no runtime dependencies), with RE2's own syntax and its
 * leftmost-first matching. This is the only module that imports re2js, and `compileRegexProgram` its only entry point,
 * so that the engine can later be loaded on demand: the host then loads it before it compiles source, validates a plan
 * or data, or runs a session that may hold a regex, and no instruction ever waits for it.
 *
 * Every search runs re2js's NFA and counts its work (V30 §8): one instruction cannot be interrupted, so a regex
 * operation that needs more than its limit stops with an error instead of freezing the Player. The units count what
 * the NFA does, never time, so a limit stops the same operation at the same point on every host.
 */

/** A compiled regex. Offsets are UTF-16 code units of the searched text. */
export interface RegexProgram {
  /** How many instructions RE2 compiled the regex into. */
  readonly size: number;
  /** The number of capturing groups. */
  readonly groups: number;
  /** Whether the regex matches the whole text. */
  matchesWhole(text: string, work: RegexWork): boolean;
  /** Whether the regex matches somewhere in the text. */
  matchesPart(text: string, work: RegexWork): boolean;
  /**
   * The leftmost match that starts at or after `from`, a code point boundary, as the start and end of the whole match,
   * followed with `groups` by the start and end of each group in opening-parenthesis order, -1 for one that did not
   * take part; `null` when nothing matches there. Text before `from` still decides `^`, `$`, and `\b` at `from`.
   */
  search(text: string, from: number, groups: boolean, work: RegexWork): number[] | null;
}

/** The most units of work one regex operation may use: see `docs/RESOURCE-LIMITS.md`. */
export const MAX_REGEX_WORK = 5_000_000;

let workLimit = MAX_REGEX_WORK;

/** Work that the operations of `withRegexWorkPool` share, besides each one's own limit, or `null`. */
let workPool: { remaining: number } | null = null;

/** Thrown out of a regex operation that needs more work than its limit. */
export const REGEX_WORK_EXCEEDED = new Error("A regex operation needed more work than it may use.");

/**
 * The work of one regex operation, such as one `findAll`: its searches charge what re2js's NFA does, and the operation
 * charges what it builds. A charge that would pass the limit throws `REGEX_WORK_EXCEEDED` before that work is done.
 */
export class RegexWork {
  readonly #limit = workLimit;
  readonly #pool = workPool;
  #used = 0;
  /** The numbers of capture offsets whose NFA setup this operation has charged; the engine keeps it. */
  readonly widths = new Set<number>();

  /** The units charged so far. */
  get used(): number {
    return this.#used;
  }

  charge(units: number): void {
    if (units > this.#limit - this.#used) throw REGEX_WORK_EXCEEDED;
    if (this.#pool !== null) {
      if (units > this.#pool.remaining) throw REGEX_WORK_EXCEEDED;
      this.#pool.remaining -= units;
    }
    this.#used += units;
  }
}

/** Runs `run` with `limit` instead of `MAX_REGEX_WORK` for the regex operations it starts, so tests reach the limit. */
export function withRegexWorkLimit<T>(limit: number, run: () => T): T {
  const outer = workLimit;
  workLimit = limit;
  try {
    return run();
  } finally {
    workLimit = outer;
  }
}

/**
 * Runs `run` with the regex operations it starts also charging `pool`, so that together they use at most the work it
 * has left. The compiler computes known values so (see `KnownValues`).
 */
export function withRegexWorkPool<T>(pool: { remaining: number }, run: () => T): T {
  const outer = workPool;
  workPool = pool;
  try {
    return run();
  } finally {
    workPool = outer;
  }
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
  let compiled: RE2JS;
  try {
    compiled = withPinnedCase(MAX_CASE_LOOKUPS, () => RE2JS.compile(source, options));
  } catch (error) {
    if (error === CASE_LOOKUPS_EXCEEDED) return { ok: false, reason: "caseRanges" };
    if (!(error instanceof RE2JSSyntaxException)) throw error;
    return { ok: false, reason: "syntax", error: error.error, fragment: error.input ?? source };
  }
  return { ok: true, program: new Re2Program(compiled) };
}

class Re2Program implements RegexProgram {
  readonly size: number;
  readonly groups: number;
  readonly #engine: Re2Engine;
  /**
   * The most capture offsets a machine of this program keeps and fills for each search: those it compiled, and those
   * of every group.
   */
  readonly #keptOffsets: number;
  /** The most work one consuming instruction may do to compare a character: see `runeWeight`. */
  readonly #runeWeight: number;

  constructor(compiled: RE2JS) {
    this.size = compiled.programSize();
    this.groups = compiled.groupCount();
    this.#engine = compiled.re2();
    this.#keptOffsets = Math.max(2, this.#engine.prog.numCap, 2 * (this.#engine.numSubexp + 1));
    this.#runeWeight = 0;
    for (const instruction of this.#engine.prog.inst)
      this.#runeWeight = Math.max(this.#runeWeight, runeWeight(instruction.runes.length));
  }

  matchesWhole(text: string, work: RegexWork): boolean {
    return this.#execute(text, 0, ANCHOR_BOTH, 0, work) !== null;
  }

  matchesPart(text: string, work: RegexWork): boolean {
    return this.#execute(text, 0, UNANCHORED, 0, work) !== null;
  }

  search(text: string, from: number, groups: boolean, work: RegexWork): number[] | null {
    // Groups are numbered; a named group keeps its number, and re2js's map of names is not read.
    return this.#execute(text, from, UNANCHORED, groups ? 2 * (this.groups + 1) : 2, work);
  }

  /**
   * Runs re2js's NFA on `text` from `from`, asking for `offsets` capture offsets, while `work` is charged. Each number
   * of offsets charges the NFA's setup once per operation, as if its queues were allocated, and each search the offsets
   * a machine fills and returns, so the count does not depend on what earlier searches left in re2js's pool of machines.
   */
  #execute(
    text: string,
    from: number,
    anchor: number,
    offsets: number,
    work: RegexWork,
  ): number[] | null {
    const classes = nfaClasses();
    if (!work.widths.has(offsets)) {
      work.charge(this.size * (4 + 2 * offsets) + this.#keptOffsets);
      work.widths.add(offsets);
    }
    work.charge(1 + 2 * this.#keptOffsets + offsets);
    const engine = this.#engine;
    if (engine.machinePool.length === 0)
      engine.put(meteredMachine(classes.machine.fromRE2(engine), this.#runeWeight));
    const outer = activeWork;
    activeWork = work;
    nesting = 0;
    try {
      return withPinnedCase(Infinity, () =>
        engine.doExecuteNFA(new classes.input(text, 0, text.length), from, anchor, offsets),
      );
    } finally {
      activeWork = outer;
    }
  }
}

/** re2js's anchors: a match anywhere, and one that spans the whole text. */
const UNANCHORED = 0;
const ANCHOR_BOTH = 2;

/**
 * The work of comparing a character with a consuming instruction's list of `length` range bounds: re2js reads up to
 * eight of them one by one and searches longer lists by halves. The logarithm is taken with integers, the same on
 * every host.
 */
function runeWeight(length: number): number {
  return length <= 8 ? length : 34 - Math.clz32(length - 1);
}

/** The parts of an RE2 program in re2js 2.8.6 that the work count reads. They are not part of its public API. */
interface Re2Engine {
  readonly prog: {
    readonly numCap: number;
    readonly inst: readonly { readonly runes: readonly number[] }[];
  };
  readonly numSubexp: number;
  readonly machinePool: readonly Re2Machine[];
  put(machine: Re2Machine): void;
  doExecuteNFA(input: Re2Input, pos: number, anchor: number, ncap: number): number[] | null;
}

/** re2js's input: `step` decodes the character at a position, and `context` the conditions of `^`, `$`, and `\b`. */
interface Re2Input {
  step(pos: number): number;
  context(pos: number): number;
  canCheckPrefix(): boolean;
}

/** re2js's NFA machine, which keeps the states of a search in two queues and steps them over one character at a time. */
interface Re2Machine {
  readonly q0: Re2Queue;
  readonly q1: Re2Queue;
  /** The number of capture offsets the search asks for. */
  readonly ncap: number;
  /** Adds a state and, calling itself, the states that follow it without a character. */
  add(
    q: Re2Queue,
    pc: number,
    pos: number,
    capArray: Int32Array,
    capOffset: number,
    cond: number,
  ): void;
  step(
    runq: Re2Queue,
    nextq: Re2Queue,
    pos: number,
    nextPos: number,
    rune: number,
    nextCond: number,
    anchor: number,
    atEnd: boolean,
  ): void;
}

/** A queue of NFA states: `contains` is asked before every state that a transition without a character adds. */
interface Re2Queue {
  readonly size: number;
  readonly ncap: number;
  contains(pc: number): boolean;
}

/** The operation whose work the NFA charges while it runs: set only during a search. */
let activeWork: RegexWork | null = null;

/**
 * The most calls of re2js's `add` a search may have open at once. `add` calls itself for each alternative or group it
 * enters without a character, so a long chain of those, such as `(?:a??b??c??d??e??){999}`, would pass the host's stack
 * limit, which differs between hosts; stopping at this depth ends such a search the same way everywhere.
 */
const MAX_NFA_NESTING = 500;
let nesting = 0;

function charge(units: number): void {
  if (activeWork === null) throw new Error("A regex search ran without counting its work.");
  activeWork.charge(units);
}

/**
 * Makes `machine` charge its work before doing it: each state it tries to add to a queue, with the capture offsets it
 * may copy, and before each character each state in its queue, with the offsets it copies and the most work of
 * comparing the character. Its `add` also stops past `MAX_NFA_NESTING` open calls, as if the work were used up. A
 * charge that throws leaves the machine out of re2js's pool, which only takes back a machine whose search ended.
 */
function meteredMachine(machine: Re2Machine, runeWork: number): Re2Machine {
  const add = machine.add;
  machine.add = function (this: Re2Machine, q, pc, pos, capArray, capOffset, cond) {
    nesting += 1;
    if (nesting > MAX_NFA_NESTING) throw REGEX_WORK_EXCEEDED;
    add.call(this, q, pc, pos, capArray, capOffset, cond);
    nesting -= 1;
  };
  for (const queue of [machine.q0, machine.q1]) {
    const contains = queue.contains;
    queue.contains = function (this: Re2Queue, pc: number): boolean {
      charge(1 + this.ncap);
      return contains.call(this, pc);
    };
  }
  const step = machine.step;
  machine.step = function (
    this: Re2Machine,
    runq,
    nextq,
    pos,
    nextPos,
    rune,
    nextCond,
    anchor,
    atEnd,
  ) {
    charge(runq.size * (1 + this.ncap + runeWork));
    step.call(this, runq, nextq, pos, nextPos, rune, nextCond, anchor, atEnd);
  };
  return machine;
}

/**
 * re2js's NFA machine and an input that charges every character and condition it reads, and never skips ahead to a
 * pattern's leading text with the host's string search, whose work the count cannot see. Both are found once, from a
 * search of an empty text.
 */
let nfa: {
  readonly machine: { fromRE2(engine: Re2Engine): Re2Machine };
  readonly input: new (text: string, start: number, end: number) => Re2Input;
} | null = null;

function nfaClasses(): NonNullable<typeof nfa> {
  if (nfa !== null) return nfa;
  const probe = RE2JS.compile("(a)").re2();
  const inputs: Re2Input[] = [];
  probe.executeEngine = function (input: Re2Input, pos: number, anchor: number, ncap: number) {
    inputs.push(input);
    return this.doExecuteNFA(input, pos, anchor, ncap);
  };
  probe.matchWithGroup("", 0, 0, UNANCHORED, 1);
  const machine: { fromRE2(engine: Re2Engine): Re2Machine } = probe.machinePool[0].constructor;
  const Input: new (text: string, start: number, end: number) => Re2Input = Object.getPrototypeOf(
    inputs[0],
  ).constructor;
  class MeteredInput extends Input {
    override step(pos: number): number {
      charge(1);
      return super.step(pos);
    }

    override context(pos: number): number {
      charge(1);
      return super.context(pos);
    }

    override canCheckPrefix(): boolean {
      return false;
    }
  }
  nfa = { machine, input: MeteredInput };
  return nfa;
}

/** Thrown out of re2js when compiling a regex makes more case lookups than it may. */
const CASE_LOOKUPS_EXCEEDED = new Error("A regex made more case lookups than it may.");

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
 * Runs `work`, re2js compiling or searching, while the case of one character from U+0080 on comes from the pinned pairs
 * instead of the host. re2js folds a character outside its own table with the host's `toLowerCase` and `toUpperCase`,
 * whose Unicode version differs between browsers and their versions, when it ignores case and when it simplifies a
 * class of two characters; it calls them on one character at a time. Every other text keeps the methods the host had,
 * which are back in place when `work` returns or throws. At most `lookups` pinned lookups are made: the count depends
 * only on the pattern, so stopping there gives the same result everywhere.
 */
function withPinnedCase<T>(lookups: number, work: () => T): T {
  const { lower, upper } = pinnedCasePairs();
  const prototype = String.prototype;
  const hostToLowerCase = prototype.toLowerCase;
  const hostToUpperCase = prototype.toUpperCase;
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
  prototype.toLowerCase = pinned(lower, hostToLowerCase);
  prototype.toUpperCase = pinned(upper, hostToUpperCase);
  try {
    return work();
  } finally {
    prototype.toLowerCase = hostToLowerCase;
    prototype.toUpperCase = hostToUpperCase;
  }
}
