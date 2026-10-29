// Fixed compiler inputs from astra-m4-i1268-review-evidence/regression.test.mjs.
const fixedCases = [
  ["inline-1", 'let mood = 1\nmood = "happy"\nexit'],
  ["inline-2", "let ns = [1, null]\nlet n = ns[1]\nsay n + 1\nexit"],
];
export const cases = fixedCases;
export const checks = ["publication"];
