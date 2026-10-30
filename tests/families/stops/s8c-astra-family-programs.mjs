// scalar, list and related fixed cases; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8c-review-evidence/builder/generators/tools/family.mjs).
export const cases = (() => {
  const tail = '\nsay n\nrepeat 2 { say "AFTER" }\nexit\n';
  const programs = {
    scalar: 'let n = 1\nn = "wrong"' + tail,
    list: 'let n = [1]\nn = ["wrong"]' + tail,
    object: 'let n = {x: 1}\nn = {x: "wrong"}' + tail,
    nested: 'let n = {x: {y: 1}}\nn = {x: {y: "wrong"}}' + tail,
    decimal: "let n = 1\nn = 2.5" + tail,
    copy: 'let n = 1\nn = "wrong"\nlet m = n' + tail,
  };
  return Object.entries(programs);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node "$g/family.mjs" "$base/head"',
      "R/astra-m4-s8c-review-evidence/builder/generators/jobs/reviewers.sh:11",
    ],
  ],
  sources: 6,
  sha256: "eb36a623cbf38adc8821791a250e4907ca93bd88637131bd6bd502a5dc25f078",
};
