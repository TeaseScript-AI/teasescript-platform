// S9b, Astra plan review (R/astra-m4-s9b-plan-review-evidence/output-canaries.mjs:7): the output canaries compiled without
// host values, each of whose plan facts the review dropped in turn.
export const cases = [
  [
    "ways",
    'speaker guide { firstName: "Ada" }\nlet count = 2\nif count is integer { guide.mood = "calm" }\nsay guide.mood\nexit',
  ],
  ["form", 'let answers = askForm fields: { amount: { type: "number", value: 1 } }\nexit'],
  ["speaker", 'speaker guide { firstName: "Ada" }\nsay guide.mood\nguide.mood = "calm"\nexit'],
];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node output-canaries.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s9b-plan-review-evidence/output-canaries.mjs",
    ],
  ],
  sources: 3,
  sha256: "6b7cbf9293a725d531d698fb9c8dd74bb889e7180f7aacb132f32b9b703a0639",
};
