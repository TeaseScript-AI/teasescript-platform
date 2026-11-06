import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
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
 * - the pair as elements, properties or `+` operands;
 * - both orders.
 * Here, each kind at every position with every relation of its carried layer to the null (`RELATIONS`: an interior
 * carrier with the null below it, the element's with the leaf's, the deepest with none, the null at its layer, the
 * shallow side's two), and joined again with a second disagreeing side at the interior relation, the order turned
 * through them, in four modes. The modes agree. Where both checkers report the error, the first sentences are equal, except
 * the inherited classes, each its issue's work:
 * - the later element's leaf `null`, #1790 (#1819, stacked on this);
 * - an element's own `or null` (a copy at the element that may be null, by flow or from the host), #1843;
 * - a typed host value under `!= null`, which leaves no mark on its unknown items, #1847.
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
const OPEN = ["#1790", "#1843", "#1847"];

// (the sample: each kind at every position with every relation of its carried layer to the null (`RELATIONS`), the
// order turned through them; joined again with a second disagreeing side, the interior relation only. The structural
// combinations of kind, position and null, not a rotation over their marginals, Codex r14–r16)
const RELATIONS: readonly (readonly [depth: number, at: number, nullAt: number])[] = [
  [3, 1, 2],
  [3, 0, 3],
  [3, 2, 0],
  [3, 1, 1],
  [2, 0, 1],
  [2, 1, 2],
];

function sampled(cases: readonly (readonly [string, string])[]): (readonly [string, string])[] {
  const kinds = [...new Set(cases.map(([name]) => mixedDimensions(name).kind))];
  const positions = [...new Set(cases.map(([name]) => mixedDimensions(name).position))];
  const out: (readonly [string, string])[] = [];
  let turn = 0;
  for (const kind of kinds)
    for (const position of positions)
      for (const [depth, carried, nullAt] of position === "joinTwice"
        ? RELATIONS.slice(0, 1)
        : RELATIONS) {
        const later = turn++ % 2 === 1;
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
  return out;
}

test("a mixed-list error's type text equals the current checker's across the sampled family (#1765)", async () => {
  const { cases } = await family<{ cases: readonly (readonly [string, string])[] }>(
    "1765-mixed-family.mjs",
  );
  const differing: string[] = [];
  let compared = 0;
  for (const [name, source] of sampled(cases)) {
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
