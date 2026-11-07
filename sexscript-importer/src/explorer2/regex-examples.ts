/**
 * Texts a regex may match as a whole, for a typed answer a condition tests with `matches` (an email address, a code of
 * so many digits): the shortest one, and one with a few more repeats. They are guesses from RE2's syntax as far as this
 * reads it; the runtime's own matcher keeps those that match. A construct it does not read (a Unicode class, a flag
 * group, quoted text) gives none.
 */
export function regexExamples(pattern: string, flags: string): string[] {
  const examples = new Set<string>();
  try {
    const parsed = new RegexReader(pattern, flags.includes("i")).read();
    for (const extra of [0, 2])
      try {
        examples.add(textOf(parsed, extra));
      } catch (error) {
        if (!(error instanceof Unread)) throw error;
      }
  } catch (error) {
    if (!(error instanceof Unread)) throw error;
  }
  return [...examples].filter((text) => [...text].length <= MAX_EXAMPLE);
}

/**
 * The longest example, in characters, the most repeats one quantifier may ask for, and the deepest groups: answers a
 * player types.
 */
const MAX_EXAMPLE = 256;
const MAX_REPEATS = 1000;
const MAX_DEPTH = 64;
/** Characters an example takes from a class, in this order: plain ones first. */
const POOL = [..."xa1A_ .-@/0bZ", "é"];

/** A part of a regex: one character of a set, parts one after another, alternatives, or a repeated part. */
type Part =
  | { readonly kind: "character"; readonly text: string }
  | { readonly kind: "sequence"; readonly parts: readonly Part[] }
  | { readonly kind: "choice"; readonly parts: readonly Part[] }
  | { readonly kind: "repeat"; readonly part: Part; readonly min: number; readonly max: number };

class Unread extends Error {}

/** One character the class has: `\d`, a range, a single character, or the opposite of one of them. */
type Member = (character: string) => boolean;

const DIGIT: Member = (character) => /^[0-9]$/.test(character);
const WORD: Member = (character) => /^[A-Za-z0-9_]$/.test(character);
// RE2's \s is \t \n \f \r and space.
const SPACE: Member = (character) => "\t\n\f\r ".includes(character);
const SETS: Readonly<Record<string, Member>> = { d: DIGIT, w: WORD, s: SPACE };

/** A one-character part with the characters `accepts` takes, `preferred` first. */
function character(accepts: Member, preferred: readonly string[] = []): Part {
  // The first that fits: a class of thousands of members is tested once per candidate, not once per member.
  const text = [...preferred, ...POOL].find(accepts);
  if (text === undefined) throw new Unread();
  return { kind: "character", text };
}

class RegexReader {
  readonly #pattern: string;
  /** With the `i` flag, a class holds each member in either case (`[^x]` takes no `X` either). */
  readonly #ignoreCase: boolean;
  #at = 0;
  #depth = 0;

  constructor(pattern: string, ignoreCase: boolean) {
    this.#pattern = pattern;
    this.#ignoreCase = ignoreCase;
  }

  read(): Part {
    const parsed = this.#choice();
    if (this.#at < this.#pattern.length) throw new Unread();
    return parsed;
  }

  #peek(): string {
    return this.#pattern[this.#at] ?? "";
  }

