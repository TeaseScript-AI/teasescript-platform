// 1 fixed astra r2 order witness source input; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/order-witness.mjs).
export const cases = (() => {
  const source =
    'let flagHost = askBoolean "flag"\nlet value: integer | string | null = null\nif flagHost { value = "bad" }\nsay value + 1\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node order-witness.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-review-r2-evidence/order-witness.mjs",
    ],
  ],
  sources: 1,
  sha256: "7edf094c760c428c8a21296a3b2e1309780c8dea336970e7cbf9033da98a42bf",
};
