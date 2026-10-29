// 2 fixed n1probe inputs; #1310, 1310, review/builder evidence
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n1probe.mjs).
const fixedCases = [
  ["inline-1", 'let xs: integer[][] = [[1]]\nxs = [["bad"]]\nsay "DONE"\nexit\n'],
  ["inline-2", 'let xs = [[1]]\nxs = [["bad"]]\nsay "DONE"\nexit\n'],
];
export const cases = fixedCases;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node n1probe.mjs (no command recorded: its run without arguments)",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n1probe.mjs",
    ],
  ],
  sources: 2,
  sha256: "390de0fc9947d2c28d659f62040913512620b0391917a13d53c5d8897d87eeea",
};
