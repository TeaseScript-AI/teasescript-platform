// 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs:55): IDENTITY, k contributions of one source
// to an entry, which the budget check compared at 2 and 8.
// The recorded runs also gave the check other runs' case files, which the corpus does not copy (README).
const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
const SNAP = "global seed = {a: 1}\nfunction snapshot { return seed }\n";
const IDENTITY = [
  // [entry path, counter, source with k contributions of one source]
  [
    "whole store",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nlet picked = seed\n${many(k, () => "if hostFlag { picked = seed }")}\nlet n: integer = picked.a`,
  ],
  [
    "guarded copy",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nlet picked = seed\n${many(k, () => "if seed != null { picked = seed }")}\nlet n: integer = picked.a`,
  ],
  [
    "child-guarded copy",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1, b: 1}\nlet picked = seed\n${many(k, () => "if seed.a is integer { picked = seed }")}\nlet n: integer = picked.b`,
  ],
  [
    "call result in a store",
    "prefixEntries",
    (k) =>
      `${SNAP}let archive = snapshot()\n${many(k, () => "if hostFlag { archive = snapshot() }")}\nlet n: integer = archive.a`,
  ],
  [
    "literal in a store",
    "prefixEntries",
    (k) =>
      `${SNAP}let archive = {layer: [snapshot()]}\n${many(k, () => "if hostFlag { archive = {layer: [snapshot()]} }")}\nlet n: integer = archive.layer.first.a`,
  ],
  [
    "argument",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nfunction take(p) { let n: integer = p.a }\n${many(k, () => "take(seed)")}`,
  ],
  [
    "add",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nlet xs = [seed]\n${many(k, () => "xs.add(seed)")}\nlet n: integer = xs.first.a`,
  ],
  [
    "store through a prefix",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1, b: 1}\nseed.a = 2\nlet picked = seed\n${many(k, () => "if hostFlag { picked = seed }")}\nlet n: integer = picked.a`,
  ],
  [
    "alias",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\n${many(k, (i) => `let s${i} = seed`)}\nlet archive = [${many(k, (i) => `s${i}`, ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "place of copies",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\n${many(k, (i) => `let c${i} = seed\nif seed.a is integer { c${i} = seed }`)}\nlet archive = [${many(k, (i) => `c${i}`, ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "read in a literal",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\nlet archive = [${many(k, () => "seed", ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "call result in a literal",
    "literalEntries",
    (k) =>
      `${SNAP}let archive = [${many(k, () => "snapshot()", ", ")}]\nlet n: integer = archive.first.a`,
  ],
  // r4.17: guarded stores of one wrapper literal, the guards on alternating children of a fixed two-field root
  [
    "guarded wrapper literal",
    "prefixEntries",
    (k) =>
      `let root = {p0: 2.0, p1: 2.0}\nlet picked = {layer: [root]}\n${many(k, (i) => `if root.p${i % 2} is integer { picked = {layer: [root]} }`)}\nlet x: number = picked.layer.first.p0\nlet y: number = picked.layer.first.p1`,
  ],
];

export const shapes = Object.fromEntries(IDENTITY.map(([name, , source]) => [name, source]));
export const sizes = [2, 8];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node budget-check.mjs <dist> [--mutants] <case files>: its IDENTITY check at 2 and 8",
      "R/3a-newcore/checkpoint-9/spike14/tools/checks.sh:27 and vps/run-all14.sh:154",
    ],
  ],
  sources: 26,
  sha256: "068d2dfee20cdfc6556d6eb266b9d2fc44744ed8380aef72deca6267058e2129",
};
