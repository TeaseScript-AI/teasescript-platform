// 1 fixed sol guard probe source input; #1188, Sol review, r1 (R/sol-m4-i1188-held-nodes-r1-evidence/guard-probe.mjs).
export const cases = (() => {
  const source =
    'let typed: integer = 1\nlet word: string = "x"\nlet a = {n: typed}\nlet b = {n: word}\nlet c = a\nc = b\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe/guard-probe.mjs /home/peter/work/sol-m4-i1188-held-nodes-r1/src",
      "R/sol-m4-i1188-held-nodes-r1-evidence/focused.sh:5",
    ],
  ],
  sources: 1,
  sha256: "c16e34db4bed589959c4c4fddf16ce9b14b48f9ac06437fb5c0c1ee6868a2905",
};