  #take(): string {
    const point = this.#pattern.codePointAt(this.#at);
    if (point === undefined) throw new Unread();
    const taken = String.fromCodePoint(point);
    this.#at += taken.length;
    return taken;
  }

  #choice(): Part {
    const parts = [this.#sequence()];
    while (this.#peek() === "|") {
      this.#at += 1;
      parts.push(this.#sequence());
    }
    return parts.length === 1 ? parts[0]! : { kind: "choice", parts };
  }

  #sequence(): Part {
    const parts: Part[] = [];
    while (this.#at < this.#pattern.length && this.#peek() !== "|" && this.#peek() !== ")")
      parts.push(this.#repeated(this.#single()));
    return { kind: "sequence", parts };
  }

  /** A part with the quantifier after it, if any (a lazy one matches the same texts). */
  #repeated(part: Part): Part {
    const next = this.#peek();
    let min: number;
    let max: number;
    const counted = /^\{(\d+)(,(\d*))?\}/.exec(this.#pattern.slice(this.#at));
    if (next === "*" || next === "+" || next === "?") {
      min = next === "+" ? 1 : 0;
      max = next === "?" ? 1 : Infinity;
      this.#at += 1;
    } else if (counted !== null) {
      min = Number(counted[1]);
      max = counted[2] === undefined ? min : counted[3] === "" ? Infinity : Number(counted[3]);
      if (min > MAX_REPEATS || max < min || (max !== Infinity && max > MAX_REPEATS))
        throw new Unread();
      this.#at += counted[0].length;
    } else return part;
    if (this.#peek() === "?") this.#at += 1;
    return { kind: "repeat", part, min, max };
  }

  #single(): Part {
    const next = this.#take();
    if (next === "(") return this.#group();
    if (next === "[") return this.#class();
    if (next === ".") return character((each) => each !== "\n");
    // Anchors take no text: an example is a whole answer.
    if (next === "^" || next === "$") return { kind: "sequence", parts: [] };
    if (next === "\\") {
      const escaped = this.#escape();
      return typeof escaped === "function" ? character(escaped) : escaped;
    }
    if ("*+?".includes(next)) throw new Unread();
    return character((each) => each === next, [next]);
  }

  #group(): Part {
    if (this.#peek() === "?") {
      const named = /^\?(?:P?<[A-Za-z0-9_]+>|:)/.exec(this.#pattern.slice(this.#at));
      // Flag groups change how the rest reads.
      if (named === null) throw new Unread();
      this.#at += named[0].length;
    }
    if (++this.#depth > MAX_DEPTH) throw new Unread();
    const inside = this.#choice();
    if (this.#take() !== ")") throw new Unread();
    this.#depth -= 1;
    return inside;
  }

  /** An escape: a set of characters, one character, or an assertion (which takes no text). */
  #escape(): Part | Member {
    const next = this.#take();
    const set = SETS[next.toLowerCase()];
    if (set !== undefined) return next === next.toLowerCase() ? set : (each: string) => !set(each);
    if ("bBAz".includes(next)) return { kind: "sequence", parts: [] };
    const controls: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      f: "\f",
      v: "\v",
      a: "\x07",
    };
    const control = controls[next];
    if (control !== undefined) return character((each) => each === control, [control]);
    if (next === "x") {
      const hex = /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{2}))/.exec(
        this.#pattern.slice(this.#at),
      );
      if (hex === null) throw new Unread();
      this.#at += hex[0].length;
      const point = Number.parseInt(hex[1] ?? hex[2]!, 16);
      if (point > 0x10ffff) throw new Unread();
      const exact = String.fromCodePoint(point);
      return character((each) => each === exact, [exact]);
    }
    // Letters and digits name classes, properties, or back references this does not read; punctuation stands for itself.
    if (/^[A-Za-z0-9]$/.test(next)) throw new Unread();
    return character((each) => each === next, [next]);
  }

  /** A bracketed class, as one character it takes. */
  #class(): Part {
    const negated = this.#peek() === "^";
    if (negated) this.#at += 1;
    const members: Member[] = [];
    const preferred: string[] = [];
    // A `]` first is a member.
    for (let first = true; first || this.#peek() !== "]"; first = false) {
      if (this.#at >= this.#pattern.length || this.#pattern.startsWith("[:", this.#at))
        throw new Unread();
      let low = this.#take();
      if (low === "\\") {
        const escaped = this.#escape();
        if (typeof escaped === "function") {
          members.push(escaped);
          continue;
        }
        if (escaped.kind !== "character") throw new Unread();
        low = escaped.text;
      }
      if (this.#peek() === "-" && this.#pattern[this.#at + 1] !== "]") {
        this.#at += 1;
        let high = this.#take();
        if (high === "\\") {
          const escaped = this.#escape();
          if (typeof escaped === "function" || escaped.kind !== "character") throw new Unread();
          high = escaped.text;
        }
        const from = low.codePointAt(0)!;
        const to = high.codePointAt(0)!;
        if (to < from) throw new Unread();
        members.push((each) => from <= each.codePointAt(0)! && each.codePointAt(0)! <= to);
        preferred.push(low);
      } else {
        const exact = low;
        members.push((each) => each === exact);
        preferred.push(exact);
      }
    }
    this.#at += 1;
    return character(
      (each) =>
        members.some(
          (member) =>
            member(each) ||
            (this.#ignoreCase && (member(each.toLowerCase()) || member(each.toUpperCase()))),
        ) !== negated,
      negated ? [] : preferred,
    );
  }
}

/**
 * The text of a part with each repeat `extra` times more than its least (as far as it may), the shortest alternative
 * that has one; none when it grows past an example's length (repeats of repeats).
 */
function textOf(part: Part, extra: number): string {
  if (part.kind === "character") return part.text;
  let text: string;
  if (part.kind === "sequence") text = part.parts.map((each) => textOf(each, extra)).join("");
  else if (part.kind === "choice") {
    const texts = part.parts.flatMap((each) => {
      try {
        return [textOf(each, extra)];
      } catch (error) {
        if (error instanceof Unread) return [];
        throw error;
      }
    });
    if (texts.length === 0) throw new Unread();
    text = texts.reduce((shortest, each) =>
      [...each].length < [...shortest].length ? each : shortest,
    );
  } else {
    const count = Math.min(part.max, part.min + extra);
    // No copies need no text of the part (an optional group of a long text).
    text = count === 0 ? "" : grown(textOf(part.part, extra), count);
  }
  if (text.length > 2 * MAX_EXAMPLE) throw new Unread();
  return text;
}

/** A text repeated `count` times, refused before it would grow past an example's length. */
function grown(text: string, count: number): string {
  if (text.length * count > 2 * MAX_EXAMPLE) throw new Unread();
  return text.repeat(count);
}
