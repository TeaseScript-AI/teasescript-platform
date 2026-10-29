// S10 part 2, Astra plan review (R/astra-m4-s10p2-plan-review/n5-bound.mjs:18): the witness of the whole-store
// invalidation bound, its one compiled source at k = 4 (its counts at 16 to 64 model the algorithm, compiling nothing).
export const sizes = [4];
const corpus = (() => {
  function source(k) {
    return `let keep: boolean = hostValue\n${Array.from({ length: k }, (_, i) => `let a${i}: integer? = hostValue`).join("\n")}\nlet total: integer? = 0\nif total != null and ${Array.from({ length: k }, (_, i) => `a${i} != null`).join(" and ")} {\nwhile keep {\n total = ${Array.from({ length: k }, (_, i) => `(a${i} otherwise 0)`).join(" + ")}\n ${Array.from({ length: k - 1 }, (_, i) => `a${i} = a${i + 1}`).join("\n ")}\n a${k - 1} = null\n repeat total {}\n}\n}\nexit\n`;
  }
  return { shapes: { source: (n) => source(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "SX_HEAVY_MEM=2G SX_HEAVY_SWAP=0 node evidence/<script>.mjs",
      "R/astra-m4-s10p2-plan-review.md:95",
    ],
  ],
  sources: 1,
  sha256: "6a2c4878ef91a607f9b4ee7e45e0b84dc4c1ea54f0bddff7b0a5d6f5d0168ba4",
};
