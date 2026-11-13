import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { checkedResult } from "../../src/type-inference/core/check-result/check-result.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import { inMode, MODES, stopSet } from "../helpers/type-core-oracles.js";
import { runGlobals } from "../helpers/type-core-route.js";
import { sampled } from "../helpers/sweep.js";

// #2378, the owner's decision of 2026-11-12 (V30 §12): a function's written result type travels to the copies of its
// result, as a variable's written type travels to the copies of the variable (ADR 0021 1.1-1.3). A call of such a
// function is a copy of its written result, through every form a copy of a variable takes.

/**
 * One mode's answer: the outcome, each diagnostic by code, class and line, each check by target and set, the errors'
 * messages.
 */
interface Answer {
  readonly outcome: string;
  readonly diagnostics: readonly string[];
  readonly checks: readonly string[];
  readonly errors: readonly string[];
}

function answerIn(files: readonly SourceFile[]): Answer {
  const request = coreRequest(files);
  assert.ok(request !== null, files[0]!.source);
  const result = checkedResult(analyseCore(request), request);
  const sources = request.files.map((file) => file.source);
  const paths = request.files.map((file) => file.path);
  const shown = messageSource(sources, result.diagnostics);
  const line = (file: number, offset: number): number =>
    sources[file]!.slice(0, offset).split("\n").length;
  return {
    outcome: result.outcome,
    diagnostics: result.diagnostics
      .map((d) => `${d.code} ${d.class} ${paths[d.site.file]}:${line(d.site.file, d.site.start)}`)
      .sort(),
    checks: coreRecord(result, paths)
      .runtimeChecks.map((check) => `${check.target} [${[...check.against].sort().join(",")}]`)
      .sort(),
    errors: result.diagnostics
      .filter((d) => d.class === "compile-error")
      .map((d) => coreMessage(d, shown))
      .sort(),
  };
}

/** The answer, the same in the four modes (both orders, sharing on and off). */
function answer(files: readonly SourceFile[] | string): Answer {
  const project = typeof files === "string" ? [{ path: "main.tease", source: files }] : files;
  const [first, ...others] = MODES.map((mode) => inMode(mode, () => answerIn(project)));
  for (const other of others) assert.deepEqual(other, first, project[0]!.source);
  return first!;
}

/** `valid`, `warning` or `error` with each compile error's code and line in `main.tease`. */
function summary({ outcome, diagnostics }: Answer): string {
  if (outcome === "valid") return "valid";
  const errors = diagnostics
    .filter((d) => d.includes(" compile-error "))
    .map((d) => d.replace(/ compile-error main\.tease:/u, "@"));
  return outcome === "compile-error" ? `error ${errors.join(" ")}` : "warning";
}

