// B1, B2 and related fixed cases; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8c-review-evidence/builder/generators/tools/repro-report.mjs).
export const cases = (() => {
  const cases = {
    B1: 'let n = 1\nn = "wrong"\nsay "AFTER"\nexit\n',
    B2: 'let base: integer[]? = hostValue\nlet copy = base\nsay copy.length\nsay "AFTER"\nexit\n',
    B3: 'let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nif flag { room = {other: 0} }\nsay room.n\nsay room.n\nsay "DONE"\nexit\n',
  };
  return Object.entries(cases);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node "$g/repro-report.mjs" "$base/head"',
      "R/astra-m4-s8c-review-evidence/builder/generators/jobs/reviewers.sh:10",
    ],
  ],
  sources: 3,
  sha256: "748b644dd3167b1e4e4a85a91a20341e525b7751a2ad199c4e6058948f3463e2",
};
