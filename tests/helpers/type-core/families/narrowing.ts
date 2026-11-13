// pins for tests/type-core/work/type-core-work-c.test.ts: main's 64 → 128 growth step of the route rule's entries over many keys (a known product), as gates | line /^\s*measured: \d/u
import {
  type KnownProduct,
  type WorkFamily,
  rows,
  lines,
  cells,
  fields,
  main,
  file,
  balancedSum,
  record,
} from "./builders.js";

/**
 * Stage 3b's families (W27–W34 and the tested-copy variant), as the design defines them: each makes the
 * narrowing index's construction or its queries a product of two program dimensions in some realization of it. They are
 * measured with every read's narrowing and route asked (`tests/helpers/type-core/type-core-narrowing.ts`), as the consumers will
 * ask them; N5's (W29 and its variants) through the analysis too, whose stored values read their narrowings (S10 part
 * 2b).
 */
export const NARROWING_FAMILIES: readonly WorkFamily[] = [
  {
    name: "W27",
    measures: "N2: k narrowings of one key, k reads, one binary search each",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if flagHost { n = null }",
          rows(k, () => "if n != null { repeat n {} }"),
          "exit",
        ),
      ),
  },
  {
    name: "W27-unsuccessful",
    measures:
      "N3: k null stores in leaving branches before k uses, the nearest candidate examined once",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          rows(k, () => "if flagHost { n = null\nexit }"),
          rows(k, () => "repeat n {}"),
          "exit",
        ),
      ),
  },
  {
    name: "W28",
    measures: "N2: k nested tests on k path texts of one element key, k reads of the earliest path",
    program: (k) =>
      main(
        lines(
          `let xs = [${cells(k, "1")}, null]`,
          rows(k, (i) => `if xs[${i}] == null { exit }`),
          rows(k, () => "repeat xs[0] {}"),
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W29", (i: number) => `xs[${i}] = 1`],
      ["W29-same-path", (i: number) => `xs[i${i}] = 1`],
    ] as const
  ).map(([name, store]): WorkFamily => ({
    name,
    measures: "N5: k tests of `xs[i_j]` around a loop with k reads and k element stores, k × log",
    program: (k) =>
      main(
        lines(
          `let xs = [${cells(k, "1")}, null]`,
          rows(k, (i) => `let i${i} = ${i}`),
          rows(k, (i) => `if xs[i${i}] == null { exit }`),
          "repeat 2 {",
          rows(k, (i) => `repeat xs[i${i}] {}`),
          rows(k, store),
          "}",
          "exit",
        ),
      ),
  })),
  {
    name: "W29-scalar",
    measures: "N5: k preserving stores to k scalar locations in one loop, one evaluation each",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let v${i} = 1\nif flagHost { v${i} = null }`),
          rows(k, (i) => `if v${i} == null { exit }`),
          "repeat 2 {",
          rows(k, (i) => `repeat v${i} {}\nv${i} = v${i} + 1`),
          "}",
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W29-wide-chain", "null"],
      ["W29-wide-ring", "total otherwise null"],
    ] as const
  ).map(([name, last]): WorkFamily => ({
    name,
    measures:
      "N5 (Astra's G2): a wide surviving store whose k operands' facts are lost one by one, each loss one operand's work",
    // (the k operands summed as a balanced tree)
    program: (k) =>
      main(
        lines(
          "let keep: boolean = hostValue",
          rows(k, (i) => `let a${i}: integer? = hostValue`),
          "let total: integer? = 0",
          `if total != null and ${rows(k, (i) => `a${i} != null`).replaceAll("\n", " and ")} {`,
          "while keep {",
          `total = ${balancedSum(0, k)}`,
          rows(k - 1, (i) => `a${i} = a${i + 1}`),
          `a${k - 1} = ${last}`,
          "repeat total {}",
          "}",
          "}",
          "exit",
        ),
      ),
  })),
  // (W29-wide-ring read through one wide gather: a literal of its k values, of computed ones, of records holding them, or
  // a choice of k options: a changed value re-runs the gather's nodes above it, never the whole gather)
  ...(
    [
      [
        "literal",
        (k: number) =>
          `let xs = [${rows(k, (i) => `a${i}`).replaceAll("\n", ", ")}]\ntotal = xs[i] otherwise 0`,
      ],
      [
        "computed",
        (k: number) =>
          `let xs = [${rows(k, (i) => `a${i} otherwise null`).replaceAll("\n", ", ")}]\ntotal = xs[i] otherwise 0`,
      ],
      [
        "sums",
        (k: number) =>
          `let xs = [${rows(k, (i) => `a${i} + 0`).replaceAll("\n", ", ")}]\ntotal = xs[i] otherwise 0`,
      ],
      [
        "records",
        (k: number) =>
          `let xs = [${rows(k, (i) => `{n: a${i}}`).replaceAll("\n", ", ")}]\ntotal = xs[i].n otherwise 0`,
      ],
      [
        "choice",
        (k: number) =>
          `total = (askChoice ${rows(k, (i) => `{text: "${i}", value: a${i}}`).replaceAll("\n", ", ")}) otherwise 0`,
      ],
      [
        "choice-list",
        (k: number) =>
          `total = (askChoice [${rows(k, (i) => `{text: "${i}", value: a${i}}`).replaceAll("\n", ", ")}]) otherwise 0`,
      ],
      [
        "choice-values",
        (k: number) =>
          `total = (askChoice [${rows(k, (i) => `a${i}`).replaceAll("\n", ", ")}]) otherwise 0`,
      ],
    ] as const
  ).map(([variant, read]): WorkFamily => ({
    name: `W29-wide-ring-${variant}`,
    measures: `N5: W29-wide-ring read through a wide ${variant} gather: a changed value re-runs the nodes above it`,
    program: (k) =>
      main(
        lines(
          "let i = 0",
          rows(k, (i) => `let a${i}: integer? = 1\nif flagHost { a${i} = null }`),
          "let total: integer? = 0",
          `if total != null and ${rows(k, (i) => `a${i} != null`).replaceAll("\n", " and ")} {`,
          "while flagHost {",
          read(k),
          rows(k - 1, (i) => `a${i} = a${i + 1}`),
          `a${k - 1} = total otherwise null`,
          "}",
          "}",
          "exit",
        ),
      ),
  })),
  {
    name: "W29-guarded-choice",
    measures:
      "N2 (Sol's U3 r1): k options holding one tested record, read at k fields: one value class for one environment",
    program: (k) =>
      main(
        lines(
          `let root = ${record(k, "1")}`,
          "if hostValue { root = null }",
          "if root != null {",
          `let pick = askChoice ${rows(k, (i) => `{text: "${i}", value: root}`).replaceAll("\n", ", ")}`,
          rows(k, (i) => `let f${i} = pick.f${i}`),
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "W29-guarded-choice-loop",
    measures:
      "N2 (Sol's U3 build r1): the same in a loop, its record a loop's own definition, every field stored typed",
    program: (k) =>
      main(
        lines(
          "repeat 2 {",
          "let root = hostValue",
          "if root is object {",
          `let pick = askChoice ${rows(k, (i) => `{text: "${i}", value: root}`).replaceAll("\n", ", ")}`,
          rows(k, (i) => `let f${i}: integer = pick.f${i}`),
          "}",
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "W29-one-location",
    measures:
      "N5: k preserving stores to one location in k branches of one loop, each read through G: k × log, never k²",
    program: (k) =>
      main(
        lines(
          "let v: integer? = 1",
          "if flagHost { v = null }",
          "if v != null {",
          "repeat 2 {",
          rows(k, (i) => `if hostValue == ${i} { v = v + 1 }`),
          "repeat v {}",
          "}",
          "}",
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W30", "!=", "and"],
      ["W30-or", "==", "or"],
    ] as const
  ).map(([name, test, logical]): WorkFamily => ({
    name,
    measures: `N1, N2: one \`${logical}\` chain of k field tests, k reads in its last operand`,
    program: (k) =>
      main(
        lines(
          `let box = ${record(k, "1")}`,
          rows(k, (i) => `if flagHost { box.f${i} = null }`),
          `if ${rows(k, (i) => `box.f${i} ${test} null`).replaceAll("\n", ` ${logical} `)} ${logical} [${rows(k, (i) => `box.f${i} + 1`).replaceAll("\n", ", ")}].length > 0 { say "ready" }`,
          "exit",
        ),
      ),
  })),
  {
    name: "W31",
    measures:
      "N2: k invalidations between k narrowings and k reads, one sorted list per collection",
    program: (k) =>
      main(
        lines(
          `let xs = [${cells(k, "1")}, null]`,
          rows(k, (i) => `if xs[${i}] == null { exit }`),
          rows(k, () => "xs.sort()"),
          rows(k, (i) => `repeat xs[${i}] {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W32",
    measures: "N3: k whole stores of a record with null fields under k branches, read at k fields",
    program: (k) =>
      main(
        lines(
          `let rec = ${record(k, "1")}`,
          rows(k, () => `if flagHost { rec = ${record(k, "null")} }`),
          rows(k, (i) => `repeat rec.f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W33", () => "restore()", (i: number) => `repeat v${i} {}`],
      ["W33-header", () => "if restore() > 0 { say 1 }", (i: number) => `repeat v${i} {}`],
      ["W33-earlier-operand", () => "", (i: number) => `repeat restore() + v${i} {}`],
    ] as const
  ).map(([name, call, use]): WorkFamily => ({
    name,
    measures:
      "N3: k optional scalars one function stores, k calls, k uses: one shared list of k call positions",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let v${i} = 1`),
          "function restore {",
          rows(k, (i) => `v${i} = 1`),
          "return 1",
          "}",
          "if flagHost {",
          rows(k, (i) => `v${i} = null`),
          "}",
          rows(k, call),
          rows(k, use),
          "exit",
        ),
      ),
  })),
  {
    name: "W34-record-chain",
    measures:
      "N3: k whole copies of a k-field record read at k fields, refused below the record's kinds",
    program: (k) =>
      main(
        lines(
          `let r0 = ${record(k, "1")}`,
          `if flagHost { r0 = ${record(k, "null")} }`,
          rows(k, (i) => `let r${i + 1} = r${i}`),
          rows(k, (i) => `repeat r${k}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-scalar-chain",
    measures: "N3: a chain of k scalar copies, each read: one memoised query per copy",
    program: (k) =>
      main(
        lines(
          "let s0 = 1",
          "if flagHost { s0 = null }",
          rows(k, (i) => `let s${i + 1} = s${i}`),
          rows(k, (i) => `repeat s${i + 1} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-scalar-fan",
    measures: "N3: k scalar copies of one source, each read: one memoised query of the source",
    program: (k) =>
      main(
        lines(
          "let s = 1",
          "if flagHost { s = null }",
          rows(k, (i) => `let t${i} = s`),
          rows(k, (i) => `repeat t${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-dead-fallback",
    measures: "N3: a chain of k `otherwise null` copies over a dead fallback, each read",
    program: (k) =>
      main(
        lines(
          "let s0 = 1 otherwise null",
          rows(k, (i) => `let s${i + 1} = s${i} otherwise null`),
          rows(k, (i) => `repeat s${i + 1} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-tested-copies",
    measures: "a test on a field of the source before each whole copy, k copies read at k fields",
    program: (k) =>
      main(
        lines(
          `let box0 = ${record(k, "1")}`,
          `if flagHost { box0 = ${record(k, "null")} }`,
          rows(k, (i) => `if box${i}.f${i} != null { say 1 }\nlet box${i + 1} = box${i}`),
          rows(k, (i) => `repeat box${k}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W32-copied-record",
    measures:
      "N3: k whole copies of one record under k branches, read at k fields: prefix kills shared, never per field",
    program: (k) =>
      main(
        lines(
          `let source = ${record(k, "1")}`,
          "let box = source",
          rows(k, () => "if flagHost { box = source }"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "N3-wide-switch",
    measures:
      "N3: a switch of k cases each storing `null`, then k conditional repairs: each arm closed once, no rescans",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "switch hostValue {",
          rows(k, (i) => `case ${i} { n = null }`),
          "default { n = null }",
          "}",
          "repeat n {}",
          rows(k, (i) => `if hostValue == ${i} { n = 2 }`),
          "repeat n {}",
          "exit",
        ),
      ),
  },
  {
    name: "N3-omitted-default",
    measures:
      "N3: a parameter's omitted `null` default, k conditional stores and k reads: one argument index, never a scan per read",
    program: (k) =>
      main(
        lines(
          "function inspect(n = null) {",
          'let gate = askBoolean "gate"',
          rows(k, (i) => `if gate { n = ${i} }`),
          rows(k, () => "repeat n {}"),
          "}",
          "inspect()",
          "exit",
        ),
      ),
  },
  ...(["is", "is not"] as const).map((test): WorkFamily => ({
    name: `N1-wide-union-${test.replace(" ", "-")}`,
    measures: `N1: \`${test}\` a union naming one kind k times, read k times: each kind filtered once`,
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if flagHost { n = null }",
          `if n ${test} ${rows(k, () => "integer").replaceAll("\n", " | ")} | null {`,
          rows(k, () => "say n"),
          "}",
          "exit",
        ),
      ),
  })),
];

/**
 * The route rule's narrowed default (#1938): in a program that holds an `if` arm no run enters, a route promotes only
 * along the closed list (`NarrowingRoutes.#plain`: entered arms, passable statements, no loop before the use), over one
 * feasibility layer built per program. Each family asks k route queries beside k such arms, through the analysis.
 */
export const ROUTE_FEASIBILITY_FAMILIES: readonly WorkFamily[] = [
  {
    name: "R-feasible-around",
    measures:
      "N3: k guards with an infeasible way past, each followed by a use whose route takes the guard's arm",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if hostValue is boolean { n = null }",
          "let o = {k: 1}",
          rows(k, () => 'if o != null { say "g" }\nrepeat n {}'),
          "exit",
        ),
      ),
  },
  {
    name: "R-inline-selections",
    measures:
      "N3: k inline fallbacks, each of a value an infeasible arm's merge leaves null, each its own default",
    program: (k) =>
      main(
        lines(
          "let o = {k: 1}",
          rows(
            k,
            (i) => `let a${i} = null\nif o != null { a${i} = 1 }\nrepeat (a${i} otherwise null) {}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "R-break-only-loops",
    measures:
      "N3: k loops only an infeasible break leaves, each before a use, each route refused at its loop by the closed list",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if hostValue is boolean { n = null }",
          "let o = {k: 1}",
          rows(k, () => "while true { if o == null { break } }\nrepeat n {}"),
          "exit",
        ),
      ),
  },
  {
    name: "R-loops-left",
    measures:
      "N3: k loops their header leaves, each before a use beside one infeasible arm, each route refused at its loop",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if hostValue is boolean { n = null }",
          "let o = {k: 1}",
          'if o != null { say "g" }',
          rows(k, () => 'repeat 2 { say "r" }\nrepeat n {}'),
          "exit",
        ),
      ),
  },
];

/** A use of `n` that errs where its `null` arrives unchecked, and a store of `null` after it. */
const USE_THEN_NULL = "repeat n {}\nn = null";

/**
 * The route rule's entries (#2497, the accepted record's r4-451): per key, every jump a seed and each entry's segments
 * once; per use, its nearest entry per level and one segment each; per root, its holding statements and the compound
 * statements around them, once.
 */
export const ROUTE_ENTRY_FAMILIES: readonly WorkFamily[] = [
  {
    name: "E-labels",
    measures:
      "N3: one key over k labels, each with a conditional `goto` back to it and a use after it",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          rows(
            k,
            (i) =>
              `label l${i}\n${USE_THEN_NULL}\nif hostValue is boolean { goto l${i} }\nn = ${i}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "E-gotos",
    measures:
      "N3: one label, one use after it and k conditional `goto`s back to it, each after a store of `null`",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          "label top",
          "repeat n {}",
          rows(k, () => "n = null\nif hostValue is boolean { goto top }\nn = 1"),
          "exit",
        ),
      ),
  },
  {
    name: "E-uses",
    measures:
      "N3: one label, one `goto` back to it after a store of `null`, and k uses between them",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          "label top",
          rows(k, () => "repeat n {}"),
          "n = null",
          "if hostValue is boolean { goto top }",
          "exit",
        ),
      ),
  },
  {
    name: "E-loops-in-sequence",
    measures: "N3: k loops in sequence, each with a use and a later store of `null` in its body",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          rows(k, () => `repeat 2 {\n${USE_THEN_NULL}\n}\nn = 1`),
          "exit",
        ),
      ),
  },
  {
    name: "E-default-loops",
    measures:
      "N3 under the program default (R2.2): an arm no run enters, then k loops in sequence, each with a use and a later store of `null` in its body",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          'if n == null { say "never" }',
          rows(k, () => `repeat 2 {\n${USE_THEN_NULL}\n}\nn = 1`),
          "exit",
        ),
      ),
  },
  {
    name: "E-default-labels",
    measures:
      "N3 under the program default (R2.2): an arm no run enters, then k labels, each with a conditional `goto` back to it and a use after it",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          'if n == null { say "never" }',
          rows(
            k,
            (i) =>
              `label l${i}\n${USE_THEN_NULL}\nif hostValue is boolean { goto l${i} }\nn = ${i}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "E-default-copied-fields",
    measures:
      "N3 under the program default (R2.2): a record of k fields copied k times, then one loop reading each field",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if hostValue is boolean { seed = {${fields(k, () => "null")}} }`,
          'if seed == null { say "absent" }',
          rows(k, (i) => `let c${i} = seed\nseed = c${i}`),
          "repeat 2 {",
          rows(k, (i) => `let value${i}: integer = seed.f${i}`),
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "E-default-copied-in-loop",
    measures:
      "N3 under the program default (R2.2): a record of k fields copied k times inside one loop, then each field read",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if hostValue is boolean { seed = {${fields(k, () => "null")}} }`,
          'if seed == null { say "absent" }',
          "repeat 2 {",
          rows(k, (i) => `let c${i} = seed\nseed = c${i}`),
          rows(k, (i) => `let value${i}: integer = seed.f${i}`),
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "E-default-copied-nested",
    measures:
      "N3 under the program default (R2.2): a record of k fields copied k times inside a compound statement, then one loop reading each field",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if hostValue is boolean { seed = {${fields(k, () => "null")}} }`,
          'if seed == null { say "absent" }',
          "if true {",
          rows(k, (i) => `let c${i} = seed\nseed = c${i}`),
          "}",
          "repeat 2 {",
          rows(k, (i) => `let value${i}: integer = seed.f${i}`),
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "E-default-copied-siblings",
    measures:
      "N3 under the program default (R2.2): a record of k fields copied once in each of k compound statements, then one loop reading each field",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if hostValue is boolean { seed = {${fields(k, () => "null")}} }`,
          'if seed == null { say "absent" }',
          rows(k, (i) => `if true {\n  let c${i} = seed\n  seed = c${i}\n}`),
          "repeat 2 {",
          rows(k, (i) => `let value${i}: integer = seed.f${i}`),
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "E-held-deep",
    measures:
      "N3: a label's segment over a test of the root k compound statements deep, and k uses after it",
    program: (k) =>
      main(
        lines(
          "let n: integer? = 1",
          "label top",
          rows(k, () => "if hostValue is boolean {"),
          'if n != null { say "x" }',
          rows(k, () => "}"),
          rows(k, () => "repeat n {}"),
          "n = null",
          "if hostValue is boolean { goto top }",
          "exit",
        ),
      ),
  },
  {
    name: "E-files",
    measures:
      "N3: k files in a transfer cycle, each a use of one global and a store of `null` before its `goto`",
    program: (k) => [
      file("main.tease", 'global n: integer? = 1\ngoto "f0.tease"'),
      ...Array.from({ length: k }, (_, i) =>
        file(`f${i}.tease`, `${USE_THEN_NULL}\ngoto "f${(i + 1) % k}.tease"`),
      ),
    ],
  },
  {
    name: "E-functions",
    measures:
      "N3: one global, k functions each a loop that reads it and stores `null` after the read, each called once",
    program: (k) =>
      main(
        lines(
          "global n: integer? = 1",
          rows(k, (i) => `function f${i} {\nrepeat 2 {\nrepeat n {}\nn = null\n}\n}`),
          rows(k, (i) => `n = 1\nf${i}()`),
          "exit",
        ),
      ),
  },
  {
    name: "E-block-bodies",
    measures: "N3: k timers' bodies, each reading one key that may be `null` when it is registered",
    program: (k) =>
      main(
        lines(
          "global n: integer? = 1",
          "if hostValue is boolean { n = null }",
          rows(k, () => 'timer async 1 s "t" { repeat n {} }'),
          "exit",
        ),
      ),
  },
];

/**
 * Under the program default (R2.2), k compound statements each storing `null` in one scalar, then one loop reading it:
 * the jumps the scalar's k stores hold are found once (`RouteEntries.#held`), their stretches sorted by start, |L| log |L|
 * charged once per list and name (R60). Main's own work on this shape grows faster per counter than the entry gate
 * allows (its definitions' parent stack, `parentStackSteps`, the same on main), so the total is gated alone, at its
 * measured 64 → 128 step.
 */
export const ROUTE_ENTRY_SIBLING_STORES: KnownProduct = {
  name: "E-default-sibling-stores",
  measures:
    "N3 under the program default (R2.2): k compound statements each storing `null` in one scalar, then one loop reading it",
  program: (k) =>
    main(
      lines(
        "let token = 1",
        'if token == null { say "absent" }',
        "let n: integer? = 1",
        rows(k, () => "if true { n = null }"),
        "repeat 2 { let value: integer = n }",
        "exit",
      ),
    ),
  measured: 2.07,
};

/**
 * Under the program default (R2.2), one scalar's `null` store before a `switch` of k cases, each a `goto` back to the
 * label before the use: k standing jumps for one key, tried in source order after one sort per key (R63). The total is
 * gated alone, at its measured 64 → 128 step, as `ROUTE_ENTRY_SIBLING_STORES`.
 */
export const ROUTE_ENTRY_SWITCH_JUMPS: KnownProduct = {
  name: "E-default-switch-jumps",
  measures:
    "N3 under the program default (R2.2): one scalar's use after a label, its `null` store, then a switch of k cases each going back to the label",
  program: (k) =>
    main(
      lines(
        "let token = 1",
        'if token == null { say "absent" }',
        "let n: integer? = 1",
        "label top",
        "let value: integer = n",
        "n = null",
        "switch hostValue {",
        rows(k, (i) => `  case ${i} { goto top }`),
        "}",
        "exit",
      ),
    ),
  measured: 2.03,
};

/**
 * The route rule's jump index over k files each left by a computed `goto script(...)` (#2497, r4-451's give-up: such a
 * transfer enters no file). The program's flow already grows as files × transfers here, a computed transfer having an
 * edge to every file, so the family is gated on the index's own counter, never on the total.
 */
export const ROUTE_ENTRY_COMPUTED_TRANSFERS: WorkFamily = {
  name: "E-computed-transfers",
  measures:
    "N3: k files, each a use of one global and a store of `null` before a computed `goto script(...)`, which enters no file",
  program: (k) => [
    file("main.tease", 'global n: integer? = 1\ngoto "f0.tease"'),
    ...Array.from({ length: k }, (_, i) =>
      file(`f${i}.tease`, `${USE_THEN_NULL}\ngoto script(hostValue)`),
    ),
  ],
};

/**
 * The route rule's entries over many keys (#2497, r4-451): each key's `null` reaches every later loop's head or label,
 * so its relation tries each later jump once, keys × jumps in all; a known product, gated at its measured doubling.
 */
export const ROUTE_ENTRY_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "E-keys-over-loops",
    measures: "N3: k keys, each read in its own one of k loops and stored `null` after the read",
    measured: 3.84,
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let v${i}: integer? = 1`),
          rows(k, (i) => `repeat 2 {\nrepeat v${i} {}\nv${i} = null\n}`),
          "exit",
        ),
      ),
  },
  {
    name: "E-keys-over-labels",
    measures:
      "N3: k keys, each read after its own one of k labels in a chain and stored `null` after the read",
    measured: 3.23,
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let v${i}: integer? = 1`),
          rows(
            k,
            (i) =>
              `label l${i}\nrepeat v${i} {}\nv${i} = null\nif hostValue is boolean { goto l${i} }`,
          ),
          "exit",
        ),
      ),
  },
];
