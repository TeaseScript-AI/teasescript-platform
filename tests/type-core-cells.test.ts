import assert from "node:assert/strict";
import test from "node:test";

import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture, type FixtureRecord } from "./helpers/type-core-fixture.js";
import { recordDifferences, type CompactRecord } from "./helpers/type-core-records.js";

/**
 * The coarse core against its independent expectation set (checkpoint 9, TABLE §10.2, §10.5; the port plan's §3.1):
 * per record the outcome, the diagnostics as (kind, class, site, asserted context) and the checks as (kind, target,
 * required kinds, boundary, site) multisets. The step that builds the core's analysis (M4 S4) completes the cells
 * below; a record is asserted when every cell it tests is among them. Admission (A2–A8; A1 and A9, against written
 * types, are S4's), the boundary checks of external data (C9), fallbacks and defaults (C10), saves (C8), loads (F18,
 * F19), the adapters' cell (C13), the budget's fallback (B1), stage 3b (§13), and the cells and work families that
 * measure admission (F28, S5, S6, P1, H8; W3, W5, W15) join with their steps.
 */
const COMPLETED: ReadonlySet<string> = new Set([
  // the transfers (§2)
  ...["F1", "F1a", "F2", "F3", "F4", "F5", "F5a", "F6", "F7a", "F7b", "F7c", "F8", "F9", "F10"],
  ...["F11", "F12", "F13", "F14", "F16", "F17a", "F17b", "F19a", "F20", "F21", "F22", "F23", "F24"],
  ...["F25", "F26a", "F26b", "F27a", "F27b", "F27c"],
  // the reads (§3): the exact path, the contract with its guard mark, the quiet path, the context words
  ...["X1", "X2", "X3", "X4", "X5", "X6", "X7", "R", "§3.2", "§3.3", "§3.4"],
  // the consumers (§4), C1 and C7 against written types, and admission against written types (A1, A9)
  ...["C1", "C2", "C3", "C4", "C5", "C5a", "C5b", "C5c", "C6", "C7", "C11", "C12", "A1", "A9"],
  // ownership and placement (§6), the exact answers (§7), the graph's rules (G1), the result's names (§10.5)
  ...[
    "O1",
    "O1a",
    "O2",
    "O3",
    "O4",
    "O5",
    "O6",
    "O7",
    "O8",
    "O9",
    "O10",
    "O11",
    "O12",
    "O13",
    "O14",
  ],
  ...["O15", "O16", "O17", "O18", "O19", "S1", "S2", "S3", "S4", "S7", "S8", "S9"],
  ...["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12", "L13"],
  ...["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H9", "P2", "P3", "P4", "P5", "P6", "P7"],
  ...["G1", "§10.5"],
  // the verdicts of the work families whose row measures only the cells above (§10.1)
  ...[
    "W1",
    "W2",
    "W4",
    "W6",
    "W7",
    "W8",
    "W9",
    "W10",
    "W11",
    "W12",
    "W13",
    "W14",
    "W16",
    "W17",
    "W18",
    "W19",
  ],
  ...[
    "W20",
    "W21",
    "W22",
    "W23",
    "W24",
    "W25",
    "W35",
    "W36",
    "W37",
    "W38",
    "W39",
    "W40",
    "W41",
    "W42",
    "W43",
  ],
]);

/**
 * Records whose expectation rests on admission's decided types (A2–A7) or on C9's boundary placement, which the set
 * tags with their transfer cell only: they join with admission (S6).
 */
const ADMISSION: ReadonlyMap<string, string> = new Map([
  ["cp9-cells/F9/filled-snapshot", "an add into a copy decided by its source's literal (A2, A6)"],
  ["cp9-cells/F10/toSet", "an add into a converted collection decided by its elements (A2, A6)"],
  ["cp9-cells/F10/toList", "an add into a converted collection decided by its elements (A2, A6)"],
  ["cp9-cells/F10/take", "an add into a taken list decided by its elements (A2, A6)"],
  ["cp9-cells/F10/takeLast", "an add into a taken list decided by its elements (A2, A6)"],
  ["cp9-cells/F10/plus", "an add into a joined list decided by its elements (A2, A6)"],
  ["cp9-cells/F23/return-conflict", "a function's result decided by its first return (A2, A6)"],
  [
    "cp9-cells/F25/choice",
    "an obsolete C9 boundary at an authored choice (withdrawn by r4.42), kept byte-identical until S6 refreshes the set",
  ],
]);

