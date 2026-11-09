import { compileProject } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { coreRequest } from "./type-core-analysis.js";
import { inMode, MODES, sentences } from "./type-core-oracles.js";

/**
 * #1765's generated mixed-list family
 * (`tests/families/messages/nested-carriers-and-diagnostic-work/nested-mixed-list-null-and-position-product.mjs`): a
 * case's dimensions, its comparison with the current checker, and the inherited classes a difference may be, each
 * exactly its issue's (Codex r12 on #1789: a class predicate alone hid an unrelated difference).
 */
export interface MixedDimensions {
  readonly depth: number;
  readonly nullAt: number;
  /** The twin's null layer where the whole-number side is joined with its twin (`joinNulls`), else 0. */
  readonly twin: number;
  readonly kind: string;
  readonly at: number;
  readonly position: string;
  readonly later: boolean;
}

// (a case's name is its axis values, `<axis>:<value>` in the generator's order of its axes; these are the ones the
// dimensions read. A name with another axis throws until they read it too)
const AXES = ["depth", "nullAt", "at", "kind", "position", "twin", "later"];

/** A case's dimensions, from its name; a name whose axes are not exactly `AXES`, in order, throws. */
export function mixedDimensions(name: string): MixedDimensions {
  const parts = name.split("/").map((part) => part.split(":"));
  if (parts.some((part) => part.length !== 2) || parts.map(([axis]) => axis).join() !== AXES.join())
    throw new Error(`a family case name whose axes are not ${AXES.join(", ")}: ${name}`);
  const value = new Map(parts.map(([axis, text]) => [axis!, text!]));
  const number = (axis: string): number => Number(value.get(axis));
  return {
    depth: number("depth"),
    nullAt: number("nullAt"),
    at: number("at"),
    kind: value.get("kind")!,
    position: value.get("position")!,
    twin: number("twin"),
    later: value.get("later") === "true",
  };
}

const first = (messages: readonly string[]): string[] =>
  [...new Set(messages.map((message) => sentences(message)[0]!))].sort();

/**
 * The first sentences of a source's mixed-list errors, the current checker's and the core's in each of the four modes;
 * `null` for a route that reports none (a source outside the candidate slice there is not compared).
 */
export function mixedSentences(source: string): {
  readonly current: readonly string[];
  readonly core: readonly (readonly string[])[];
} {
  const files = [{ path: "main.tease", source }];
  const current = first(
    compileProject(files, { globals: ["hostValue"] })
      .diagnostics.filter((each) => each.code === "TSV044")
      .map((each) => each.message),
  );
  const request = coreRequest(files);
  const core = MODES.map((mode) =>
    request === null
      ? []
      : inMode(mode, () => {
          const { diagnostics } = analyseCore(request);
          const text = messageSource([source], diagnostics);
          return first(
            diagnostics
              .filter((each) => each.code === "TSV044")
              .map((each) => coreMessage(each, text)),
          );
        }),
  );
  return { current, core };
}

// (the whole-number side's type text in a sentence: the parenthesized type holding `integer`)
const INTEGER_TYPE = /\(([^()]*integer[^()]*)\)/;

/**
 * Each inherited class a case may be, of the issues still `open` on the tree, with what the core says there given the
 * checker's sentence: the checker's sentence changed exactly where the issue's defect is, on the whole-number side.
 * - #1843: an element's own `or null` dropped, for a copy at the element that may be null;
 * - #1847: a `!= null` test of a typed host value not seen, its `?` at the tested layer kept;
 * - #1858: the leaf `?` dropped for an `otherwise` of a typed host value with a `null` fallback, where the whole-number
 *   side is the earliest (its later side's leaf is the occurrence's since #1828).
 */
function mixedInherited(
  row: MixedDimensions,
  open: readonly string[],
): readonly (readonly [string, (sentence: string) => string])[] {
  const out: (readonly [string, (sentence: string) => string])[] = [];
  if (
    open.includes("#1843") &&
    row.at === 0 &&
    ["maybe", "host", "invalidated", "hostOrNull"].includes(row.kind)
  )
    out.push(["#1843", (sentence) => sentence.replace(/(\([^()]*integer[^()]*\)) or null/, "$1")]);
  if (
    open.includes("#1858") &&
    row.kind === "hostOrNull" &&
    row.at === 0 &&
    row.nullAt === row.depth &&
    !row.later
  )
    out.push(["#1858", (sentence) => sentence.replace("integer?", "integer")]);
  if (open.includes("#1847") && row.kind === "notNull" && row.at > 0)
    out.push([
      "#1847",
      (sentence) =>
        sentence.replace(INTEGER_TYPE, (_, type: string) => {
          // (the tested layer's `?`: after the brackets of the layers from the leaf up to it)
          let seen = 0;
          let at = 0;
          const wanted = row.depth - row.at;
          for (; at < type.length && seen < wanted; at += 1) if (type[at] === "]") seen += 1;
          return `(${type.slice(0, at)}${type[at] === "?" ? "" : "?"}${type.slice(at)})`;
        }),
    ]);
  return out;
}

/**
 * The sentences a case compares, the core's and the checker's; `null` where one names no mixed error of the
 * whole-number side (outside the candidate slice there, not compared). A pair joined with a second disagreeing side
 * (`joinTwice`, `joinNulls`) names both joins in the core and the first in the checker: the sentences naming the whole-number side are compared,
 * its true-or-false partner read as the text side; one between the text side and its twin says nothing of it.
 */
export function mixedCompared(
  row: MixedDimensions,
  core: readonly string[],
  current: readonly string[],
): { readonly core: readonly string[]; readonly current: readonly string[] } | null {
  const twin = (sentences: readonly string[]): string[] =>
    row.position === "joinTwice" || row.position === "joinNulls"
      ? [
          ...new Set(
            sentences
              .filter((each) => each.includes("integer"))
              .map((each) => each.replaceAll("boolean", "string")),
          ),
        ].sort()
      : [...sentences];
  const [mine, theirs] = [twin(core), twin(current)];
  return mine.length === 0 || theirs.length === 0 ? null : { core: mine, current: theirs };
}

/**
 * Whether the core's sentences are the checker's, or exactly the checker's under some of the case's inherited classes
 * (each applied to every sentence); the classes that explain the difference, else `null`.
 */
export function mixedExplained(
  row: MixedDimensions,
  core: readonly string[],
  current: readonly string[],
  open: readonly string[],
): readonly string[] | null {
  const same = (expected: readonly string[]): boolean =>
    JSON.stringify([...expected].sort()) === JSON.stringify([...core].sort());
  if (same(current)) return [];
  const classes = mixedInherited(row, open);
  for (let subset = 1; subset < 1 << classes.length; subset += 1) {
    const chosen = classes.filter((_, at) => (subset & (1 << at)) !== 0);
    const expected = current.map((sentence) =>
      chosen.reduce((text, [, change]) => change(text), sentence),
    );
    if (same(expected)) return chosen.map(([issue]) => issue);
  }
  return null;
}