// (each row: its name in #2378's HEAD 0, its source, the answer by the rule its row names there; `i6`, `i7`, `m3d`,
// `n2e`, `n3b`, `n3d`, `n5b`, `n8c` and `n10c` are the rows' controls with a declared variable)
const ACCEPTANCE: readonly (readonly [string, string | readonly SourceFile[], string])[] = [
  [
    "i1",
    "function id(_x): integer {\n    return 1\n}\nlet y = id(0)\ny = 2.5\nexit\n",
    "error TSV041@5",
  ],
  [
    "i2",
    'function idu(_x): integer | string {\n    return 1\n}\nlet y = idu(0)\ny = "s"\nexit\n',
    "valid",
  ],
  [
    "i3",
    "function idu(_x): integer | string {\n    return 1\n}\nlet y = idu(0)\ny = 2.5\nexit\n",
    "error TSV041@5",
  ],
  [
    "i4",
    "function id(_x): integer {\n    return 1\n}\nlet y = id(0)\nlet xs = [y, 2.5]\nxs[0] = 1.5\nexit\n",
    "valid",
  ],
  [
    "i5",
    "function id(_x): integer {\n    return 1\n}\nlet xs = [id(0), 2.5]\nxs[0] = 1.5\nexit\n",
    "valid",
  ],
  ["i6", "let lives: integer = 3\nlet y = lives\ny = 2.5\nexit\n", "error TSV041@3"],
  ["i7", "let lives: integer = 3\nlet y = lives\nlet xs = [y, 2.5]\nexit\n", "valid"],
  [
    "m1",
    'function idu(_x): integer | string {\n    return 1\n}\nlet xs = ["s", idu(0)]\nexit\n',
    "valid",
  ],
  [
    "m1b",
    'function idu(_x): integer | string {\n    return 1\n}\nlet xs = ["s", idu(0)]\nxs.add("t")\nxs.add(3)\nexit\n',
    "valid",
  ],
  [
    "m1c",
    'function ids(_x): (integer | string)[] {\n    return [1]\n}\nlet xs = ["s", ids(0)[0]]\nexit\n',
    "valid",
  ],
  [
    "m1d",
    'function idsi(_x): integer[] {\n    return [1]\n}\nlet xs = ["s", idsi(0)[0]]\nexit\n',
    "error TSV044@4",
  ],
  [
    "m2",
    'function idu(_x): integer | string {\n    return 1\n}\nlet xs = [idu(0), 2]\nxs.add("s")\nexit\n',
    "valid",
  ],
  [
    "m3",
    "function id(_x): integer {\n    return 1\n}\nlet xs = [2, id(0)]\nlet ys = xs\nys[0] = 1.5\nexit\n",
    "error TSV041@6",
  ],
  [
    "m3b",
    "function id(_x): integer {\n    return 1\n}\nlet xs = [2, id(0)]\nxs[0] = 1.5\nexit\n",
    "error TSV041@5",
  ],
  [
    "m3c",
    "function id(_x): integer {\n    return 1\n}\nlet xs = [2, id(0)]\nxs.add(2.5)\nexit\n",
    "error TSV041@5",
  ],
  ["m3d", "let lives: integer = 3\nlet xs = [2, lives]\nxs.add(2.5)\nexit\n", "error TSV041@3"],
  [
    "m4",
    "function id(_x): integer {\n    return 1\n}\nlet xs = [[2, id(0)]]\nxs[0][0] = 1.5\nexit\n",
    "error TSV041@5",
  ],
  [
    "m5",
    "function id(_x): integer {\n    return 1\n}\nlet box = {v: [2, id(0)]}\nlet xs = [box.v, [2]]\nxs[0][0] = 1.5\nexit\n",
    "error TSV041@6",
  ],
  [
    "m6",
    'function idu(_x): integer | string {\n    return 1\n}\nlet xs = ["s", idu(0)]\nxs.add(2.5)\nexit\n',
    "error TSV041@5",
  ],
  [
    "m6b",
    'function idu(_x): integer | string {\n    return 1\n}\nlet xs = ["s", idu(0)]\nxs[0] = 2.5\nexit\n',
    "error TSV041@5",
  ],
  [
    "m7",
    'function price(_x): number {\n    return 1.5\n}\nlet xs = [2, price(0)]\nxs.add(1.5)\nxs.add("s")\nexit\n',
    "error TSV041@6",
  ],
  [
    "n1",
    "function id(_x): integer {\n    return 1\n}\nlet n: number = id(0)\nn = 2.5\nexit\n",
    "valid",
  ],
  [
    "n1b",
    "function id(_x): integer {\n    return 1\n}\nlet a = id(0)\nlet b = a\nb = 2.5\nexit\n",
    "error TSV041@6",
  ],
  ["n1c", "function id(_x): integer {\n    return 1\n}\nlet n = 0.5\nn = id(0)\nexit\n", "valid"],
  [
    "n1d",
    "function id(_x): integer {\n    return 1\n}\nlet n = id(0)\nn = id(1)\nn = 3\nexit\n",
    "valid",
  ],
  [
    "n2",
    "function maybe(_x): integer? {\n    return 1\n}\nlet m = maybe(0)\nm = 2.5\nexit\n",
    "error TSV041@5",
  ],
  [
    "n2b",
    "function maybe(_x): integer? {\n    return 1\n}\nlet m = maybe(0)\nlet k = m + 1\nexit\n",
    "error TSV043@5",
  ],
  [
    "n2c",
    "function maybe(_x): integer? {\n    return 1\n}\nlet m = maybe(0)\nif m != null {\n    let k = m + 1\n    k = 2.5\n}\nexit\n",
    "valid",
  ],
  [
    "n2d",
    "function maybe(_x): integer? {\n    return 1\n}\nlet m = maybe(0)\nm = null\nm = 4\nexit\n",
    "valid",
  ],
  ["n2e", "let v: integer? = 1\nlet m = v\nm = 2.5\nexit\n", "error TSV041@3"],
  [
    "n3",
    "function id(_x): integer {\n    return 1\n}\nfunction again(_x) {\n    return id(0)\n}\nlet n = again(0)\nn = 2.5\nexit\n",
    "valid",
  ],
  [
    "n3b",
    "let lives: integer = 3\nfunction again(_x) {\n    return lives\n}\nlet n = again(0)\nn = 2.5\nexit\n",
    "valid",
  ],
  [
    "n3c",
    "function id(_x): integer {\n    return 1\n}\nfunction use(x) {\n    let y = x\n    y = 2.5\n}\nuse(id(0))\nexit\n",
    "error TSV041@6",
  ],
  [
    "n3d",
    "let lives: integer = 3\nfunction use(x) {\n    let y = x\n    y = 2.5\n}\nuse(lives)\nexit\n",
    "error TSV041@4",
  ],
  [
    "n3e",
    "function id(_x): integer {\n    return 1\n}\nfunction again(_x): integer {\n    return id(0)\n}\nlet n = again(0)\nn = 2.5\nexit\n",
    "error TSV041@8",
  ],
  [
    "n4",
    "function fact(n: integer): integer {\n    if n <= 1 {\n        return 1\n    }\n    return n * fact(n - 1)\n}\nlet r = fact(5)\nr = 2.5\nexit\n",
    "error TSV041@8",
  ],
  [
    "n4b",
    "function down(n: integer): integer {\n    if n <= 0 {\n        return 0\n    }\n    let t = down(n - 1)\n    t = 0.5\n    return 1\n}\nlet r = down(3)\nexit\n",
    "error TSV041@6",
  ],
  [
    "n5",
    "function idu(_x): integer | string {\n    return 1\n}\nlet r = idu(0)\nif r is integer {\n    let n = r\n    n = 2.5\n}\nexit\n",
    "error TSV041@7",
  ],
  [
    "n5b",
    "let v: integer | string = 1\nlet r = v\nif r is integer {\n    let n = r\n    n = 2.5\n}\nexit\n",
    "error TSV041@5",
  ],
  [
    "n6b",
    "function pair(_x): integer[] {\n    return [1, 2]\n}\nlet s = pair(0)[0]\ns = 2.5\nexit\n",
    "error TSV041@5",
  ],
  [
    "n6c",
    "function scores(_x): integer[] {\n    return [1]\n}\nlet xs = scores(0)\nxs.add(2.5)\nexit\n",
    "error TSV041@5",
  ],
  ["n7", "function plain(_x) {\n    return 1\n}\nlet y = plain(0)\ny = 2.5\nexit\n", "valid"],
  [
    "n7b",
    "function plain(_x) {\n    return 1\n}\nlet xs = [2, plain(0)]\nxs.add(2.5)\nexit\n",
    "valid",
  ],
  [
    "n8",
    "function id(_x): integer {\n    return 1\n}\nlet xs = [id(0)] + [2.5]\nexit\n",
    "error TSV044@4",
  ],
  [
    "n8b",
    "function ids(_x): integer[] {\n    return [1]\n}\nlet xs = ids(0) + [2.5]\nexit\n",
    "error TSV044@4",
  ],
  [
    "n9",
    [
      { path: "main.tease", source: "let y = gid(0)\ny = 2.5\nexit\n" },
      { path: "helpers.tease", source: "global function gid(_x): integer {\n    return 1\n}\n" },
    ],
    "error TSV041@2",
  ],
  [
    "n10",
    "function id(_x): integer {\n    return 1\n}\nlet xs = []\nxs.add(id(0))\nxs.add(2.5)\nexit\n",
    "error TSV041@6",
  ],
  ["n8c", "let lives: integer = 3\nlet xs = [lives] + [2.5]\nexit\n", "error TSV044@2"],
  [
    "n10c",
    "let lives: integer = 3\nlet xs = []\nxs.add(lives)\nxs.add(2.5)\nexit\n",
    "error TSV041@4",
  ],
  [
    "n11",
    "function id(_x): integer {\n    return 1\n}\nfunction half(x: number) {\n    let h = x / 2\n}\nhalf(id(0))\nexit\n",
    "valid",
  ],
  [
    "n12",
    "function id(_x): integer {\n    return 1\n}\nif id(0) > 0 {\n    let z = 1.5\n}\nexit\n",
    "valid",
  ],
];

