// A8 in the cells: a literal's elements' types, their order and certainty, shared verdicts, typed ingresses, one
// obligation per store.

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { recordDifferences, type CompactRecord } from "../../helpers/type-core-records.js";

test("a named collection in a literal or an add brings its elements' types to the literal's, as a written one would (A8, the owner's F2)", () => {
  const after = '\nsay "AFTER"\nexit';
  const lists = 'let a = [1]\nlet b = ["bad"]\n';
  // per program its outcome and its errors' sites: the named source of another type, where it is written
  const programs: readonly (readonly [string, string, string, readonly number[]])[] = [
    ["a list of lists", `${lists}let xs = [a, b]${after}`, "compile-error", [41]],
    ["a list of lists, nested", `${lists}let xs = [[a], [b]]${after}`, "compile-error", [43]],
    ["a set of lists", `${lists}let xs = set[a, b]${after}`, "compile-error", [44]],
    ["a dict of lists", `${lists}let xs = dict{x: a, y: b}${after}`, "compile-error", [51]],
    ["a record of lists", `${lists}let xs = [{n: a}, {n: b}]${after}`, "compile-error", [46]],
    [
      "a list of dicts",
      `let a = dict{k: 1}\nlet b = dict{k: "bad"}\nlet xs = [a, b]${after}`,
      "compile-error",
      [55],
    ],
    [
      "a list of sets",
      `let a = set[1]\nlet b = set["bad"]\nlet xs = [a, b]${after}`,
      "compile-error",
      [47],
    ],
    ["an add", `${lists}let xs = [a]\nxs.add(b)${after}`, "compile-error", [48]],
    ["a whole store", `${lists}let xs = a\nxs = b${after}`, "compile-error", [44]],
    ["each copy of the source", `${lists}let xs = [a, b, b, a]${after}`, "compile-error", [41, 44]],
    [
      "results of calls",
      `function f {\n  return [1]\n}\nfunction g {\n  return ["bad"]\n}\nlet xs = [f(), g()]${after}`,
      "compile-error",
      [75],
    ],
    [
      "fields read",
      `let r = {items: [1]}\nlet s = {items: ["bad"]}\nlet xs = [r.items, s.items]${after}`,
      "compile-error",
      [65],
    ],
    [
      "lists grown by adds",
      `let a = []\na.add(1)\nlet b = []\nb.add("bad")\nlet xs = [a, b]${after}`,
      "compile-error",
      [57],
    ],
    // the literal forms the named ones match
    ["inline lists", `let xs = [[1], ["bad"]]${after}`, "compile-error", [16]],
    ["an inline add", `let xs = [[1]]\nxs.add(["bad"])${after}`, "compile-error", [22]],
    ["inline records", `let xs = [{n: 1}, {n: "bad"}]${after}`, "compile-error", [22]],
    // a named record's field, reached only through copies, where the copy meets the literal, read or not (A2, ADR 0021
    // rule 1.1)
    [
      "records, a field read",
      `let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]\nrepeat xs[0].n {}${after}`,
      "compile-error",
      [47],
    ],
    [
      "a record beside a literal one",
      `let b = {n: "bad"}\nlet xs = [{n: 1}, b]${after}`,
      "compile-error",
      [37],
    ],
    // whole numbers with numbers; fields apart
    [
      "whole numbers and numbers",
      `let a = [1]\nlet b = [2.5]\nlet xs = [a, b]${after}`,
      "valid",
      [],
    ],
    [
      "records of other fields",
      `let a = {n: 1}\nlet b = {m: "x"}\nlet xs = [a, b]${after}`,
      "valid",
      [],
    ],
    [
      "records, no field read",
      `let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]${after}`,
      "compile-error",
      [47],
    ],
    [
      "records holding lists, no field read",
      `let a = {items: [1]}\nlet b = {items: ["bad"]}\nlet xs = [a, b]${after}`,
      "compile-error",
      [59],
    ],
    // host data named in the literal: no error, C1's check against the decided lists (round 10 B1)
    [
      "host data",
      `let a = [1]\nlet b = hostValue\nlet xs = [a, b]${after}`,
      "warning-runtime-check",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, sites] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const errors = record.diagnostics
        .filter((diagnostic) => diagnostic.class === "compile-error")
        .map((diagnostic) => diagnostic.site.offset)
        .sort((a, b) => a - b);
      if (record.outcome !== outcome || JSON.stringify(errors) !== JSON.stringify(sites))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome} @${errors.join(", @")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a value an operation carries of a named collection brings its element types to a literal (A8, F10, round 10 B2)", () => {
  const after = '\nsay "AFTER"\nexit';
  const lists = 'let a = [1]\nlet b = ["bad"]\n';
  // per program its outcome and its errors' sites: the second element, whose source holds text
  const programs: readonly (readonly [string, string, string, readonly number[]])[] = [
    ["take", `${lists}let xs = [a.take(1), b.take(1)]${after}`, "compile-error", [49]],
    ["takeLast", `${lists}let xs = [a.takeLast(1), b.takeLast(1)]${after}`, "compile-error", [53]],
    [
      "toList",
      `let a = set[1]\nlet b = set["bad"]\nlet xs = [a.toList(), b.toList()]${after}`,
      "compile-error",
      [56],
    ],
    ["toSet", `${lists}let xs = [a.toSet(), b.toSet()]${after}`, "compile-error", [49]],
    // (#1857: a property read below a copy is its receiver's element's property, both errors at the read, never the
    // receiver's own property: reusing the path whatever its first step loses the store's TSV041)
    [
      "take, read at a property",
      `let xs = [{p: 1}]\nlet ys = xs.take(1)\nlet n: integer = ys.p${after}`,
      "compile-error",
      [55, 55],
    ],
    ["otherwise", `${lists}let xs = [a, b otherwise b]${after}`, "compile-error", [41]],
    [
      "a dict's values",
      `let a = dict{q: [1]}\nlet b = dict{q: ["bad"]}\nlet xs = [a.values[0], b.values[0]]${after}`,
      "compile-error",
      [69],
    ],
    // whole numbers with numbers; a dict's keys are text
    [
      "take of whole numbers and numbers",
      `let a = [1]\nlet b = [2.5]\nlet xs = [a.take(1), b.take(1)]${after}`,
      "valid",
      [],
    ],
    [
      "a dict's keys",
      `let a = dict{q: 1}\nlet b = dict{r: 2}\nlet xs = [a.keys, b.keys]${after}`,
      "valid",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, sites] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const errors = record.diagnostics
        .filter((diagnostic) => diagnostic.class === "compile-error")
        .map((diagnostic) => diagnostic.site.offset)
        .sort((x, y) => x - y);
      if (record.outcome !== outcome || JSON.stringify(errors) !== JSON.stringify(sites))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome} @${errors.join(", @")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a literal's verdicts are shared only where its named elements hold the same values, in both orders (round 11 B1)", () => {
  // per program its errors' sites: the second literal, after the named value became text, at both its elements (A8
  // against its text, C1 against the whole numbers the first literal decided)
  const programs: readonly (readonly [string, string, readonly number[]])[] = [
    [
      "stores",
      'let a = hostValue\nlet xs = []\nxs = [a, 1]\na = "bad"\nxs = [a, 1]\nexit',
      [58, 61],
    ],
    [
      "adds",
      'let a = hostValue\nlet xs = []\nxs.add([a, 1])\na = "bad"\nxs.add([a, 1])\nexit',
      [62, 66],
    ],
    [
      "addAll",
      'let a = hostValue\nlet xs = []\nxs.addAll([[a, 1]])\na = "bad"\nxs.addAll([[a, 1]])\nexit',
      [70, 75],
    ],
    [
      "text first",
      'let a = "bad"\nlet xs = []\nxs = [a, 1]\na = hostValue\nxs = [a, 1]\nexit',
      [35],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, sites] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    const errors = forward.diagnostics
      .filter((diagnostic) => diagnostic.class === "compile-error")
      .map((diagnostic) => diagnostic.site.offset)
      .sort((x, y) => x - y);
    if (JSON.stringify(errors) !== JSON.stringify(sites))
      differing.push(`${name}: @${errors.join(", @")}`);
    if (recordDifferences(forward, reversed).length > 0)
      differing.push(`${name} reversed: ${recordDifferences(forward, reversed).join("; ")}`);
  }
  assert.deepEqual(differing, []);
});

/**
 * The value carriers (round 11; the walk of `answers.ts` `#propertyNames`): each carrier over a direct, a named, a
 * computed and a projected list, in a literal beside the same carrier over another list (A8), stored before and after
 * its source changes (A2), and carrying host data with no consumer (C1, C9); in both orders. A carrier that gives
 * possible elements (a removal) decides nothing (A2), yet its elements are published with the literal's whole numbers,
 * so named host data it carries owes its check (A7, A8); a choice's answer carries no list, which no
 * button returns (TSV029); a load or a parse
 * typed by its default alone validates the loaded value by the default's own kinds, so host data the default holds
 * leaves the elements' kind open, C1's beside the call's boundary.
 */
/*
 * The regressions of review rounds 11 to 17, Astra's and the external reviewer's, here and in
 * `type-core-cells-written.test.ts`, assert the answers layer: their programs need constructs outside the candidate
 * slice (functions, `get`, `otherwise`, the copy methods, written unions, records), so their plan content and their
 * runs wait for S7–S9b to widen the slice; those inside it prove plan and run in `tests/type-core/candidate/` (the
 * projections of a literal in `type-core-candidate-written.test.ts`, the endpoint matrix in
 * `type-core-candidate-admitted-places.test.ts`, the cell sample in `type-core-candidate-external.test.ts`).
 */
test("a value any carrier gives brings its elements' types, decided and checked as a literal's, a removal's published as possible, in both orders (round 11)", () => {
  const carriers: readonly (readonly [string, (value: string) => string])[] = [
    ["projection", (value) => `[${value}][0]`],
    ["otherwise", (value) => `${value} otherwise ${value}`],
    ["get with its default", (value) => `[].get(0, default: ${value})`],
    ["load's default", (value) => `load("k", default: ${value})`],
    ["a parse's default", (value) => `fromJson("[]", default: ${value})`],
    ["take", (value) => `${value}.take(1)`],
    ["takeLast", (value) => `${value}.takeLast(1)`],
    ["toList", (value) => `${value}.toList()`],
    ["toSet", (value) => `${value}.toSet()`],
    ["removeFirst", (value) => `[${value}].removeFirst()`],
    ["+", (value) => `${value} + []`],
  ];
  const possible = new Set(["removeFirst"]);
  // a list (a set for `toList`) of one element, and how the matrix's kinds of value hold it
  const list = (carrier: string, element: string): string =>
    carrier === "toList" ? `set[${element}]` : `[${element}]`;
  const kinds: readonly (readonly [
    string,
    (name: string, literal: string) => readonly [string, string],
  ])[] = [
    ["direct", (_, literal) => ["", literal]],
    ["named", (name, literal) => [`let ${name} = ${literal}\n`, name]],
    ["computed", (name, literal) => [`function ${name} {\n  return ${literal}\n}\n`, `${name}()`]],
    ["projected", (name, literal) => [`let ${name} = {items: ${literal}}\n`, `${name}.items`]],
  ];
  const differing: string[] = [];
  const analysed = (name: string, source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (items) => [...items].reverse(),
        () => compactAnalysis(request),
      ),
    );
    for (const difference of recordDifferences(forward, reversed))
      differing.push(`${name} reversed: ${difference}`);
    return forward;
  };
  const errors = (record: CompactRecord): number[] =>
    record.diagnostics
      .filter((diagnostic) => diagnostic.class === "compile-error")
      .map((diagnostic) => diagnostic.site.offset);
  for (const [carrier, carry] of carriers) {
    // A8: the second element's text is the error inside it, where the carrier's elements are definite
    for (const [kind, hold] of kinds) {
      const [goodSetup, good] = hold("g", list(carrier, "1"));
      const [badSetup, bad] = hold("b", list(carrier, '"bad"'));
      const source = `${goodSetup}${badSetup}let xs = [${carry(good)}, ${carry(bad)}]\nsay "AFTER"\nexit`;
      const name = `${carrier}, ${kind}`;
      const record = analysed(name, source);
      const second = source.indexOf(carry(bad), source.indexOf("let xs"));
      const found = errors(record);
      if (
        possible.has(carrier)
          ? record.outcome !== "valid"
          : found.length !== 1 || found[0]! < second || found[0]! >= second + carry(bad).length
      )
        differing.push(`${name}: ${record.outcome} @${found.join(", @")}`);
    }
    // A2, A6: a named value stored before and after a change of it: the change of the decided list is the error at its
    // text, rejected, so the second store holds whole numbers as the first does
    const one = list(carrier, "1");
    const changed = `let a = ${one}\nlet xs = []\nxs = [${carry("a")}, ${carry(one)}]\na = ${list(carrier, '"bad"')}\nxs = [${carry("a")}, ${carry(one)}]\nexit`;
    const record = analysed(`${carrier}, changed`, changed);
    if (JSON.stringify(errors(record)) !== JSON.stringify([changed.indexOf('"bad"')]))
      differing.push(`${carrier}, changed: ${record.outcome} @${errors(record).join(", @")}`);
    // the same, the named list host data first and text after: one record in both orders (round 11 B1's sharing)
    analysed(
      `${carrier}, changed from host data`,
      changed.replace(`let a = ${one}`, `let a = ${list(carrier, "hostValue")}`),
    );
    // C1, C9: host data the carrier brings into the decided elements, with no consumer
    const host = `let a = ${list(carrier, "hostValue")}\nlet xs = [${carry(one)}, ${carry("a")}]\nsay "AFTER"\nexit`;
    const carried = analysed(`${carrier}, host data`, host);
    const warned = carried.diagnostics.some(
      (diagnostic) =>
        diagnostic.kind === "written-target" && diagnostic.class === "warning-runtime-check",
    );
    // (a removal's possible element decides nothing, F7, yet the elements are published with the
    // literal's whole numbers, so the named host data owes its check: C9)
    if (carried.outcome !== "warning-runtime-check" || !warned)
      differing.push(`${carrier}, host data: ${carried.outcome}`);
  }
  assert.deepEqual(differing, []);
});

