// #1310's Codex r9: null-first and typed-first joins of null[] and integer[] aliases
// (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/null-controls.mjs).
export const cases = [
  [
    "null-controls-j0-input1",
    "let nils: null[] = [null]\nlet ints: integer[] = [1]\nlet held = nils + ints\nheld.add(null)\nsay held.length\nexit\n",
  ],
  [
    "null-controls-j0-input2",
    "let nils: null[] = [null]\nlet ints: integer[] = [1]\nlet held = ints + nils\nheld.add(null)\nsay held.length\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node null-controls.mjs",
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/null-controls.jsonl:1",
    ],
  ],
  sources: 2,
  sha256: "a3935bbc1e80ead2596183d2af2729e14a92fd448ab3ad41e04aa8c73f5c081b",
};
