// Fixed compiler inputs from astra-m4-i1241-review/regression.test.mjs.
const fixedCases = [
  ["inline-1", 'let d = dict{found: [1]}\nsay d["absent"] + 2\nexit\n'],
  ["inline-2", 'let d = dict{found: 2}\nlet delay: duration = d["absent"]\nsay delay\nexit\n'],
  ["inline-3", 'let d = dict{found: [1]}\nsay d["found"] + 2\nexit\n'],
  ["inline-4", 'let d = dict{found: 2}\nlet delay: duration = d["found"]\nsay delay\nexit\n'],
];
export const cases = fixedCases;
export const checks = ["publication"];
