// 1 fixed astra verify mutant source input; Astra review, round unrecorded
// (R/astra-m4-s8d-review-evidence/verify-mutant.mjs).
export const cases = (() => {
  const source =
    "let packet = {random: 4.5}\nlet whole: integer = packet.random\nsay whole\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node verify-mutant.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-review-evidence/verify-mutant.mjs",
    ],
  ],
  sources: 1,
  sha256: "4ff5b2d6089e59feedf035fd7d71fdb16578142dfabe948cee699a5f8ea14fa0",
};
