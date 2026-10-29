// random-selection control; unintended collision input excluded; Astra review, r2
// (R/astra-m4-s8d-review-r2-evidence/check-extra.mjs).
const generated = [
  [
    "original-2",
    "let groups: integer[][] = [[], [21]]\nif groups.random.length > 0 { say groups.random.last }\nexit\n",
  ],
];

export const checks = ["publication"];

// collision-applied: the offered temporary name declared twice, the intended TSV001 its verdict shows
// (R/astra-m4-s8d-review-r2-evidence/check-extra.mjs:3, verdict-comment.md:38).
const captured = [
  [
    "collision-applied",
    'let value = "inventory"\nlet remaining = [3, null]\nlet value = remaining[0]\nif value != null { repeat value {} }\nsay value\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node check-extra.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-review-r2-evidence/check-extra.mjs",
    ],
  ],
  sources: 2,
  sha256: "beae05a88c5ca58ce069c1baf8fd2a1cc5daf13841bedda5a47555c3fa5ce3b3",
};
