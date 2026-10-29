// Fixed compiler inputs from 1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/domains.mjs.
const fixedCases = [
  [
    "inline-1",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make()\nheld.add("tail")\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
