// 1 fixed r3 astra read depth source input; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/read-depth.mjs).
export const cases = (() => {
  const source = `repeat hostValue${"[0]".repeat(1040)} {}\nexit`;
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node read-depth.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-r3-evidence/read-depth.mjs",
    ],
  ],
  sources: 1,
  sha256: "793a6d825ecbe66e79a16cf34f16e27412ff0015b48d947c5d7d2e24866f47f6",
};
