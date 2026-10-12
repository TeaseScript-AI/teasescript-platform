import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

function said(source: string, seed?: number): string[] {
  const result = runValidSource(source, seed);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function failure(source: string): [string | undefined, string | undefined] {
  const failed = runValidSource(source).snapshot.failure;
  return [failed?.code, failed?.message];
}

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("statistics of a list of numbers", () => {
  assert.deepEqual(
    said(
      [
        "let scores = [3, 1, 4, 1, 5, 9, 2, 6]",
        'say "${sum(scores)} ${average(scores)} ${median(scores)} ${stddev(scores)} ${min(scores)} ${max(scores)}"',
        // Between the two nearest values in ascending order, [1, 1, 2, 3, 4, 5, 6, 9]: the 90th lies at rank 6.3.
        'say "${percentile(scores, 0)} ${percentile(scores, 10)} ${percentile(scores, 25)} ${percentile(scores, 90)} ${percentile(scores, 100)}"',
        'say "${median([7])} ${median([1, 2, 3])} ${stddev([2, 4, 4, 4, 5, 5, 7, 9])}"',
        "exit",
      ].join("\n"),
    ),
    ["31 3.875 3.5 2.748376143938713 1 9", "1 1 1.75 6.9 9", "7 2 2.138089935299395"],
  );
});

test("statistics read a property with by:, and durations give durations", () => {
  assert.deepEqual(
    said(
      [
        "let sessions = [",
        '    { count: 10, pause: 30 s, day: toDate("2026-10-02") },',
        '    { count: 14, pause: 45 s, day: toDate("2026-10-01") },',
        '    { count: 12, pause: 40 s, day: toDate("2026-10-03") }',
        "]",
        'say "${median(sessions, by: "count")} ${sum(sessions, by: "count")} ${percentile(sessions, 50, by: "count")}"',
        'say "${average(sessions, by: "pause")} ${sum(sessions, by: "pause")} ${max(sessions, by: "pause")} ${stddev([1 min, 2 min])}"',
        'say "${min(sessions, by: "day")} ${max([toDate("2026-01-05"), toDate("2025-12-31")])} ${sum([1 day, 1 week])}"',
        "exit",
      ].join("\n"),
    ),
    [
      "12 36 12",
      "38.333 seconds 1 minute 55 seconds 45 seconds 42.426 seconds",
      "2026-10-01 2026-01-05 8 days",
    ],
  );
});

test("statistics have the types of their values", () => {
  assert.deepEqual(
    diagnostics(
      [
        "let counts = [3, 4]",
        "let pauses = [30 s, 45 s]",
        "let total: integer = sum(counts)",
        "let lowest: integer = min(counts)",
        "let typical: number = median(counts)",
        "let rest: duration = average(pauses)",
        "let spread: duration = stddev(pauses)",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    diagnostics("let counts = [3, 4]\nlet typical: integer = average(counts)\nexit").map(
      ([code, , text]) => [code, text],
    ),
    [["TSV041", "average(counts)"]],
  );
});

test("statistics report empty lists, values they cannot read, and percentages outside 0 through 100", () => {
  assert.deepEqual(diagnostics('say sum(["a"])\nexit'), [
    ["TSV043", "sum(...) needs numbers or durations, not text (string).", '["a"]'],
  ]);
  assert.deepEqual(diagnostics("say median(5)\nexit"), [
    ["TSV043", "median(...) needs a list, not a whole number (integer).", "5"],
  ]);
  assert.deepEqual(diagnostics("say percentile([1, 2], 150)\nexit"), [
    ["TSV043", "percentile(...) needs a percentage from 0 through 100, not 150.", "150"],
  ]);
  assert.deepEqual(
    diagnostics('let sessions = [{ count: 10 }]\nsay sum(sessions, by: "amount")\nexit'),
    [["TSV043", "sum(...): the objects in this list have no property 'amount'.", '"amount"']],
  );
  assert.deepEqual(diagnostics('say average([1, 2], by: "count")\nexit'), [
    [
      "TSV043",
      "average(...) needs a list of objects for by:, not a list that holds a whole number (integer).",
      "[1, 2]",
    ],
  ]);
  assert.deepEqual(diagnostics("say sum([1, 2], scale: 2)\nexit"), [
    ["TSV022", "sum(...) has no parameter 'scale'. Its only named argument is 'by:'.", "scale"],
  ]);
  const cases: [string, string, string][] = [
    [
      "sum(dynamic([]))",
      "TSR018",
      "sum(...) of an empty list has no result. Check that the list's length is above 0 first.",
    ],
    [
      "max(dynamic([]))",
      "TSR018",
      "max(...) of an empty list has no result. Check that the list's length is above 0 first.",
    ],
    ["stddev(dynamic([4]))", "TSR018", "stddev(...) needs at least 2 values, but the list has 1."],
    [
      "percentile([1, 2], dynamic(-1))",
      "TSR039",
      "percentile(...) needs a percentage from 0 through 100, not -1.",
    ],
    [
      "average(dynamic([1, dynamic(2 s)]))",
      "TSR060",
      "average(...) needs values of one kind: all numbers or all durations.",
    ],
    [
      "average(dynamic([1 calendar day, 2 calendar days]))",
      "TSR060",
      "average(...) needs numbers or durations, not a calendar duration. A calendar day or month has no fixed length.",
    ],
    [
      "sum([dynamic(2), dynamic(1 s)])",
      "TSR060",
      "sum(...) needs values of one kind: all numbers or all durations.",
    ],
    [
      'sum(dynamic([{ n: 1 }]), by: "count")',
      "TSR060",
      "sum(...): an object in the list has no property 'count'.",
    ],
    [
      'median(dynamic([1]), by: "count")',
      "TSR060",
      "median(...) needs a list of objects for by:, not a list that holds a number.",
    ],
    ["sum(dynamic(5))", "TSR059", "sum(...) needs a list, not a number."],
    [
      "sum(dynamic([1e308, 1e308]))",
      "TSR036",
      "sum(...) gives a number too large to represent. Use smaller values.",
    ],
  ];
  for (const [call, code, message] of cases)
    assert.deepEqual(failure(`${DYNAMIC}say ${call}\nexit`), [code, message], call);
});

test("statistics and trends keep their precision for equal, close, tiny, and huge values", () => {
  assert.deepEqual(
    said(
      [
        // Equal values have no spread, also when their rounded average differs from them.
        'say "${linearRegression([0.1, 0.1, 0.1]).r2} ${stddev([0.1, 0.1, 0.1])} ${stddev([10000000000000000, 10000000000000002])}"',
        'say "${stddev([0, 1e-200])} ${average([1e308, 1e308])} ${percentile([-1e308, 1e308], 25)} ${median([5e-324, 5e-324])}"',
        'say linearRegression([{ x: 0, y: 0 }, { x: 1e200, y: 1 }], x: "x", y: "y")',
        'say "${linearRegression([0, 1e200]).r2}"',
        // A horizontal line predicts its value even where the distance to its start overflows.
        'let level = linearRegression([{ x: -1e308, y: 1 }, { x: -1e308 + 1e292, y: 1 }], x: "x", y: "y")',
        'say "${predict(level, 1e308)}"',
        // Large values that cancel leave the small one, and a line's intercept may cancel a change that overflows.
        'say "${sum([1e308, -1e308, 1e-100])} ${average([1e308, -1e308, 1e-100])}"',
        'let rising = linearRegression([{ x: -1e308, y: -1e308 }, { x: 0, y: 0 }], x: "x", y: "y")',
        'say "${predict(rising, 1e308)}"',
        'say linearRegression([{ x: -5e-324, y: 1e308 }, { x: 0, y: 0 }, { x: 5e-324, y: 1e308 }], x: "x", y: "y").slope',
        // Duration sums are exact too, in milliseconds and in whole days.
        'say "${sum([1e16 ms, 1 ms, -1e16 ms])} ${sum([9007199254740991 d, 2 d, -9007199254740991 d])} ${sum([-5 s, 5 s])}"',
        "exit",
      ].join("\n"),
    ),
    [
      "1 0 1.4142135623730951",
      "7.071067811865475e-201 1e+308 -5e+307 5e-324",
      "{ slope: 1e-200, intercept: 0, r2: 1, start: 0 }",
      "1",
      "1",
      "1e-100 3.3333333333333336e-101",
      "1e+308",
      "0",
      "1 millisecond 2 days 0 seconds",
    ],
  );
});

test("possibly null lists and values of list functions need a check first", () => {
  assert.deepEqual(
    diagnostics(
      [
        "function measure(samples: integer[]?, share: number?) {",
        "    let result: integer = sum(samples)",
        "    say percentile([1, 2], share)",
        "    return result",
        "}",
        "say measure(null, null)",
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "'samples' may be null. Check it first: if samples != null { ... }, or give a fallback: samples otherwise ...",
        "samples",
      ],
      [
        "TSV043",
        "'share' may be null. Check it first: if share != null { ... }, or give a fallback: share otherwise 0",
        "share",
      ],
    ],
  );
  assert.deepEqual(diagnostics("let samples: integer?[] = [1, null]\nsay sum(samples)\nexit"), [
    ["TSV043", "sum(...) needs numbers or durations, not null.", "samples"],
  ]);
  // Known elements and a known property name are checked also where the property's type stays unknown.
  assert.deepEqual(
    diagnostics('let samples: object?[] = [null]\nsay sum(samples, by: "n")\nexit'),
    [
      [
        "TSV043",
        "sum(...) needs a list of objects for by:, not a list that holds null.",
        "samples",
      ],
    ],
  );
  assert.deepEqual(
    diagnostics('let samples: (object | integer)[] = [1]\nsay sum(samples, by: "n")\nexit'),
    [
      [
        "TSV043",
        "sum(...) needs a list of objects for by:, not a list that holds a whole number (integer).",
        "samples",
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(`${DYNAMIC}say randomWeighted(dynamic([{ p: 1 }]), weight: null)\nexit`),
    [
      [
        "TSV043",
        "randomWeighted(...) needs the name of a property as its weight:, not null.",
        "null",
      ],
    ],
  );
  assert.deepEqual(diagnostics(`${DYNAMIC}say predict(dynamic(1), "x")\nexit`), [
    [
      "TSV043",
      "predict(...) needs a number, date, datetime, or absolute date and time as its x, not text (string).",
      '"x"',
    ],
  ]);
  assert.deepEqual(
    diagnostics('function measure(line: object) {\n    return predict(line, "a")\n}\nexit'),
    [
      [
        "TSV043",
        "predict(...) needs a number, date, datetime, or absolute date and time as its x, not text (string).",
        '"a"',
      ],
    ],
  );
  // Each kind x may be is checked on its own; the line decides at runtime.
  assert.deepEqual(
    said(
      "function measure(line, point: number | date) {\n    return predict(line, point)\n}\nsay measure(linearRegression([1, 2]), 2)\nexit",
    ),
    ["3"],
  );
  assert.deepEqual(diagnostics(`${DYNAMIC}say sum(dynamic([{ n: 1 }]), by: 1)\nexit`), [
    [
      "TSV043",
      "sum(...) needs the name of a property as its by:, not a whole number (integer).",
      "1",
    ],
  ]);
});

test("take and takeLast return a new list of the first or last elements", () => {
  assert.deepEqual(
    said(
      [
        "let scores = [1, 2, 3, 4, 5]",
        "let recent = scores.takeLast(2)",
        "recent.add(6)",
        'say "${scores.take(2).join()} | ${recent.join()} | ${scores.take(10).join()} | ${scores.takeLast(0).length} | ${scores.join()}"',
        "exit",
      ].join("\n"),
    ),
    ["1, 2 | 4, 5, 6 | 1, 2, 3, 4, 5 | 0 | 1, 2, 3, 4, 5"],
  );
  assert.deepEqual(diagnostics("let kept: integer[] = [1, 2].take(1)\nexit"), []);
  assert.deepEqual(diagnostics("say [1, 2].take(-1)\nexit"), [
    ["TSV043", "take() needs a whole number of at least 0, not -1.", "-1"],
  ]);
  assert.deepEqual(diagnostics("say [1, 2].takeLast(1.5)\nexit"), [
    ["TSV043", "takeLast() needs a whole number (integer), not a number.", "1.5"],
  ]);
  assert.deepEqual(diagnostics("say set[1, 2].take(1)\nexit"), [
    ["TSV043", "A set has no take(). Copy it into a list with toList() first.", "take"],
  ]);
  // Only lists have take and takeLast, so a visible count is checked whatever the compiler knows about the receiver.
  for (const count of ['"a"', "null", "1.5", "-1"])
    assert.deepEqual(
      diagnostics(`${DYNAMIC}say dynamic([1, 2]).take(${count}).length\nexit`).map(
        ([code]) => code,
      ),
      ["TSV043"],
      count,
    );
  assert.deepEqual(diagnostics("function f(m: integer?) {\n    say [1, 2].takeLast(m)\n}\nexit"), [
    [
      "TSV043",
      "'m' may be null. Check it first: if m != null { ... }, or give a fallback: m otherwise 0",
      "m",
    ],
  ]);
  assert.deepEqual(failure(`${DYNAMIC}say [1, 2].takeLast(dynamic(-2))\nexit`), [
    "TSR057",
    "takeLast() needs a whole number of at least 0, not -2.",
  ]);
});

test("indexOf, lastIndexOf, and count find a value by ==, and a missing value has no position", () => {
  assert.deepEqual(
    said(
      [
        DYNAMIC,
        "let xs = [3, 5, 3]",
        'say "${xs.indexOf(3) == 0} ${xs.lastIndexOf(3) == 2} ${xs.indexOf(9) == null} ${xs.count(3) == 2} ${xs.count(9) == 0}"',
        // Equality is ==, as for contains: nested lists and objects by value, and values of other kinds never.
        'let nested: (integer[] | object)[] = [[1, 2], { a: [1], b: "x" }, [1, 2]]',
        'say "${nested.indexOf([1, 2])} ${nested.lastIndexOf([1, 2])} ${nested.indexOf({ b: "x", a: [1] })} ${nested.indexOf([2, 1])} ${nested.count([1, 2])}"',
        'say "${[1, 2].indexOf("1")} ${[null, 1].indexOf(null)} ${[1, 2].count("1")} ${dynamic([1, 5]).lastIndexOf(5)}"',
        // A checked position is a whole number.
        'let queue = ["wash", "feed", "walk"]',
        'let at = queue.indexOf("feed")',
        "if at != null {",
        "    say queue[at + 1]",
        "}",
        'let last = queue.lastIndexOf("sleep")',
        "if last == null {",
        '    say "not queued"',
        "}",
        'let washes: integer = queue.count("wash")',
        "say washes",
        "exit",
      ].join("\n"),
    ),
    ["true true true true true", "0 2 1 null 2", "null 0 0 1", "walk", "not queued", "1"],
  );
  const check = (name: string) =>
    `'${name}' may be null. Check it first: if ${name} != null { ... }, or give a fallback: ${name} otherwise 0`;
  const cases: [string, [string, string, string][]][] = [
    [
      "let xs = [1, 2]\nsay xs[xs.indexOf(2)]\nexit",
      [
        [
          "TSV043",
          "This value may be null. Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise 0",
          "xs.indexOf(2)",
        ],
      ],
    ],
    ["let xs = [1, 2]\nlet at = xs.indexOf(2)\nsay at + 1\nexit", [["TSV043", check("at"), "at"]]],
    [
      "let xs = [1, 2]\nlet at = xs.lastIndexOf(2)\nsay xs.take(at)\nexit",
      [["TSV043", check("at"), "at"]],
    ],
    [
      "say set[1].indexOf(1)\nexit",
      [
        [
          "TSV043",
          "A set has no positions, so it has no indexOf(). Copy it into a list with toList() first.",
          "indexOf",
        ],
      ],
    ],
    [
      "say set[1].count(1)\nexit",
      [
        [
          "TSV043",
          "A set holds each member once, so it has no count(). Use contains(...) instead.",
          "count",
        ],
      ],
    ],
    [
      "say [1].indexOf()\nexit",
      [["TSV020", "indexOf() takes 1 argument (value), received 0.", "[1].indexOf()"]],
    ],
    [
      "say [1].count(value: 1)\nexit",
      [["TSV022", "count() takes its value without a name. Remove 'value:'.", "value"]],
    ],
    // Only lists count, and lists search for any value, so the arguments are checked whatever the receiver is.
    [
      `${DYNAMIC}say dynamic([1]).lastIndexOf(1, 2)\nexit`,
      [
        [
          "TSV020",
          "lastIndexOf() takes 1 argument (value), received 2.",
          "dynamic([1]).lastIndexOf(1, 2)",
        ],
      ],
    ],
  ];
  for (const [source, expected] of cases) assert.deepEqual(diagnostics(source), expected, source);
  assert.deepEqual(failure(`${DYNAMIC}say dynamic(set[1]).indexOf(1)\nexit`), [
    "TSR016",
    "Sets have no method 'indexOf'.",
  ]);
});

test("get gives the element at an index, or its default for an index the list does not have", () => {
  assert.deepEqual(
    said(
      [
        DYNAMIC,
        'say "${[1, 2].get(0, default: 9) == 1} ${[1, 2].get(2, default: 9) == 9} ${[1, 2].get(-1, default: 9) == 9}"',
        // An index the compiler cannot know gives the element only at a whole-number position, and otherwise the default.
        "let scores = [10, 20]",
        'say [scores.get(dynamic(1.0), default: 0), scores.get(dynamic(1.5), default: 0), scores.get(dynamic("1"), default: 0), scores.get(dynamic(null), default: 0)]',
        // A default of another type makes the result optional or a union, which a check narrows.
        'let deck = ["ace", "king"]',
        "let card = deck.get(2, default: null)",
        "if card == null {",
        '    say "no card"',
        "}",
        "let next = deck.get(1, default: null)",
        "if next != null {",
        "    say next.uppercase()",
        "}",
        "let shown: string | integer = deck.get(5, default: 0)",
        "say shown",
        // A kept element is a copy, as with grid[0].
        "let grid = [[1], [2]]",
        "let row = grid.get(0, default: [])",
        "row.add(9)",
        "say grid",
        "say row",
        "exit",
      ].join("\n"),
    ),
    ["true true true", "[20, 0, 0, 0]", "no card", "KING", "0", "[[1], [2]]", "[1, 9]"],
  );
  const deck = 'let deck = ["ace", "king"]\n';
  const cases: [string, [string, string, string][]][] = [
    [
      `${deck}let card: string = deck.get(0, default: null)\nexit`,
      [
        [
          "TSV041",
          "'card' is declared as string, so it cannot start as text (string) or null. Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise \"\"",
          "deck.get(0, default: null)",
        ],
      ],
    ],
    [
      `${deck}let card: string = deck.get(0, default: 0)\nexit`,
      [
        [
          "TSV041",
          "'card' is declared as string, so it cannot start as text (string) or a whole number (integer). Keep it in a variable and check it first, as in: if value is string { ... }",
          "deck.get(0, default: 0)",
        ],
      ],
    ],
    // The index is checked as for deck[index]: a whole number, also when the compiler can see it is not.
    [
      `${deck}say deck.get(0.5, default: "")\nexit`,
      [
        [
          "TSV043",
          "A list index must be a whole number (integer), but this is a number. Round it with floor(...), round(...), or ceil(...).",
          "0.5",
        ],
      ],
    ],
    [
      `${deck}let at = deck.indexOf("king")\nsay deck.get(at, default: "")\nexit`,
      [
        [
          "TSV043",
          "'at' may be null. Check it first: if at != null { ... }, or give a fallback: at otherwise 0",
          "at",
        ],
      ],
    ],
    // The element of an inner empty list that nothing decided has no type to name.
    [
      "let rows = [[]]\nfor v in rows.get(0, default: [0]) {\n    say v + 1\n}\nexit",
      [
        [
          "TSV043",
          "'v' may be of a type that no value decided yet, such as an element of an empty list without a written type. Check it first: if v is integer { ... }",
          "v",
        ],
      ],
    ],
    [
      'function pick(c: string[] | string dict) {\n    say c.get(0, default: "")\n}\nexit',
      [
        [
          "TSV043",
          "'c' may be a dict (string dict). Check it first: if c is string[] { ... }",
          "c",
        ],
      ],
    ],
    [
      'say set["ace"].get(0, default: "")\nexit',
      [
        [
          "TSV043",
          "A set has no positions, so it has no 'get()'. Use 'contains(...)' instead.",
          "get",
        ],
      ],
    ],
    [
      `${deck}say deck.get(0)\nexit`,
      [
        [
          "TSV020",
          "'get(index, default: value)' needs a 'default:' for an index the list does not have. Read an element that must exist as 'list[index]'.",
          "deck.get(0)",
        ],
      ],
    ],
    [
      `${deck}say deck.get(0, "")\nexit`,
      [
        [
          "TSV020",
          "'get(index, default: value)' takes one index and a 'default:'.",
          'deck.get(0, "")',
        ],
      ],
    ],
    [
      `${deck}say deck.get(0, fallback: "")\nexit`,
      [
        [
          "TSV022",
          "get(...) has no parameter 'fallback'. Its only named argument is 'default:'.",
          "fallback",
        ],
      ],
    ],
  ];
  for (const [source, expected] of cases) assert.deepEqual(diagnostics(source), expected, source);
  assert.deepEqual(failure(`${DYNAMIC}say dynamic(set[1]).get(0, default: 3)\nexit`), [
    "TSR016",
    "Sets have no method 'get'.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}say dynamic([1]).get(0)\nexit`), [
    "TSR028",
    "'list.get(index, default: value)' takes an index and a 'default:' value.",
  ]);
});

test("get joins an empty list default into the element type as a literal does", () => {
  // As in [[1, 2], []], the empty list takes the element type of the inner lists, also inside an object.
  assert.deepEqual(
    said(
      [
        "let rows: integer[][] = [[1, 2], [3]]",
        "for count in rows.get(5, default: []) {",
        "    say count + 1",
        "}",
        "for count in rows.get(0, default: []) {",
        "    say count + 1",
        "}",
        'let groups = [{ name: "warmup", counts: [10] }]',
        'let group = groups.get(0, default: { name: "none", counts: [] })',
        "for count in group.counts {",
        "    say count + 1",
        "}",
        'say groups.get(1, default: { name: "none", counts: [] }).name',
        "exit",
      ].join("\n"),
    ),
    ["2", "3", "11", "none"],
  );
});

test("get decides the element type of an empty list from its default, as a first value does, but not from null", () => {
  assert.deepEqual(
    said(
      [
        // Counting needs no declared type.
        "let scores = []",
        "scores.add(scores.get(0, default: 0) + 1)",
        "scores.add(scores.get(0, default: 0) + 1)",
        "say scores",
        // A null default decides nothing, so a later element decides the type alone, before or after the read.
        "let i = 0",
        "let names = []",
        "say names.get(i, default: null)",
        'names.add("ann")',
        "for name in names {",
        "    say name.uppercase()",
        "}",
        "let pets = []",
        'pets.add("rex")',
        "let pet = pets.get(i, default: null)",
        "if pet != null {",
        "    say pet.uppercase()",
        "}",
        "exit",
      ].join("\n"),
    ),
    ["[1, 2]", "null", "ANN", "REX"],
  );
  assert.deepEqual(diagnostics('let l = []\nsay l.get(0, default: 0)\nl.add("x")\nexit'), [
    [
      "TSV041",
      "'l' holds integer values (integer[]) since line 2, so it cannot contain text (string). To allow both, declare it as 'let l: (integer | string)[] = ...'.",
      '"x"',
    ],
  ]);
  // Parts of a deciding default that the compiler cannot know are checked against the type when the script runs, also
  // where a read or a copy saw the list undecided before.
  for (const before of ["", "say xs.get(0, default: null)\n", "let copy = xs\n"])
    assert.deepEqual(
      failure(
        `${DYNAMIC}let v = null\nv = dynamic("y")\nlet xs = []\n${before}say xs.get(0, default: [v])\nxs.add([1])\nexit`,
      ),
      [
        "TSR058",
        `An element of 'xs' holds a list (integer?[]), so it cannot take a list with text (string) "y" at [0].`,
      ],
      before,
    );
});

test("get with a null default gives the element type or null for lists of values, lists, and objects", () => {
  const lists = [
    "let scores: integer[] = [10, 20]",
    "let rows: integer[][] = [[1, 2], [3]]",
    'let people = [{ name: "Ann", age: 30 }]',
    "",
  ].join("\n");
  assert.deepEqual(
    said(
      [
        lists,
        "let score = scores.get(1, default: null)",
        "if score != null {",
        "    say score + 1",
        "}",
        "let row = rows.get(0, default: null)",
        "if row != null {",
        "    say row[0] + 1",
        "}",
        "let person = people.get(0, default: null)",
        "if person != null {",
        "    say person.age + 1",
        "}",
        'say "${scores.get(2, default: null) == null} ${rows.get(2, default: null) == null} ${people.get(2, default: null) == null}"',
        "exit",
      ].join("\n"),
    ),
    ["21", "2", "31", "true true true"],
  );
  const cases: [string, [string, string, string][]][] = [
    [
      `${lists}let score: integer = scores.get(0, default: null)\nexit`,
      [
        [
          "TSV041",
          "'score' is declared as integer, so it cannot start as a whole number (integer) or null. Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise 0",
          "scores.get(0, default: null)",
        ],
      ],
    ],
    [
      `${lists}let row: integer[] = rows.get(0, default: null)\nexit`,
      [
        [
          "TSV041",
          "'row' is declared as integer[], so it cannot start as a list (integer[]) or null. Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise ...",
          "rows.get(0, default: null)",
        ],
      ],
    ],
    [
      `${lists}let person = people.get(0, default: null)\nsay person.age\nexit`,
      [
        [
          "TSV043",
          "'person' may be null. Check it first: if person != null { ... }, or give a fallback: person otherwise ...",
          "person",
        ],
      ],
    ],
    // An element type that already holds null stays as written.
    [
      "let maybe: (null | integer)[] = [null, 1]\nlet n: integer = maybe.get(1, default: null)\nexit",
      [
        [
          "TSV041",
          "'n' is declared as integer, so it cannot start as null or a whole number (integer). Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise 0",
          "maybe.get(1, default: null)",
        ],
      ],
    ],
  ];
  for (const [source, expected] of cases) assert.deepEqual(diagnostics(source), expected, source);
});

test("linearRegression fits a line through the points of a list, and predict reads it", () => {
  assert.deepEqual(
    said(
      [
        "let fit = linearRegression([2, 4, 6, 8])",
        "say fit",
        'say "${predict(fit, 10)}"',
        // x is measured in days from the first point: 0, 2, and 3.
        "let sessions = [",
        '    { day: toDate("2026-10-01"), count: 10 },',
        '    { day: toDate("2026-10-03"), count: 14 },',
        '    { day: toDate("2026-10-04"), count: 15 }',
        "]",
        'let trend = linearRegression(sessions, x: "day", y: "count")',
        'say "${round(trend.slope, decimals: 4)} ${round(trend.intercept, decimals: 4)} ${round(trend.r2, decimals: 4)} ${trend.start}"',
        'say "${round(predict(trend, toDate("2026-10-10")), decimals: 1)} ${round(predict(linearRegression(sessions, y: "count"), 3), decimals: 1)}"',
        "let laps = linearRegression([62 s, 60 s, 59 s, 57 s])",
        'say "${laps.slope} ${laps.intercept} ${predict(laps, 5)}"',
        // Half a day apart: the slope is per day.
        'let times = [{ at: toDateTime("2026-10-01T08:00"), n: 1 }, { at: toDateTime("2026-10-01T20:00"), n: 2 }]',
        'let stamps = [{ at: toAbsoluteDateTime("2026-10-01T00:00:00Z"), n: 0 }, { at: toAbsoluteDateTime("2026-10-03T00:00:00Z"), n: 4 }]',
        'say "${linearRegression(times, x: "at", y: "n").slope} ${linearRegression(stamps, x: "at", y: "n").slope} ${linearRegression([5, 5, 5]).r2}"',
        "exit",
      ].join("\n"),
    ),
    [
      "{ slope: 2, intercept: 2, r2: 1, start: 0 }",
      "22",
      "1.7143 10.1429 0.9796 2026-10-01",
      "25.6 18",
      "-1.6 seconds 1 minute 1.9 seconds 53.9 seconds",
      "2 2 1",
    ],
  );
  assert.deepEqual(
    diagnostics(
      [
        'let trend = linearRegression([{ day: toDate("2026-10-01"), count: 1 }], x: "day", y: "count")',
        "let rate: number = trend.slope",
        "let first: date = trend.start",
        'let expected: number = predict(trend, toDate("2026-10-02"))',
        "let laps = linearRegression([62 s, 60 s])",
        "let pace: duration = predict(laps, 3)",
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("linearRegression and predict report too few points, one x, and values of the wrong kind", () => {
  assert.deepEqual(
    diagnostics(
      'let fit = linearRegression([1, 2, 3])\nsay predict(fit, toDate("2026-01-01"))\nexit',
    ),
    [
      [
        "TSV043",
        "predict(...) needs a number as its x, like the line's start, not a date.",
        'toDate("2026-01-01")',
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(
      'say linearRegression([{ at: "a", n: 1 }, { at: "b", n: 2 }], x: "at", y: "n").slope\nexit',
    ).map(([, message]) => message),
    [
      "linearRegression(...) needs numbers, dates, datetimes, or absolute dates and times, not text (string).",
    ],
  );
  assert.deepEqual(diagnostics('say linearRegression([{ day: 1 }], x: "day")\nexit'), [
    [
      "TSV043",
      "linearRegression(...) needs y: with x:, the property that holds the values.",
      '"day"',
    ],
  ]);
  assert.deepEqual(diagnostics('say linearRegression(["a", "b"])\nexit'), [
    [
      "TSV043",
      "linearRegression(...) needs numbers or durations, not text (string).",
      '["a", "b"]',
    ],
  ]);
  assert.deepEqual(diagnostics("say predict({ slope: 1 }, 2)\nexit")[0]?.[0], "TSV043");
  const cases: [string, string, string][] = [
    [
      "linearRegression(dynamic([1]))",
      "TSR018",
      "linearRegression(...) needs at least 2 points, but the list has 1.",
    ],
    [
      'linearRegression(dynamic([{ x: 1, y: 2 }, { x: 1, y: 3 }]), x: "x", y: "y")',
      "TSR036",
      "linearRegression(...) has no result: every point has the same x, so the line's slope cannot be determined. Use points with at least two different x values.",
    ],
    [
      'linearRegression(dynamic([{ x: toTime("08:00"), y: 2 }, { x: toTime("09:00"), y: 3 }]), x: "x", y: "y")',
      "TSR060",
      "linearRegression(...) needs numbers, dates, datetimes, or absolute dates and times as x values, not a time.",
    ],
    [
      "predict(dynamic({ slope: 1 }), 2)",
      "TSR059",
      "predict(...) needs a line from linearRegression(...), with slope, intercept, and start, not an object.",
    ],
    [
      'predict(linearRegression([1, 2]), dynamic(toDate("2026-01-01")))',
      "TSR059",
      "predict(...) needs a number as its x, like the line's start, not a date.",
    ],
    [
      'predict(linearRegression([{ at: toAbsoluteDateTime("2026-01-01T00:00:00Z"), n: 1 }, { at: toAbsoluteDateTime("2026-01-02T00:00:00Z"), n: 2 }], x: "at", y: "n"), dynamic(toDate("2026-01-01")))',
      "TSR059",
      "predict(...) needs an absolute date and time as its x, like the line's start, not a date.",
    ],
  ];
  for (const [call, code, message] of cases)
    assert.deepEqual(failure(`${DYNAMIC}say ${call}\nexit`), [code, message], call);
});

test("randomWeighted chooses with one draw of the session generator, in proportion to the weights", () => {
  // The same seed gives the same draw, so the first draw decides the choice: "a" below 3/4 of the total weight.
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const [draw, next] = said('say "${random()}"\nsay "${random()}"\nexit', seed).map(Number);
    const [chosen, after] = said(
      'say randomWeighted(dict{ "a": 3, "b": 0, "c": 1 })\nsay "${random()}"\nexit',
      seed,
    );
    assert.equal(chosen, draw! * 4 < 3 ? "a" : "c", `seed ${seed}`);
    // One draw only: the next random() is the generator's second number.
    assert.equal(Number(after), next, `seed ${seed}`);
  }
  // Only the proportions of the weights count, not their size.
  for (const seed of [5000, 123456789, 987654321, 2654435761]) {
    const chosen = ["5e-324", "1", "1e308"].map(
      (weight) => said(`say randomWeighted(dict{ "a": ${weight}, "b": ${weight} })\nexit`, seed)[0],
    );
    assert.deepEqual(new Set(chosen).size, 1, `seed ${seed}: ${chosen.join(", ")}`);
  }
  // A list of objects gives a copy of the chosen element.
  assert.deepEqual(
    said(
      [
        'let tasks = [{ name: "squats", chance: 0 }, { name: "plank", chance: 2 }]',
        'let task = randomWeighted(tasks, weight: "chance")',
        'task.name = "rest"',
        'say "${task.name} ${tasks[1].name}"',
        "exit",
      ].join("\n"),
    ),
    ["rest plank"],
  );
  assert.deepEqual(
    diagnostics(
      [
        'let key: string = randomWeighted(dict{ "a": 1 })',
        'let task = randomWeighted([{ name: "a", chance: 1 }], weight: "chance")',
        "let name: string = task.name",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    diagnostics('say randomWeighted(dict{ "a": "often" })\nexit')[0]?.[1],
    "randomWeighted(...) needs numbers, not text (string).",
  );
  assert.deepEqual(diagnostics('say randomWeighted([{ name: "a" }])\nexit')[0]?.[0], "TSV043");
  const cases: [string, string, string][] = [
    [
      'randomWeighted(dynamic(dict{ "a": 0 }))',
      "TSR039",
      "randomWeighted(...) needs at least one weight above 0.",
    ],
    [
      'randomWeighted(dynamic(dict{ "a": -1, "b": 2 }))',
      "TSR039",
      "randomWeighted(...) needs weights of at least 0, not -1.",
    ],
    [
      "randomWeighted(dynamic(dict{}))",
      "TSR018",
      "randomWeighted(...) of an empty dict has nothing to choose.",
    ],
    [
      'randomWeighted(dynamic(dict{ "a": "often" }))',
      "TSR060",
      "randomWeighted(...) needs numbers as weights, not text (string).",
    ],
  ];
  for (const [call, code, message] of cases)
    assert.deepEqual(failure(`${DYNAMIC}say ${call}\nexit`), [code, message], call);
});

test("list results survive checkpoint resume", () => {
  const source = [
    "let scores = [12, 15, 11, 18, 16]",
    "let target = round(percentile(scores, 10))",
    "wait 1 s",
    "let recent = scores.takeLast(3)",
    "let trend = linearRegression(recent)",
    "wait 1 s",
    'let task = randomWeighted(dict{ "squats": 3, "plank": 1 })',
    "wait 1 s",
    'say "${target} ${recent.join()} ${trend.slope} ${predict(trend, 3)} ${task == "squats" or task == "plank"}"',
    // A search waits for its value after reading its list.
    'let rounds = [["squats"], ["plank"], ["squats"]]',
    "function exercise(name: string) {",
    "    wait 1 s",
    "    return [name]",
    "}",
    'say "${rounds.lastIndexOf(exercise("squats"))} ${rounds.indexOf(exercise("lunges"))} ${rounds.count(exercise("squats"))}"',
    // So does get, for its default.
    'say "${rounds.get(1, default: exercise("rest")).join()} ${rounds.get(5, default: exercise("rest")).join()}"',
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["11 11, 18, 16 2.5 20 true", "2 null 2", "plank rest"],
  );
});
