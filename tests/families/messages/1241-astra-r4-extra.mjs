// Fixed compiler inputs from astra-m4-i1241-review-r4/extra.mjs.
const fixedCases = [
  ["inline-1", 'let x = "hi"\nsay x.size\nlet d: duration = 3\nsay [1].join\nexit'],
  ["inline-2", "let n = [2, null].random\nlet d: duration = 2 * (n + 1)\nsay d\nexit"],
  ["inline-3", "let seed = {n: 2}\nlet state = seed\nstate = hostValue\nrepeat state.n {}\nexit"],
  ["inline-4", "let n = [2, null].random\nlet d: duration = 2 * (3 + (n * 4))\nsay d\nexit"],
  ["inline-5", 'let x = "hello"\nsay x.size\nlet d: duration = 3\nsay [1].join\nexit'],
];
export const cases = fixedCases;
export const checks = ["publication"];
