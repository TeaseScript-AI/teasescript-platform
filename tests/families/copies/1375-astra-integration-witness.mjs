// 1 fixed astra integration witness input; #1375 Astra review r1 (R/astra-m4-g3-p1-review-evidence/integration.mjs).
export const cases = (() => {
  const source =
    'let root = {q: {n: 1}}\nroot.q.n = "bad"\nroot.q.n = 3\nlet copy = [root.q]\nsay copy[0].n\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node integration.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-g3-p1-review-evidence/integration.mjs",
    ],
  ],
  sources: 1,
  sha256: "70558ea9c1c0027d8968dabe79dd00eae2bfe08a742a4240dfe2869fc445b2c8",
};
