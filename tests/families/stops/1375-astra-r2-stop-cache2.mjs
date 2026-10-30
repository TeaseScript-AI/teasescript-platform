// 5 fixed astra r2 stop cache2 inputs; #1375 Astra review r2
// (R/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache2.mjs).
const fixedCases = [
  ["inline-1", "let box = [{n: 1}]\nsay box[0].n\nexit\n"],
  ["inline-2", "let box = [[{n: 1}]]\nsay box.first.first.n\nexit\n"],
  ["inline-3", "let v: integer? = null\nlet a = {n: v}\nsay a.n otherwise 2\nexit\n"],
  ["inline-4", "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n"],
  ["inline-5", "let a = {n: 1}\nsay [a][0].n\nexit\n"],
];
export const cases = fixedCases;
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node stop-cache2.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache2.mjs",
    ],
  ],
  sources: 6,
  sha256: "f128eefecb80490216ecd211cd57db7b2378ec4fe78fa2aafd410d8f9a7cb9a0",
  dropped: [
    [
      "16db8c5fefc1b80ded2780d63a51a2a581e88ecc92e18e27d613b750c5e02997",
      "Since-removed choose(...) interaction spelling, not an intended parser/name failure: the driver tests cache answers for an option selection and skips null requests. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache2.mjs:1,16,22-23. main reports TSP032 for choose/parenthesized askChoice.",
    ],
  ],
};
