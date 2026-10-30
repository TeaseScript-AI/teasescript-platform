// The harness's own source; #1165 / S8, Astra review, r2 (R/astra-m4-s8c-review-r2-evidence/worker/harness.mjs).
// Its run also analysed the failing samples of #1165's matrix
// (desktop:~/work/evidence/1165/c4866420d9bf…/matrix/q/), another run's case files, which the corpus does not copy.
export const cases = [["source-018", 'let value: integer = "wrong"\nexit']];

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node worker/harness.mjs", "R/astra-m4-s8c-review-r2-evidence/worker/run-harness.sh:3"],
  ],
  sources: 1,
  sha256: "349c68b21add3dc524803b87db2ca29103540077b4fcb025405d6bb90886a6d6",
};
