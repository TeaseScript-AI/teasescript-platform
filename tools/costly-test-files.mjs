// The compiled test files that take longest, costliest first. The full suite starts them before the others, so that
// the end of the run does not wait for one of them alone. Update it from measured file durations when the costliest
// files change.
export const costlyTestFiles = [
  "type-core-work.test.js",
  "type-core-written.test.js",
  "type-core-sharing.test.js",
  "type-core-native.test.js",
  "type-core-candidate.test.js",
  "deep-literal-scale.test.js",
];