test("a literal cell's elements are compared in the literal's order, however its index lists them (#2289)", () => {
  // (`q` is listed where its own value stands, `{p: w}` where its property's written stop does: a merge of two lists
  // that must be sorted; `{p: w}` and `{p: s}` are both listed by their written stops, one list in the literal's order.
  // In both the earliest element decides: `xs`'s element is `{p: w}`, and `n` copies its written integer)
  const sources = [
    'let w: integer = 1\nlet q = {p: "s"}\nlet xs = [{p: w}, q]\nlet n = xs[0].p\nsay "${n}"\nexit\n',
    'let w: integer = 1\nlet s: string = "s"\nlet xs = [{p: w}, {p: s}]\nlet n = xs[0].p\nsay "${n}"\nexit\n',
  ];
  for (const source of sources) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { places } = new CoreProgram(request);
    const binding = (name: string) =>
      places.find((place) => place.kind.kind === "binding" && place.kind.name === name)!.id;
    for (const mode of MODES)
      inMode(mode, () => {
        const at = `${JSON.stringify(mode)}: ${source}`;
        const answers = analyseCore(request);
        const element = answers.place(binding("xs"), ["element"]).admitted;
        assert.ok(element.by === "decided", at);
        assert.equal(element.decider?.start, source.indexOf("{p: w}"), at);
        const n = answers.place(binding("n"), []).admitted;
        assert.deepEqual(n.by === "decided" ? n.kinds : n.by, ["integer"], at);
      });
  }
});

