// Admission in the cells: a range's list, an opaque chain, start values and fallbacks, written copies through carriers,
// arguments beside defaults.

import assert from "node:assert/strict";
import test from "node:test";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { type CompactRecord } from "../../helpers/type-core-records.js";
import { summary } from "../../helpers/type-core/type-core-cells-setup.js";

/**
 * V30 §6, F10, F27 (Astra's B1 on #1028): a range's list holds the range's whole numbers, as the category layer declares
 * a range's elements, and maybe none, as its bounds decide (review round 3: `3..1` holds none, and its list's `first`
 * fails at runtime with TSR018). Its element read is an integer into a count, a written integer and through `first`,
 * bound, in a loop and through a function's result of two returns, each selection with its empty check; in both
 * orders. A written text is the control.
 */
test("a range's list holds its whole numbers, maybe none", () => {
  const programs: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "counted",
      "let xs = (1..3).toList()\nrepeat xs.first {}\nexit",
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "warning-runtime-check",
      ],
    ],
    [
      "into a written integer",
      "let n: integer = (1..3).toList().first\nexit",
      [
        "empty-check (1..3).toList() [list] @17",
        "member-read warning-runtime-check @17",
        "warning-runtime-check",
      ],
    ],
    ["visited by a loop", "for x in (1..3).toList() { repeat x {} }\nexit", ["valid"]],
    [
      "through a function's result",
      'function make(f) {\nif f { return (1..3).toList() }\nreturn (2..4).toList()\n}\nrepeat make(askBoolean "f").first {}\nexit',
      [
        "empty-check make.result [list] @83",
        "member-read warning-runtime-check @83",
        "warning-runtime-check",
      ],
    ],
    [
      "an empty range's first",
      "let xs = (3..1).toList()\nrepeat xs.first {}\nexit",
      // (beside V30 §6's ordinary warning at the written range that holds no number, S9b)
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "static warning @9",
        "warning-runtime-check",
      ],
    ],
    [
      "an empty range's removal",
      "let xs = (3..1).toList()\nrepeat xs.removeFirst() {}\nexit",
      // (beside V30 §6's ordinary warning at the written range that holds no number, S9b)
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "static warning @9",
        "warning-runtime-check",
      ],
    ],
    [
      "into a written text",
      "let s: string = (1..3).toList().first\nexit",
      [
        "compile-error",
        "empty-check (1..3).toList() [list] @16",
        "member-read warning-runtime-check @16",
        "written-target compile-error @16",
      ],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const got = summary(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * F15 (Astra's D1 on #1028): a method without a category (a list's `union`, whose result is the
 * runtime's until the result relations, S9b) answers the runtime's opaque `unknown` on a receiver of a known kind, and on
 * what the core cannot know keeps that value's own reasons, so a chain of such methods stays opaque (the word
 * `unmodelled`), with no external data and no boundary; a modelled method in the chain gives its declared result. Both
 * orders.
 */
test("a chain of methods without a category stays opaque", () => {
  const cases: readonly (readonly [string, string, readonly string[], readonly string[]])[] = [
    [
      "two methods without a category",
      "let n: integer = [1].union([2]).union([3])\nexit",
      [
        "copy-type n [integer] @17",
        "null-check [1].union([2]) [non-null] @17",
        "warning-runtime-check",
      ],
      ["written-target warning-runtime-check unmodelled @17"],
    ],
    [
      "a modelled method, then one without a category",
      "let n: integer = [1, 2].take(1).union([2])\nexit",
      ["copy-type n [integer] @17", "warning-runtime-check"],
      ["written-target warning-runtime-check unmodelled @17"],
    ],
    [
      "one without a category, then a modelled method",
      "let n: integer = [1].union([2]).join()\nexit",
      ["compile-error", "null-check [1].union([2]) [non-null] @17"],
      ["written-target compile-error null @17"],
    ],
    [
      "a receiver of a known kind or an opaque answer",
      'let s = [1]\nlet t = s\nif askBoolean "f" { t = s.union([2]) }\nlet n: integer = t.union([3])\nexit',
      // (the opaque answer stored into `t`, decided a list by its start value, owes its check there: A5, C1)
      [
        "copy-type n [integer] @78",
        "copy-type t [list] @46",
        "copy-type t.element [integer] @46",
        "null-check t [non-null] @78",
        "warning-runtime-check",
      ],
      ["written-target warning-runtime-check unmodelled @78"],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected, words] of cases)
    for (const reversed of [false, true]) {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, `${name}: its source parses and resolves`);
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // its outcome and checks, and the words of its value's diagnostics
      const got = [
        record.outcome,
        ...record.checks.map(
          (check) =>
            `${check.kind} ${check.target} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
        ),
      ].sort();
      const worded = record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context} @${d.site.offset}`,
      );
      if (
        JSON.stringify(got) !== JSON.stringify(expected) ||
        words.some((word) => !worded.includes(word))
      )
        differing.push(`${name}${reversed ? " reversed" : ""}: ${[...got, ...worded].join("; ")}`);
    }
  assert.deepEqual(differing, []);
});

const f =
  'function f(flag: boolean): string | boolean {\n  if flag { return "bad" }\n  return false\n}\n';
const nest = (depth: number, value: string): string =>
  `${"[".repeat(depth)}${value}${"]".repeat(depth)}`;
// (a fourth part: what the reversed order gives where it differs)
const programs: readonly (
  | readonly [string, string, (at: (text: string) => number) => string[]]
  | readonly [
      string,
      string,
      (at: (text: string) => number) => string[],
      (at: (text: string) => number) => string[],
    ]
)[] = [
  [
    "a start value after an earlier store in a function",
    'function change { n = "bad" }\nlet n = 1\nrepeat n {}\nexit',
    (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
  ],
  [
    "a literal element copying a written union",
    'let original: integer | string = 1\nlet xs = [original, "ok"]\nsay xs\nexit',
    () => ["valid"],
  ],
  [
    "a dict value copying a written union",
    'let original: integer | string = 1\nlet d = dict{a: original, b: "ok"}\nsay d\nexit',
    () => ["valid"],
  ],
  [
    "a shared field copying a written union",
    'let original: integer | string = 1\nlet rows = [{n: original}, {n: "ok"}]\nsay rows\nexit',
    () => ["valid"],
  ],
  [
    "no kind fitting a decided field",
    `${f}let box = {n: 1}\nbox.n = f(true)\nsay box.n\nexit`,
    (at) => ["compile-error", `written-target compile-error @${at("f(true)")}`],
  ],
  [
    "no kind fitting a decided element or entry",
    `${f}let xs = [1]\nxs.add(f(true))\nlet d = dict{k: 1}\nd["k"] = f(true)\nexit`,
    (at) => [
      "compile-error",
      `written-target compile-error @${at("f(true))")}`,
      `written-target compile-error @${at("f(true)\nexit")}`,
    ],
  ],
  [
    "a null into a copy of a written binding",
    "let n: integer = 1\nlet copy = n\ncopy = null\nrepeat copy {}\nexit",
    (at) => ["compile-error", `written-target compile-error @${at("null")}`],
  ],
  [
    "a literal's element of another type",
    'let xs = [1, "bad"]\nlet r: integer = xs.first\nexit',
    (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
  ],
  [
    "a literal's nested element of another type",
    'let xs = [{n: 1}, {n: "bad"}]\nexit',
    (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
  ],
  [
    "an unknown fallback landing in a written union",
    "let r: integer | string = [1, null][1] otherwise hostValue\nexit",
    (at) => [
      "warning-runtime-check",
      `written-target warning-runtime-check @${at("[1, null]")}`,
      `written-target warning-runtime-check @${at("hostValue")}`,
      `copy-type r [integer, string] @${at("[1, null]")}`,
      `copy-type hostValue [integer, number, string] @${at("hostValue")}`,
      `copy-type hostValue [unknown] boundary @${at("hostValue")}`,
    ],
  ],
  [
    "a fallback of two other kinds",
    `${f}let x = [1, null][1] otherwise f(true)\nexit`,
    (at) => [
      "warning-runtime-check",
      `written-target warning-runtime-check @${at("f(true)")}`,
      `written-target warning-runtime-check @${at("f(true)")}`,
      `copy-type f.result [integer, number] @${at("f(true)")}`,
      `copy-type f.result [integer, number] @${at("f(true)")}`,
    ],
  ],
  [
    "a written integer copied beside a whole number",
    "let n: integer = 1\nlet xs = [n, 2]\nrepeat xs[0] {}\nlet rows = [{n: n}, {n: 2}]\nexit",
    () => ["valid"],
  ],
  [
    // (#2289 B1 rule 1: whole numbers beside a number are numbers, whatever is declared)
    "a written integer copied beside a fraction",
    "let n: integer = 1\nlet xs = [n, 2.5]\nexit",
    () => ["valid"],
  ],
  [
    "a written union copied beside a whole number",
    'let n: integer | string = "a"\nlet d = dict{first: n, second: 2}\nexit',
    () => ["valid"],
  ],
  [
    "no possible kind fitting a decided field",
    `${f}let box = {n: 1}\nbox.n = f(true)\nrepeat box.n {}\nexit`,
    (at) => ["compile-error", `written-target compile-error @${at("f(true)")}`],
  ],
  // (the decision of `xs` grows with the literal's depth, never its square, so it stays within its allowance, #1438)
  [
    "a deep literal's element of another type",
    `let xs = [${nest(300, "1")}, ${nest(300, '"bad"')}]\nexit`,
    (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
  ],
  [
    "a deep literal's element copying a written union",
    `let typed: integer | string = 1\nlet xs = [${nest(300, "typed")}, ${nest(300, '"ok"')}]\nexit`,
    () => ["valid"],
    // (reversed, its deepest paths' decisions cost depth × copies past their allowance, G6 in #1319's design-round
    // list: one restart, then a stop in it stops the analysis,
    // docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183; the G6 repair returns it to
    // `valid`)
    (at) => [
      "warning-runtime-check",
      `budget not-checked-budget @${at("[")}`,
      `budget warning-runtime-check @${at("[")}`,
      `copy-type xs [unknown] @${at("[")}`,
    ],
  ],
  [
    "a default's other kind beside the receiving union",
    'function alternate(flag: boolean): string | integer {\n  if flag { return "allowed" }\n  return 2\n}\nlet r: boolean | string = toBoolean("bad", default: alternate(true))\nexit',
    // (known text the conversion cannot convert is its own error, `default:` or not: V30 §13, #1105)
    (at) => [
      "compile-error",
      `static compile-error @${at('"bad"')}`,
      `written-target warning-runtime-check @${at("toBoolean")}`,
      `written-target warning-runtime-check @${at("alternate(true)")}`,
      `copy-type r [boolean, string] @${at("toBoolean")}`,
      `copy-type alternate.result [string, boolean] @${at("alternate(true)")}`,
    ],
  ],
  [
    "a lazy file default of another kind",
    'let r = fileFromBase64("!", default: false)\nexit',
    (at) => ["compile-error", `written-target compile-error @${at("false")}`],
  ],
  [
    "a lazy decryption default of external data",
    'let r = decryptText("!", password: "p", default: hostValue)\nexit',
    (at) => [
      "warning-runtime-check",
      `written-target warning-runtime-check @${at("hostValue")}`,
      `copy-type hostValue [string] @${at("hostValue")}`,
      `copy-type hostValue [unknown] boundary @${at("hostValue")}`,
    ],
  ],
  [
    "a lazy decryption default landing in a written union",
    'let r: string | boolean = decryptFile("!", password: "p", default: false)\nexit',
    () => ["valid"],
  ],
  [
    "a lazy file default of null",
    'let r = fileFromBase64("!", default: null)\nexit',
    () => ["valid"],
  ],
  [
    "a copy of a written list stored a list of another kind, its elements unread",
    'let typed: integer[] = [1]\nlet copy = typed\nlet other = ["bad"]\ncopy = other\nexit',
    (at) => ["compile-error", `written-target compile-error @${at("other\nexit")}`],
  ],
  [
    "a copy of a written integer stored a possible null, then external data",
    "let typed: integer = 1\nlet copy = typed\ncopy = [1, null][1]\ncopy = hostValue\nexit",
    (at) => [
      "warning-runtime-check",
      `written-target warning-runtime-check @${at("[1, null]")}`,
      `written-target warning-runtime-check @${at("hostValue")}`,
      `null-check copy [integer] @${at("[1, null]")}`,
      `copy-type copy [integer] @${at("hostValue")}`,
      `copy-type copy [integer] boundary @${at("hostValue")}`,
    ],
  ],
  // the earliest deciding element decides a literal's path, a written copy only where it comes first; a `null` or an
  // unknown before it decides nothing (review: Astra's B2)
  [
    "a fraction before a copy of a written integer",
    "let whole: integer = 1\nlet xs = [2.5, whole]\nxs = [3.5]\nexit",
    () => ["valid"],
  ],
  [
    "a fraction before a copy of a written integer, in dict values and shared fields",
    "let whole: integer = 1\nlet d = dict{a: 2.5, b: whole}\nd = dict{c: 3.5}\nlet rows = [{n: 2.5}, {n: whole}]\nrows = [{n: 3.5}]\nexit",
    () => ["valid"],
  ],
  [
    "a whole number before a copy of a written text",
    'let s: string = "a"\nlet xs = [1, s]\nexit',
    (at) => ["compile-error", `written-target compile-error @${at("s]")}`],
  ],
  [
    // (`[whole, 2.5]` holds numbers, #2289 B1 rule 1; `ys` the declared integer its one deciding element has)
    "a copy of a written integer first, a null and external data before it",
    "let whole: integer = 1\nlet xs = [whole, 2.5]\nlet ys = [null, hostValue, whole]\nys = [3.5]\nexit",
    (at) => [
      "compile-error",
      `written-target compile-error @${at("3.5")}`,
      // (the null element keeps the element optional, ADR 0021 1.3; the external one owes its check and boundary)
      `written-target warning-runtime-check @${at("hostValue")}`,
      `copy-type ys.element [integer, null] @${at("hostValue")}`,
      `copy-type ys.element [integer, null] boundary @${at("hostValue")}`,
    ],
  ],
  // a return's literal decides the result's paths as a store's does: a later return of another element kind errs
  // (ADR 0021 1.5, A8; review r5)
  [
    "two returns' lists of different element kinds",
    'function g(flag: boolean) {\n  if flag { return [1] }\n  return ["x"]\n}\nlet r = g(true)\nexit',
    (at) => ["compile-error", `written-target compile-error @${at('"x"')}`],
  ],
  // a return of another kind is rejected, so the result's readers see the first return's kind (A6, F23; review:
  // Astra's D1); a written result's alike
  [
    "a return of another element kind, its result read",
    'function f(flag: boolean) {\n  if flag { return [3] }\n  return ["bad"]\n}\nlet n: integer = f(true).first\nexit',
    (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
  ],
  [
    "a return of another kind, its result read",
    'function f(flag: boolean) {\n  if flag { return 3 }\n  return "bad"\n}\nlet n: integer = f(true)\nexit',
    (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
  ],
  // a literal's `null` element beside the copy makes the element optional (ADR 0021 1.3, A8), its type strict
  [
    "a list whose first element copies a written integer, a later one possibly null, then external data",
    "let typed: integer = 1\nlet xs = [typed, [1, null][1], hostValue]\nexit",
    (at) => [
      "warning-runtime-check",
      `written-target warning-runtime-check @${at("hostValue")}`,
      `copy-type xs.element [integer, null] @${at("hostValue")}`,
      `copy-type xs.element [integer, null] boundary @${at("hostValue")}`,
    ],
  ],
  // (a possible misfit warns at the store's value, the literal; an error would sit at its innermost expression)
  [
    // (a number beside the written integer makes the set's elements numbers, #2289 B1 rule 1: nothing to check)
    "a set whose first element copies a written integer, a later one possibly a fraction",
    "let typed: integer = 1\nlet xs = set[typed, [1, 2.5][1]]\nexit",
    () => ["valid"],
  ],
  [
    "a default whose written contract fits",
    "let fallback: integer = hostValue\nlet result = [1].get(2, default: fallback)\nexit",
    (at) => [
      "warning-runtime-check",
      `written-target warning-runtime-check @${at("hostValue")}`,
      `copy-type fallback [integer] @${at("hostValue")}`,
      `copy-type fallback [integer] boundary @${at("hostValue")}`,
    ],
  ],
  // G3 2c: the earliest decider read through the carriers' transfers (`admission/transfers.ts`)
  [
    "nested selections' element of another type",
    'let seed = "s"\nlet xs = [[[[seed, "o"][0], "o"][0], "o"][0], 1]\nexit',
    (at) => ["compile-error", `written-target compile-error @${at("1]")}`],
  ],
  [
    "a choice object's selected value read below the choice",
    'let out = askChoice [{text: "a", value: {n: 1}}, {text: "b", value: {n: "x"}}]\nsay "${out.n}"\nexit',
    // (each object as a button's value is TSV029's error too since S9b)
    (at) => [
      "compile-error",
      `operator compile-error @${at("{n: 1}")}`,
      `operator compile-error @${at('{n: "x"}')}`,
      `written-target compile-error @${at('"x"')}`,
    ],
  ],
  [
    "the choice objects in the other order",
    'let out = askChoice [{text: "b", value: {n: "x"}}, {text: "a", value: {n: 1}}]\nsay "${out.n}"\nexit',
    (at) => [
      "compile-error",
      `operator compile-error @${at('{n: "x"}')}`,
      `operator compile-error @${at("{n: 1}")}`,
      `written-target compile-error @${at("1}")}`,
    ],
  ],
  [
    "nested selections of a nullable written source",
    'let typed: string? = hostValue\nlet xs = [[[typed, "o"][0], "o"][0], 1]\nexit',
    (at) => [
      "compile-error",
      `copy-type typed [string, null] @${at("hostValue")}`,
      `copy-type typed [string, null] boundary @${at("hostValue")}`,
      `written-target compile-error @${at("1]")}`,
      `written-target warning-runtime-check @${at("hostValue")}`,
    ],
  ],
  [
    "nested selections before a fallback",
    'let seed = "s"\nlet xs = [([[seed, "o"][0], "o"][0] otherwise 2), 1]\nexit',
    (at) => [
      "compile-error",
      `copy-type xs.element [string] @${at("[(")}`,
      // (#1072, V30 §18: the selection is never null, so its fallback never runs; the fallback stays checked)
      `static warning @${at("otherwise 2")}`,
      `written-target compile-error @${at("2)")}`,
      `written-target compile-error @${at("1]")}`,
      `written-target warning-runtime-check @${at("[(")}`,
    ],
  ],
  [
    "nested selections as a default",
    'let seed = ["s"]\nlet xs = [seed.get(0, default: [["d", "o"][0], "o"][0]), 1]\nexit',
    (at) => [
      "warning-runtime-check",
      `copy-type xs.element [integer] @${at("[seed")}`,
      `written-target warning-runtime-check @${at("[seed")}`,
    ],
  ],
  [
    "a place decided below nested selections of objects",
    'let seed = {p: "s"}\nlet box = [[seed, {p: "o"}][0], {p: "o"}][0]\nbox = {p: 2}\nsay box.p\nexit',
    (at) => ["compile-error", `written-target compile-error @${at("2}")}`],
  ],
];

/**
 * Admission's rules over stores, literals and fallbacks that the set leaves untested (review r1 of M4 S6), each in both
 * orders with its record, sites written as the text they start at: a declaration's start value decides before an
 * earlier store in a function (ADR 0021 1.6); a literal's element that copies a written binding keeps its written type
 * (A4, ADR 0021 1.3); a value none of whose kinds fits a field's, an element's or an entry's decided type errs (C1, ADR
 * 0021 1.7); a definite misfit is rejected, so a later use sees the decided type (A6), a null into a copy of a written
 * binding and a literal's element of another type included; C10's unknown fallback may fit the receiving written union,
 * and each offending kind of a fallback owes its own check; a fallback whose contract fits asks nothing. Review
 * r2: a copied written type checks a literal's other elements by their own kinds (a whole number fits a written
 * integer, a fraction does not); a store none of whose possible kinds fits is rejected too; literals are checked at
 * any depth; a concrete misfit of a fallback is checked against the receiving union too; the lazy defaults of
 * `fileFromBase64`, `decryptText` and `decryptFile` follow C10 (ADR 0021 7.2). Review r4: a copy of a written type is
 * decided at every path of that type, read or not, and admits `null` only where its type, an earlier store or a null
 * element of the literal it stands in does. Review r5: returns, parameter defaults and single-site arguments decide the
 * result's and the parameter's paths as stores do. G3 2c: an element's earliest decider read through its carriers'
 * transfers, below nested selections (of a nullable written source too, and before a fallback or as a default) and
 * below a choice of choice objects, in both orders of the objects.
 */
test("admission decides from the start value, keeps written copies, rejects every definite misfit, and checks fallbacks per kind", () => {
  const differing: string[] = [];
  for (const [name, source, expect, expectReversed = expect] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const expected = (reversed ? expectReversed : expect)((text) => source.indexOf(text)).sort();
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary(record);
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * A4 at every carrier of a definition (review r5): a copy of a written binding that a store, a literal's element, an add,
 * an `addAll`, a single-site argument, a parameter's default or a return brings decides its destination by the written
 * type, read or not, so a later possible fraction there owes C1's check against `integer`, a scalar's and a collection's
 * element's alike, and external data carried beside the copy owes its boundary against `integer` (C9). Both orders.
 */
test("a copy of a written type keeps it through every carrier", () => {
  // per carrier: the program around the copy `COPY` and the later value `LATER`, and the stored value the later one's
  // check sits at (an `addAll`'s list)
  const carriers: readonly (readonly [string, string, string])[] = [
    ["a store", "let d = COPY\nd = LATER\nexit", "LATER"],
    ["an add", "let d = []\nd.add(COPY)\nd.add(LATER)\nexit", "LATER"],
    ["an addAll", "let d = []\nd.addAll([COPY])\nd.addAll([LATER])\nexit", "[LATER]"],
    ["a single-site argument", "function use(p) {\n  p = LATER\n}\nuse(COPY)\nexit", "LATER"],
    ["a parameter's default", "function use(p = COPY) {\n  p = LATER\n}\nuse()\nexit", "LATER"],
    [
      "a return",
      'function give {\n  if askBoolean "first?" { return COPY }\n  return LATER\n}\nlet r = give()\nexit',
      "LATER",
    ],
  ];
  const kinds: readonly (readonly [string, string, string])[] = [
    ["a scalar", "let typed: integer = 1\n", "[1, 2.5][1]"],
    ["a list's element", "let typed: integer[] = [1]\n", "[[1], [2.5]][1]"],
  ];
  // per carrier of a literal: the program around the literal `HELD` that holds the copy beside external data
  const ingresses: readonly (readonly [string, string])[] = [
    ["a store", "let d = HELD\nexit"],
    ["a single-site argument", 'function use(p) {\n  say "inside"\n}\nuse(HELD)\nexit'],
    ["a return", "function give {\n  return HELD\n}\nlet r = give()\nexit"],
  ];
  const programs: (readonly [string, string, string, boolean])[] = [];
  for (const [carrier, shape, site] of carriers)
    for (const [kind, declaration, later] of kinds)
      programs.push([
        `${kind} through ${carrier}`,
        declaration + shape.replace("COPY", "typed").replace("LATER", later),
        site.replace("LATER", later),
        false,
      ]);
  for (const [carrier, shape] of ingresses)
    programs.push([
      `external data beside a copy through ${carrier}`,
      `let typed: integer = 1\n${shape.replace("HELD", "[typed, hostValue]")}`,
      "hostValue",
      true,
    ]);
  const differing: string[] = [];
  for (const [name, source, offending, boundary] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const at = source.lastIndexOf(offending);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // the value's check against the written kind at its own site, and the boundary there for external data
      const checked = record.checks.some(
        (check) =>
          check.kind === "copy-type" &&
          check.boundary === boundary &&
          check.site.offset === at &&
          JSON.stringify(check.against) === '["integer"]',
      );
      if (record.outcome !== "warning-runtime-check" || !checked)
        differing.push(`${name}${reversed ? " reversed" : ""}: ${summary(record).join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * F21, ADR 0021 1.5 (review: Astra's B1): each call types an unannotated parameter from its argument, and its default
 * is the start value the function is checked against once, so a supplied argument and the default never constrain each
 * other: the argument decides nothing and is no candidate, a store of another kind in the body errs against the default
 * whether calls supply the argument or omit it, and a written parameter checks its argument. Per kind of value (a
 * scalar, a list, a record, a dict): supplied (positionally, by name, at two calls), a body store of the argument's
 * kind with the argument supplied or omitted, and written; both orders.
 */
test("a supplied argument and a parameter's default never constrain each other", () => {
  const kinds: readonly (readonly [string, string, string, string | null])[] = [
    ["a scalar", "3", '"hello"', "integer"],
    ["a list", "[3]", '["hello"]', "integer[]"],
    ["a record", "{n: 3}", '{n: "hello"}', null],
    ["a dict", "dict{a: 3}", 'dict{a: "hello"}', null],
  ];
  const programs: (readonly [string, string, boolean])[] = [];
  const body = (statement: string): string => `{\n  ${statement}\n}`;
  for (const [kind, given, other, written] of kinds) {
    const show = (parameter: string, statement: string): string =>
      `function show(${parameter}) ${body(statement)}\n`;
    const plain = `value = ${given}`;
    programs.push(
      [`${kind}, supplied`, `${show(plain, 'say "shown"')}show(${other})\nexit`, false],
      [
        `${kind}, supplied by name`,
        `${show(plain, 'say "shown"')}show(value: ${other})\nexit`,
        false,
      ],
      [
        `${kind}, supplied at two calls`,
        `${show(plain, 'say "shown"')}show(${other})\nshow(${other})\nexit`,
        false,
      ],
      [
        `${kind}, supplied, another kind stored in the body`,
        `${show(plain, `value = ${other}`)}show(${other})\nexit`,
        true,
      ],
      [
        `${kind}, omitted, another kind stored in the body`,
        `${show(plain, `value = ${other}`)}show()\nexit`,
        true,
      ],
    );
    if (written !== null)
      programs.push([
        `${kind}, written`,
        `${show(`value: ${written} = ${given}`, 'say "shown"')}show(${other})\nexit`,
        true,
      ]);
  }
  const differing: string[] = [];
  for (const [name, source, errs] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const expected = errs
      ? ["compile-error", `written-target compile-error @${source.indexOf('"hello"')}`]
      : ["valid"];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const got = summary(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      if (JSON.stringify(got) !== JSON.stringify(expected.sort()))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * F12: the word is the read's first failing condition; an element read fails X3 (`member`)
 * where the contract answers it, several element-contributing sources or a literal of several elements meeting at the
 * read's element step, before a later condition's word (`branch`) and the result's own (`call`); a single exact
 * contribution keeps the read's word. A call's result with two returns and with one, a variable's literal of two
 * elements, a list stored in a branch beside another list and beside an empty one; both orders.
 */
test("an element read the contract answers is X3's member, before a later condition's word", () => {
  const programs: readonly (readonly [string, string, string])[] = [
    [
      "a call's result of two returns",
      "function f(flag: boolean) {\n  if flag { return [1] }\n  return [1.5]\n}\nrepeat f(true).first {}\nexit",
      "member",
    ],
    [
      "a call's result of one return",
      "function f {\n  return [[1, 2.5][0]]\n}\nrepeat f().first {}\nexit",
      "call",
    ],
    [
      "a variable's literal of two elements",
      "let xs = [1, 1.5]\nrepeat xs.first {}\nexit",
      "member",
    ],
    [
      "a list stored in a branch beside another",
      'let xs = [1]\nif askBoolean("b") { xs = [1.5] }\nrepeat xs.first {}\nexit',
      "member",
    ],
    [
      "a list stored in a branch beside an empty one",
      'let xs = [1.5]\nif askBoolean("b") { xs = [] }\nrepeat xs.first {}\nexit',
      "branch",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, word] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const words = record.diagnostics
        .filter((diagnostic) => diagnostic.kind === "integer-use")
        .map((diagnostic) => `${diagnostic.class} ${diagnostic.context}`);
      if (JSON.stringify(words) !== JSON.stringify([`warning-runtime-check ${word}`]))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${words.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * C9, F18 beside F21 and ADR 0021 1.5 (reviews r7 and r8 of the repairs): external data an argument brings into an
 * unannotated parameter with a default is checked against the argument's own kinds at the boundary's path, never the
 * default's decision: a parsed text against its expected text, host data against `unknown`, positionally, by name and at
 * two calls; a record that carries a parsed text or host data against its record, at the first ingress (C9);
 * a list's element against the element's kinds; a written parameter's boundary is its type. Both orders.
 */
test("an argument beside a default meets its own boundary, never the default's", () => {
  const parsed = 'fromJson("\\"hello\\"", default: "hello", files: false)';
  const show = (parameter: string, statement: string): string =>
    `function show(${parameter}) {\n  ${statement}\n}\n`;
  // per program its outcome and its boundary checks, as target and kinds
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a parsed text",
      `${show("value = [3]", "say value")}show(${parsed})\nexit`,
      "valid",
      ["show.value [string]"],
    ],
    [
      "a parsed text at two calls",
      `${show("value = [3]", "say value")}show(${parsed})\nshow(${parsed})\nexit`,
      "valid",
      ["show.value [string]", "show.value [string]"],
    ],
    [
      "host data",
      `${show("value = [3]", "say value.length")}show(hostValue)\nexit`,
      "warning-runtime-check",
      ["show.value [unknown]"],
    ],
    [
      "host data by name",
      `${show("value = [3]", "say value.length")}show(value: hostValue)\nexit`,
      "warning-runtime-check",
      ["show.value [unknown]"],
    ],
    [
      "a record carrying a parsed text",
      `${show('value = {text: ""}', "say value.text")}show({text: ${parsed}})\nexit`,
      "valid",
      ["show.value [object]"],
    ],
    [
      "a record carrying a parsed text and a parsed number",
      `${show('value = {text: ""}', "say value.text")}show({text: ${parsed}, count: fromJson("1", default: 1, files: false)})\nexit`,
      "valid",
      ["show.value [object]"],
    ],
    [
      "a record carrying host data and a parsed text",
      `${show('value = {text: ""}', "say value.text")}show({extra: hostValue, text: ${parsed}})\nexit`,
      "valid",
      ["show.value [object]"],
    ],
    [
      "a list carrying a parsed text",
      `${show('value = [""]', "say value")}show([${parsed}])\nexit`,
      "valid",
      ["show.value.element [string]"],
    ],
    [
      "a parsed text bound first",
      `${show("value = [3]", "say value")}let text = ${parsed}\nshow(text)\nexit`,
      "valid",
      ["text [string]"],
    ],
    [
      "a parsed text forwarded through another function",
      `${show("value = [3]", "say value")}function pass(given) {\n  show(given)\n}\npass(${parsed})\nexit`,
      "valid",
      ["pass.given [string]"],
    ],
    [
      "a parsed text into a written list",
      `${show("value: integer[] = [3]", "say value")}show(${parsed})\nexit`,
      "compile-error",
      ["show.value [list]"],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const boundaries = record.checks
        .filter((check) => check.boundary)
        .map((check) => `${check.target} [${check.against.join(", ")}]`)
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(boundaries) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${boundaries.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a written expected type holds a default to its own kinds at every depth, known or possible (C10, the owner's F3)", () => {
  const integer = (call: string): string => `let n: integer = ${call}\nrepeat n {}\nexit`;
  const integers = (call: string): string => `let xs: integer[] = ${call}\nrepeat xs[0] {}\nexit`;
  // per program its outcome and its written-target diagnostics, as class and site
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a fraction for an integer",
      integer('fromJson("bad", default: 1.5)'),
      "compile-error",
      ["compile-error @42"],
    ],
    ["a whole number for an integer", integer('fromJson("bad", default: 2)'), "valid", []],
    [
      "a fraction loaded for an integer",
      integer('load("k", default: 1.5)'),
      "compile-error",
      ["compile-error @36"],
    ],
    ["a whole number loaded for an integer", integer('load("k", default: 2)'), "valid", []],
    [
      "a possible fraction for an integer",
      integer('fromJson("bad", default: [1, 2.5][0])'),
      "warning-runtime-check",
      ["warning-runtime-check @42"],
    ],
    [
      "host data for an integer",
      integer('fromJson("bad", default: hostValue)'),
      "warning-runtime-check",
      ["warning-runtime-check @42"],
    ],
    ["a fraction for a number", 'let n: number = fromJson("bad", default: 1.5)\nexit', "valid", []],
    [
      "a whole number for a number",
      'let n: number = fromJson("bad", default: 2)\nexit',
      "valid",
      [],
    ],
    [
      "a fraction for an integer or a text",
      'let n: integer | string = fromJson("1", default: 1.5)\nexit',
      "compile-error",
      ["compile-error @49"],
    ],
    [
      "a text for an integer or a text",
      'let n: integer | string = fromJson("1", default: "x")\nexit',
      "valid",
      [],
    ],
    // below the default, at the element (A8)
    [
      "a fraction among integers",
      integers('fromJson("bad", default: [1.5])'),
      "compile-error",
      ["compile-error @46"],
    ],
    ["integers", integers('fromJson("bad", default: [2])'), "valid", []],
    [
      "a fraction loaded among integers",
      integers('load("k", default: [1, 2.5])'),
      "compile-error",
      ["compile-error @43"],
    ],
    [
      "a nested fraction",
      'let xs: integer[][] = fromJson("[]", default: [[1], [2.5]])\nexit',
      "compile-error",
      ["compile-error @53"],
    ],
    [
      "a possible list of fractions",
      integers('fromJson("[]", default: [[1], [2.5]][0])'),
      "warning-runtime-check",
      ["warning-runtime-check @44"],
    ],
    // an inferred default keeps the family: a fraction beside whole numbers
    [
      "a fraction beside inferred whole numbers",
      "let xs = [1]\nlet y = xs.get(0, default: 1.5)\nexit",
      "valid",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const found = record.diagnostics
        .filter((diagnostic) => diagnostic.kind === "written-target")
        .map((diagnostic) => `${diagnostic.class} @${diagnostic.site.offset}`)
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(found) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${found.join(", ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});
