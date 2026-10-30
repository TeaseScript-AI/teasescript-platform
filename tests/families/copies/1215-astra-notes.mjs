// 3 fixed astra notes inputs; #1215, astra-m4-i1215-review-evidence, review/builder evidence
// (R/astra-m4-i1215-review-evidence/notes.mjs).
const fixedCases = [
  [
    "inline-1",
    'let seed: object = {payload: 7}\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
  ],
  [
    "inline-2",
    'let seed: integer = 7\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
  ],
  [
    "inline-3",
    'let seed: object = {payload: 7}\nlet copy = {open: seed}\ncopy = hostValue\nsay "REACHED"\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node notes.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1215-review-evidence/notes.mjs",
    ],
  ],
  sources: 3,
  sha256: "8e8c4256f6379163099bdefc06171cf89c30a6796263b23824aa3715b9641d8a",
};
