// 1 fixed astra finishing source input; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8b-evidence/finishing.mjs).
export const cases = (() => {
  const source =
    "let count = 3\nrepeat count {}\n" +
    "if true {\n".repeat(257) +
    "repeat hostValue {}\n" +
    "}\n".repeat(257) +
    "repeat 0.5 {}\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node finishing.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-evidence/finishing.mjs",
    ],
  ],
  sources: 1,
  sha256: "19d4c39e5e54e2d98f222a574396bef979cbbc45868bcd9467c5160e70e1942f",
};