test("a copy of a function's written result is as strict as the result, as a copy of a declared variable is (#2378's rows)", () => {
  for (const [name, files, expected] of ACCEPTANCE)
    assert.equal(summary(answer(files)), expected, name);
});

/** Each written type: a start value, a value of the type, a value of another type, and a first value for a later store. */
const TYPES: Readonly<Record<string, Readonly<Record<"V" | "GOOD" | "BAD" | "G0", string>>>> = {
  integer: { V: "1", GOOD: "2", BAD: "2.5", G0: "3" },
  number: { V: "1.5", GOOD: "3", BAD: '"s"', G0: "0.5" },
  "integer | string": { V: "1", GOOD: '"t"', BAD: "2.5", G0: '"u"' },
  "integer?": { V: "1", GOOD: "3", BAD: "2.5", G0: "4" },
  string: { V: '"a"', GOOD: '"b"', BAD: "1", G0: '"c"' },
  "integer[]": { V: "[1]", GOOD: "[2]", BAD: "[2.5]", G0: "[3]" },
  object: { V: "{values: [1], keys: [2]}", GOOD: "1", BAD: "2.5", G0: "0" },
};

/** Each form a copy takes, `SRC` the copied source; `[]` forms for a list type alone, `object` forms for `object` alone. */
const FORMS: Readonly<Record<string, string>> = {
  direct: "let y = SRC\ny = BAD\n",
  "direct-good": "let y = SRC\ny = GOOD\n",
  "copy-of-copy": "let a = SRC\nlet y = a\ny = BAD\n",
  "element-first": "let xs = [SRC, GOOD]\nxs.add(BAD)\n",
  "element-second": "let xs = [GOOD, SRC]\nxs.add(BAD)\n",
  "literal-copy": "let xs = [SRC]\nlet ys = xs\nys[0] = BAD\n",
  nested: "let xs = [[SRC]]\nxs[0][0] = BAD\n",
  property: "let o = {v: SRC}\no.v = BAD\n",
  "projected-box": "let box = {v: [SRC]}\nlet xs = [box.v]\nxs[0][0] = BAD\n",
  add: "let xs = []\nxs.add(SRC)\nxs.add(BAD)\n",
  parameter: "function use(x) {\n    let y = x\n    y = BAD\n}\nuse(SRC)\n",
  "join-first": "let xs = [SRC] + [BAD]\n",
  "join-second": "let xs = [BAD] + [SRC]\n",
  "later-store": "let y = G0\ny = SRC\ny = BAD\n",
  "after-null": "let y = null\ny = SRC\ny = BAD\n",
  narrowed: "let r = SRC\nif r != null {\n    let n = r\n    n = BAD\n}\n",
  "[] element-of-list": "let y = SRC[0]\ny = BAD\n",
  "dict-values-good": "let xs = dict{a: SRC, b: V}\nlet ys = xs.values\nys.add(GOOD)\n",
  "dict-values-bad": "let xs = dict{a: SRC, b: V}\nlet ys = xs.values\nys.add(BAD)\n",
  "dict-values-copy": "let xs = dict{a: SRC}\nlet ys = xs.values\nlet zs = ys\nzs.add(BAD)\n",
  "dict-values-element": "let xs = dict{a: SRC}\nlet y = xs.values[0]\ny = BAD\n",
  "dict-store": 'let xs = dict{a: SRC}\nxs["b"] = BAD\n',
  "dict-get": 'let xs = dict{a: SRC}\nlet y = xs["a"]\ny = BAD\n',
  "set-literal": "let xs = set[SRC, V]\nxs.add(BAD)\n",
  "set-literal-copy": "let xs = set[SRC]\nlet ys = xs\nys.add(BAD)\n",
  "to-set": "let xs = [SRC].toSet()\nxs.add(BAD)\n",
  "object values-join": 'let xs = SRC.values + [2.5]\nxs.add("s")\n',
  "object keys-join": 'let xs = SRC.keys + [2.5]\nxs.add("s")\n',
  "object values-copy": 'let xs = SRC.values\nxs.add("s")\n',
};

