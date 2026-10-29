// Fixed compiler inputs from astra-m4-i1241-review-r3/delta.mjs.
const fixedCases = [
  ["inline-1", "let converted: duration = 2\nsay converted\nexit"],
  ["inline-2", 'function check(n) { say n.size }\ncheck("hi")\nexit'],
  ["inline-3", 'let box = {text: "alpha"}\nsay box.text.size\nexit'],
];
export const cases = fixedCases;
export const checks = ["publication"];
