// 1 fixed astra r2 r1 exact source input; #1165 / S8, Astra review, r2
// (R/astra-m4-s8c-review-r2-evidence/worker/r1-exact.mjs).
export const cases = (() => {
  const source =
    'let tally = 1\ntally = 2\ntally = hostValue\nlet picked: integer = tally\nrepeat tally {}\nsay "DONE"\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node worker/r1-exact.mjs", "R/astra-m4-s8c-review-r2-evidence/worker/run-exact.sh:3"],
  ],
  sources: 1,
  sha256: "bb990976af129bb81c743b6f14d0487bbdebb25df1c9731f02e191fa16cb77d7",
};
