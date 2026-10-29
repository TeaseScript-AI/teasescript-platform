// 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs): MARKS, guarded alias chains and sibling marks, at the check's 8 and 32.
// The recorded runs also gave the check other runs' case files, which the corpus does not copy (README).
const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const MARKS = [
    // [shape, source with k aliases or guards]: the mark structures and visits grow O(k)
    [
      "alias chain",
      (k) =>
        `let seed = {n0: 1, n1: 1}\nlet a0 = seed\nif a0.n0 is not integer { exit }\n${many(k - 1, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is not integer { exit }`)}\nlet out: integer = a${k - 1}.n1`,
    ],
    [
      "alias group",
      (k) =>
        `let seed = {n0: 1, ${many(k, (i) => `f${i}: 1`, ", ")}}\n${many(k, (i) => `let a${i} = seed\nlet b${i} = a${i}\nif a${i}.n0 is integer { b${i} = a${i} }`)}\nlet bundle = [${many(k, (i) => `b${i}`, ", ")}]\n${many(k, (i) => `let n${i}: integer = bundle.first.f${i}`)}`,
    ],
    [
      "sibling guards",
      (k) =>
        `let seed = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet picked = seed\n${many(k, (i) => `if seed.f${i} is integer { picked = seed }`)}\n${many(k, (i) => `let n${i}: integer = picked.f${i}`)}`,
    ],
    // round 10's own finds: every alias of a chain tested (Astra's r5 guard-alias-chain: each read asked every tested
    // alias), one entry's array shared by k entries (asked once per entry), a chain read through k aliases of its end
    [
      "every alias tested",
      (k) =>
        `let seed = {${many(k, (i) => `n${i}: 3`, ", ")}}\nlet a0 = seed\nif a0.n0 is integer { say "ok" }\n${many(k, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is integer { say "ok" }`)}\nlet bundle = a${k}\n${many(k, (i) => `let out${i}: integer = bundle.n${i}`)}`,
    ],
    [
      "shared array",
      (k) =>
        `let seed = {n0: 3, n1: 3}\n${many(k, (i) => `let a${i} = seed\nif a${i}.n0 is integer { say "ok" }`)}\nlet picked = seed\n${many(k, (i) => `if hostFlag { picked = a${i} }`)}\n${many(k, (j) => `let c${j} = picked\nif hostFlag { c${j} = picked }\nlet o${j}: integer = c${j}.n0`)}`,
    ],
    [
      "chain then group",
      (k) =>
        `let seed = {n0: 3}\nlet a0 = seed\n${many(k, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is integer { say "ok" }`)}\n${many(k, (j) => `let b${j} = a${k}\nlet o${j}: integer = b${j}.n0`)}`,
    ],
    // a chain of k projected aliases each tested below (k nested levels): one reference per level, never its way copied
    [
      "projected chain",
      (k) =>
        `let seed = ${Array.from({ length: k }).reduce((lit) => `{x: ${lit}, t: 3}`, "3")}\nlet p0 = seed\n${many(k - 1, (i) => `if p${i}.x.t is integer { say "ok" }\nlet p${i + 1} = p${i}.x`)}\n${many(k, (j) => `let q${j} = p${k - 1}\nlet o${j}: integer = q${j}.t`)}`,
    ],
    // r4.23 (round 12): one holder per source and projection, references composing (W36–W38): k guarded projected aliases
    // of one source read at k siblings (Sol r6 D1, also in wrappers), k enclosing wrappers of one guarded alias (Astra r6
    // D2: no re-seated reads), an alias forest merged into one place (Astra r6 D1b), k reads of one source in a literal
    // (one reference, not k)
    [
      "guarded projected aliases",
      (k) =>
        `let root = {wrap: {flag: 2.0, ${many(k, (i) => `p${i}: 2.0`, ", ")}}}\nlet picked = root.wrap\n${many(k, (i) => `if root.wrap.flag is integer { let a${i} = root.wrap\npicked = a${i} }`)}\n${many(k, (i) => `let got${i}: number = picked.p${i}`)}`,
    ],
    [
      "projected aliases in wrappers",
      (k) =>
        `let root = {wrap: {flag: 2.0, ${many(k, (i) => `p${i}: 2.0`, ", ")}}}\nlet picked = {one: [{two: root.wrap}]}\n${many(k, (i) => `if root.wrap.flag is integer { let a${i} = root.wrap\npicked = {one: [{two: a${i}}]} }`)}\n${many(k, (i) => `let got${i}: number = picked.one.first.two.p${i}`)}`,
    ],
    [
      "wrappers of one alias",
      (k) =>
        `let seed = {n0: 3, n1: 3}\nlet selected = seed\n${many(k, () => "if seed.n0 is integer { selected = seed }")}\n${many(k, (i) => `let w${i} = {shell: [{payload: selected}]}`)}\nlet bag = [${many(k, (i) => `w${i}`, ", ")}]\nrepeat bag.first.shell.first.payload.n1 {}`,
    ],
    [
      "alias forest",
      (k) =>
        `let seed = {${many(k + 1, (i) => `n${i}: 3`, ", ")}}\nlet merged = seed\n${many(k, (i) => `let a${i} = seed\nif a${i}.n0 is not integer { exit }\nlet b${i} = a${i}\nif b${i}.n0 is not integer { exit }\nlet c${i} = b${i}\nif hostFlag { merged = c${i} }`)}\n${many(k, (j) => `repeat merged.n${j + 1} {}`)}`,
    ],
    // r4.28 (round 12b, W40): k functions each testing a different field and copying the record into one place, read at k
    // fields: one group visit per field, never every group
    [
      "callable groups per tested field",
      (k) =>
        `let root = {wrap: {${many(k, (i) => `f${i}: "x"`, ", ")}}}\nlet picked = root.wrap\n${many(k, (i) => `function contribute${i} { if root.wrap.f${i} is integer { picked = root.wrap } }\ncontribute${i}()`)}\n${many(k, (i) => `say picked.f${i} + 1`)}`,
    ],
    // round 16 (r4.33, W40's logical variants): tests in logical operands, the copies in k callables
    [
      "logical operand tests, k callables",
      (k) =>
        `let root = {${many(k, (i) => `f${i}: "bad"`, ", ")}}\nlet chosen = root\n${many(k, (i) => `function pick${i} { chosen = root }\npick${i}()`)}\n${many(k, (i) => `say root.f${i} is integer and hostFlag\nif chosen.f${i} is integer { repeat chosen.f${i} {} }`)}\nexit`,
    ],
    [
      "operand tests in k functions",
      (k) =>
        `let root = {wrap: {${many(k, (i) => `f${i}: "x"`, ", ")}}}\nlet picked = root.wrap\n${many(k, (i) => `function take${i} {\nlet checked${i} = root.wrap.f${i} is integer and root.wrap.f${i} == 1\npicked = root.wrap\n}\ntake${i}()`)}\n${many(k, (i) => `say picked.f${i} + "tail"`)}\nexit`,
    ],
    [
      "one source read k times in a literal",
      (k) =>
        `let seed = {t: 3, ${many(k, (i) => `f${i}: 3`, ", ")}}\nif seed.t is integer { say "ok" }\nlet archive = [${many(k, () => "seed", ", ")}]\n${many(k, (i) => `let o${i}: integer = archive.first.f${i}`)}`,
    ],
  ];
  return { shapes: Object.fromEntries(MARKS.map((row) => [row[0], row[1]])) };
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
      "node budget-check.mjs <dist> [--mutants] <case files>: its MARKS check at 8 and 32",
      "R/3a-newcore/checkpoint-9/spike14/tools/checks.sh:27 and vps/run-all14.sh:154",
    ],
  ],
  sources: 31,
  sha256: "71dd8ec6d956b5de4e6aa69b17c5ed7694d046b9665969cbddac2f2b6dba6033",
};
