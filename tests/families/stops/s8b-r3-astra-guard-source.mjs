// 1 fixed r3 astra guard source input; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/guard.mjs).
export const cases = (() => {
  const source = "repeat 1.25 {}\nlet flag:boolean=hostValue\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node guard.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-r3-evidence/guard.mjs",
    ],
  ],
  sources: 1,
  sha256: "de0f9d90e0b2a7610dbe3c362b38e661925e5d27e120be492af238a9996bb23a",
};