// (#2538: a later store of a written union's read is an error through the variable's writer route, a warning and a
// check for a call, which has none; the route rule's, not a copy's)
const APART = new Set(["later-store integer | string"]);

test("a call of a function with a written result answers as a read of a variable declared with that type, in every form a copy takes and with every written type (#2378's family)", () => {
  let pairs = 0;
  for (const [type, values] of Object.entries(TYPES))
    for (const [named, form] of Object.entries(FORMS)) {
      const [scope, name] = named.includes(" ") ? named.split(" ") : [null, named];
      if ((scope === "[]") !== type.endsWith("[]") || (scope === "object") !== (type === "object"))
        continue;
      pairs += 1;
      if (APART.has(`${name} ${type}`)) continue;
      const body = form
        .replaceAll("GOOD", values.GOOD)
        .replaceAll("BAD", values.BAD)
        .replaceAll("G0", values.G0)
        .replace(/\bV\b/gu, values.V);
      const [call, variable] = [
        `function src(_x): ${type} { return ${values.V} }\n${body.replaceAll("SRC", "src(0)")}exit\n`,
        `let src: ${type} = ${values.V}\n${body.replaceAll("SRC", "src")}exit\n`,
      ].map((source) => {
        const { outcome, diagnostics, checks } = answer(source);
        return {
          outcome,
          diagnostics,
          checks: checks.map((check) => check.replace("src.result", "src")),
        };
      });
      assert.deepEqual(call, variable, `${name} ${type}`);
    }
  assert.equal(pairs, 129);
});

