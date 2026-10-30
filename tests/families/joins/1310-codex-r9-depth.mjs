// #1310's Codex r9: a typed empty list joined at depth 32 and 64, on either side
// (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/depth.mjs).
export const cases = [
  [
    "080-0-1",
    "let u: list[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet r = u + []\nsay r.length\nexit\n",
  ],
  [
    "080-0-2",
    "let u: list[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet r = u + []\nsay r.length\nexit\n",
  ],
  [
    "080-0-3",
    "let u: list[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet r = [] + u\nsay r.length\nexit\n",
  ],
  [
    "080-0-4",
    "let u: list[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet r = [] + u\nsay r.length\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node depth.mjs 32",
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/depth-32.jsonl:1",
    ],
  ],
  sources: 4,
  sha256: "9e6d66598116bebba1e123edee751587119de9df4a754cfad95eeee62e096587",
};