const records = readFixture();
const asserted = records.filter(
  (record) =>
    record.owner !== "adapter" &&
    !ADMISSION.has(record.name) &&
    record.cells.every((cell) => COMPLETED.has(cell)),
);

function analysed(record: FixtureRecord): CompactRecord {
  const request = coreRequest(record.files);
  assert.ok(request !== null, `${record.name}: its files parse and resolve`);
  return compactAnalysis(request);
}

test("the core gives the expected record for every record of the cells it completes", () => {
  assert.ok(asserted.length > 800, `asserted ${asserted.length} records`);
  const failures = asserted.flatMap((record) => {
    const differences = recordDifferences(record.expected, analysed(record));
    return differences.length === 0 ? [] : [`${record.name}: ${differences.join("; ")}`];
  });
  assert.deepEqual(failures, []);
});

test("the comparison fails a record whose second check is replaced by a copy of its first", () => {
  // the negative control of the port plan's §3.1: one check lost beside a surviving one must show
  const record = asserted.find(
    (candidate) =>
      candidate.expected.checks.length >= 2 &&
      JSON.stringify(candidate.expected.checks[0]) !== JSON.stringify(candidate.expected.checks[1]),
  );
  assert.ok(record !== undefined, "a record with two different checks");
  const [first, , ...others] = record.expected.checks;
  const altered: CompactRecord = { ...record.expected, checks: [first!, first!, ...others] };
  const actual = analysed(record);
  assert.deepEqual(recordDifferences(record.expected, actual), []);
  assert.notDeepEqual(recordDifferences(altered, actual), []);
});

/**
 * Programs beside the set, for cells whose transfers the set leaves untested (review r1): per program its cell, the
 * outcome and the diagnostics' context words in order.
 */