// (B-VALUES: the witness returns the very variable its control reads, so the call and the variable hold one value)
const WITNESS =
  "let typedV: integer | string = hostValue\nfunction fnn(_x): integer | string {\n    return typedV\n}\n";

/** The checks an answer owes besides `typedV`'s own, which reads the host value. */
function beyondWitness({ checks }: Answer): readonly string[] {
  return checks.filter((check) => !check.startsWith("typedV "));
}

test("a dict's `.values` is a copy of its values with their written type, for a call's result and a declared variable alike (#2378, V30 §12)", () => {
  for (const value of ["fnn(0)", "typedV"]) {
    for (const [store, expected] of [
      ['"s"', "warning"],
      ["2.5", "error TSV041@7"],
    ] as const) {
      const got = answer(
        `${WITNESS}let xs = dict{a: ${value}, b: 2}\nlet ys = xs.values\nys.add(${store})\nexit\n`,
      );
      assert.equal(summary(got), expected, `${value}, ${store}`);
      assert.deepEqual(beyondWitness(got), [], `${value}, ${store}: no check of the list`);
    }
    const nested = answer(
      `${WITNESS}let xs = dict{a: dict{b: ${value}}}\nlet ys = xs.values\nlet zs = ys[0].values\nzs.add("s")\nzs.add(2.5)\nexit\n`,
    );
    assert.equal(summary(nested), "error TSV041@9", value);
    assert.deepEqual(beyondWitness(nested), [], value);
  }
  // (a written dict: its values list, a copy of it, an element of it and a set of it; a call's dict result; the list
  // and `toSet` controls main already holds to the same rule)
  const DICT = "let d: integer dict = dict{a: 1}\n";
  const rows: readonly (readonly [string, string])[] = [
    [`${DICT}let ys = d.values\nys.add(2.5)\nexit\n`, "error TSV041@3"],
    [`${DICT}let e = d\nlet ys = e.values\nys.add(2.5)\nexit\n`, "error TSV041@4"],
    [`${DICT}let y = d.values[0]\ny = 2.5\nexit\n`, "error TSV041@3"],
    [`${DICT}let s = d.values.toSet()\ns.add(2.5)\nexit\n`, "error TSV041@3"],
    [
      "function src(_x): integer dict { return dict{a: 1} }\nlet ys = src(0).values\nys.add(2.5)\nexit\n",
      "error TSV041@3",
    ],
    [`${DICT}let ys = d.values\nys.add(2)\nexit\n`, "valid"],
    [`${DICT}let ks = d.keys\nks.add("b")\nexit\n`, "valid"],
    [
      'let d: (integer | string) dict = dict{a: 1}\nlet ys = d.values\nys.add("s")\nys.add(2.5)\nexit\n',
      "error TSV041@4",
    ],
    [
      "let lives: integer = 1\nlet xs = [lives]\nlet ys = xs\nys.add(2.5)\nexit\n",
      "error TSV041@4",
    ],
    ["let lives: integer = 1\nlet s = [lives].toSet()\ns.add(2.5)\nexit\n", "error TSV041@3"],
  ];
  for (const [source, expected] of rows) assert.equal(summary(answer(source)), expected, source);
});

