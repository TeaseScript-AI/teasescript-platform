// 1 fixed astra combine source input; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8c-review-evidence/worker/combine.mjs).
export const cases = (() => {
  const source = [
    "let tally = 1",
    ...Array.from({ length: 24 }, (_, i) => `tally = ${i + 2}`),
    "tally = hostValue",
    "let picked: integer = tally",
    "repeat tally {}",
    'say "DONE"',
    "exit",
  ].join("\n");
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "/home/peter/opt/node-24.18/bin/node combine.mjs",
      "R/astra-m4-s8c-review-evidence/worker/start.sh:5",
    ],
  ],
  sources: 1,
  sha256: "c263afee577bb3c5ea515e26dec3e586a3dcfcd261e905c8ddee0f974b7b1c7c",
};
