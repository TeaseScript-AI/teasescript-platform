// Fixed compiler inputs from 1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/probe.mjs.
const fixedCases = [
  [
    "inline-1",
    "let a: (integer | string)[] = [1]\nlet b: (integer | boolean)[] = [1]\nlet x = a\nlet y = b\nlet z = (x + y) + [true]\nexit\n",
  ],
  [
    "inline-2",
    'let box = {last: {items: [1,null]}}\nbox.last.items += [2]\nbox.last.items += ["bad",null]\nbox.last.items += [true]\nexit\n',
  ],
  ["inline-3", 'let result = ([1,hostValue / 3] + [2]) + ["bad"]\nexit\n'],
  ["inline-4", 'let held = [1,hostValue / 3]\nlet result = (held + [2]) + ["bad"]\nexit\n'],
  ["inline-5", 'let result = [{p: {q: 1}}] + ([{p: {q: "bad"}}] + [])\nexit\n'],
  ["inline-6", 'let xs = [[null, 1], null]\nxs += [["bad",null]]\nexit\n'],
  [
    "inline-7",
    "let u: (boolean | string)[] = [true]\nlet result = ([false] + u) + [2]\nresult[0] = 3\nexit\n",
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
