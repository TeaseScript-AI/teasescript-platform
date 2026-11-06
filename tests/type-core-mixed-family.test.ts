import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import {
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
 * Here, one case per carrier kind, position and order, with the depth, the null's layer and the carried layer turned
 * through their boundaries (the shallow and the deep side, the element and the deepest layer, no null, a layer's, the
 * leaf's), in four modes. The modes agree. Where both checkers report the error, the first sentences are equal, except
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

// (the sample: for each kind, position and order the case whose depth, null layer and carried layer this turn picks)
function sampled(cases: readonly (readonly [string, string])[]): (readonly [string, string])[] {
  const kinds = [...new Set(cases.map(([name]) => mixedDimensions(name).kind))];
  const positions = [...new Set(cases.map(([name]) => mixedDimensions(name).position))];
  const out: (readonly [string, string])[] = [];
  kinds.forEach((kind, k) =>
    positions.forEach((position, p) =>
      [false, true].forEach((later, o) => {
        const depth = [2, 3][(k + p + o) % 2]!;
        const nullAt = [0, 1, depth][(k + p + 2 * o) % 3]!;
        const at = kind === "plain" ? -1 : [0, depth - 1][(k + o) % 2]!;
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
      }),
    ),
  );
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
    if (core[0]!.length === 0 || current.length === 0) continue;
    compared += 1;
    if (mixedExplained(mixedDimensions(name), core[0]!, current, OPEN) === null)
      differing.push(`${name}\n  core: ${core[0]!.join(" | ")}\n  checker: ${current.join(" | ")}`);
  }
  assert.deepEqual(differing, [], `${compared} compared`);
  assert.ok(compared > 0);
});

/**
 * #1765's invariant, its work: each carrier kind deep (a nest behind it, ×4.5 per doubling, as the nest alone grows) and
 * wide (wrapped elements before as many disagreeing ones, ×2.5), at the first doubling of
 * `tests/families/messages/1765-mixed-growth.mjs` (the second runs on the queue). One mode: the four-mode growth tests
 * in `type-core-messages.test.ts` cover the evaluator's other dimensions.
 */
test("a mixed-list error's layers grow linearly behind every carrier kind (#1765)", async () => {
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
    const [small, large] = [sizes[0]!, sizes[1]!].map((size) => total(make(size)));
    const bound = shape.startsWith("deep:") ? 4.5 : 2.5;
    assert.ok(large! <= bound * small!, `${shape}: ${small}, ${large}`);
  }
});
