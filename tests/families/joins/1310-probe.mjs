// Fixed compiler inputs from 1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/probe.mjs.
const fixedCases = [
  [
    "inline-1",
    'let a: integer[] = [1]\nlet u: list = [2]\nlet held = a + u\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "inline-2",
    'let a: integer[] = [1]\nlet u: list = [2]\nlet result = (a + u) + ["tail"]\nexit\n',
  ],
  [
    "inline-3",
    'let a: integer[] = [1]\nlet u: list = [2]\nlet held = u + a\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "inline-4",
    'let a: integer[] = [1]\nlet u: list = [2]\nlet held = a + u\nheld.add("tail")\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
