// Fixed compiler inputs from 1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n1probe.mjs.
const fixedCases = [
  ["inline-1", 'let xs: integer[][] = [[1]]\nxs = [["bad"]]\nsay "DONE"\nexit\n'],
  ["inline-2", 'let xs = [[1]]\nxs = [["bad"]]\nsay "DONE"\nexit\n'],
];
export const cases = fixedCases;
export const checks = ["publication"];
