// captured r3 astra speaker check input; astra-m4-s8d-r3-evidence, review/builder evidence
// (R/astra-m4-s8d-r3-evidence/speaker-check.mjs).
export const cases = [
  ["original-1", "player.add(73)\nexit\n"],
  ["original-2", "player.clear()\nexit\n"],
  ["original-3", "say player.rank\nexit\n"],
  ["original-4", "player.rank = 73\nsay player.rank\nexit\n"],
  ["original-5", "say player.get(0)\nexit\n"],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node speaker-check.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-r3-evidence/speaker-check.mjs",
    ],
  ],
  sources: 5,
  sha256: "ac9da5480175ea651c815fd8c0c7cf226296dac7ce586071a9a7b6eef063324c",
};
