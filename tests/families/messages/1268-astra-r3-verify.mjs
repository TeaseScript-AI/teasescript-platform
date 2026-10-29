// Fixed compiler inputs from astra-m4-i1268-review-r3-evidence/verify.mjs.
const fixedCases = [
  ["inline-1", '\nlet xs: integer set = set["wrong"]\nexit\n'],
  [
    "inline-2",
    'function f {\n let v: integer = hostValue\n let inside: integer set = set["wrong"]\n}\nlet outside: integer set = set["wrong"]\nf()\nexit\n',
  ],
  [
    "inline-3",
    'function bad { return null }\nlet v: integer = hostValue\nlet xs: integer set = set["wrong", bad() + 1]\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