const CONTROLS: readonly (readonly [string, string, string, string])[] = [
  // §3.2: the mark travels with the value through a conversion, a length, a dict's keys and a declared result
  [
    "§3.2 guarded conversion",
    "let xs = null\nif xs != null { let wrong: string = xs.toSet() }",
    "warning-runtime-check",
    "branch branch branch",
  ],
  [
    "§3.2 guarded length",
    "let xs = [1]\nif xs != null { let wrong: string = xs.length }",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 guarded dict keys",
    "let xs = dict {x: 1}\nif xs != null { for key in xs { let wrong: integer = key } }",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 guarded declared result",
    "let xs = [1]\nif xs != null { let wrong: string = xs.count() }",
    "warning-runtime-check",
    "branch",
  ],
  ["§3.2 unguarded length", "let xs = [1]\nlet wrong: string = xs.length", "compile-error", "-"],
  // W34: copies of a source without an exact definition at the copy keep the guard's mark (review r3)
  [
    "§3.2 guarded copies of a source a later store redefines",
    "let seed = {g: {v: 1.5}}\nif seed.g is integer {\n  let a = seed\n  let b = a\n  repeat b.g {}\n}\nseed = {g: {v: 2}}\nexit",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 unguarded copies of a source a later store redefines",
    "let seed = {g: {v: 1.5}}\nlet a = seed\nlet b = a\nrepeat b.g {}\nseed = {g: {v: 2}}\nexit",
    "compile-error",
    "-",
  ],
  // W34: a guard of the argument a parameter copies marks the callee's copies of it (review r5)
  [
    "§3.2 a guarded argument copied in the callee",
    "let seed = {f: 2.0}\nfunction take(p) {\n  seed = p\n  let saved = seed\n  repeat saved.f {}\n}\nif seed.f is integer { take(seed) }\nexit",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 an unguarded argument copied in the callee",
    "let seed = {f: 2.0}\nfunction take(p) {\n  seed = p\n  let saved = seed\n  repeat saved.f {}\n}\ntake(seed)\nexit",
    "compile-error",
    "-",
  ],
  // F21: a dead call is no site and binds nothing
  [
    "F21 one live call beside a dead one",
    "function take(x) { repeat x {} }\ntake(1)\nif false { take(1.5) }",
    "valid",
    "",
  ],
  [
    "F21 two live calls",
    "function take(x) { repeat x {} }\ntake(1)\ntake(1.5)",
    "warning-runtime-check",
    "deferred-parameter",
  ],
  // X6, X7 (r4.10): a helper only blocks run stores as block code does, one ordinary code runs too as a call
  [
    "X6 a helper only a later block runs",
    'let n = 1\nfunction change { n = 1.5 }\nfunction unrelated { say "hello" }\nunrelated()\nlet shown: integer = n\nshowPermanentButton "x" { change() }',
    "valid",
    "",
  ],
  [
    "X7 a helper only an earlier block runs",
    'let n = 1\nfunction change { n = 1.5 }\nfunction unrelated { say "hello" }\nshowPermanentButton "x" { change() }\nunrelated()\nlet shown: integer = n',
    "warning-runtime-check",
    "handler",
  ],
  [
    "X6 a helper ordinary code runs too",
    'let n = 1\nfunction change { n = 1.5 }\nchange()\nlet shown: integer = n\nshowPermanentButton "x" { change() }',
    "warning-runtime-check",
    "call",
  ],
  [
    "X6 a helper's helper ordinary code runs too",
    'let n = 1\nfunction change { n = 1.5 }\nfunction outer { change() }\nshowPermanentButton "x" { outer() }\nouter()\nlet shown: integer = n',
    "warning-runtime-check",
    "call",
  ],
  // F25: every ask with a declared answer gives it, as its adapter row says
  ["F25 a date answer", 'let d = askDate "When?"\nlet w: integer = d', "compile-error", "-"],
  [
    "F25 a password answer",
    'let p = askPassword "Word?"\nlet w: integer = p',
    "compile-error",
    "-",
  ],
  // F25: a declared result is the receiver kind's own: text's `reverse` gives text, a list's `null`
  ["F25 a text's reversed text", 'let s = "abc".reverse()\nsay s.uppercase()', "valid", ""],
  [
    "F25 a list's reverse gives null",
    "let xs = [1, 2]\nlet r = xs.reverse()\nsay r + 1",
    "compile-error",
    "-",
  ],
  // V30 §19: askChoice gives a label's kind, or a button's value: a whole choice object's or an element's `value`, or
  // its `text` where it has no `value` (review r5)
  ["§19 a name label", "let r = askChoice back: 5\nlet n: integer = r", "compile-error", "-"],
  ["§19 a number label", 'let r = askChoice 1: "One"\nlet t: string = r', "compile-error", "-"],
  [
    "§19 an element without its value",
    'let xs = [{text: "Corner"}]\nlet r = askChoice xs\nlet n: integer = r',
    "compile-error",
    "-",
  ],
  [
    "§19 a whole choice object",
    'let r = askChoice {text: "A", value: {payload: 2}}\nlet t: string = r.payload',
    "compile-error",
    "-",
  ],
  [
    "§19 a bound choice object",
    'let o = {text: "A", value: 3}\nlet r = askChoice o\nrepeat r {}',
    "valid",
    "",
  ],
  // §3.2 (review r6): a guarded copy of a computed record passed to a written parameter at two sites keeps its mark
  [
    "§3.2 a guarded computed argument at two sites",
    "let source = null otherwise {f: 2.0}\nfunction take(p: object) { repeat p.f {} }\nif source.f is integer {\n  take(source)\n  take(source)\n}\nexit",
    "warning-runtime-check",
    "member",
  ],
  [
    "§3.2 an unguarded computed argument at two sites",
    "let source = null otherwise {f: 2.0}\nfunction take(p: object) { repeat p.f {} }\ntake(source)\ntake(source)\nexit",
    "compile-error",
    "-",
  ],
  // §19, F25, F7 (review r6): an external value beside a choice object's text; an unknown receiver's result is every
  // receiver kind's that has the method
  [
    "§19 an external value beside a choice object without one",
    'let r: string = askChoice [{text: "A", value: hostValue}, {text: "B"}]',
    "warning-runtime-check",
    "unknown",
  ],
  [
    "F25 an unknown receiver's reverse",
    'let raw = fromJson("\\"abc\\"", default: null, files: false)\nlet text: string = raw.reverse()',
    "warning-runtime-check",
    "unknown unknown unknown",
  ],
  [
    "F7 an unknown receiver's remove",
    'let raw = fromJson("{}", default: null, files: false)\nlet text: string = raw.remove("key")',
    "warning-runtime-check",
    "unknown unknown unknown unknown",
  ],
  // X7, H1, G1(b) (r4.25; Astra B4): a dead call registers no handler; a live one before the read does
  [
    "X7 a registration only a dead call makes before the read",
    'let n = 1\nfunction register { showPermanentButton "x" { n = 1.5 } }\nif false { register() }\nlet whole: integer = n\nregister()\nexit',
    "valid",
    "",
  ],
  [
    "X7 a registration a live call makes before the read",
    'let n = 1\nfunction register { showPermanentButton "x" { n = 1.5 } }\nregister()\nlet whole: integer = n\nexit',
    "warning-runtime-check",
    "handler",
  ],
  // F7b, C12 (Astra B3): a receiver that may be a list or a dict owes the dict key only as a check; a dict an error
  [
    "C12 remove on a possible list or dict",
    'let flag = askBoolean "flag"\nfunction selected {\n  if flag { return [1] }\n  return dict {key: 1}\n}\nsay selected().remove(1)\nexit',
    "warning-runtime-check",
    "unknown",
  ],
  ["C12 remove on a dict", "let d = dict {key: 1}\nsay d.remove(1)\nexit", "compile-error", "-"],
  // F11, F12, C2, C5 (Astra B1): a property named as an internal step is the object's property
  [
    "C2 a property named iteration of the wrong kind",
    'let box = {iteration: "bad"}\nrepeat box.iteration {}\nexit',
    "compile-error",
    "-",
  ],
  ["C5 a property named entry", "let box = {entry: 1}\nrepeat box.entry {}\nexit", "valid", ""],
  ["C5 a property named index", "let box = {index: 1}\nrepeat box.index {}\nexit", "valid", ""],
  [
    "F13 a store into a property named element",
    "let box = {element: 1}\nbox.element = 2\nrepeat box.element {}\nexit",
    "valid",
    "",
  ],
  [
    "F13 a wrong store into a property named element",
    "let box = {element: 1}\nbox.element = 2.5\nrepeat box.element {}\nexit",
    "compile-error",
    "-",
  ],
];

