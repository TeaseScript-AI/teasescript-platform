// S8d, Astra r2 (R/astra-m4-s8d-review-r2-evidence/selection-witness.mjs): a random selection read unguarded, guarded
// by its length, and captured first.
const source = "let groups: integer[][] = [[], [21]]\nsay groups.random.last\nexit\n";
const fixed =
  "let groups: integer[][] = [[], [21]]\nif groups.random.length > 0 { say groups.random.last }\nexit\n";
const capture =
  "let groups: integer[][] = [[], [21]]\nlet chosen = groups.random\nif chosen.length > 0 { say chosen.last }\nexit\n";
// the run analysed the unguarded read with hostValue; the two repairs it only compiled, without globals
export const cases = [
  ["source", source, ["hostValue"]],
  ["fixed", fixed, []],
  ["capture", capture, []],
];
export const checks = ["publication"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node selection-witness.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-review-r2-evidence/selection-witness.mjs",
    ],
  ],
  sources: 3,
  sha256: "5c33936812390431c1ebde126c955fe1996c2f48ea9c844176d271f42047cce6",
};