test("an object's property named `values` or `keys` is the property, not a dict's list: a copy of it keeps the written type, which an `object` leaves open (#2378 R16, #2551)", () => {
  for (const name of ["values", "keys"])
    for (const [head, read] of [
      [`function src(_x): object { return {${name}: [1]} }\n`, "src(0)"],
      [`let src: object = {${name}: [1]}\n`, "src"],
    ] as const) {
      for (const body of [
        `let xs = ${read}.${name} + [2.5]\nxs.add("s")\n`,
        `let xs = ${read}.${name}\nxs.add("s")\n`,
        `let xs = ${read}.${name}\nxs[0] = "s"\n`,
      ]) {
        const got = answer(`${head}${body}exit\n`);
        assert.equal(summary(got), "valid", `${head}${body}`);
        assert.deepEqual(got.checks, [], `${head}${body}`);
      }
    }
  // (and a written integer read through properties of those names is strict, as through any other name; the probe of
  // `type-core-key-ids`' member chain)
  for (const name of ["values", "keys", "year"])
    assert.equal(
      summary(
        answer(
          `let seed: integer = 1\nlet root = {f: seed}\nlet a0 = {${name}: root}\nlet out = a0.${name}.f\nout = 2.5\nexit\n`,
        ),
      ),
      "error TSV041@5",
      name,
    );
});

test("#2551: on the core's route a copy of an `object`'s property named `values` is planned without a check and runs to its end, as one named `year` does", () => {
  for (const source of [
    'let typedV: object = {values: hostValue}\nlet x = typedV.values\nx = "s"\nexit\n',
    'let typedV: object = {values: 1}\nlet x = typedV.values\nx = "s"\nexit\n',
    'let typedV: object = {keys: hostValue}\nlet x = typedV.keys\nx = "s"\nexit\n',
    'let typedV: object = {year: hostValue}\nlet x = typedV.year\nx = "s"\nexit\n',
  ])
    for (const mode of MODES) {
      const { plan, diagnostics } = inMode(mode, () =>
        compileProjectWithBackend(
          [{ path: "main.tease", source }],
          { globals: ["hostValue"] },
          CORE_BACKEND,
        ),
      );
      assert.deepEqual(
        diagnostics.filter((d) => d.severity === "error"),
        [],
        source,
      );
      assert.ok(plan !== null, source);
      for (const hostValue of [1, "s"])
        assert.deepEqual(
          [runGlobals(plan, { hostValue }).status, runGlobals(plan, { hostValue }).failure],
          ["halted", null],
          `${source} with ${hostValue}`,
        );
    }
});

