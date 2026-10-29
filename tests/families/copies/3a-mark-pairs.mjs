// 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs): MARK_PAIRS, another contribution or none tested.
// The recorded runs also gave the check other runs' case files, which the corpus does not copy (README).
export const cases = [
  [
    "original-1",
    "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
  ],
  [
    "another contribution tested",
    "let seed = {n: 1.5, m: 2.5}\nlet a = seed\nif seed.n is integer { a = seed }\nlet b = seed\nif hostFlag { b = seed }\nlet x: integer = b.n\nexit",
  ],
  [
    "no contribution tested",
    "let seed = {n: 1.5, m: 2.5}\nlet a = seed\nif hostFlag { a = seed }\nlet b = seed\nif hostFlag { b = seed }\nlet x: integer = b.n\nexit",
  ],
  [
    "the untested field",
    "let seed = {n: 1.5, m: 2.5}\nlet a = seed\nif seed.n is integer { a = seed }\nlet b = seed\nif hostFlag { b = seed }\nlet x: integer = b.m\nexit",
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node budget-check.mjs <dist> [--mutants] <case files>: its MARK_PAIRS check",
      "R/3a-newcore/checkpoint-9/spike14/tools/checks.sh:27 and vps/run-all14.sh:154",
    ],
  ],
  sources: 4,
  sha256: "84e79e213668bf7e069b8139ce409d69b48dbcfb56606dedcb0c2f7051dce1df",
};
