// captured init; 3a review, round unrecorded (R/pr-3a-closing-check-files/declaration-probe.mjs).
export const cases = [
  [
    "original-1",
    "let a = [[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1]].get(0, default: [2])\nlet r = hashText(a)\nexit",
  ],
  [
    "original-2",
    "let a = [[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1]].get(0, default: [2])\nlet r = hashText(a, default: a)\nexit",
  ],
  [
    "original-3",
    "let a = [[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1]].get(0, default: [2])\nlet r = script(a)\nexit",
  ],
  [
    "original-4",
    "let a = [[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],[1]].get(0, default: [2])\nlet r = script(a, default: a)\nexit",
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node declaration-probe.mjs (no command recorded: its run without arguments)",
      "R/pr-3a-closing-check-files/declaration-probe.mjs",
    ],
  ],
  sources: 4,
  sha256: "9413e7eb020b0eb40ed8e7d8e884433a12a8776caa0b34c4482ea7e0058206c0",
};
