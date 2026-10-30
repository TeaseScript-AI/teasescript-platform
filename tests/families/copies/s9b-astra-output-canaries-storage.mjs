// S9b, Astra plan review (R/astra-m4-s9b-plan-review-evidence/output-canaries.mjs:8): the storage canary, which reads its saved
// value back with a host value, and whose storage types the review dropped.
export const cases = [
  [
    "storage",
    'let score = load("score", default: 1)\nsave hostValue as "score"\nsay "after"\nexit',
  ],
];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node output-canaries.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s9b-plan-review-evidence/output-canaries.mjs",
    ],
  ],
  sources: 1,
  sha256: "3462c9706562b5eabf8d798786a8981fb2274f36351ff8cb2f1e14737913a6b3",
};
