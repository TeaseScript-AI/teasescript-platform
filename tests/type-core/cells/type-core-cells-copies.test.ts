// A2 in the cells: whole copies and their properties, split cycles, value origins, and the copied-property check's
// growth.

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { checkedResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import type { CoreResult } from "../../../src/type-inference/core/result.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES, stopIdentity } from "../../helpers/type-core-oracles.js";
import { type CompactRecord } from "../../helpers/type-core-records.js";

test("a property only copies of whole objects bring errs where the copy meets the place, read or not; a store or a literal's own field keeps its error (ADR 0021 rule 1.1)", () => {
  // per program its errors as site text
  const programs: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "copies of variables",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = a\nc = b\nsay c.n\nexit',
      ["b"],
    ],
    // a conflict nobody reads is refused, as for inline objects, in either order of the copies
    [
      "copies of variables, unread",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = a\nc = b\nexit',
      ["b"],
    ],
    [
      "copies of variables, the other first",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = b\nc = a\nexit',
      ["a"],
    ],
    [
      "a list, a set and a dict of copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]\nlet ys = set[a, b]\nlet zs = dict{"a": a, "b": b}\nexit',
      ["b", "b", "b"],
    ],
    [
      "a literal of copies nothing stores",
      'let a = {n: 1}\nlet b = {n: "bad"}\nsay [a, b].length\nexit',
      ["b"],
    ],
    // a projection that copies a whole object is a copy too
    [
      "copies through projections",
      'let bundle = {left: {n: 1}, right: {n: "bad"}}\nlet c = bundle.left\nc = bundle.right\nsay c.n\nexit',
      ["bundle.right"],
    ],
    // a store through the property is the property's own, whatever names its value
    [
      "a direct store of a named value",
      'let a = {n: 1}\nlet c = a\nsay c.n\nlet wrong = "bad"\nc.n = wrong\nexit',
      ["wrong"],
    ],
    // copies inside literals that wrap them, at the wrapper that brings the copy
    [
      "copies through literal wrappers",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = {box: {inner: a}}\nc = {box: {inner: b}}\nsay c.box.inner.n\nexit',
      ["{box: {inner: b}}"],
    ],
    [
      "elements wrapping copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}, {inner: b}]\nsay xs[0].inner.n\nexit',
      ["{inner: b}"],
    ],
    // a dict's values, an added list's elements, and a wrapper without the property, like the list's
    [
      "dict values wrapping copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = dict{a: {inner: a}, b: {inner: b}}\nsay xs["a"].inner.n\nexit',
      ["{inner: b}"],
    ],
    [
      "an added list wrapping a copy",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}]\nxs.addAll([{inner: b}])\nsay xs[0].inner.n\nexit',
      ["[{inner: b}]"],
    ],
    [
      "a wrapper without the property beside the copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}, {inner: {}}, {inner: b}]\nsay xs[0].inner.n\nexit',
      ["{inner: b}"],
    ],
    [
      "a wrapper with the property beside the copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}, {inner: {n: 2}}, {inner: b}]\nsay xs[0].inner.n\nexit',
      ["{inner: b}"],
    ],
    // copies in a literal that lands inside another literal or through an add: at the copy in its own literal
    [
      "a list of copies inside an object",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = {items: [a, b]}\nxs.items[0].n = 2\nexit',
      ["b"],
    ],
    [
      "a list of copies inside a list",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [[a, b]]\nsay xs[0][0].n\nexit',
      ["b"],
    ],
    [
      "an added list of copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = []\nxs.addAll([a, b])\nsay xs[0].n\nexit',
      ["b"],
    ],
    [
      "an added element that is a list of copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = []\nxs.add([a, b])\nsay xs[0][0].n\nexit',
      ["b"],
    ],
    // a literal's own field is its own contribution, whatever it copies
    [
      "a literal's field copied from a property",
      'let a = {n: 1}\nlet c = {n: a.n}\nc = {n: "bad"}\nsay c.n\nexit',
      ['"bad"'],
    ],
    [
      "a literal's field beside the copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, {n: 2}, b]\nsay xs[0].n\nexit',
      ["b"],
    ],
    // an object with a written property beside a plain one: the plain one where the copy meets the place, the written
    // one by its written type (A4)
    [
      "a plain property beside a written one",
      'let typed: integer = 1\nlet a = {n: typed, m: 1}\nlet b = {n: 2, m: "x"}\nlet c = a\nc = b\nlet xs = [a, b]\nexit',
      ["b", "b"],
    ],
    // a place whose own type is unknown, a property of it receiving copies, each rejection found again (Codex r2 B3)
    [
      "copies into a property of host data",
      'let c = hostValue\nlet a = {n: 1}\nlet b = {n: "x"}\nc.inner = a\nc.inner = b\nc.inner = b\nexit',
      ["b", "b"],
    ],
    [
      "copies into a place that starts empty",
      'let a = {n: 1}\nlet b = {n: "x"}\nlet c = null\nc = a\nc = b\nexit',
      ["b"],
    ],
    // whole numbers and numbers are one family, so nothing errs
    [
      "a whole number beside a number",
      "let a = {n: 1}\nlet b = {n: 1.5}\nlet xs = [a, b]\nlet c = a\nc = b\nexit",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const errors = record.diagnostics
        .filter((diagnostic) => diagnostic.class === "compile-error")
        .map(({ site }) => source.slice(site.offset, site.end));
      if (JSON.stringify(errors) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${errors.join(", ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/** A record as its outcome, then each diagnostic's class, kind, site and related site, and each check, sorted (A2). */
function a2Record(source: string, reversed: boolean): string[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const run = (): CompactRecord =>
    withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
  const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
  const text = (site: { readonly offset: number; readonly end: number }): string =>
    `'${source.slice(site.offset, site.end)}'`;
  return [
    record.outcome,
    ...[
      ...record.diagnostics.map(
        ({ kind, class: level, site, related }) =>
          `${level} ${kind} ${text(site)}${related === undefined ? "" : ` related ${text(related)}`}`,
      ),
      ...record.checks.map((check) => `check ${check.kind} ${check.target} ${text(check.site)}`),
    ].sort(),
  ];
}

/**
 * A2's witnesses (docs/specifications/type-inference-accepted-record/admission.md#r4-154), their exact records in both
 * orders of the copy and the object and in both analysis orders: per form, a place copied with its setup and an object
 * holding another type at one property, stored into one place and as a list's elements, unread. Through whole copies
 * (Codex r1's cycle of whole copies, a cycle fed from outside, a copy into a property, a projection, nested objects, a
 * written property beside an inferred one, a property that may be null) the second errs where it meets the place or the
 * list. Through a cycle of copies that adds or takes steps (Codex r2's and r3's projections and composed projections,
 * r2's and r5's self-grafts) their meeting is beyond the bound: valid unread; read, the error is at the
 * first read and names the second.
 */
test("A2's witnesses: whole copies err where they meet the place or the list, read or not; a cycle that adds or takes steps errs where it is read, in both orders", () => {
  // per form: its setup, the place copied, the object of another type, and for a cycle beyond the bound the path read
  const forms: readonly (readonly [string, string, string, string, string | null])[] = [
    [
      "a cycle of whole copies",
      "let a = {n: 1}\nlet b = {m: 2}\na = b\nb = a",
      "a",
      '{m: "x"}',
      null,
    ],
    [
      "a cycle fed from outside",
      "let src = {n: 1}\nlet a = src\nlet b = a\na = b",
      "b",
      '{n: "x"}',
      null,
    ],
    [
      "a copy into a property",
      "let src = {n: 1}\nlet a = {p: null}\na.p = src",
      "a",
      '{p: {n: "x"}}',
      null,
    ],
    ["a projection", "let bundle = {left: {n: 1}}\nlet a = bundle.left", "a", '{n: "x"}', null],
    [
      "nested objects",
      "let inner = {n: 1}\nlet a = {box: {inner: inner}}",
      "a",
      '{box: {inner: {n: "x"}}}',
      null,
    ],
    [
      "a written property beside an inferred one",
      "let typed: integer = 1\nlet a = {n: typed, m: 1}",
      "a",
      '{n: 2, m: "x"}',
      null,
    ],
    [
      "a property that may be null",
      "let a = {inner: {n: 1}}\nlet b = {inner: null}\nb = a",
      "b",
      '{inner: {n: "x"}}',
      null,
    ],
    ["a projection of itself", "let a = {inner: {n: 1}}\na = a.inner", "a", '{n: "x"}', "n"],
    [
      "a store into its own property",
      "let a = {n: 1, inner: null}\na.inner = a",
      "a",
      '{inner: {n: "x"}}',
      "inner.n",
    ],
    [
      "composed projections",
      "let a = {left: {right: {n: 1}}}\nlet b = a.left\na = b.right",
      "a",
      '{n: "x"}',
      "n",
    ],
    [
      "two places stored into each other's property",
      "let a = {n: 1, inner: null}\nlet b = {m: 2, inner: null}\na.inner = b\nb.inner = a",
      "a",
      '{inner: {m: "x"}}',
      "inner.m",
    ],
    [
      "a store into its own property in a loop",
      "let a = {n: 1, inner: null}\nrepeat 3 {\n  a.inner = a\n}",
      "a",
      '{inner: {n: "x"}}',
      "inner.n",
    ],
    [
      "a self-graft below a projection through wrappers",
      "let a = {n: 1, inner: null}\nlet b = {p: a}\nlet d = {q: b}\na = d.q.p\na.inner = a",
      "d",
      '{q: {p: {n: "x"}}}',
      "q.p.n",
    ],
  ];
  const differing: string[] = [];
  const expect = (label: string, source: string, expected: readonly string[]): void => {
    for (const reversed of [false, true]) {
      const actual = a2Record(source, reversed);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        differing.push(`${label}${reversed ? ", reversed" : ""}: ${actual.join(", ")}`);
    }
  };
  for (const [form, setup, place, other, read] of forms)
    for (const copyFirst of [true, false]) {
      const [first, second] = copyFirst ? [place, "bad"] : ["bad", place];
      const label = `${form}, ${copyFirst ? "the copy" : "the object"} first`;
      const stored = `${setup}\nlet bad = ${other}\nlet c = ${first}\nc = ${second}`;
      const listed = `${setup}\nlet bad = ${other}\nlet xs = [${first}, ${second}]\nexit`;
      if (read === null) {
        const at = (code: string): string[] => [
          "compile-error",
          `compile-error ${code} '${second}'`,
        ];
        expect(`${label}, stored`, `${stored}\nexit`, at("written-target"));
        expect(`${label}, listed`, listed, at("written-target"));
        continue;
      }
      expect(`${label}, stored`, `${stored}\nexit`, ["valid"]);
      expect(`${label}, listed`, listed, ["valid"]);
      expect(`${label}, read`, `${stored}\nsay c.${read}\nexit`, [
        "compile-error",
        `compile-error written-target 'c.${read}' related '${second}'`,
      ]);
    }
  // Codex r2's six permutations (#1293): a ring of three whole copies, two members starting with one object and the
  // third with another; the copy that first brings the third's type errs or is checked where it meets its member
  const objects = { good: "{n:1}", bad: '{n:"x"}', flag: "{n:true}" } as const;
  for (const first of ["good", "bad", "flag"] as const)
    for (const other of ["good", "bad", "flag"] as const) {
      if (first === other) continue;
      const ring =
        `let good=${objects.good}\nlet bad=${objects.bad}\nlet flag=${objects.flag}\n` +
        `let a2=${other}\nlet a0=${first}\nlet a1=${other}\na2=a0\na1=a2\na0=a1\nexit`;
      expect(`a ring of ${other}, ${first} and ${other}`, ring, [
        "compile-error",
        "check copy-type a2.n 'a0'",
        "compile-error written-target 'a2'",
        "warning-runtime-check written-target 'a0'",
      ]);
    }
  // Codex r3's B4 and the second store of the same object (#1293): a ring of three copies fed an object of three
  // properties, each relay then taking an empty object, or the same object again, and the first member another of
  // three other-typed properties; one error per property where it meets the first member (the same-object relays are
  // asked there too: a known cost, G5, #1339)
  const fields = (value: string): string => `p0:${value},p1:${value},p2:${value}`;
  for (const [axis, second] of [
    ["an empty object", "{}"],
    ["the same object", "good"],
  ] as const)
    expect(
      `a fed ring whose relays each also take ${axis}`,
      `let good={${fields("1")}}\nlet bad={${fields('"x"')}}\nlet a0=good\nlet a1=a0\nlet a2=a1\na0=a2\n` +
        `a1=${second}\na2=${second}\na0=bad\nexit`,
      [
        "compile-error",
        "compile-error written-target 'bad'",
        "compile-error written-target 'bad'",
        "compile-error written-target 'bad'",
      ],
    );
  // a written `object?` place holds any object, its properties unchecked, inline or copied (A1)
  expect(
    "a written object? place",
    'let a = {n: 1}\nlet b = {n: "x"}\nlet c: object? = null\nc = a\nc = b\nc = {n: 1}\nc = {n: "x"}\nexit',
    ["valid"],
  );
  assert.deepEqual(differing, []);
});

/**
 * #1317's witness: two objects whose properties hold different types, copied into each other, both copies rejected, so
 * each keeps its own contents; an alias of each, a fitting store into a different property of each, then both aliases in
 * one list. Each property errs at the list, in all four modes: after the cycle splits, the meetings of the elements' tries
 * reach only `nest.g`, and the meetings of what they definitely hold (A2, #1293) bring `f` before the literal's conflict
 * paths are kept. The aliases in the other order err at the other element; the same alias twice is quiet at the list.
 */
test("a split cycle's aliases, each stored into after the split, err at their list at each property, in all four modes (#1317)", () => {
  const setup =
    'let t:integer=7\nlet w:string="w"\nlet a={f:1,nest:{g:1}}\nlet b={f:"s",nest:{g:"s"}}\n' +
    "b=a\na=b\nlet before=a\nlet peer=b\na.f=t\nb.nest.g=w\n";
  const differing: string[] = [];
  for (const [list, element] of [
    ["[before,peer]", "peer"],
    ["[peer,before]", "before"],
    ["[before,before]", null],
  ] as const) {
    const source = `${setup}let final=${list}\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, list);
    // (a site: the token in the first occurrence of the text around it, or that whole text, in the program's one file)
    const site = (around: string, token = around) => {
      const start = source.indexOf(around) + around.indexOf(token);
      return { file: 0, start, end: start + token.length };
    };
    const a = "let a={f:1,nest:{g:1}}";
    const b = 'let b={f:"s",nest:{g:"s"}}';
    const property = (path: readonly string[]) => path.map((step) => ({ property: step }));
    // each rejected copy's error per property where it meets its place: the place's type there, decided by its own
    // literal, and the copied object's
    const copied = (into: string, copy: string, path: readonly string[]) => {
      const [own, type, kinds] = into === "b" ? [b, "string", "integer"] : [a, "integer", "string"];
      return {
        class: "compile-error",
        kind: "written-target",
        code: "TSV041",
        site: site(`\n${into}=${copy}\n`, copy),
        rule: {
          rule: "store",
          into: `'${into}.${path.join(".")}'`,
          type: [type],
          written: false,
          decider: site(own, own.slice(6)),
          brought: null,
          root: { kind: "let", name: into, site: site(own) },
          steps: property(path),
        },
        kinds: [kinds],
      };
    };
    // with two aliases, each property's error at the list's second element, against the first element's type
    const mixed = (second: string, path: readonly string[]) => ({
      class: "compile-error",
      kind: "written-target",
      code: "TSV044",
      site: site(`,${second}]`, second),
      rule: {
        rule: "mixed",
        collection: "list",
        path,
        type: [second === "peer" ? "integer" : "string"],
        root: { kind: "let", name: "final", site: site(`let final=${list}`) },
      },
      kinds: [second === "peer" ? "string" : "integer"],
    });
    const expected = [
      copied("b", "a", ["f"]),
      copied("b", "a", ["nest", "g"]),
      copied("a", "b", ["f"]),
      copied("a", "b", ["nest", "g"]),
      ...(element === null ? [] : [mixed(element, ["f"]), mixed(element, ["nest", "g"])]),
    ];
    // (each diagnostic whole, as a stop keeps it, in the order of its site and what it names)
    const order = (list: readonly Readonly<Record<string, unknown>>[]) =>
      [...list].sort((x, y) =>
        JSON.stringify([x.site, x.rule]).localeCompare(JSON.stringify([y.site, y.rule])),
      );
    for (const mode of MODES) {
      const result: CoreResult = inMode(mode, () => checkedResult(analyseCore(request), request));
      try {
        assert.equal(result.outcome, "compile-error");
        assert.deepStrictEqual(order(result.diagnostics.map(stopIdentity)), order(expected));
        assert.equal(result.checks.length, 0);
      } catch (error) {
        differing.push(`${list} ${JSON.stringify(mode)}: ${String(error)}`);
      }
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * A2's value origins (Astra r1 N1 on #1293): a property's value in one of two objects whose property holds two kinds, as
 * a literal, a written or an inferred binding, a written binding in a nested object, a binding written as a union or as
 * `object?` (the property itself, or one below it), in either object; the objects as a list's elements, stores into one
 * place, the same through projections, and a ring of whole copies, in both orders, unread and read. A written binding's
 * copy brings its written type as a literal brings its kind: the second errs where it meets the place or the list, read
 * or not, and a union's copy only where it comes second into a place (first, the place takes both kinds), never in a
 * list, whose type is the union all its elements fit, in either order (#2289 B1). An `object?` holds any
 * object, its properties unchecked (A1): below it, nothing meets, and what a read of such a property gives is the read's
 * own record, not A2's.
 */
test("A2's value origins: a written binding's copy errs where it meets the place or the list as a literal's does, read or not, in both orders", () => {
  const values = { int: ["integer", "1"], str: ["string", '"text"'] } as const;
  // per origin: the setup it needs, the object with its value of a kind, the plain object of a kind, the path compared
  const origins: readonly (readonly [
    string,
    (kind: "int" | "str") => readonly [string, string],
    (kind: "int" | "str") => string,
    string,
  ])[] = [
    [
      "a literal",
      (kind) => ["", `{n: ${values[kind][1]}}`],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "a written binding",
      (kind) => [`let w: ${values[kind][0]} = ${values[kind][1]}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "an inferred binding",
      (kind) => [`let w = ${values[kind][1]}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "a written binding in a nested object",
      (kind) => [`let w: ${values[kind][0]} = ${values[kind][1]}\n`, "{p: {n: w}}"],
      (kind) => `{p: {n: ${values[kind][1]}}}`,
      "p.n",
    ],
    [
      "a union binding",
      (kind) => [`let w: (integer | string) = ${values[kind][1]}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "an object? binding beside a scalar",
      (kind) => [`let w: object? = {k: ${values[kind][1]}}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "an object? binding below it",
      (kind) => [`let w: object? = {k: ${values[kind][1]}}\n`, "{n: w}"],
      (kind) => `{n: {k: ${values[kind][1]}}}`,
      "n.k",
    ],
  ];
  // per shape: the program after the objects `a` and `b`, the second's site, and the place read
  const shapes: readonly (readonly [
    string,
    (first: string, second: string) => string,
    (second: string) => string,
    string,
  ])[] = [
    ["a list", (first, second) => `let xs = [${first}, ${second}]`, (second) => second, "xs[0]"],
    ["a place", (first, second) => `let c = ${first}\nc = ${second}`, (second) => second, "c"],
    [
      "a list through projections",
      (first, second) =>
        `let x = {inner: ${first}}\nlet y = {inner: ${second}}\nlet xs = [x.inner, y.inner]`,
      () => "y.inner",
      "xs[0]",
    ],
    [
      "a place through projections",
      (first, second) =>
        `let x = {inner: ${first}}\nlet y = {inner: ${second}}\nlet c = x.inner\nc = y.inner`,
      () => "y.inner",
      "c",
    ],
    [
      "a ring of whole copies",
      (first, second) => `let c = ${first}\nlet d = c\nc = d\nd = ${second}`,
      (second) => second,
      "c",
    ],
  ];
  const differing: string[] = [];
  for (const [origin, value, plain, path] of origins)
    for (const side of ["int", "str"] as const) {
      const [setup, own] = value(side);
      const objects = {
        a: side === "int" ? own : plain("int"),
        b: side === "str" ? own : plain("str"),
      };
      const sideOf = side === "int" ? "a" : "b";
      for (const [shape, program, siteOf, place] of shapes)
        for (const [first, second] of [
          ["a", "b"],
          ["b", "a"],
        ] as const) {
          const source = `${setup}let a = ${objects.a}\nlet b = ${objects.b}\n${program(first, second)}\n`;
          const label = `${origin} in ${sideOf}, ${shape}, ${first} first`;
          const unread =
            origin.endsWith("below it") ||
            (origin === "a union binding" && (first === sideOf || shape.startsWith("a list")));
          const expected = unread
            ? ["valid"]
            : ["compile-error", `compile-error written-target '${siteOf(second)}'`];
          for (const reversed of [false, true]) {
            const actual = a2Record(`${source}exit`, reversed);
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              differing.push(`${label}${reversed ? ", reversed" : ""}: ${actual.join(", ")}`);
            if (origin.endsWith("below it")) continue;
            const read = a2Record(`${source}say ${place}.${path}\nexit`, reversed);
            if (JSON.stringify(read) !== JSON.stringify(expected))
              differing.push(`${label}, read${reversed ? ", reversed" : ""}: ${read.join(", ")}`);
          }
        }
    }
  assert.deepEqual(differing, []);
});

test("the copied-property check grows with the program, not with its copies times its fields, in either order (A2)", () => {
  // k copies of a record with k fields and a record of k other-typed fields, each field read: one error per field; the
  // copies as a list's elements, as stores into one variable, and wrapped in literals of both. The gate's shapes,
  // unread, in both orders of the copies: k copies of the first record in one list beside a copy of one that
  // differs in one field (one error, or one per copy where it comes first), and k places each receiving a copy of each
  // (one error per place, at its store). k places each receiving a copy of the first record and then its own object of
  // one other-typed field (one error each). A ring of k whole copies fed the first record and then the other (one error
  // per field, at the store bringing it: Codex r1's review of #1293), and a quiet one. Beyond the bound,
  // linear: Codex r4's k independent property cycles of one object, `b_i = a.f_i`, `a.f_i = b_i`, the object then
  // copied beside another type (one error, at its own property), and r5's: those cycles beside k self-grafts
  // `a.g_i = a` (none). The written-type axis (Astra r1 N1): the elements, the stores, the places and the list with
  // each field a copy of a written binding (a ring of such copies costs what `main`'s ring costs, #1078)
  const fields = (k: number, value: string): string =>
    Array.from({ length: k }, (_, i) => `f${i}: ${value}`).join(", ");
  const records = (k: number): string =>
    `let good = {${fields(k, "1")}}\nlet bad = {${fields(k, '"x"')}}\n`;
  const reads = (k: number, read: string): string =>
    Array.from({ length: k }, (_, i) => `say "\${${read}.f${i}}"`).join("\n");
  const copies = (k: number, copy: string): string =>
    Array.from({ length: k }, () => copy).join(", ");
  // the records with each field a copy of a written binding, and the first record but one field of the other's
  const typed = (k: number): string =>
    `${Array.from({ length: k }, (_, i) => `let w${i}: integer = ${i}\nlet s${i}: string = "x"`).join("\n")}\n` +
    `let good = {${Array.from({ length: k }, (_, i) => `f${i}: w${i}`).join(", ")}}\n` +
    `let bad = {${Array.from({ length: k }, (_, i) => `f${i}: s${i}`).join(", ")}}\n` +
    `let other = {${Array.from({ length: k }, (_, i) => (i === 0 ? "f0: s0" : `f${i}: w${i}`)).join(", ")}}\n`;
  // a ring of k whole copies fed the first record, each relay's second store after it closes, then the other record at
  // its first member; and a ring whose steps each pass a chain of `length` copies (r3's axes, #1293)
  const ring = (k: number, second: (i: number) => string): string =>
    `${records(k)}let a0 = good\n` +
    `${Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`).join("\n")}\na0 = a${k - 1}\n` +
    `${Array.from({ length: k - 1 }, (_, i) => second(i + 1)).join("\n")}\na0 = bad\nexit`;
  const chained = (k: number, length: number): string =>
    `${records(k)}let a0 = good\n` +
    Array.from({ length: k - 1 }, (_, i) =>
      Array.from({ length }, (_, step) =>
        step === length - 1
          ? `let a${i + 1} = ${step === 0 ? `a${i}` : `c${i}_${step - 1}`}`
          : `let c${i}_${step} = ${step === 0 ? `a${i}` : `c${i}_${step - 1}`}`,
      ).join("\n"),
    ).join("\n") +
    `\na0 = a${k - 1}\na0 = bad\nexit`;
  const shapes: readonly (readonly [string, (k: number) => string])[] = [
    [
      "elements",
      (k) =>
        `${records(k)}let xs = [${copies(k, "good")}]\nxs.add(bad)\n${reads(k, "xs[0]")}\nexit`,
    ],
    [
      "stores",
      (k) =>
        `${records(k)}let c = good\n${Array.from({ length: k }, () => "c = good").join("\n")}\nc = bad\n` +
        `${reads(k, "c")}\nexit`,
    ],
    [
      "wrapped stores",
      (k) =>
        `${records(k)}let c = {box: {inner: good}}\n` +
        `${Array.from({ length: k }, () => "c = {box: {inner: good}}").join("\n")}\n` +
        `c = {box: {inner: bad}}\n${reads(k, "c.box.inner")}\nexit`,
    ],
    [
      "wrapped elements",
      (k) =>
        `${records(k)}let xs = [${copies(k, "{inner: good}")}]\nxs.add({inner: bad})\n` +
        `${reads(k, "xs[0].inner")}\nexit`,
    ],
    [
      "independent property cycles",
      (k) =>
        `let a = {n: 1, ${fields(k, "null")}}\n` +
        `${Array.from({ length: k }, (_, i) => `let b${i} = a.f${i}\na.f${i} = b${i}`).join("\n")}\n` +
        'let bad = {n: "x"}\nlet c = a\nc = bad\nexit',
    ],
    [
      "one object copied by k places, each then receiving its own other copy",
      (k) =>
        `${records(k)}${Array.from({ length: k }, (_, i) => `let o${i} = {f${i}: "x"}\nlet c${i} = good\nc${i} = o${i}`).join("\n")}\nexit`,
    ],
    [
      "places",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `${Array.from({ length: k }, (_, i) => `let c${i} = good\nc${i} = other`).join("\n")}\nexit`,
    ],
    [
      "places, the other first",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `${Array.from({ length: k }, (_, i) => `let c${i} = other\nc${i} = good`).join("\n")}\nexit`,
    ],
    [
      "a list",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `let xs = [${copies(k, "good")}, other]\nexit`,
    ],
    [
      "a list, the other first",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `let xs = [other, ${copies(k, "good")}]\nexit`,
    ],
    [
      "a ring of k copies fed two objects of k other-typed fields",
      (k) =>
        `${records(k)}let a0 = good\n` +
        `${Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`).join("\n")}\n` +
        `a0 = a${k - 1}\na${k - 1} = bad\nexit`,
    ],
    [
      "a ring of k copies fed two objects of k fields of one type",
      (k) =>
        `${records(k)}let a0 = good\n` +
        `${Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`).join("\n")}\n` +
        `a0 = a${k - 1}\na${k - 1} = {${fields(k, "2")}}\nexit`,
    ],
    // rings through chains of two and of three copies, their relays of one store each (r3's axes, #1293)
    ["a fed ring through chains of two copies", (k) => chained(k, 2)],
    ["a fed ring through chains of three copies", (k) => chained(k, 3)],
    [
      "elements of written fields",
      (k) => `${typed(k)}let xs = [${copies(k, "good")}]\nxs.add(bad)\n${reads(k, "xs[0]")}\nexit`,
    ],
    [
      "stores of written fields",
      (k) =>
        `${typed(k)}let c = good\n${Array.from({ length: k }, () => "c = good").join("\n")}\nc = bad\n` +
        `${reads(k, "c")}\nexit`,
    ],
    [
      "places of written fields",
      (k) =>
        `${typed(k)}${Array.from({ length: k }, (_, i) => `let c${i} = good\nc${i} = other`).join("\n")}\nexit`,
    ],
    [
      "places of written fields, the other first",
      (k) =>
        `${typed(k)}${Array.from({ length: k }, (_, i) => `let c${i} = other\nc${i} = good`).join("\n")}\nexit`,
    ],
    ["a list of written fields", (k) => `${typed(k)}let xs = [${copies(k, "good")}, other]\nexit`],
    [
      "a list of written fields, the other first",
      (k) => `${typed(k)}let xs = [other, ${copies(k, "good")}]\nexit`,
    ],
    [
      "property cycles beside self-grafts",
      (k) =>
        `let a = {n: 1, ${fields(k, "null")}, ${fields(k, "null").replaceAll("f", "g")}}\n` +
        `${Array.from({ length: k }, (_, i) => `let b${i} = a.f${i}\na.f${i} = b${i}\na.g${i} = a`).join("\n")}\n` +
        "let c = a\nexit",
    ],
  ];
  const errors = (name: string, k: number): number =>
    name === "independent property cycles" ||
    name === "a list" ||
    name === "a list of written fields"
      ? 1
      : name === "property cycles beside self-grafts" || name.endsWith("of one type")
        ? 0
        : k;
  const steep: string[] = [];
  for (const [name, program] of shapes)
    for (const reversed of [false, true]) {
      const work = (k: number): ReadonlyMap<string, number> & { total: number } => {
        const request = coreRequest([{ path: "main.tease", source: program(k) }]);
        assert.ok(request !== null, name);
        const answers = reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder(
                (list) => [...list].reverse(),
                () => analyseCore(request),
              ),
            )
          : analyseCore(request);
        assert.equal(
          answers.diagnostics.filter((diagnostic) => diagnostic.class === "compile-error").length,
          errors(name, k),
          name,
        );
        return Object.assign(new Map(answers.budget.counts), { total: answers.budget.total });
      };
      // (k stores into one object carry the parent stack's log factor, 2.36 at 64 → 128 before A2 too: those cycles'
      // counters at 128 → 256)
      const from = name.includes("property cycles") ? 128 : 64;
      const small = work(from);
      const large = work(2 * from);
      // per doubling of the source, against `tests/helpers/type-core/type-core-work.ts`'s criteria (2 for linear work): the total, and
      // each counter of at least 200 units
      const scale = (large.get("syntaxNodes") ?? 0) / (small.get("syntaxNodes") ?? 1);
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      const label = `${name}${reversed ? " reversed" : ""}`;
      if (doubling(small.total, large.total) > 2.15)
        steep.push(`${label}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const [counter, after] of large)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small.get(counter) ?? 0, after) > 2.35
        )
          steep.push(`${label} ${counter}: ${doubling(small.get(counter) ?? 0, after).toFixed(3)}`);
    }
  // the fed ring's relays each also taking an empty object (r3's B4) or a conflicting object of one property (r3's axes,
  // #1293): A2's own work, the candidates it lists and its index, grows with the program; what its checks at the ring's
  // members then ask of the value side is `main`'s ring cost (#1078, #1339: the G5 design round), so not the total. The
  // second store of the same object is a known cost too (G5), its record in the witnesses above
  for (const [name, second, count] of [
    ["an empty object", "{}", (k: number) => k],
    ["a conflicting object of one property", '{f0: "x"}', (k: number) => 2 * k - 1],
  ] as const)
    for (const reversed of [false, true]) {
      const counted = (k: number): ReadonlyMap<string, number> => {
        const request = coreRequest([
          { path: "main.tease", source: ring(k, (i) => `a${i} = ${second}`) },
        ]);
        assert.ok(request !== null, name);
        const answers = reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder(
                (list) => [...list].reverse(),
                () => analyseCore(request),
              ),
            )
          : analyseCore(request);
        assert.equal(
          answers.diagnostics.filter((diagnostic) => diagnostic.class === "compile-error").length,
          count(k),
          name,
        );
        return answers.budget.counts;
      };
      const [small, large] = [counted(16), counted(32)];
      const scale = (large.get("syntaxNodes") ?? 0) / (small.get("syntaxNodes") ?? 1);
      for (const counter of ["eligibility", "indexSteps"]) {
        const doubling =
          (2 * ((large.get(counter) ?? 0) / Math.max(1, small.get(counter) ?? 0))) / scale;
        if (doubling > 2.35)
          steep.push(
            `relays with ${name}${reversed ? " reversed" : ""} ${counter}: ${doubling.toFixed(3)}`,
          );
      }
    }
  assert.deepEqual(steep, []);
});

test("a mixed literal's conflicts are found once, under however many wrappers (A2)", () => {
  // k wrappers around a list of k copies (or k lists of two copies): one conflicting copy against k, at one size, so the
  // deep literal's own checks cancel and the difference is the conflicts' own work
  const source = (k: number, siblings: boolean, many: boolean): string => {
    const values = Array.from({ length: k }, (_, i) =>
      siblings ? (many || i === 0 ? "[a, b]" : "[a, a]") : many || i === 0 ? "b" : "a",
    ).join(", ");
    const list = siblings ? `[${values}]` : `[a, ${values}]`;
    return (
      `let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = ${"{inner: ".repeat(k)}${list}${"}".repeat(k)}\n` +
      `say xs${".inner".repeat(k)}${siblings ? "[0][0]" : "[0]"}.n\nexit`
    );
  };
  for (const siblings of [false, true]) {
    const extra = (k: number): { checks: number; nodes: number } => {
      const counts = [false, true].map((many) => {
        const request = coreRequest([{ path: "main.tease", source: source(k, siblings, many) }]);
        assert.ok(request !== null);
        return analyseCore(request).budget.counts;
      });
      return {
        checks: (counts[1]!.get("checks") ?? 0) - (counts[0]!.get("checks") ?? 0),
        nodes: counts[1]!.get("syntaxNodes") ?? 0,
      };
    };
    const small = extra(32);
    const large = extra(64);
    // the conflicts' checks per doubling of the source, against `tests/helpers/type-core/type-core-work.ts`'s counter criterion
    const doubling = (2 * (large.checks / small.checks)) / (large.nodes / small.nodes);
    assert.ok(doubling <= 2.35, `${siblings ? "siblings" : "copies"}: ${doubling.toFixed(3)}`);
  }
});
