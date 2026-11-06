import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import type { MixedDimensions } from "./helpers/type-core-mixed-family.js";
import {
  mixedCompared,
  mixedDimensions,
  mixedExplained,
  mixedSentences,
} from "./helpers/type-core-mixed-family.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

/**
 * #1765's invariant (the lead's family rule on #1789, after Codex r9–r11 and Astra r2), sampled as the owner's
 * test-cost rule asks. The full product is `tests/families/messages/1765-mixed-family.mjs` (run on the queue):
 * - a whole-number side two or three lists deep against its text twin;
 * - its `null` at no layer, at a layer or at the leaf;
 * - at the element or a layer its value carried, or a copy (narrowed, maybe null, held, typed host values tested or
 *   not, an `otherwise` of a copy);
 * - the pair as elements, properties or `+` operands, joined again with a second disagreeing side, or the whole-number
 *   side a `+` of two whose nulls are at different layers;
 * - both orders.
 * Here, each kind at every position with every relation of its carried layer to the null (`RELATIONS`: the null one
 * and two layers below it, inside and at the leaf, three below at the leaf, at its layer, none), the order turned
 * through them, and the two joined positions (`ONE`: the twin's join in both orders of its answers) in both orders;
 * then each case that brings a class the sample lacks (`classes`, the coverage invariant); in four modes. The modes agree. Where both checkers report the error, the first sentences are equal, except
 * the inherited classes, each its issue's work:
 * - the later element's leaf `null`, #1790 (#1819, stacked on this);
 * - an element's own `or null` (a copy at the element that may be null, by flow or from the host), #1843;
 * - a typed host value under `!= null`, which leaves no mark on its unknown items, #1847;
 * - the earliest side's leaf `?` of an `otherwise` of a typed host value with a `null` fallback, #1858.
 * Each class is exactly its issue's change of the checker's sentence (`mixedExplained`, Codex r12 on #1789). A source
 * only one checker reports on is outside the candidate slice there and is not compared.
 */

/** The family modules (the families' module contract), read where the tests run. */
async function family<T>(name: string): Promise<T> {
  const file = resolve(process.cwd(), `tests/families/messages/${name}`);
  // EVIDENCE: the family modules export `cases` (name and source) and `shapes` with `sizes` (the module contract).
  return (await import(pathToFileURL(file).href)) as T;
}

// (the issues still open here, each a class of differences `mixedExplained` names exactly)
const OPEN = ["#1790", "#1843", "#1847", "#1858"];

// (the sample: each kind at every position with every relation of its carried layer to the null (`RELATIONS`, the
// null's distance below it inside a list and at the leaf), the order turned through them; the joined positions at one
// relation or two (`ONE`): a second disagreeing side asks the first join again at the interior relation, and the side
// joined with its twin in both orders of their answers, the side's null above the twin's (Codex r17's witness) and
// below it (a copy two lists in, the twin's at the element's own layer, Codex r18))
type Relation = readonly [depth: number, at: number, nullAt: number];
const RELATIONS: readonly Relation[] = [
  [3, 1, 2],
  [3, 0, 2],
  [3, 0, 3],
  [3, 1, 3],
  [3, 2, 0],
  [3, 1, 1],
  [2, 0, 1],
  [2, 1, 2],
];
const ONE: Readonly<Record<string, readonly Relation[]>> = {
  joinTwice: [[3, 1, 2]],
  joinNulls: [
    [3, 1, 1],
    [3, 2, 0],
  ],
};

// (the coverage invariant, the lead's after Codex r16–r18 each found an axis those relations missed: a case's classes,
// from its name, which is exactly its values on the generator's axes (`axes`, the only values a case varies by). One
// per value of each axis; the relation (the depth triple) and the side's null above or below its twin's; and one per
// pair of axes the transport composes (the relation with the order, the carried layer with the kind). The sample holds
// every class the family has)
function classes(row: MixedDimensions): string[] {
  const relation = `${row.depth},${row.at},${row.nullAt}`;
  const twin =
    row.twin === 0 ? "-" : row.nullAt === 0 ? "free" : row.nullAt < row.twin ? "above" : "below";
  return [
    ...Object.entries(row).map(([axis, value]) => `${axis} ${String(value)}`),
    `relation ${relation}`,
    `twin ${twin}`,
    `relation×later ${relation} ${row.later}`,
    `layer×kind ${row.depth}@${row.at} ${row.kind}`,
  ];
}

