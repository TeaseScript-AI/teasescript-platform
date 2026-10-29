// 1 fixed r3 astra fixture delta source input; Astra review, r3 (R/astra-m4-s8d-r3-evidence/fixture-delta.mjs).
export const cases = (() => {
  const source =
    'let choice: integer | string | null = null\nif askBoolean "Continue?" { choice = "later" }\nsay choice + 2\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node fixture-delta.mjs <root>", "R/astra-m4-s8d-review-r3.md:67"]],
  sources: 1,
  sha256: "cacea70695054375ebcba8a01a336345080d8b07ab8e9b2ea23fcc39765527e0",
};
