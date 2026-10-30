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
const generated = captured;

// the own-publication run's inputs whose files the integration run also analysed, with the run's three globals (run-integration.sh:5)
const captured2 = [
  ["r1-witness", "let tree = [{q: [{q: 1}]}]\nlet copy = tree[0].q[0].q\nsay copy\nexit\n"],
  [
    "restarted-stop-depth-1",
    'let box = {n: 1}\nbox.n = 2 + 3\nbox.n = 3 + 4\nbox.n = 4 + 5\nbox.n = 5 + 6\nbox.n = 6 + 7\nbox.n = 7 + 8\nbox.n = 8 + 9\nbox.n = 9 + 10\nbox.n = 10 + 11\nbox.n = 11 + 12\nbox.n = 12 + 13\nbox.n = 13 + 14\nbox = {n: 4}\nrepeat box.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "restarted-stop-depth-2",
    'let box = {branch: {n: 1}}\nbox.branch.n = 2 + 3\nbox.branch.n = 3 + 4\nbox.branch.n = 4 + 5\nbox.branch.n = 5 + 6\nbox.branch.n = 6 + 7\nbox.branch.n = 7 + 8\nbox.branch.n = 8 + 9\nbox.branch.n = 9 + 10\nbox.branch.n = 10 + 11\nbox.branch.n = 11 + 12\nbox.branch.n = 12 + 13\nbox.branch.n = 13 + 14\nbox = {branch: {n: 4}}\nrepeat box.branch.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "restarted-stop-depth-3",
    'let box = {branch: {branch: {n: 1}}}\nbox.branch.branch.n = 2 + 3\nbox.branch.branch.n = 3 + 4\nbox.branch.branch.n = 4 + 5\nbox.branch.branch.n = 5 + 6\nbox.branch.branch.n = 6 + 7\nbox.branch.branch.n = 7 + 8\nbox.branch.branch.n = 8 + 9\nbox.branch.branch.n = 9 + 10\nbox.branch.branch.n = 10 + 11\nbox.branch.branch.n = 11 + 12\nbox.branch.branch.n = 12 + 13\nbox.branch.branch.n = 13 + 14\nbox = {branch: {branch: {n: 4}}}\nrepeat box.branch.branch.n {}\nsay "DONE"\nexit\n',
  ],
];
export const cases = [...generated, ...captured2];

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
  sources: 13,
  sha256: "0f7c600159d540dfcecf776463fa46b7c8776e8dc73000b82ae0275a1ddff5cc",
};