// (#2378 R26: every read of a dict's values list, each requirement it makes on its destination and on the dict's own
// list element decided by the dict's element domain, for a call and a variable of one written type alike; the function
// returns the very variable its control reads, so both forms hold one value)
const READS: Readonly<Record<string, string>> = {
  "whole copy": "let ys = d.values\nys.add(X)\n",
  "copy, then an element": "let ys = d.values\nlet y = ys[0]\ny = X\n",
  index: "let y = d.values[0]\ny = X\n",
  first: "let y = d.values.first\ny = X\n",
  last: "let y = d.values.last\ny = X\n",
  random: "let y = d.values.random\ny = X\n",
  loop: "for v in d.values {\n    let w = v\n    w = X\n}\n",
  take: "let ys = d.values.take(1)\nys.add(X)\n",
  toSet: "let s = d.values.toSet()\ns.add(X)\n",
  join: "let ys = d.values + [2]\nys.add(X)\n",
  "a list argument": "function use(xs) {\n    let y = xs[0]\n    y = X\n}\nuse(d.values)\n",
  "an element argument": "function use(x) {\n    let y = x\n    y = X\n}\nuse(d.values[0])\n",
  "a copy of the dict": "let e = d\nlet y = e.values[0]\ny = X\n",
  "a nested dict": "let dd = dict{k: d}\nlet y = dd.values[0].values[0]\ny = X\n",
  // (no requirement: a read alone, and a store into the list `d.values` gives, which nothing holds)
  contains: "let found = d.values.contains(X)\n",
  "add in place": "d.values.add(X)\n",
};

test("a read through a dict's `.values` is decided by the dict's written element domain, for a call's result and a declared variable alike (#2378 R26)", () => {
  for (const [type, fits] of [
    ["integer | string", '"s"'],
    ["integer", "3"],
  ] as const)
    for (const [read, body] of Object.entries(READS))
      for (const value of [fits, "2.5"]) {
        const [call, variable] = ["supply(0)", "item"].map((src) =>
          answer(
            `let item: ${type} = hostValue\nfunction supply(_arg): ${type} {\n    return item\n}\n` +
              `let d = dict{a: ${src}, b: 2}\n${body.replaceAll("X", value)}exit\n`,
          ),
        );
        const at = `${read}, ${type}, ${value}`;
        assert.deepEqual(
          [call!.outcome, call!.diagnostics, call!.checks],
          [variable!.outcome, variable!.diagnostics, variable!.checks],
          at,
        );
        const errors = call!.diagnostics.filter((d) => d.includes(" compile-error "));
        if (value === fits || read === "contains" || read === "add in place") {
          assert.deepEqual(errors, [], at);
          assert.deepEqual(beyondItem(call!), [], `${at}: no check of the dict's values`);
        } else assert.ok(errors.length === 1 && errors[0]!.startsWith("TSV041 "), at);
      }
});

/**
 * The checks an answer owes besides `item`'s own, which reads the host value, and the emptiness check a list's `.first`,
 * `.last` or `.random` owes whatever its elements.
 */
function beyondItem({ checks }: Answer): readonly string[] {
  return checks.filter((check) => !check.startsWith("item ") && !check.endsWith(" [list]"));
}

/** The parts of `stopSet`'s record a stopped run's strictness reads. */
interface StopRecord {
  readonly diagnostics: readonly {
    readonly class: string;
    readonly site: { readonly start: number };
  }[];
  readonly checks: readonly { readonly target: string; readonly against: readonly string[] }[];
}

