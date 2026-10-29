// #1375, Astra r2 (R/astra-m4-g3-p1-review-r2-evidence/own-publication-cases.json): the review's own nested chains and
// descendants, as run-integration.sh published them with builder/probe/publication.mjs.
export const checks = ["publication"];

// The case list, as its file holds it.
const captured = [
  ["chain-1-false", 'let plant = {twig0: 1, quiet: "ok"}\nsay plant.twig0\nexit\n'],
  ["chain-1-true", "let plant = [1]\nsay plant[0]\nexit\n"],
  [
    "chain-3-false",
    'let plant = {twig0: [{twig2: 1, quiet: "ok"}], quiet: "ok"}\nsay plant.twig0[0].twig2\nexit\n',
  ],
  ["chain-3-true", 'let plant = [{twig1: [1], quiet: "ok"}]\nsay plant[0].twig1[0]\nexit\n'],
  [
    "chain-5-false",
    'let plant = {twig0: [{twig2: [{twig4: 1, quiet: "ok"}], quiet: "ok"}], quiet: "ok"}\nsay plant.twig0[0].twig2[0].twig4\nexit\n',
  ],
  [
    "chain-5-true",
    'let plant = [{twig1: [{twig3: [1], quiet: "ok"}], quiet: "ok"}]\nsay plant[0].twig1[0].twig3[0]\nexit\n',
  ],
  [
    "selection-descendants",
    "let plant = [{branch: [{leaf: 1}]}]\nsay plant.first.branch[0].leaf\nexit\n",
  ],
  [
    "operation-descendants",
    "let seed: integer? = null\nlet plant = {branch: {leaf: [seed]}}\nsay (plant.branch otherwise {leaf: [2]}).leaf[0]\nexit\n",
  ],
  [
    "branching-occurrences",
    'let plant = {left: [{leaf: 1}], right: [{leaf: "x"}]}\nsay plant.left[0].leaf\nsay plant.right[0].leaf\nsay plant.left[0].leaf\nexit\n',
  ],
];
export const cases = captured;

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "PUBLICATION_TEXT=1 node publication.mjs <tree>/dist own-publication-cases.json own",
      "R/astra-m4-g3-p1-review-r2-evidence/run-integration.sh:5",
    ],
  ],
  sources: 9,
  sha256: "ae73ca79b0f2127f55cf29f554d363a3522dbdfb269aeea00ffb7588bbe019f1",
};
