// 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs): the check's built-in families, each at the
// sizes it compared them at, one recorded run (the per-family modules #1427 cut from it, merged). The recorded runs
// also gave the check other runs' case files, which the corpus does not copy (README).
/** A former module's sources: its fixed cases, then its shapes at its sizes. */
const expand = ({ sizes = [4, 8], shapes = {}, cases = [] }) => [
  ...cases,
  ...sizes.flatMap((size) =>
    Object.entries(shapes).map(([name, shape]) => [`${name}@${size}`, shape(size)]),
  ),
];

// COPIES, tested and guarded copy widths, at the check's 8 and 32.
const a3CopyWidths = (() => {
  const corpus = (() => {
    const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
    const COPIES = [
      // round 17 (r4.36): a test on the source before each copy (Sol r9 D1), and copies inside tests that mark their reads
      [
        "a tested whole-copy chain read at k fields",
        (k) =>
          `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if box${i}.f0 != null {}\nlet box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
      ],
      [
        "a marked whole-copy chain",
        (k) =>
          `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if box${i}.f0 > 1 {\nlet box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\n${"}".repeat(k)}\nexit`,
      ],
      // round 18 (r4.38): k sibling guarded copies each testing its own field (Astra r10 D1), an `and` over k fields with k
      // copies inside (Sol R10-D1), a chain of copies with a store to a different field between each pair (Astra r10 D2)
      [
        "sibling guarded copies, one field each",
        (k) =>
          `let root = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { root = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if root.f${i} != null {\nif root.f${i} > 0 {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}\n}`)}\nexit`,
        ["exactQueries", "indexSteps", "eventSteps"],
      ],
      [
        "copies inside an and over k fields",
        (k) =>
          `let seed = load("n", default: null)\nlet box0 = {${many(k, (i) => `f${i}: seed`, ", ")}}\nif ${many(k, (i) => `box0.f${i} > 0`, " and ")} {\n${many(k, (i) => `let box${i + 1} = box0`)}\n${many(k, (i) => `repeat box${i + 1}.f${i} {}`)}\n}\nexit`,
        ["exactQueries", "indexSteps", "eventSteps"],
      ],
      [
        "a whole-copy chain read at k fields",
        (k) =>
          `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `let box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
      ],
    ];
    return { shapes: Object.fromEntries(COPIES.map((row) => [row[0], row[1]])) };
  })();
  const sizes = [8, 32];
  const shapes = corpus.shapes;

  const cases = [
    [
      "original/1/original-1",
      "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
    ],
  ];
  return { sizes, shapes, cases };
})();

// GRAPH, function and file control graphs, at the check's 8 and 32.
const a3FileControlGraphs = (() => {
  const corpus = (() => {
    const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
    const FILES = (main, parts) => [{ path: "main.tease", source: main }, ...parts];
    const GRAPH = [
      [
        "function chain from k files",
        (k) =>
          FILES(
            [
              ...many(
                k,
                (i) => `global function hop${i} { ${i + 1 < k ? `hop${i + 1}()` : "end"} }`,
              ).split("\n"),
              ...many(k, (i) => `call "leaf${i}.tease"`).split("\n"),
              "exit",
            ].join("\n"),
            Array.from({ length: k }, (_, i) => ({
              path: `leaf${i}.tease`,
              source: "hop0()\nend",
            })),
          ),
      ],
      [
        "ending buttons before file calls",
        (k) =>
          FILES(
            `${many(k, (i) => `showPermanentButton "b${i}" { end }`)}\n${many(k, (i) => `call "leaf${i}.tease"`)}\nexit`,
            Array.from({ length: k }, (_, i) => ({
              path: `leaf${i}.tease`,
              source: "wait 1 s\nend",
            })),
          ),
      ],
      [
        "files going to one tail",
        (k) =>
          FILES(`${many(k, (i) => `call "leaf${i}.tease"`)}\nexit`, [
            ...Array.from({ length: k }, (_, i) => ({
              path: `leaf${i}.tease`,
              source: 'goto "tail.tease"',
            })),
            { path: "tail.tease", source: "end" },
          ]),
      ],
    ];
    return { shapes: Object.fromEntries(GRAPH.map((row) => [row[0], row[1]])) };
  })();
  const sizes = [8, 32];
  const shapes = corpus.shapes;

  const cases = [
    [
      "original/1/original-1",
      "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
    ],
  ];
  return { sizes, shapes, cases };
})();

// MARKS, guarded alias chains and sibling marks, at the check's 8 and 32.
const a3GuardedAliasMarks = (() => {
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
  const sizes = [8, 32];
  const shapes = corpus.shapes;

  const cases = [
    [
      "original/1/original-1",
      "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
    ],
  ];
  return { sizes, shapes, cases };
})();

// IDENTITY (budget-check.mjs:55), k contributions of one source to an entry, at the check's 2 and 8.
const a3IdentityEntries = (() => {
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

  const shapes = Object.fromEntries(IDENTITY.map(([name, , source]) => [name, source]));
  const sizes = [2, 8];
  return { sizes, shapes };
})();

// MARK_PAIRS, another contribution or none tested.
const a3MarkPairs = (() => {
  const cases = [
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
  return { cases };
})();

// NARROW, test and invalidation widths, at the check's 8 and 32.
const a3NarrowingWidths = (() => {
  const corpus = (() => {
    const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
    const NARROW = [
      [
        "one key's tests",
        (k) =>
          `let n = 1\nif hostFlag { n = null }\n${many(k, () => "if n != null { repeat n {} }")}\nexit`,
      ],
      [
        "sibling tests then reads",
        (k) =>
          `let n = 1\nif hostFlag { n = null }\n${many(k, () => "if n != null { say 1 }")}\n${many(k, () => "repeat n {}")}\nexit`,
      ],
      [
        "an and chain",
        (k) =>
          `let r = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { r = {${many(k, (i) => `f${i}: null`, ", ")}} }\nif ${many(k, (i) => `r.f${i} != null`, " and ")} and ${many(k, (i) => `r.f${i}`, " + ")} > 0 { say "ok" }\nexit`,
      ],
      [
        "an or chain read after",
        (k) =>
          `let r = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { r = {${many(k, (i) => `f${i}: null`, ", ")}} }\nif ${many(k, (i) => `r.f${i} == null`, " or ")} { exit }\n${many(k, (i) => `repeat r.f${i} {}`)}\nexit`,
      ],
      [
        "invalidations",
        (k) =>
          `let xs = [1, null]\n${many(k, (i) => `if xs[${i}] == null { exit }`)}\n${many(k, () => "xs.reverse()")}\n${many(k, (i) => `repeat xs[${i}] {}`)}\nexit`,
      ],
      // round 14 (N5): one subset of preserving stores per (location, kind set), its entries counted, never walked
      [
        "one key's preserving loops",
        (k) =>
          `let v = 1\nif hostFlag { v = null }\n${many(k, () => "if v != null { repeat 2 { repeat v {}\nv = v + 1 } }")}\nexit`,
      ],
      [
        "a loop of preserving stores",
        (k) =>
          `let v = 1\nif hostFlag { v = null }\nif v != null { repeat 2 {\n${many(k, () => "repeat v {}")}\n${many(k, () => "v = v + 1")}\n} }\nexit`,
      ],
      [
        "k scalars preserved in one loop",
        (k) =>
          `${many(k, (i) => `let v${i} = 1\nif hostFlag { v${i} = null }`)}\n${many(k, (i) => `if v${i} == null { exit }`)}\nrepeat 2 {\n${many(k, (i) => `v${i} = v${i} + 1`)}\n${many(k, (i) => `repeat v${i} {}`)}\n}\nexit`,
      ],
    ];
    return { shapes: Object.fromEntries(NARROW.map((row) => [row[0], row[1]])) };
  })();
  const sizes = [8, 32];
  const shapes = corpus.shapes;

  const cases = [
    [
      "original/1/original-1",
      "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
    ],
  ];
  return { sizes, shapes, cases };
})();

// CORRIDOR, object stores, calls and child-layer corridors, at the check's 8 and 32.
const a3StoreAndCallCorridors = (() => {
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
  const sizes = [8, 32];
  const shapes = corpus.shapes;

  const cases = [
    [
      "original/1/original-1",
      "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
    ],
  ];
  return { sizes, shapes, cases };
})();

// WIDE, wide literals and interleaved field stores, at the check's 16 and 128.
const a3WideFieldStores = (() => {
  const corpus = (() => {
    const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
    const WIDE = [
      [
        "a wide literal certificate",
        (k) =>
          `let box = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `repeat box.f${i} {}`)}\nexit`,
      ],
      [
        "a copy chain with interleaved field stores",
        (k) =>
          `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if hostFlag { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
        ["exactQueries", "invSteps"],
      ],
      // round 19d (r4.46 (3), W44): k sibling fields, each stored, projected into its own copy and read: the keys below a
      // projection from the prefix index, never the root's whole key set per copy
      [
        "sibling fields each stored, projected and read",
        (k) =>
          `let root = {${many(k, (i) => `f${i}: {v: 1}`, ", ")}}\n${many(k, (i) => `root.f${i}.v = 2\nlet p${i} = root.f${i}\nrepeat p${i}.v {}`)}\nexit`,
        ["invSteps"],
      ],
      // round 19e: the same chain read once (its copies' listings dominate: an inherited node copied per prefix is k²/2)
      [
        "a copy chain with interleaved field stores, read once",
        (k) =>
          `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if hostFlag { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`)}\nrepeat box${k}.f0 {}\nexit`,
        ["invSteps", "prefixEntries"],
      ],
      // round 19e (r4.47 (3), W45): k destinations each copying root `a` then storing root `b`, each root with k stored
      // fields: each root listed whole in one shared entry, never flattened per destination
      [
        "the two-roots join",
        (k) =>
          `let a = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet b = {${many(k, (i) => `f${i}: 1`, ", ")}}\n${many(k, (i) => `a.f${i} = 2\nb.f${i} = 3`)}\n${many(k, (i) => `let d${i} = a\nd${i} = b\nrepeat d${i}.f${i} {}`)}\nexit`,
        ["invSteps", "prefixEntries"],
      ],
      [
        "a needed form under k tests",
        (k) =>
          `let n: integer | string | null = 1\nif hostFlag { n = "bad" }\nif hostFlag { n = null }\n${many(k, () => "if n == null { exit }")}\n${many(k, () => "repeat n {}")}\nexit`,
      ],
    ];
    return { shapes: Object.fromEntries(WIDE.map((row) => [row[0], row[1]])) };
  })();
  const sizes = [16, 128]; // budget-check.mjs's WIDE check
  const shapes = corpus.shapes;

  const cases = [
    [
      "original/1/original-1",
      "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
    ],
  ];
  return { sizes, shapes, cases };
})();

export const cases = [
  a3CopyWidths,
  a3FileControlGraphs,
  a3GuardedAliasMarks,
  a3IdentityEntries,
  a3MarkPairs,
  a3NarrowingWidths,
  a3StoreAndCallCorridors,
  a3WideFieldStores,
].flatMap(expand);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "$H $N spike14/budget-check.mjs $D --mutants $(for f in $F; do echo spike14/$f; done) diff/rand-1.jsonl diff/disp-1.jsonl diff/agg-1.jsonl diff/rec-1.jsonl gates/small-var.jsonl gates10/ladders.jsonl gates10/nonmono.jsonl gates12/siblings-small.jsonl gates10/semantic.jsonl gates10/probes-small.jsonl gates13/crashes.jsonl gates13/empty-checks.jsonl gates13/restore.jsonl gates13/quiet-open-small.jsonl gates13/open-smallest.jsonl > spike14/budget-check.txt 2>&1; echo \"budget-check $? $(tr '\\n' ' ' < spike14/budget-check.txt | cut -c1-200)\"",
      "R/3a-newcore/checkpoint-9/spike14/tools/checks.sh:27",
    ],
    [
      'job 0 "timeout 180m $N spike14/budget-check.mjs $D probes/ledger/*.jsonl > logs/ledger-reviewers.txt 2>&1" > /dev/null',
      "R/3a-newcore/checkpoint-9/spike14/vps/run-all14.sh:154",
    ],
  ],
  sources: 117,
  sha256: "6fc291a852883ef2d9f9e61a1c721fa4532c3b96dbd434bf657f2db35cbd09f3",
};
