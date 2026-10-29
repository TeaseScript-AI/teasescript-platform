// Fixed compiler inputs from astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache2.mjs.
const fixedCases = [
  ["inline-1", "let box = [{n: 1}]\nsay box[0].n\nexit\n"],
  ["inline-2", "let box = [[{n: 1}]]\nsay box.first.first.n\nexit\n"],
  ["inline-3", "let v: integer? = null\nlet a = {n: v}\nsay a.n otherwise 2\nexit\n"],
  ["inline-4", "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n"],
  ["inline-5", "let a = {n: 1}\nsay [a][0].n\nexit\n"],
];
export const cases = fixedCases;
export const checks = ["publication", "stops"];
