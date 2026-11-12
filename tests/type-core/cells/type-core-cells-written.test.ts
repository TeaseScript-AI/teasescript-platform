// A4 in the cells: a written type through operations, projections and carriers, deciding only where its read runs.

import assert from "node:assert/strict";
import test from "node:test";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { type CompactRecord } from "../../helpers/type-core-records.js";

test("a written type an operation carries decides only where the operation's value holds it (A4, round 13 B1)", () => {
  // the receiver's element is selected, the written default never: the later text decides, the host value is checked
  // against it, nothing is an error
  const programs: readonly (readonly [string, string])[] = [
    [
      "a written list as a dead default",
      "let typed: integer[] = [1]\nlet xs = [[hostValue]].get(0, default: typed)",
    ],
    [
      "a written whole number in a dead default",
      "let typed: integer = 1\nlet xs = [[hostValue]].get(0, default: [typed])",
    ],
    [
      "a written list as a dead fallback",
      "let typed: integer[] = [1]\nlet xs = [hostValue] otherwise typed",
    ],
  ];
  const differing: string[] = [];
  for (const [name, store] of programs) {
    const source = `${store}\nxs.add("bad")\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      if (record.outcome !== "warning-runtime-check")
        differing.push(`${name}${reversed ? " reversed" : ""}: ${record.outcome}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a written copy decides through operations only where its read runs, with its whole written type (A4, round 14)", () => {
  // per program its outcome: a dead written operand under an outer carrier decides nothing (the numbers widen, the host
  // value is checked); a selected copy of a written union keeps the union, which the later text fits
  const programs: readonly (readonly [string, string, string])[] = [
    [
      "a dead fallback under a get",
      "let typed: integer[] = [1]\nlet xs = [[hostValue] otherwise typed, [1]].get(0, default: [])\nxs.add(2.5)\nexit",
      "warning-runtime-check",
    ],
    [
      "a dead default under a get",
      "let typed: integer[] = [1]\nlet xs = [[[hostValue]].get(0, default: typed), [1]].get(0, default: [])\nxs.add(2.5)\nexit",
      "warning-runtime-check",
    ],
    [
      "a selected written union",
      'let typed: (integer | string)[] = [1]\nlet xs = [typed].get(0, default: [])\nxs.add("good")\nexit',
      "valid",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      if (record.outcome !== outcome || (outcome === "valid" && record.checks.length > 0))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}, ${record.checks.length} checks`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a written copy carried through a projection or an operation keeps its written type where it is selected (A4, round 15)", () => {
  // per program its outcome: a selected written copy decides by its written type (strict integer, a union admitting
  // text), an evaluated but unselected one decides nothing
  const programs: readonly (readonly [string, string, string])[] = [
    [
      "an unselected receiver element",
      'let typed: integer[] = [1]\nlet xs = [typed].get(2, default: [])\nxs.add("good")\nexit',
      "valid",
    ],
    [
      "a selected union through otherwise",
      'let typed: (integer | string)[] = [1]\nlet xs = typed otherwise []\nxs.add("good")\nexit',
      // (#1072, V30 §18: `typed` is never null, so its fallback is never used)
      "warning",
    ],
    [
      "a selected union through a projection",
      'let typed: (integer | string)[] = [1]\nlet xs = (null otherwise {v: typed}).v\nxs.add("good")\nexit',
      "valid",
    ],
    [
      "a projected written integer list",
      "let typed: integer[] = [1]\nlet xs = [typed][0]\nxs = [2.5]\nexit",
      "compile-error",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      if (record.outcome !== outcome || (outcome === "valid" && record.checks.length > 0))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}, ${record.checks.length} checks`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a written operand its operation does not give decides nothing, whether its items name writers or not (A4, F17a, F17b, Astra r2 B1)", () => {
  // per shape (a parameter, a captured binding, a record's field, a default's default, an `otherwise` fallback; an add or
  // a whole store) the operation gives the written operand (index 0: the copy decides, the text is the error at "ok") or
  // another one only (index 3: the empty value decides nothing, the text decides)
  const fill = (copy: string, store: string, typed = "typed: integer[]"): string =>
    `function fill(${typed}) {\n  let xs = ${copy}\n  ${store}\n}\nfill([4])\nfill([6])\nexit`;
  const shapes: readonly (readonly [string, (index: number, store: string) => string])[] = [
    ["a parameter", (index, store) => fill(`[typed].get(${index}, default: [])`, store)],
    [
      "a captured binding",
      (index, store) =>
        `let typed: integer[] = [4]\nfunction fill {\n  let xs = [typed].get(${index}, default: [])\n  ${store}\n}\nfill()\nexit`,
    ],
    [
      "a record's field",
      (index, store) => fill(`[{data: typed}].get(${index}, default: {data: []}).data`, store),
    ],
    [
      "a default's default",
      (index, store) => fill(`[].get(0, default: [typed].get(${index}, default: []))`, store),
    ],
    // (`otherwise` gives its fallback where its own operand may be null: `[null][0]`, never beside `[[]][0]`; and its own
    // operand where that may be a value: a written list, never a null one)
    [
      "an `otherwise` fallback",
      (index, store) => fill(`${index === 0 ? "[null][0]" : "[[]][0]"} otherwise typed`, store),
    ],
    [
      "an `otherwise` operand",
      (index, store) =>
        `let typed: integer[]? = ${index === 0 ? "[1]" : "null"}\nlet xs = typed otherwise []\n${store}\nexit`,
    ],
    [
      "an `otherwise` operand's projection",
      (index, store) =>
        `let typed: integer[]? = ${index === 0 ? "[1]" : "null"}\nlet xs = [typed][0] otherwise []\n${store}\nexit`,
    ],
  ];
  const programs: (readonly [string, string, boolean])[] = [];
  for (const [name, shape] of shapes)
    for (const [how, store] of [
      ["an add", 'xs.add("ok")'],
      ["a whole store", 'xs = ["ok"]'],
    ] as const) {
      programs.push([`${name}, selected, ${how}`, shape(0, store), true]);
      programs.push([`${name}, not selected, ${how}`, shape(3, store), false]);
    }
  programs.push([
    "an unwritten parameter, not selected",
    fill("[typed].get(3, default: [])", 'xs.add("ok")', "typed"),
    false,
  ]);
  const differing: string[] = [];
  for (const [name, source, error] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.indexOf('"ok"')}`] : [];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // (the errors only: an `otherwise` keeps its fallback's kinds as possible where it never takes it, F17a, so the
      // later text may warn at the initializer)
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a projection of a written binding keeps its written type at the projected path, through the carriers that select it (A4, F12, Astra r2 B2)", () => {
  // per expression over a written `integer[][]` (a fraction then the error) and `(integer | string)[][]` (text then
  // fits): a direct projection, a carrier's selected receiver or default, a copy of the elements, a removal; a nested
  // `.first` on a copy of the elements may still warn that it is empty (C6), never err
  const expressions = [
    "typed[0]",
    "typed.first",
    "[typed][0][0]",
    "[typed].get(0, default: [])[0]",
    "[typed].get(0, default: []).first",
    "[].get(0, default: typed)[0]",
    "[typed].take(1)[0][0]",
    "[typed].take(1).first.first",
    "[typed].removeAt(0)[0]",
    "(typed otherwise [])[0]",
  ];
  const programs: (readonly [string, string, boolean])[] = [];
  for (const expression of expressions) {
    programs.push([
      `${expression}, integer`,
      `let typed: integer[][] = [[1]]\nlet xs = ${expression}\nxs = [2.5]\nexit`,
      true,
    ]);
    programs.push([
      `${expression}, union`,
      `let typed: (integer | string)[][] = [[1]]\nlet xs = ${expression}\nxs = ["later"]\nexit`,
      false,
    ]);
  }
  programs.push([
    "an element of a written list",
    "let typed: integer[] = [1]\nlet n = typed[0]\nn = 2.5\nexit",
    true,
  ]);
  const differing: string[] = [];
  for (const [name, source, error] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.lastIndexOf("2.5")}`] : [];
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

test("a written copy a carrier surely gives decides at the path's end too, an unselected one nowhere (A4, F17a, F17b, Codex r16 B1)", () => {
  // per expression over a written `integer` (a fraction then the error) and `integer | string` (text then fits): a
  // singleton literal's element or field, `otherwise` beside a never-null or an only-null operand, a `get` whose literal
  // proof gives its receiver or its default; and the operands those operations do not give, where the fraction fits
  const seed = "let seed = 1\nlet direct = seed\n";
  const programs: (readonly [string, string, boolean])[] = [];
  for (const expression of [
    "[typed][0]",
    "{n: typed}.n",
    "typed otherwise 0",
    "null otherwise typed",
    "[typed].get(0, default: 0)",
    "[].get(0, default: typed)",
  ]) {
    programs.push([
      `${expression}, integer`,
      `let typed: integer = 1\nlet xs = ${expression}\nxs = 2.5\nexit`,
      true,
    ]);
    programs.push([
      `${expression}, union`,
      `let typed: integer | string = 1\nlet xs = ${expression}\nxs = "ok"\nexit`,
      false,
    ]);
  }
  for (const expression of [
    "direct otherwise typed",
    "[direct].get(0, default: typed)",
    "[typed].get(4, default: direct)",
  ])
    programs.push([
      `${expression}, not given`,
      `${seed}let typed: integer = seed\nlet xs = ${expression}\nxs = 2.5\nexit`,
      false,
    ]);
  const differing: string[] = [];
  for (const [name, source, error] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.lastIndexOf("2.5")}`] : [];
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

test("an operation the receiver's or the key's decision leaves opaque or external carries no written type (F19a, F19, A4, Astra r3 B1)", () => {
  // per shape a projection, a `get` or a method of a receiver that may be a reference (the runtime's member, F19a), or
  // a `load` of a computed key (external data, F19): their typed operands give the value no written domain, so the
  // fraction or the text after them warns with its checks and never errs; the ordinary controls (a literal key, a
  // receiver that is no reference) keep their written copy's error
  const programs: readonly (readonly [string, string, boolean])[] = [
    [
      "a computed key's load",
      'let typed: integer[] = [1]\nlet key = "k"\nlet xs = load(key, default: typed)\nxs = [2.5]',
      false,
    ],
    [
      "a literal key's load",
      'let typed: integer[] = [1]\nlet xs = load("k", default: typed)\nxs = [2.5]',
      true,
    ],
    ["an index", "let typed: integer[][] | speaker = [[1]]\nlet xs = typed[0]\nxs = [2.5]", false],
    [
      "a first",
      "let typed: integer[][] | speaker = [[1]]\nlet xs = typed.first\nxs = [2.5]",
      false,
    ],
    [
      "a dict's values",
      "let typed: (integer[] dict) | speaker = dict{a: [1]}\nlet xs = typed.values[0]\nxs = [2.5]",
      false,
    ],
    [
      "a removal",
      "let typed: integer[][] | speaker = [[1]]\nlet xs = typed.removeAt(0)\nxs = [2.5]",
      false,
    ],
    ["a copy", "let typed: integer[] | speaker = [1]\nlet xs = typed.toList()\nxs = [2.5]", false],
    [
      "a get's receiver",
      "let typed: integer[][] | speaker = [[1]]\nlet xs = typed.get(0, default: [])\nxs = [2.5]",
      false,
    ],
    [
      "a get's default",
      'speaker vera { length: 2 }\nlet typed: integer[] = [1]\nlet pool: dict = dict{a: [[1]], b: vera}\nlet holder = pool.get("a", default: vera)\nlet xs = holder.get(0, default: typed)\nxs = [2.5]',
      false,
    ],
    ["a take", 'let typed: integer[] | speaker = [1]\nlet xs = typed.take(1)\nxs.add("ok")', false],
    [
      "a speaker's get",
      "speaker vera { length: 2 }\nlet typed: integer[] = [1]\nlet xs = vera.get(0, default: typed)\nxs = [2.5]",
      false,
    ],
    [
      "a speaker's get, inferred",
      'speaker vera { length: 2 }\nlet xs = vera.get(0, default: [1])\nxs = ["ok"]',
      false,
    ],
    [
      "a list's get",
      "let typed: integer[][] = [[1]]\nlet xs = typed.get(0, default: [])\nxs = [2.5]",
      true,
    ],
  ];
  const differing: string[] = [];
  for (const [name, body, error] of programs) {
    const source = `${body}\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.lastIndexOf("2.5")}`] : [];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // (a written union of a collection and the speaker, the only receiver with a written type that may be a reference
      // and holds a list, is also V30 §13's error, which this test sets aside)
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error" && d.kind !== "written-type")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});
