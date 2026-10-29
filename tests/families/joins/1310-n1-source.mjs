// 1 fixed n1 source input; #1310, builder/review archive
// (desktop:~/work/evidence/1310/e31779d45c8bc60b3426f1c670403156674312a1/pre-rebase-6d8f874a7/tools/n1.mjs).
export const cases = (() => {
  const source = 'let xs = [1]\nlet ys = xs + ([1] + ["a"])\nsay ys.length\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node n1.mjs (no command recorded: its run without arguments)",
      "desktop:~/work/evidence/1310/e31779d45c8bc60b3426f1c670403156674312a1/pre-rebase-6d8f874a7/tools/n1.mjs",
    ],
  ],
  sources: 1,
  sha256: "21cb7710f723207d45dc01b1d280612e9b49ef07133157e8306c1c0ea5c37495",
};
