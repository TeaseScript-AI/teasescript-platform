// The compiled test files whose tests take 30 s or more together, with their seconds, costliest first: measured in a run
// of the suite as CI runs it (main 843a5ffc1, four CPUs, three files at once; #1638). The full suite starts them before
// the others, so that the end of the run does not wait for one of them alone, and CI's test jobs share them out by these
// seconds (`tools/test-shards.mjs`). Update it from measured file durations when the costliest files change.
export const costlyTestSeconds = {
  "type-core-work.test.js": 323,
  "type-core-written.test.js": 134,
  "type-core-sharing.test.js": 92,
  "type-core-stop.test.js": 89,
  "families-runner.test.js": 80,
  "type-core-closure.test.js": 64,
  "deep-literal-scale.test.js": 57,
  "type-core-cells.test.js": 54,
  "type-core-native.test.js": 54,
  "type-core-candidate.test.js": 47,
  "type-core-budget.test.js": 32,
};

/** The seconds of every other test file in the same run, their mean (298 files). */
export const otherTestSeconds = 1.8;

export const costlyTestFiles = Object.keys(costlyTestSeconds);
