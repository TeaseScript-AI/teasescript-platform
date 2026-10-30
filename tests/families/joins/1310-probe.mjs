// 4 fixed probe inputs; #1310, 1310, review/builder evidence, r9
// (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/probe.mjs).
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

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs quick",
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/quick.jsonl:1 (its result's header)",
    ],
  ],
  sources: 4,
  sha256: "4e1e3ff63cdef35637022fb7fcbc3e6f0a476bda5261511851a11e87125b4904",
};
