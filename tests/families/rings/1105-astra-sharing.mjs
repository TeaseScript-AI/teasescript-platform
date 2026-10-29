// Fixed compiler inputs from astra-m4-i1105-review/scripts/sharing.mjs.
const fixedCases = [
  [
    "inline-1",
    'let json = "12"\nlet text: string = fromJson(json, default: "14", files: false)\nlet result = toInteger(text, default: 0)\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