/** C1's warning and check for external data stored into a written place, by site (TABLE r4.43, C9 r4.29). */
test("external data in a choice's options or in a literal is warned at its own expression", () => {
  const sited = (source: string): readonly string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const record = compactAnalysis(request);
    return [
      record.outcome,
      ...record.diagnostics.map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset}`),
      ...record.checks.map((check) => `${check.kind}@${check.site.offset}`),
    ];
  };
  // r4.43 (1): an external option of a choice, as an external element of a literal
  assert.deepEqual(sited("let chosen: integer = askChoice [hostValue, 2]\nexit"), [
    "warning-runtime-check",
    "written-target@33",
    "copy-type@33",
  ]);
  assert.deepEqual(sited("let chosen: integer = askChoice [2, hostValue]\nexit"), [
    "warning-runtime-check",
    "written-target@36",
    "copy-type@36",
  ]);
  assert.deepEqual(sited("let pool: integer?[] = [hostValue, null, 7]\nexit"), [
    "warning-runtime-check",
    "written-target@24",
    "copy-type@24",
  ]);
  // V30 §19: a choice object gives its `value` (or its `text` without one), so its external value is the site
  assert.deepEqual(
    sited(
      'let chosen: integer = askChoice [{text: "A", value: hostValue}, {text: "B", value: 2}]\nexit',
    ),
    ["warning-runtime-check", "written-target@52", "copy-type@52"],
  );
  assert.deepEqual(sited('let chosen: integer = askChoice {text: "A", value: hostValue}\nexit'), [
    "warning-runtime-check",
    "written-target@51",
    "copy-type@51",
  ]);
  assert.deepEqual(sited("let chosen: integer = askChoice [{text: hostValue}]\nexit"), [
    "warning-runtime-check",
    "written-target@40",
    "copy-type@40",
  ]);
  // an external option read through a projection sits at its own expression (Astra B6-r2), in a choice and a literal
  assert.deepEqual(sited("let chosen: integer = askChoice [hostValue.field, 2]\nexit"), [
    "warning-runtime-check",
    "written-target@33",
    "member-read@33",
    "copy-type@33",
    "null-check@33",
  ]);
  assert.deepEqual(sited("let chosen: integer = [hostValue.field, 2][0]\nexit"), [
    "warning-runtime-check",
    "written-target@23",
    "member-read@23",
    "copy-type@23",
    "null-check@23",
  ]);
  // the selected value's site, not the first external expression in the option: a choice object's `value` beside an
  // external `text`, read whole or through a projection, alone or in a list; its `text` without a value
  assert.deepEqual(
    sited("let chosen: integer = askChoice {text: hostValue.label, value: hostValue.field}\nexit"),
    [
      "warning-runtime-check",
      "written-target@63",
      "member-read@39",
      "member-read@63",
      "copy-type@63",
      "null-check@39",
      "null-check@63",
    ],
  );
  assert.deepEqual(
    sited(
      "let chosen: integer = (askChoice {text: hostValue.label, value: {text: hostValue.field}}).text\nexit",
    ),
    [
      "warning-runtime-check",
      "written-target@71",
      "member-read@40",
      "member-read@71",
      "copy-type@71",
      "null-check@40",
      "null-check@71",
    ],
  );
  assert.deepEqual(
    sited(
      "let chosen: integer = (askChoice [{text: hostValue.label, value: {text: hostValue.field}}]).text\nexit",
    ),
    [
      "warning-runtime-check",
      "written-target@72",
      "member-read@41",
      "member-read@72",
      "copy-type@72",
      "null-check@41",
      "null-check@72",
    ],
  );
  assert.deepEqual(sited("let chosen: integer = askChoice {text: hostValue.label}\nexit"), [
    "warning-runtime-check",
    "written-target@39",
    "member-read@39",
    "copy-type@39",
    "null-check@39",
  ]);
  // r4.43 (3): options held in a variable follow the copy reading: the store into the written place
  assert.deepEqual(sited("let opts = [hostValue, 1]\nlet answer: integer = askChoice opts\nexit"), [
    "warning-runtime-check",
    "written-target@48",
    "copy-type@48",
  ]);
  assert.deepEqual(
    sited("let opts = [hostValue.field, 1]\nlet answer: integer = askChoice opts\nexit"),
    [
      "warning-runtime-check",
      "written-target@54",
      "member-read@12",
      "copy-type@54",
      "null-check@12",
    ],
  );
});

test("a choice's option reached through index and property projections is selected before its path (Astra B6-r3)", () => {
  // C1's site in both orders: each form follows `let chosen: integer = `, sites zero-based
  const sites = (form: string): string[] => {
    const request = coreRequest([
      { path: "main.tease", source: `let chosen: integer = ${form}\nexit` },
    ]);
    assert.ok(request !== null, form);
    const both = [false, true].map((reversed) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      return [
        record.outcome,
        ...record.diagnostics
          .filter((diagnostic) => diagnostic.kind === "written-target")
          .map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset}`),
        ...record.checks
          .filter((check) => check.kind === "copy-type")
          .map((check) => `${check.kind}@${check.site.offset}`),
      ];
    });
    assert.deepEqual(both[1], both[0], `${form}: both orders`);
    return both[0]!;
  };
  const at = (offset: number): string[] => [
    "warning-runtime-check",
    `written-target@${offset}`,
    `copy-type@${offset}`,
  ];
  // an option inside an index or a property projection, with and without a projection of the result
  assert.deepEqual(
    sites("(askChoice [{text: hostValue.label, value: {text: hostValue.field}}][0]).text"),
    at(72),
  );
  assert.deepEqual(
    sites(
      "(askChoice {option: {text: hostValue.label, value: {text: hostValue.field}}}.option).text",
    ),
    at(80),
  );
  assert.deepEqual(
    sites('(askChoice [{text: "A", value: {text: hostValue.field}}][0]).text'),
    at(60),
  );
  assert.deepEqual(sites('askChoice [{text: "A", value: hostValue.field}][0]'), at(52));
  assert.deepEqual(sites('askChoice {option: {text: "A", value: hostValue.field}}.option'), at(60));
  // a choice as another choice's option (Astra B6-r4), beside its literal analogue; a returned choice object read
  // through the outer choice's selection; a returned text-only option's length
  assert.deepEqual(sites("askChoice [(askChoice [hostValue.field, 1]), 2]"), at(45));
  assert.deepEqual(sites("[(askChoice [hostValue.field, 1]), 2][0]"), at(35));
  assert.deepEqual(
    sites(
      '(askChoice [(askChoice {text: "inner", value: {text: hostValue.label, value: {text: hostValue.field}}})]).text',
    ),
    at(106),
  );
  assert.deepEqual(
    sites('(askChoice [(askChoice {text: "inner", value: {text: hostValue.label}})]).length'),
    at(75),
  );
  // the controls: the literal analogues and the direct choice object
  assert.deepEqual(
    sites("[{text: hostValue.label, value: {text: hostValue.field}}][0].value.text"),
    at(61),
  );
  assert.deepEqual(
    sites("{option: {text: hostValue.label, value: {text: hostValue.field}}}.option.value.text"),
    at(69),
  );
  assert.deepEqual(
    sites("(askChoice {text: hostValue.label, value: {text: hostValue.field}}).text"),
    at(71),
  );
});