test("a literal's elements are compared at each store with their own certainty, guarded or not, in both orders (round 12 B1)", () => {
  const carriers: readonly (readonly [string, (value: string) => string])[] = [
    ["direct", (value) => value],
    ["take", (value) => `${value}.take(1)`],
    ["get with its default", (value) => `[].get(0, default: ${value})`],
    ["otherwise", (value) => `${value} otherwise ${value}`],
    ["projection", (value) => `[${value}][0]`],
    ["+", (value) => `${value} + []`],
  ];
  const differing: string[] = [];
  for (const [name, carry] of carriers) {
    const store = `xs = [${carry("a")}, ${carry('["bad"]')}]`;
    for (const [order, source] of [
      ["guarded first", `let a = [1]\nlet xs = []\nif a is list { ${store} }\n${store}\nexit`],
      ["unguarded first", `let a = [1]\nlet xs = []\n${store}\nif a is list { ${store} }\nexit`],
    ] as const) {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, `${name}, ${order}: its source parses and resolves`);
      const forward = compactAnalysis(request);
      const reversed = withSolverSeam({ reverseWorklist: true }, () =>
        withConsumerOrder(
          (list) => [...list].reverse(),
          () => compactAnalysis(request),
        ),
      );
      for (const difference of recordDifferences(forward, reversed))
        differing.push(`${name}, ${order}, reversed: ${difference}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a literal's own elements decide through the operations that carry it, under their certainty (round 12 B2)", () => {
  const after = '\nsay "AFTER"\nexit';
  // per program its outcome and its copy checks: C1's at the named host value against the literal's whole numbers,
  // beside the boundary of the store that brought it in; a removal's possible element decides nothing (F7)
  const checked = ["a [unknown] B @8", "xs.element [integer] @27"];
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "get with its default",
      "let xs = [].get(0, default: [1, a])",
      "warning-runtime-check",
      checked,
    ],
    ["takeLast", "let xs = [1, a].takeLast(1)", "warning-runtime-check", checked],
    ["toSet", "let xs = [1, a].toSet()", "warning-runtime-check", checked],
    // (a list's `+` combines: the named read that brought the kind is C1's site)
    [
      "+",
      "let xs = [1, a] + []",
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @31"],
    ],
    // (a removal's possible element decides nothing, F7, but the place is published with the literal's whole numbers,
    // so the named host value owes its check there: C9)
    [
      "removeFirst",
      "let xs = [[1, a]].removeFirst()",
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @32"],
    ],
  ];
  const differing: string[] = [];
  for (const [name, store, outcome, expected] of programs) {
    const source = `let a = hostValue\n${store}${after}`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const copies = record.checks
        .filter((check) => check.kind === "copy-type")
        .map(
          (check) =>
            `${check.target} [${check.against.join(", ")}]${check.boundary ? " B" : ""} @${check.site.offset}`,
        )
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(copies) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${copies.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("literals of typed ingresses share their conflict paths only by the type their defaults give (A8, F18)", () => {
  // a literal of one default's ingresses beside one of two defaults: the second still errs at the ingress of the other
  // default, as alone; a `load` beside a parse of one default, two classes of one kind, offends nowhere
  const seeds = 'let seed = {n: 1}\nlet other = {n: "x"}\nlet xs = []\n';
  const programs: readonly (readonly [string, string, string | null])[] = [
    [
      "loads, shared then mixed",
      `${seeds}xs.add([load("a", default: seed), load("b", default: seed)])\nxs.add([load("c", default: seed), load("d", default: other)])\nrepeat xs[0][0].n {}\nexit`,
      'load("d"',
    ],
    [
      "loads, mixed alone",
      `${seeds}xs.add([load("c", default: seed), load("d", default: other)])\nrepeat xs[0][0].n {}\nexit`,
      'load("d"',
    ],
    [
      "parses, shared then mixed",
      `${seeds}xs.add([fromJson("{}", default: seed), fromJson("{}", default: seed)])\nxs.add([fromJson("{}", default: seed), fromJson("{}", default: other)])\nrepeat xs[0][0].n {}\nexit`,
      'fromJson("{}", default: other)',
    ],
    [
      "a load beside a parse of one default",
      `${seeds}xs.add([load("a", default: seed), fromJson("{}", default: seed)])\nxs.add([load("c", default: seed), load("d", default: seed)])\nrepeat xs[0][0].n {}\nexit`,
      null,
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, offending] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = offending === null ? [] : [`compile-error@${source.indexOf(offending)}`];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("each store of one value whole owes its obligation once, however many lists group it (A7, Codex r18 B1)", () => {
  // the stores of `root` into `box` are one group (their earliest checked whole for the rest), met through the whole
  // stores of `box` and through its candidates: each owes its warning and check once
  const source =
    'let root = {n: hostValue}\nlet box = {n: 1}\nbox = root\nbox = root\nrepeat box.n {}\nsay "AFTER"\nexit';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const stores = [source.indexOf("box = root") + "box = ".length, source.lastIndexOf("root")];
  for (const reversed of [false, true]) {
    const run = (): CompactRecord =>
      withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
    const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    assert.deepEqual(
      {
        checks: record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => `${check.target} ${check.against.join("|")} @${check.site.offset}`)
          .sort(),
        warnings: record.diagnostics
          .filter((diagnostic) => diagnostic.kind === "written-target")
          .map((diagnostic) => diagnostic.site.offset)
          .sort((a, b) => a - b),
      },
      { checks: stores.map((at) => `box.n integer @${at}`), warnings: stores },
      reversed ? "reversed" : "forward",
    );
  }
});
