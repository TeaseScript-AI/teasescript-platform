// index step, property and related fixed cases; #1375 Astra review r2
// (R/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache.mjs).
export const cases = (() => {
  const cases = [
    ["index step", "let box = [{n: 1}]\nsay box[0].n\nexit\n", "box[0].n", "box", ["element"]],
    ["property", "let box = {q: {n: 1}}\nsay box.q.n\nexit\n", "box.q.n", "box", ["q"]],
    [
      "selection",
      "let box = [[{n: 1}]]\nsay box.first.first.n\nexit\n",
      "box.first.first",
      "box",
      ["element"],
    ],
    [
      "selection then property",
      "let box = [{n: 1}]\nsay box.first.n\nexit\n",
      "box.first.n",
      "box",
      ["element"],
    ],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node stop-cache.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache.mjs",
    ],
  ],
  sources: 4,
  sha256: "70a0f5265203b416c9a7d732eb75bee14468df9f5a0b20f36d8fa5d59a22e085",
};