test("C1's site follows a choice's selection as its value does, over options, wrappers, nesting and paths (Astra B6-r4)", () => {
  // the C1 sites of `let chosen: integer = <expression>`, in both orders: the n-th `hostValue`, the store, or none
  const sites = (expression: string): string[] => {
    const source = `let chosen: integer = ${expression}\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, expression);
    const both = [false, true].map((reversed) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const offsets = [
        ...record.diagnostics.filter((d) => d.kind === "written-target").map((d) => d.site.offset),
        ...record.checks
          .filter((check) => check.kind === "copy-type")
          .map((check) => check.site.offset),
      ];
      return offsets.map((offset) =>
        source.startsWith("hostValue", offset)
          ? `hostValue #${source.slice(0, offset).split("hostValue").length - 1}`
          : offset === 22
            ? "the store"
            : `@${offset}`,
      );
    });
    assert.deepEqual(both[1], both[0], `${expression}: both orders`);
    return both[0]!;
  };
  // option kinds, with the step that selects their value (V30 §19)
  const kinds: readonly (readonly [string, string, boolean])[] = [
    ["hostValue", "", true],
    ["hostValue.field", "", true],
    ['{text: "A", value: hostValue.field}', ".value", true],
    ["{text: hostValue.label}", ".text", true],
    ['{text: "A", value: 3}', ".value", false],
  ];
  const wrappers: readonly ((option: string) => string)[] = [
    (option) => option,
    (option) => `[${option}][0]`,
    (option) => `{option: ${option}}.option`,
    (option) => `{option: [${option}]}.option[0]`,
  ];
  // a choice over the wrapped option, and its literal analogue: the same selection written as projections
  const nestings: readonly (readonly [
    (w: string) => string,
    (w: string, select: string) => string,
  ])[] = [
    [(w) => `askChoice [${w}]`, (w, select) => `[${w}][0]${select}`],
    [(w) => `askChoice [(askChoice [${w}])]`, (w, select) => `[[${w}][0]${select}][0]`],
    [
      (w) => `askChoice [(askChoice {text: "inner", value: ${w}})]`,
      (w, select) => `[{text: "inner", value: ${w}}.value${select}][0]`,
    ],
  ];
  const differing: string[] = [];
  let external = 0;
  for (const [option, select, isExternal] of kinds)
    for (const wrap of wrappers)
      for (const [choice, analogue] of nestings)
        for (const path of ["", ".text", ".length"]) {
          const chosen = `(${choice(wrap(option))})${path}`;
          const literal = `(${analogue(wrap(option), select)})${path}`;
          const expected = sites(literal);
          if (
            isExternal &&
            expected.every((site) => site === "hostValue #0") &&
            expected.length > 0
          )
            external += 1;
          const got = sites(chosen);
          if (JSON.stringify(got) !== JSON.stringify(expected))
            differing.push(
              `${chosen}: ${got.join(", ")} (its literal analogue: ${expected.join(", ")})`,
            );
        }
  assert.deepEqual(differing, []);
  // every external option's analogue sites C1 at its own external expression: 4 kinds × 4 wrappers × 3 × 3
  assert.equal(external, 144);
});