function sampled(
  cases: readonly (readonly [string, string])[],
  axes: readonly string[],
): (readonly [string, string])[] {
  // (each case's name is its values on the generator's axes, so a value a case varies by is one the invariant reads)
  for (const [name] of cases) assert.deepEqual(Object.keys(mixedDimensions(name)), axes, name);
  const kinds = [...new Set(cases.map(([name]) => mixedDimensions(name).kind))];
  const positions = [...new Set(cases.map(([name]) => mixedDimensions(name).position))];
  const out: (readonly [string, string])[] = [];
  let turn = 0;
  for (const kind of kinds)
    for (const position of positions)
      for (const [depth, carried, nullAt] of ONE[position] ?? RELATIONS)
        for (const later of position in ONE ? [false, true] : [turn++ % 2 === 1]) {
          const at = kind === "plain" ? -1 : carried;
          const found = cases.find(([name]) => {
            const d = mixedDimensions(name);
            return (
              d.kind === kind &&
              d.position === position &&
              d.later === later &&
              d.depth === depth &&
              d.nullAt === nullAt &&
              d.at === at
            );
          });
          assert.ok(found !== undefined, `${kind} ${position} ${later}`);
          out.push(found);
        }
  // (then each case, in the family's order, that brings a class no sampled case has)
  const taken = new Set(out.flatMap(([name]) => classes(mixedDimensions(name))));
  for (const each of cases) {
    const mine = classes(mixedDimensions(each[0]));
    if (mine.every((one) => taken.has(one))) continue;
    out.push(each);
    for (const one of mine) taken.add(one);
  }
  return out;
}

test("a mixed-list error's type text equals the current checker's across the sampled family (#1765)", async () => {
  const { cases, axes } = await family<{
    cases: readonly (readonly [string, string])[];
    axes: readonly (readonly [string, unknown])[];
  }>("1765-mixed-family.mjs");
  const differing: string[] = [];
  let compared = 0;
  for (const [name, source] of sampled(
    cases,
    axes.map(([axis]) => axis),
  )) {
    const { current, core } = mixedSentences(source);
    for (const each of core) assert.deepEqual(each, core[0], name);
    const row = mixedDimensions(name);
    const pair = mixedCompared(row, core[0]!, current);
    if (pair === null) continue;
    compared += 1;
    if (mixedExplained(row, pair.core, pair.current, OPEN) === null)
      differing.push(
        `${name}\n  core: ${pair.core.join(" | ")}\n  checker: ${pair.current.join(" | ")}`,
      );
  }
  assert.deepEqual(differing, [], `${compared} compared`);
  assert.ok(compared > 0);
});

/**
 * #1765's invariant, its work (the lead's family rule): each composition dimension of
 * `tests/families/messages/1765-mixed-growth.mjs` (nest depth, join width, the otherwise chain, index chains, null
 * density, each carrier kind deep, wide and at every depth) at its first doubling, in one mode. The queue runs both
 * doublings in four modes against main, the head's work over main's flat (#1857 names the shapes main itself grows
 * past their bound on).
 */
test("a mixed-list error's work grows as its dimensions do (#1765)", async () => {
  const { shapes, sizes } = await family<{
    shapes: Record<string, (size: number) => string>;
    sizes: readonly number[];
  }>("1765-mixed-growth.mjs");
  const total = (source: string): number => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const answers = inMode(MODES[0]!, () => analyseCore(request));
    assert.equal(answers.budget.exhausted, null, source);
    return answers.budget.total;
  };
  for (const [shape, make] of Object.entries(shapes)) {
    // (width and the otherwise chain linear, ×2.5; depth as the errors' paths grow, ×4.5)
    const bound = /^(wide:|join-width:|otherwise-chain)/.test(shape) ? 2.5 : 4.5;
    const [small, large] = [sizes[0]!, sizes[1]!].map((size) => total(make(size)));
    assert.ok(large! <= bound * small!, `${shape}: ${small}, ${large}`);
  }
});
