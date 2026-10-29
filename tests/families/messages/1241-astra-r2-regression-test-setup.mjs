// captured setup; #1241, Astra review, r2 (R/astra-m4-i1241-review-r2/regression.test.mjs).
export const cases = [
  [
    "original-1",
    'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\nlet converted: duration = box.n\nexit\n',
  ],
  [
    "original-2",
    'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\nsay box.text.size\nexit\n',
  ],
  [
    "original-3",
    'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\nsay box.items + 2\nexit\n',
  ],
  ["original-4", "let box = {n: 2}\nlet converted: duration = box.n\nexit\n"],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node head/tools/test-output-filter.mjs evidence/regression.test.mjs",
      "R/astra-m4-i1241-review-r2/report.md:44",
    ],
  ],
  sources: 4,
  sha256: "cec39d9dd36cb7394432474ed5284143af84799c959824faf3d6bb0de263c3fe",
};