test("a stopped analysis of a read through a dict's `.values` invents no strictness: no compile error, no check against `integer` alone and none of a list against `dict` that its natural run lacks (#2378 R27)", () => {
  const files = [
    {
      path: "main.tease",
      source:
        'function fnn(_x): integer | string {\n return 1\n}\nlet d = dict{a: fnn(0), b: 2}\nlet y = d.values[0]\ny = "s"\nlet z = d.values.first\nz = 3\nexit\n',
    },
  ];
  const strict = (record: StopRecord): Set<string> =>
    new Set([
      ...record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `error@${d.site.start}`),
      ...record.checks
        .filter(
          (c) => c.against.length === 1 && (c.against[0] === "integer" || c.against[0] === "dict"),
        )
        .map((c) => `${c.target}[${c.against[0]}]`),
    ]);
  const read = (allowance: number | null, mode: (typeof MODES)[number]): StopRecord => {
    // EVIDENCE: `stoppedRecord` serializes the answers' diagnostics and checks.
    return JSON.parse(stopSet(files, mode, ["hostValue"], allowance)!.record) as StopRecord;
  };
  for (const mode of MODES) {
    const natural = strict(read(null, mode));
    assert.deepEqual([...natural], [], "the natural run is strict nowhere");
    for (const allowance of sampled(Array.from({ length: 30 }, (_, k) => k + 1)))
      assert.deepEqual(
        [...strict(read(allowance, mode))],
        [],
        `${allowance} ${JSON.stringify(mode)}`,
      );
  }
});

test("a store of numbers into a copy of an `integer` result names the function and its fix (#2378 R3, the copy sentence of #2289)", () => {
  const ID = "function id(_x): integer {\n    return 1\n}\n";
  const rows: readonly (readonly [string, string])[] = [
    [
      `${ID}let y = id(0)\ny = 2.5\nexit\n`,
      "'y' holds a whole number (integer) because it is a copy of the result of 'id', declared 'integer' on line 1. To store other numbers in it, write 'let y: number = id(0)'.",
    ],
    [
      `${ID}let xs = [id(0), id(1)]\nxs.add(2.5)\nexit\n`,
      "'xs' holds whole numbers (integer[]) because its elements are copies of the result of 'id', declared 'integer' on line 1. To add other numbers to it, write 'let xs: number[] = [id(0), id(1)]'.",
    ],
    [
      `${ID}let d = dict{a: id(0)}\nd["b"] = 2.5\nexit\n`,
      "'d' holds whole numbers (integer dict) because its values are copies of the result of 'id', declared 'integer' on line 1. To add other numbers to it, write 'let d: number dict = dict{a: id(0)}'.",
    ],
    [
      `${ID}let s = set[id(0)]\ns.add(2.5)\nexit\n`,
      "'s' holds whole numbers (integer set) because its elements are copies of the result of 'id', declared 'integer' on line 1. To add other numbers to it, write 'let s: number set = set[id(0)]'.",
    ],
    [
      "function id(_x): integer? {\n    return 1\n}\nlet y = id(0)\ny = 2.5\nexit\n",
      "'y' holds a whole number (integer) or null because it is a copy of the result of 'id', declared 'integer?' on line 1. To store other numbers in it, write 'let y: number? = id(0)'.",
    ],
    [
      "let y = id(0)\ny = 2.5\nfunction id(_x): integer {\n    return 1\n}\nexit\n",
      "'y' holds a whole number (integer) because it is a copy of the result of 'id', declared 'integer' on line 3. To store other numbers in it, write 'let y: number = id(0)'.",
    ],
    // (the variable's own, unchanged)
    [
      "let lives: integer = 3\nlet y = lives\ny = 2.5\nexit\n",
      "'y' holds a whole number (integer) because it is a copy of 'lives', declared 'integer' on line 1. To store other numbers in it, write 'let y: number = lives'.",
    ],
    // (copies of two sources: no one source to name, the general sentence, as for two variables)
    [
      `${ID}let lives: integer = 3\nlet xs = [id(0), lives]\nxs.add(2.5)\nexit\n`,
      "'xs' holds whole numbers (integer[]) since line 5, so it cannot contain a number. Round the number with the floor, round or ceil function first.",
    ],
    [
      `${ID}function other(_x): integer {\n    return 2\n}\nlet xs = [id(0), other(0)]\nxs.add(2.5)\nexit\n`,
      "'xs' holds whole numbers (integer[]) since line 7, so it cannot contain a number. Round the number with the floor, round or ceil function first.",
    ],
  ];
  for (const [source, message] of rows) assert.deepEqual(answer(source).errors, [message], source);
});
