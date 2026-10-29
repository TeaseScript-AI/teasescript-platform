// Fixed compiler inputs from astra-m4-s8b-r8-evidence/builder/probe7/ingress.mjs.
const fixedCases = [
  ["inline-1", "say fromJson(hostValue, default: 4)\nexit"],
  ["inline-2", "say fromJson(hostValue, default: [4])\nexit"],
  ["inline-3", "say fromJson(hostValue, default: {value: 4})\nexit"],
  ["inline-4", "let bag = fromJson(hostValue, default: {value: 4})\nsay bag.value\nexit"],
  ["inline-5", 'let bag: integer = load("sample", default: 4)\nsay bag\nexit'],
  ["inline-6", 'say load("sample", default: 4)\nexit'],
  ["inline-7", "say fromJson(hostValue, expected: integer)\nexit"],
];
export const cases = fixedCases;
export const checks = ["publication", "stops"];

for (const index of [6]) cases.splice(index, 1);
