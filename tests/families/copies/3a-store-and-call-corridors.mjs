// 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs): CORRIDOR, object stores, calls and child-layer corridors, at the check's 8 and 32.
// The recorded runs also gave the check other runs' case files, which the corpus does not copy (README).
const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const CORRIDOR = [
    [
      "a record's whole stores read at k fields",
      (k) =>
        `let full = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet absent = {${many(k, (i) => `f${i}: null`, ", ")}}\nlet picked = full\n${many(k, () => "if hostFlag { picked = absent }")}\n${many(k, (i) => `say picked.f${i} + 1`)}\nexit`,
    ],
    [
      "k calls between k null stores and k uses",
      (k) =>
        `let clear = askBoolean "Clear?"\n${many(k, (i) => `let n${i} = 1`)}\nfunction restoreAll {\n${many(k, (i) => `n${i} = 2`)}\n}\nif clear {\n${many(k, (i) => `n${i} = null`)}\n}\n${many(k, () => "restoreAll()")}\n${many(k, (i) => `repeat n${i} {}`)}\nexit`,
    ],
    [
      "k calls before k null stores and k uses",
      (k) =>
        `let clear = askBoolean "Clear?"\n${many(k, (i) => `let n${i} = 1`)}\nfunction restoreAll {\n${many(k, (i) => `n${i} = 2`)}\n}\n${many(k, () => "restoreAll()")}\nif clear {\n${many(k, (i) => `n${i} = null`)}\n}\n${many(k, (i) => `repeat n${i} {}`)}\nexit`,
    ],
    [
      "k closed candidates then k reads",
      (k) =>
        `let n = 1\nfunction restore {\nn = 2\n}\n${many(k, () => "if hostFlag { n = null\nrestore() }")}\n${many(k, () => "repeat n {}")}\nexit`,
    ],
    // round 16 (r4.33): child layers with their own stores or tests share the prefix's
    [
      "child layers with own stores",
      (k) =>
        `let box = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet empty = {${many(k, (i) => `f${i}: null`, ", ")}}\n${many(k, () => "if hostFlag { box = empty }")}\n${many(k, (i) => `if hostFlag { box.f${i} = 2 }`)}\n${many(k, (i) => `repeat box.f${i} {}`)}\nexit`,
    ],
    [
      "child layers with own tests",
      (k) =>
        `let box = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet source = {${many(k, (i) => `f${i}: null`, ", ")}}\n${many(k, () => "if hostFlag { box = source }")}\n${many(k, (i) => `if box.f${i} != null {}\nrepeat box.f${i} {}`)}\nexit`,
    ],
    [
      "a scalar copy chain",
      (k) =>
        `let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nlet s0 = n\n${many(k - 1, (i) => `let s${i + 1} = s${i}`)}\n${many(k, () => `repeat s${k - 1} {}`)}\nexit`,
    ],
  ];
  return { shapes: Object.fromEntries(CORRIDOR.map((row) => [row[0], row[1]])) };
})();
export const sizes = [8, 32];
export const shapes = corpus.shapes;

export const cases = [
  [
    "original/1/original-1",
    "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node budget-check.mjs <dist> [--mutants] <case files>: its CORRIDOR check at 8 and 32",
      "R/3a-newcore/checkpoint-9/spike14/tools/checks.sh:27 and vps/run-all14.sh:154",
    ],
  ],
  sources: 15,
  sha256: "187df6466a4e2cc01c96dc35f32f87d66693d30b7b9e54427afe93e2ba6aa8e2",
};
