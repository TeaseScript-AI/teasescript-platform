// captured nullable; #1241, Astra review, r3 (R/astra-m4-i1241-review-r3/regression.test.mjs).
const generated = [
  [
    "original-1",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = n + 1\nsay converted\nexit",
  ],
  [
    "original-2",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = -n\nsay converted\nexit",
  ],
  [
    "original-3",
    "let choices = [{inner: {n: 2}}, null]\nlet box = choices[1]\nlet converted: duration = box.inner.n\nsay converted\nexit",
  ],
  ["original-4", "let n = 2\nlet converted: duration = n + 1\nsay converted\nexit"],
  ["original-5", "let ns = [2, null]\nlet n = ns[1]\nsay n + 1\nexit"],
];

export const checks = ["publication"];

// The two pasted controls its regression test also compiled (R/astra-m4-i1241-review-r3/regression.test.mjs:22, :28).
const captured = [
  [
    "present arithmetic pasted",
    "let n = 2\nlet converted: duration = (n + 1) s\nsay converted\nexit",
  ],
  ["warning fallback pasted", "let ns = [2, null]\nlet n = ns[1]\nsay (n otherwise 0) + 1\nexit"],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node tools/test-output-filter.mjs <its regression.test.mjs>",
      "R/astra-m4-i1241-review-r3/COMMANDS, builder/COMMANDS",
    ],
  ],
  sources: 7,
  sha256: "ddc2654c7769d8ccbf0ac0bee75156370bab7e1b16adb18932b157917b3b7edf",
};