test("the core gives the expected outcome for the programs beside the set", () => {
  const got = CONTROLS.map(([name, source]) => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const record = compactAnalysis(request);
    const contexts = record.diagnostics.map((diagnostic) => diagnostic.context ?? "-").join(" ");
    return `${name}: ${record.outcome} [${contexts}]`;
  });
  assert.deepEqual(
    got,
    CONTROLS.map(([name, , outcome, contexts]) => `${name}: ${outcome} [${contexts}]`),
  );
});

/** A record as one sorted list of texts: its outcome, its diagnostics and its checks. */
function summary(record: CompactRecord): string[] {
  return [
    record.outcome,
    ...record.diagnostics.map((d) => `${d.kind} ${d.class} @${d.site.offset}`),
    ...record.checks.map(
      (check) =>
        `${check.kind} ${check.target} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
    ),
  ].sort();
}

/**
 * TABLE r4.46 (1), (2) (#1026): a choice object gives its `value` where it has the key and its `text` where it has
 * none, decided by the key and never by what the value resolves to (an empty answer is unresolved, not an absent key),
 * per alternative, on the value side and through a function's result (the contract) alike; a dict's `values` and
 * `keys` are lists of its values and of text that may hold none. Per program its record in both orders, with its sites
 * written as the text they start at: the set's records `cp9-cells/s4/choice-value/…` (set `486ac8093b597b45`), C9's
 * boundary check left out (it joins with S6), and controls beside them.
 */
test("a choice object's value is selected by its key, and a dict's values and keys are lists", () => {
  const programs: readonly (readonly [
    string,
    string,
    (at: (text: string) => number) => string[],
  ])[] = [
    [
      "set computed-integer",
      'let result: integer = askChoice {text:"A", value:dict{k:7}.values.first}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set computed-string",
      'let result = askChoice {text:0, value:dict{k:"bad"}.values.first}\nrepeat result {}\nexit\n',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("result {}")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:"bad"}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set bound-integer",
      'let v = dict{k:7}.values.first\nlet result: integer = askChoice {text:"A", value:v}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set mixed-omitted",
      'repeat askChoice [{text:"A", value:1}, {text:"B"}] {}\nexit\n',
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("askChoice")}`,
        `integer-check askChoice [{text:"A", value:1}, {text:"B"}] [integer] @${at("askChoice")}`,
      ],
    ],
    [
      "set all-integer",
      'repeat askChoice [{text:"A", value:1}, {text:"B", value:2}] {}\nexit\n',
      () => ["valid"],
    ],
    ["set omitted-integers", "repeat askChoice [{text:0}, {text:1}] {}\nexit\n", () => ["valid"]],
    [
      "set omitted-string-written",
      'let s: integer = askChoice [{text:"A"}]\nexit\n',
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    [
      "set external-written",
      'let result: integer = askChoice {text:"A", value:hostValue}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type result [integer] @${at("hostValue")}`,
      ],
    ],
    // each alternative its own: the first object's value, the second's text, never the first's text
    [
      "an omitted value beside a present one",
      'repeat askChoice [{text: "A", value: 1}, {text: 2}] {}\nexit',
      () => ["valid"],
    ],
    // a value computed in a solver component: the choice's own result, whichever member the solve enters
    [
      "a value from its own component",
      'function pick(n) {\n  if n > 0 { return askChoice {text: 0, value: pick(n - 1)} }\n  return "bad"\n}\nlet r: string = pick(1)\nexit',
      () => ["valid"],
    ],
    [
      "a wrong value from its own component",
      'function pick(n) {\n  if n > 0 { return askChoice {text: "zero", value: pick(n - 1)} }\n  return 5\n}\nlet r: string = pick(1)\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("pick(1)")}`],
    ],
    // the contract: a function's result (F20)
    [
      "a computed value through a result",
      'function pick { return askChoice {text: "A", value: dict{k: 7}.values.first} }\nlet n: integer = pick()\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: 7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "a wrong computed value through a result",
      'function pick { return askChoice {text: 0, value: dict{k: "bad"}.values.first} }\nrepeat pick() {}\nexit',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("pick() {}")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: "bad"}.values [list] @${at("dict")}`,
      ],
    ],
    // a present value that may be a missing member is that value, never the text beside it
    [
      "a value that may be missing",
      'let flag = askBoolean "f"\nfunction pick(f) {\n  if f { return {maybe: "s"} }\n  return {other: 1}\n}\nlet r: string = askChoice {text: 1, value: pick(flag).maybe}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("pick(flag)")}`,
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type r [string] @${at("askChoice")}`,
        `null-check pick.result [non-null] @${at("pick(flag)")}`,
      ],
    ],
    // a choice object held in a variable, whose value may be a missing member: possibly its text, never certainly
    [
      "a held choice object whose value may be missing",
      'let flag = askBoolean "f"\nfunction pick(f) {\n  if f { return {maybe: "s"} }\n  return {other: 1}\n}\nlet o = {text: 1, value: pick(flag).maybe}\nlet r: string = askChoice o\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("pick(flag)")}`,
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type r [string] @${at("askChoice")}`,
        `null-check pick.result [non-null] @${at("pick(flag)")}`,
      ],
    ],
    // a dict's lists outside a choice: read, copied, and an object's own property of the name
    [
      "a dict's values",
      'repeat dict{k: "bad"}.values.first {}\nexit',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("dict")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: "bad"}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "a dict's keys",
      "let d = dict{k: 1}\nrepeat d.keys.first {}\nexit",
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("d.keys")}`,
        `member-read warning-runtime-check @${at("d.keys")}`,
        `empty-check d.keys [list] @${at("d.keys")}`,
      ],
    ],
    [
      "a copy of a dict's values read by its contract",
      'let d = dict{k: "bad"}\nlet vs = d.values\nshowPermanentButton "b" { vs = d.values }\nrepeat vs.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("vs.first")}`,
        `member-read warning-runtime-check @${at("vs.first")}`,
        `empty-check vs [list] @${at("vs.first")}`,
        `integer-check vs.element [integer] @${at("vs.first")}`,
      ],
    ],
    // §3.2: under a test of its own path the read is marked, as `xs.first` is
    [
      "a dict's values under a test of their path",
      'let d = dict{k: "a"}\nif d.values.first is integer { repeat d.values.first {} }\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values.first is")}`,
        `member-read warning-runtime-check @${at("d.values.first {}")}`,
        `integer-use warning-runtime-check @${at("d.values.first {}")}`,
        `empty-check d.values [list] @${at("d.values.first is")}`,
        `empty-check d.values [list] @${at("d.values.first {}")}`,
        `integer-check d.values.element [integer] @${at("d.values.first {}")}`,
      ],
    ],
    // r4.43: C1's site at the external value among the options a dict's values give a choice
    [
      "a choice over a dict's values",
      'let n: integer = askChoice dict{a: {text: "A", value: hostValue}}.values\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type n [integer] @${at("hostValue")}`,
      ],
    ],
    [
      "an object's own values",
      "let o = {values: [1]}\nlet t: string = o.values.first\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("o.values.first")}`],
    ],
    [
      "external data among a dict's values",
      "let n: integer = dict{k: hostValue}.values.first\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type n [integer] @${at("hostValue")}`,
        `empty-check dict{k: hostValue}.values [list] @${at("dict")}`,
      ],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expect] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const expected = expect((text) => source.indexOf(text)).sort();
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary({ ...record, checks: record.checks.filter((check) => !check.boundary) });
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});
