// The compiled test files that take longest, costliest first: every file whose tests take 30 s or more together in a
// measured run of the suite as CI runs it (`docs/TESTING.md`, "Sampled sweeps"). The full suite starts them before the
// others, so that the end of the run does not wait for one of them alone. Update it from measured file durations when
// the costliest files change.
export const costlyTestFiles = [
  "type-core-work.test.js",
  "type-core-written.test.js",
  "type-core-sharing.test.js",
  "type-core-stop.test.js",
  "type-core-closure.test.js",
  "families-runner.test.js",
  "type-core-native.test.js",
  "type-core-cells.test.js",
  "deep-literal-scale.test.js",
  "type-core-candidate.test.js",
  "type-core-budget.test.js",
];
