import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRangeTree,
  rangeQuery,
  rangeTree,
} from "../../src/plan/instruction-stream-analyses/range-tree.js";

test("a prepared say's range tree gives the lowest and highest source of every range", () => {
  // The bypass check of a prepared say asks for the lowest and highest same-region jump source over the instructions
  // after its producer. A leaf is a source index in [0, N), or the missing value: Infinity for the lowest, -Infinity for
  // the highest. Every range of every size up to 33 (powers of two and their neighbours) is compared with a plain fold.
  let seed = 1;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % bound;
  };
  for (let size = 1; size <= 33; size += 1) {
    // Of every four leaves: none, one, two or three missing on average, and all four.
    for (const missing of [0, 1, 2, 3, 4]) {
      const sources = Array.from({ length: size }, () =>
        random(4) < missing ? undefined : random(size),
      );
      for (const [combine, identity] of [
        [Math.min, Infinity],
        [Math.max, -Infinity],
      ] as const) {
        const values = sources.map((source) => source ?? identity);
        const tree = rangeTree(size, combine, identity);
        values.forEach((value, leaf) => (tree.nodes[size + leaf] = value));
        buildRangeTree(tree);
        for (let first = 0; first < size; first += 1)
          for (let last = first; last < size; last += 1) {
            const actual = rangeQuery(tree, first, last);
            const expected = combine(...values.slice(first, last + 1));
            if (actual !== expected)
              assert.fail(
                `${combine.name} of ${first}..${last} in [${values.join(", ")}]: ${actual}, not ${expected}`,
              );
          }
      }
    }
  }
});
