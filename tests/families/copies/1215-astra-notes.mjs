// Fixed compiler inputs from astra-m4-i1215-review-evidence/notes.mjs.
const fixedCases = [
  [
    "inline-1",
    'let seed: object = {payload: 7}\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
  ],
  [
    "inline-2",
    'let seed: integer = 7\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
  ],
  [
    "inline-3",
    'let seed: object = {payload: 7}\nlet copy = {open: seed}\ncopy = hostValue\nsay "REACHED"\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
