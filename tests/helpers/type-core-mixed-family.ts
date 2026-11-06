import { compileProject } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { coreRequest } from "./type-core-analysis.js";
import { inMode, MODES, sentences } from "./type-core-oracles.js";

/**
 * #1765's generated mixed-list family (`tests/families/messages/1765-mixed-family.mjs`): a case's dimensions, its
 * comparison with the current checker, and the inherited classes a difference may be, each exactly its issue's
 * (Codex r12 on #1789: a class predicate alone hid an unrelated difference).
 */
export interface MixedDimensions {
  readonly depth: number;
  readonly nullAt: number;
  readonly kind: string;
  readonly at: number;
  readonly position: string;
  readonly later: boolean;
}

/** A case's dimensions, from its name (`d<depth>/n<null layer>/<kind>@<layer>/<position>/<first|later>`). */
export function mixedDimensions(name: string): MixedDimensions {
  const [depth, nullAt, carried, position, order] = name.split("/");
  const [kind, at] = carried!.split("@");
  return {
    depth: Number(depth!.slice(1)),
    nullAt: Number(nullAt!.slice(1)),
    kind: kind!,
    at: Number(at),
    position: position!,
    later: order === "later",
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
 * - #1790 (#1819): the later element's leaf `null` dropped;
 * - #1843: an element's own `or null` dropped, for a copy at the element that may be null;
 * - #1847: a `!= null` test of a typed host value not seen, its `?` at the tested layer kept.
 */
export function mixedInherited(
  row: MixedDimensions,
  open: readonly string[],
): readonly (readonly [string, (sentence: string) => string])[] {
  const out: (readonly [string, (sentence: string) => string])[] = [];
  if (open.includes("#1790") && row.later && row.nullAt === row.depth)
    out.push(["#1790", (sentence) => sentence.replace("integer?", "integer")]);
  if (
    open.includes("#1843") &&
    row.at === 0 &&
    ["maybe", "host", "invalidated", "hostOrNull"].includes(row.kind)
  )
    out.push(["#1843", (sentence) => sentence.replace(/(\([^()]*integer[^()]*\)) or null/, "$1")]);
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
    JSON.stringify([...expected].sort()) === JSON.stringify(core);
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
