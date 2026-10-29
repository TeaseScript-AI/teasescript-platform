// #1272, Astra r2 (R/astra-m4-i1272-review-r2/runtime.mjs:15): a number and a host value stored below a selection of a
// host value, which the probe stopped at an allowance of its stop samples.
export const cases = ["2", "hostValue"].map((value) => [
  value,
  `let box = {random: {first: {last: {n: 1}}}}\nbox.random.first = hostOther\nsay "BEFORE"\nbox.random.first.last.n = ${value}\nsay "AFTER"\nexit\n`,
]);
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node runtime.mjs R/astra-m4-i1272-review-r2", "R/astra-m4-i1272-review-r2/commands.md:28"],
  ],
  sources: 2,
  sha256: "e979ae725308ee4e2fea015e75c25e4bfbd2c7bd6d4e1d46a1c24ab7fec53df0",
};
