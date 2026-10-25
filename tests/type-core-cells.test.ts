import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture, type FixtureRecord } from "./helpers/type-core-fixture.js";
import { recordDifferences, type CompactRecord } from "./helpers/type-core-records.js";

/**
 * The coarse core against its independent expectation set (checkpoint 9, TABLE §10.2, §10.5; the port plan's §3.1):
 * per record the outcome, the diagnostics as (kind, class, site, asserted context) and the checks as (kind, target,
 * required kinds, boundary, site) multisets. Every record is asserted except the classes held back below, each named by
 * its cell with its reason.
 */
function heldBack(record: FixtureRecord): string | null {
  // the adapters' cell (C13 and the storage rules' adapter rows): the kept checks the consumer calls run with S9b
  if (record.owner === "adapter") return "the adapters' records (S9b)";
  // stage 3b (§13: N1–N10): narrowing definitions, N3's required checks for a possible null and for written unions, and
  // with them S0(c)'s class of expectations that rest on the null and written-union deviation, enter with S10
  if (record.cells.some((cell) => /^N\d/.test(cell))) return "stage 3b's cells (S10)";
  return null;
}

const records = readFixture();
const asserted = records.filter((record) => heldBack(record) === null);

function analysed(record: FixtureRecord): CompactRecord {
  const request = coreRequest(record.files);
  assert.ok(request !== null, `${record.name}: its files parse and resolve`);
  return compactAnalysis(request);
}

test("the core gives the expected record for every record of the cells it completes", () => {
  assert.ok(asserted.length > 1_100, `asserted ${asserted.length} records`);
  const failures = asserted.flatMap((record) => {
    const differences = recordDifferences(record.expected, analysed(record));
    return differences.length === 0 ? [] : [`${record.name}: ${differences.join("; ")}`];
  });
  assert.deepEqual(failures, []);
});

test("the comparison fails a record whose second boundary check is replaced by a copy of its first", () => {
  // the negative control of the port plan's §3.1: one ingress's boundary check lost beside a surviving one must show
  const record = asserted.find(
    (candidate) => candidate.name === "cp9-cells/r46/m3/sol-m3b/boundary-multisite-argument",
  );
  // two arguments of external data bound to one parameter: two boundary checks, one target, two sites
  assert.ok(record !== undefined, "the record with two external arguments");
  const boundaries = record.expected.checks.filter((check) => check.boundary);
  assert.equal(boundaries.length, 2);
  assert.notDeepEqual(boundaries[0], boundaries[1]);
  const altered: CompactRecord = {
    ...record.expected,
    checks: [
      ...record.expected.checks.filter((check) => !check.boundary),
      boundaries[0]!,
      boundaries[0]!,
    ],
  };
  const actual = analysed(record);
  assert.deepEqual(recordDifferences(record.expected, actual), []);
  assert.notDeepEqual(recordDifferences(altered, actual), []);
});

/**
 * The presence-versus-resolution controls of the port plan's §3.1 (TABLE r4.46): for every optional-field decision (a
 * choice object's `value` and its `text`, `get`'s default, `load`'s and `fromJson`'s default and expected type) the field
 * present but computed through a method's result or a solver component, a fit and a misfit, in both orders, so a decision
 * made from the resolved items instead of the key's presence fails. Derived from the TABLE and V30 beside the set
 * (`fixtures/type-core/MANIFEST.md`); the set's `s4/choice-value/…` records are the choice value's first ones.
 */
test("every optional-field decision follows the field's presence, computed through a result or a component", () => {
  const controls = readFixture("presence-controls.jsonl");
  assert.equal(controls.length, 40);
  const failures = controls.flatMap((record) =>
    [false, true].flatMap((reversed) => {
      const request = coreRequest(record.files);
      assert.ok(request !== null, record.name);
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const actual = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const differences = recordDifferences(record.expected, actual);
      return differences.length === 0
        ? []
        : [`${record.name}${reversed ? " reversed" : ""}: ${differences.join("; ")}`];
    }),
  );
  assert.deepEqual(failures, []);
});

test("a warning names the earliest admitted store of its offending kind, after a rejection too (F28)", () => {
  // the set's writer evidence (`provenance.writers`), which the compact fixture leaves out, by the writer's site
  for (const [name, site, writer] of [
    ["cp9-cells/provenance/earliest-number", 108, 49],
    ["cp9-cells/provenance/prefix-admitted", 192, 64],
    // the store of 1.5 into the whole record is rejected (A6): the first admitted number is `state.n = 2.5`
    ["cp9-cells/provenance/prefix-rejected", 196, 133],
  ] as const) {
    const record = records.find((candidate) => candidate.name === name);
    assert.ok(record !== undefined, name);
    const request = coreRequest(record.files);
    assert.ok(request !== null, name);
    const warning = analyseCore(request).diagnostics.find(
      (diagnostic) => diagnostic.site.start === site,
    );
    assert.ok(warning?.class === "warning-runtime-check", name);
    assert.deepEqual(
      warning.provenance.writers.map((found) => found.start),
      [writer],
      name,
    );
  }
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
    // (a written result: two returns of different kinds would be admission's error, ADR 0021 1.5)
    'let flag = askBoolean "flag"\nfunction selected: integer[] | integer dict {\n  if flag { return [1] }\n  return dict {key: 1}\n}\nsay selected().remove(1)\nexit',
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
      // C1's checks; C9's boundary checks are asserted with their cell
      ...record.checks
        .filter((check) => !check.boundary)
        .map((check) => `${check.kind}@${check.site.offset}`),
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
          .filter((check) => check.kind === "copy-type" && !check.boundary)
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
      // (a record is a multiset: each list in a canonical order)
      const offsets = [
        ...record.diagnostics
          .filter((d) => d.kind === "written-target")
          .map((d) => d.site.offset)
          .sort((a, b) => a - b),
        // (C1's checks: C9's boundary checks are not C1's and stand where external data enters or is read)
        ...record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => check.site.offset)
          .sort((a, b) => a - b),
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
      // (the options' shared `text` of one kind: a literal's elements share their properties' types, ADR 0021 1.4)
      "repeat askChoice [{text: 1, value: 1}, {text: 2}] {}\nexit",
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
    // choice objects held in a variable, a container or a parameter: each record its own `value` or `text`, never
    // another record's `text` (#1027 review, Astra D1)
    [
      "held records with a value and without one",
      "let opts = [{text: 0, value: 1}, {text: 2}]\nrepeat askChoice opts {}\nexit",
      () => ["valid"],
    ],
    [
      "held records that do not fit",
      'let opts = [{text: "x", value: "bad"}, {text: "also bad"}]\nrepeat askChoice opts {}\nexit',
      (at) => ["compile-error", `integer-use compile-error @${at("askChoice")}`],
    ],
    [
      "held records in a dict under a computed key",
      'let key = "pick"\nlet choices = dict{[key]: {text: 0, value: 3}, other: {text: 4}}\nrepeat askChoice choices.values {}\nexit',
      () => ["valid"],
    ],
    [
      "held records from a parameter of two calls",
      'function pick(opts) { return askChoice opts }\nrepeat pick([{text: "unused", value: 1}]) {}\nrepeat pick([{text: 2}]) {}\nexit',
      () => ["valid"],
    ],
    [
      "a held record from a result",
      'function make(n) {\n  if n > 0 { return {text: "unused", value: n} }\n  return {text: 2}\n}\nrepeat askChoice make(1) {}\nexit',
      () => ["valid"],
    ],
    // §3.2: under a test of the record's `value` the button value is marked, as the read of the `value` is
    [
      "a held record under a test of its value",
      'let o = {text: "A", value: 1.5}\nif o.value is integer { let n: integer = askChoice o }\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type n [integer] @${at("askChoice")}`,
      ],
    ],
    // a record's `value` stored after it is made is read by its key (a number widens the place, ADR 0021 1.2; a text
    // there would be admission's error and be ignored, A6)
    [
      "a held record whose value is stored",
      'let o = {text: "A", value: 1}\no.value = 2.5\nlet n: integer = askChoice o\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    // and a record's `text` stored after it is made (a number widens the place); a key without a store below it stays
    // per record (Astra on #1027), the options' texts of one kind (ADR 0021 1.4)
    [
      "a held record whose text is stored",
      "let o = {text: 1}\no.text = 2.5\nlet n: integer = askChoice o\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    [
      "held records beside a value stored elsewhere",
      "let other = {value: 0}\nother.value = 1\nlet opts = [{text: 0, value: 1}, {text: 2}]\nrepeat askChoice opts {}\nexit",
      () => ["valid"],
    ],
    [
      "held records none of whose buttons fits, beside a value stored elsewhere",
      'let other = {value: 0}\nother.value = 1\nlet opts = [{text: "w", value: "x"}, {text: "y"}]\nrepeat askChoice opts {}\nexit',
      (at) => ["compile-error", `integer-use compile-error @${at("askChoice")}`],
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
    // r4.47 (7), F12 with P3: an element read from an open derived list is possible, so a key is possible text, a
    // warning with its check; §10.5, r4.46 (2): a target through a dict's list is its source text, no key of the dict
    [
      "a dict's keys",
      "let d = dict{k: 1}\nrepeat d.keys.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("d.keys")}`,
        `member-read warning-runtime-check @${at("d.keys")}`,
        `empty-check d.keys [list] @${at("d.keys")}`,
        `integer-check d.keys.first [integer] @${at("d.keys")}`,
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
    // a selection takes only its own emptiness: a deeper list's `empty-check` stays (#1027 review, Astra B1)
    [
      "a dict's values at depth 1",
      "let d = dict{a: 1}\nrepeat d.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's values at depth 2",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's keys below its values",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.keys.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.keys [list] @${at("d.values")}`,
        `integer-check d.values.first.keys.first [integer] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's values at depth 3",
      "let d = dict{a: dict{x: dict{}}, b: dict{y: dict{v: 1}}}\nrepeat d.values.first.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a cleared inner dict's values",
      "let inner = dict{v: 1}\ninner.clear()\nlet d = dict{a: inner}\nrepeat d.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "an inner dict bound before its values are read",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet inner = d.values.first\nrepeat inner.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("inner.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check inner.values [list] @${at("inner.values")}`,
      ],
    ],
    // the list-literal analogue: the inner list's selection keeps its check
    [
      "a list's lists",
      "let d = [[], [1]]\nrepeat d.first.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.first")}`,
        `empty-check d.element [list] @${at("d.first")}`,
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
        `integer-check d.values.first [integer] @${at("d.values.first {}")}`,
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
    // F19a: a receiver that may be a reference has the runtime's members, before a dict's list (review r2)
    [
      "a dict's keys on a receiver that may be a reference",
      // (a written union: a store of the speaker into the dict's place would be admission's error and be ignored, A6)
      'let o: string dict | speaker = dict{k: "bad"}\nrepeat o.keys.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `integer-use warning-runtime-check @${at("o.keys.first")}`,
        `null-check o [non-null] @${at("o.keys.first")}`,
        `empty-check o.keys [list] @${at("o.keys.first")}`,
        `null-check o.keys [non-null] @${at("o.keys.first")}`,
        `integer-check o.keys.first [integer] @${at("o.keys.first")}`,
      ],
    ],
    // the same through an operation and a literal: the receiver's completed contract decides (review r3)
    [
      "a dict's keys through an operation whose receiver may be a reference",
      'let o: string dict | speaker = dict{k: "bad"}\nrepeat (o otherwise null).keys.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("o otherwise")}`,
        `member-read warning-runtime-check @${at("o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `integer-use warning-runtime-check @${at("(o otherwise")}`,
        `null-check o otherwise null [non-null] @${at("o otherwise")}`,
        `null-check o otherwise null [non-null] @${at("o otherwise")}`,
        `empty-check (o otherwise null).keys [list] @${at("(o otherwise")}`,
        `null-check (o otherwise null).keys [non-null] @${at("(o otherwise")}`,
        `integer-check (o otherwise null).keys.first [integer] @${at("(o otherwise")}`,
      ],
    ],
    // a path through eight objects' own `values` is read once per step, as any property's (review r2: it exhausted the
    // allowance)
    [
      "a path through eight objects' own values",
      `let n0 = {v: 7}\n${Array.from({ length: 8 }, (_, i) => `let n${i + 1} = {values: [n${i}]}`).join("\n")}\nrepeat n8${".values.first".repeat(8)}.v {}\nexit`,
      () => ["valid"],
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

/**
 * A choice reads a written list's element as its literal analogue does (TABLE r4.42–r4.43, the lead's ruling on #1027):
 * a copied record below the list's element step takes its contract (F12 r4.7), with the read's word and the copy
 * check, in both orders.
 */
test("a choice's written list element reads below the list's element step, as its literal analogue", () => {
  const recordOf = (source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [forward, reversed] = [false, true].map((reverse) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reverse }, () => compactAnalysis(request));
      return reverse ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    });
    assert.deepEqual(reversed, forward, `${source}: both orders`);
    return forward!;
  };
  for (const store of ["rec.f = 2.5", 'showPermanentButton "b" { rec.f = 2.5 }']) {
    const head = `let rec = {f: 1}\n${store}\nlet n: integer = `;
    const choice = recordOf(`${head}(askChoice [{text: "A", value: rec}]).f\nexit`);
    assert.deepEqual(choice, recordOf(`${head}[{text: "A", value: rec}][0].value.f\nexit`));
    assert.deepEqual(
      [
        choice.outcome,
        ...choice.diagnostics.map((d) => `${d.kind} ${d.context} @${d.site.offset}`),
      ],
      ["warning-runtime-check", `written-target member @${head.length}`],
    );
  }
});

/**
 * §3.2 (review round 5 on #1027): a held choice object's button value keeps the mark of a test of the key it selects,
 * through copies, a list's element, a parameter and a path below it, as the keyed read does; a test of the other key
 * marks neither. Per program its record in both orders against the same program with the keyed read in its place, the
 * checks' targets aside.
 */
test("a held choice object's button value is marked by a test of its selected key, as the keyed read is", () => {
  const cases: readonly (readonly [string, string, string, string, string])[] = [
    [
      "a test of its value",
      'let o = {text: "unused", value: 2.0}\nif o.value is integer { let r: integer = READ }\nexit',
      "askChoice o",
      "o.value",
      "warning-runtime-check",
    ],
    [
      "a test of its text, without a value",
      "let o = {text: 2.0}\nif o.text is integer { let r: integer = READ }\nexit",
      "askChoice o",
      "o.text",
      "warning-runtime-check",
    ],
    [
      "a copy of a copy in the tested branch",
      'let o = {text: "unused", value: 2.0}\nif o.value is integer {\nlet p = o\nlet q = p\nlet r: integer = READ\n}\nexit',
      "askChoice q",
      "q.value",
      "warning-runtime-check",
    ],
    [
      "a path below its value",
      'let o = {text: "unused", value: {n: 2.0}}\nif o.value.n is integer { repeat READ {} }\nexit',
      "(askChoice o).n",
      "o.value.n",
      "warning-runtime-check",
    ],
    [
      "a list's element",
      'let opts = [{text: "unused", value: 2.0}]\nif opts[0].value is integer { let r: integer = READ }\nexit',
      "askChoice opts",
      "opts[0].value",
      "warning-runtime-check",
    ],
    [
      "a parameter",
      'function pick(o) {\nif o.value is integer { let r: integer = READ }\n}\npick({text: "unused", value: 2.0})\nexit',
      "askChoice o",
      "o.value",
      "warning-runtime-check",
    ],
    [
      "a test of the other key",
      "let o = {text: 2.0, value: 2.5}\nif o.text is integer { let r: integer = READ }\nexit",
      "askChoice o",
      "o.value",
      "compile-error",
    ],
  ];
  // its outcome first, then its diagnostics with their contexts and its checks without their targets
  const shape = (record: CompactRecord): string[] => [
    record.outcome,
    ...[
      ...record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context ?? "-"} @${d.site.offset}`,
      ),
      ...record.checks.map(
        (check) =>
          `${check.kind} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
      ),
    ].sort(),
  ];
  const differing: string[] = [];
  for (const [name, program, choice, keyed, outcome] of cases)
    for (const reversed of [false, true]) {
      const [got, expected] = [choice, keyed].map((read) => {
        const request = coreRequest([
          { path: "main.tease", source: program.replace("READ", read) },
        ]);
        assert.ok(request !== null, `${name}: its source parses and resolves`);
        const run = (): CompactRecord =>
          withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
        return shape(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      });
      if (JSON.stringify(got) !== JSON.stringify(expected) || got![0] !== outcome)
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got!.join("; ")}`);
    }
  assert.deepEqual(differing, []);
});

/**
 * #1027's B1 beyond a dict's lists (review round 5's R5-3, Astra's delta): a collection's `get`, a loop's visit and the
 * removals that give an element consume only the selected element's emptiness mark; a demanded descendant's passes
 * through, so its read keeps the check whose runtime failure (TSR018) it guards. Per collection (a list, a dict's
 * values), form and depth 1–3, the selected element holds a list that many levels deep whose innermost may be empty,
 * read that many `first`s down; both orders. A scalar element is the control.
 */
test("a selection consumes only its own emptiness mark below get, a loop's visit and a removal", () => {
  const nest = (inner: string, depth: number): string =>
    `${"[".repeat(depth - 1)}${inner}${"]".repeat(depth - 1)}`;
  const collections: readonly (readonly [string, (depth: number) => string])[] = [
    ["a list", (depth) => `let c = [${nest("[]", depth)}, ${nest("[1]", depth)}]`],
    [
      "a dict's values",
      (depth) =>
        `let d = dict{a: ${nest("[]", depth)}, b: ${nest("[1]", depth)}}\nlet c = d.values`,
    ],
  ];
  // per form, the selection with its default (the selected element's shape) and the read below it
  const forms: readonly (readonly [string, (fallback: string, read: string) => string])[] = [
    ["get", (fallback, read) => `let picked = c.get(0, default: ${fallback})\nrepeat ${read} {}`],
    ["a loop's visit", (_, read) => `for picked in c { repeat ${read} {} }`],
    ["removeFirst", (_, read) => `let picked = c.removeFirst()\nrepeat ${read} {}`],
    ["removeAt", (_, read) => `let picked = c.removeAt(0)\nrepeat ${read} {}`],
  ];
  const programs: [string, string, string[]][] = [];
  for (const [collection, made] of collections)
    for (const [form, select] of forms)
      for (const depth of [1, 2, 3]) {
        const read = `picked${".first".repeat(depth)}`;
        const source = `${made(depth)}\n${select(nest("[1]", depth), read)}\nexit`;
        const at = source.indexOf(`repeat ${read}`) + "repeat ".length;
        const expected = [
          "warning-runtime-check",
          `member-read warning-runtime-check @${at}`,
          `empty-check picked${".element".repeat(depth - 1)} [list] @${at}`,
        ];
        // a dict's values may hold none: its removal keeps its own check (C6)
        if (collection === "a dict's values" && form === "removeFirst")
          expected.push(
            `member-read warning-runtime-check @${source.indexOf("c.removeFirst")}`,
            `empty-check c [list] @${source.indexOf("c.removeFirst")}`,
          );
        programs.push([`${form} of ${collection} at depth ${depth}`, source, expected.sort()]);
      }
  for (const [form, select] of forms)
    programs.push([
      `${form} of a list's scalar`,
      `let c = [1, 2]\n${select("1", "picked")}\nexit`,
      ["valid"],
    ]);
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
 * TABLE r4.47 (#1026's follow-up): the set's records `cp9-cells/s4/followup/…` (set `716ac7091de2b95e`) in both orders,
 * as their outcome, diagnostics and checks with their sites: temporal fields and calendar parts by their declared
 * results (1), a selection's descendant emptiness (2), held choice options after a store below `value` or `text` (4),
 * clock reads by their declared kind with no boundary (5), and what fits a written place (6, §3.4, §10.5). Two records
 * are S6's and left out here: `temporal/year-string-fallback` differs only by C10's error at the fallback and
 * `temporal/year-present-wrong-store` only by A6's error at the store, both admission's; the set's test asserts them.
 */
test("the set's follow-up records give their records in both orders", () => {
  // per record its source, its outcome, diagnostics and checks, and the words it asserts (an unasserted word is null)
  type Expected = readonly [string, string, readonly string[], (readonly string[])?];
  const programs: readonly Expected[] = [
    [
      "temporal/weekday-repeat",
      'let d = toDate("2026-10-04")\nrepeat d.weekday {}\nexit\n',
      ["compile-error", "integer-use compile-error @36"],
    ],
    [
      "temporal/weekday-written-string",
      'let d = toDate("2026-10-04")\nlet name: string = d.weekday\nexit\n',
      ["valid"],
    ],
    [
      "temporal/year-written-integer",
      'let d = toDate("2026-10-04")\nlet n: integer = d.year\nexit\n',
      ["valid"],
    ],
    [
      "temporal/year-written-string",
      'let x: string = (askDate "When?").year\nexit\n',
      ["compile-error", "written-target compile-error @16"],
    ],
    [
      "temporal/year-fallback-written-union",
      'let x: integer | string = (askDate "When?").year otherwise "ok"\nexit\n',
      ["valid"],
    ],
    [
      "temporal/year-partial-presence-store",
      'let x = {p: (askDate "When?").year}\nif askBoolean "pick" { x = {q: 0} }\nx.p = 1\nexit\n',
      [
        "member-read warning-runtime-check @72",
        "null-check x [non-null] @72",
        "warning-runtime-check",
      ],
      ["member-read warning-runtime-check missing @72"],
    ],
    [
      "temporal/year-present-store",
      'let x = {p: (askDate "When?").year}\nx.p = 1\nexit\n',
      ["valid"],
    ],
    [
      "temporal/property-absent-in-every-source",
      "let x = {q: 0}\nx.p = 1\nexit\n",
      ["compile-error", "member-read compile-error @8"],
    ],
    [
      "temporal/calendar-parts-written-results",
      "let c = 2 calendar days\nlet monthCount: integer = c.months\nlet dayCount: integer = c.days\nlet offset: duration = c.exactOffset\nexit\n",
      ["valid"],
    ],
    [
      "temporal/calendar-exact-offset-repeat",
      "let c = 2 calendar days\nrepeat c.exactOffset {}\nexit\n",
      ["compile-error", "integer-use compile-error @31"],
    ],
    [
      "temporal/exact-duration-has-no-calendar-parts",
      "let d = 2 days\nsay d.days\nexit\n",
      ["compile-error", "member-read compile-error @19"],
    ],
    [
      "temporal/datetime-date-and-time-fields",
      'let dt = toDateTime("2026-10-04T18:00")\nlet y: integer = dt.year\nlet h: integer = dt.hour\nexit\n',
      ["valid"],
    ],
    [
      "temporal/time-date-field-inapplicable",
      'let t = toTime("18:00")\nsay t.year\nexit\n',
      ["compile-error", "member-read compile-error @28"],
    ],
    [
      "temporal/absolute-local-field-inapplicable",
      'let a = toAbsoluteDateTime("2026-10-04T12:30:00Z")\nsay a.year\nexit\n',
      ["compile-error", "member-read compile-error @55"],
    ],
    [
      "temporal/absolute-converted-local-field",
      'let a = toAbsoluteDateTime("2026-10-04T12:30:00Z")\nlet n: integer = a.toDateTime().year\nexit\n',
      ["valid"],
    ],
    [
      "emptiness/values-first",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.first {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "empty-check d.values.first.values [list] @46",
        "member-read warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/keys-first",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.keys.first {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "empty-check d.values.first.keys [list] @46",
        "integer-check d.values.first.keys.first [integer] @46",
        "integer-use warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/get-outer",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.get(0, default: dict{v: 1}).values.first {}\nexit\n",
      [
        "empty-check d.values.get(0, default: dict{v: 1}).values [list] @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/get-inner",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.get(0, default: 0) {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/iterate-values-direct",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nfor n in d.values.first.values { repeat n {} }\nexit\n",
      [
        "empty-check d.values [list] @48",
        "member-read warning-runtime-check @48",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/iterate-inner-then-select",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nfor inner in d.values { repeat inner.values.first {} }\nexit\n",
      [
        "empty-check inner.values [list] @70",
        "member-read warning-runtime-check @70",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/removeFirst-outer",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.removeFirst().values.first {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "empty-check d.values.removeFirst().values [list] @46",
        "member-read warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/removeAt-outer",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.removeAt(0).values.first {}\nexit\n",
      [
        "empty-check d.values.removeAt(0).values [list] @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/bound-inner",
      "let d = dict{a: dict{v: 1}, b: dict{v: 2}}\nlet inner = d.values.first\nlet count: integer = inner.values.first\nrepeat count {}\nexit\n",
      [
        "empty-check d.values [list] @55",
        "empty-check inner.values [list] @91",
        "member-read warning-runtime-check @55",
        "member-read warning-runtime-check @91",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/cleared-bound-inner",
      "let d = dict{a: dict{v: 1}, b: dict{v: 2}}\nlet inner = d.values.first\ninner.clear()\nlet count: integer = inner.values.first\nrepeat count {}\nexit\n",
      [
        "empty-check d.values [list] @55",
        "empty-check inner.values [list] @105",
        "member-read warning-runtime-check @105",
        "member-read warning-runtime-check @55",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/list-literal-open-descendant",
      "let xs = [[], [1]]\nrepeat xs.first.first {}\nexit\n",
      [
        "empty-check xs.element [list] @26",
        "member-read warning-runtime-check @26",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/list-literal-held-control",
      "let xs = [[2], [1]]\nrepeat xs.first.first {}\nexit\n",
      ["valid"],
    ],
    [
      "emptiness/named-values",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet projected = d.values\nrepeat projected.first.values.first {}\nexit\n",
      [
        "empty-check projected [list] @71",
        "empty-check projected.first.values [list] @71",
        "member-read warning-runtime-check @71",
        "member-read warning-runtime-check @71",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/values-contract-route",
      "let d = dict{a: dict{}, b: dict{v: 1}}\ngoto inspect\nlabel inspect\nrepeat d.values.first.values.first {}\nexit\n",
      [
        "empty-check d.values [list] @73",
        "empty-check d.values.first.values [list] @73",
        "member-read warning-runtime-check @73",
        "member-read warning-runtime-check @73",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/key-contract-count",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet key = d.values.first.keys.first\ngoto inspect\nlabel inspect\nrepeat key {}\nexit\n",
      [
        "compile-error",
        "empty-check d.values [list] @49",
        "empty-check d.values.first.keys [list] @49",
        "integer-use compile-error @109",
        "member-read warning-runtime-check @49",
        "member-read warning-runtime-check @49",
      ],
    ],
    [
      "choice/value-base",
      'let o = {text: "A", value: 1}\nrepeat askChoice o {}\nexit\n',
      ["valid"],
    ],
    [
      "choice/value-store",
      'let o = {text: "A", value: 1}\no.value = 2\nrepeat askChoice o {}\nexit\n',
      ["valid"],
    ],
    ["choice/text-base", "let o = {text: 0}\nrepeat askChoice o {}\nexit\n", ["valid"]],
    [
      "choice/text-store",
      "let o = {text: 0}\no.text = 3\nrepeat askChoice o {}\nexit\n",
      ["valid"],
    ],
    [
      "choice/display-store",
      'let o = {text: "A", value: 1}\no.text = "B"\nrepeat askChoice o {}\nexit\n',
      ["valid"],
    ],
    [
      "clock/weekday-repeat",
      "let d = getDate()\nrepeat d.weekday {}\nexit\n",
      ["compile-error", "integer-use compile-error @25"],
    ],
    [
      "clock/weekday-written-string",
      "let d = getDate()\nlet weekdayName: string = d.weekday\nexit\n",
      ["valid"],
    ],
    ["clock/date-written", "let t: date = getDate()\nexit\n", ["valid"]],
    ["clock/year-written-integer", "let n: integer = getDate().year\nexit\n", ["valid"]],
    ["clock/time-written", "let t: time = getTime()\nexit\n", ["valid"]],
    [
      "clock/time-written-integer",
      "let t: integer = getTime()\nexit\n",
      ["compile-error", "written-target compile-error @17"],
    ],
    [
      "fit/literal-mixed-written",
      "let r: integer = [2, 2.5][0]\nexit\n",
      [
        "copy-type r [integer] @17",
        "warning-runtime-check",
        "written-target warning-runtime-check @17",
      ],
      ["written-target warning-runtime-check member @17"],
    ],
    [
      "fit/literal-number-written",
      "let r: integer = [2.5, 3.5][0]\nexit\n",
      ["compile-error", "written-target compile-error @17"],
    ],
    [
      "fit/external-mixed-written",
      "let r: integer = [hostValue, 2.5][0]\nexit\n",
      [
        "copy-type r [integer] @17",
        "copy-type r [integer] @18",
        "copy-type r [integer] boundary @18",
        "warning-runtime-check",
        "written-target warning-runtime-check @17",
        "written-target warning-runtime-check @18",
      ],
      [
        "written-target warning-runtime-check member @17",
        "written-target warning-runtime-check unknown @18",
      ],
    ],
    [
      "fit/widened-place-written",
      "let xs = [1]\nxs.add(1.5)\nlet r: integer = xs.first\nexit\n",
      [
        "copy-type r [integer] @42",
        "warning-runtime-check",
        "written-target warning-runtime-check @42",
      ],
      ["written-target warning-runtime-check member @42"],
    ],
    [
      "fit/scalar-overwrite-written",
      "let n = 1\nn = 2.5\nlet r: integer = n\nexit\n",
      ["compile-error", "written-target compile-error @35"],
    ],
    [
      "fit/literal-mixed-repeat",
      "repeat [2, 2.5][0] {}\nexit\n",
      [
        "integer-check [2, 2.5][0] [integer] @7",
        "integer-use warning-runtime-check @7",
        "warning-runtime-check",
      ],
      ["integer-use warning-runtime-check member @7"],
    ],
    [
      "fit/literal-number-repeat",
      "repeat [2.5, 3.5][0] {}\nexit\n",
      ["compile-error", "integer-use compile-error @7"],
    ],
    ["fit/literal-integer-written", "let r: integer = [2, 3][0]\nexit\n", ["valid"]],
  ];
  const differing: string[] = [];
  for (const [name, source, expected, words = []] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary(record);
      const worded = record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context} @${d.site.offset}`,
      );
      if (
        JSON.stringify(got) !== JSON.stringify(expected) ||
        words.some((word) => !worded.includes(word))
      )
        differing.push(`${name}${reversed ? " reversed" : ""}: ${[...got, ...worded].join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * §3.4, X3 (the lead's ruling on #1026's follow-up): a choice's button value, selected by key past the element step over
 * its options, carries the word `member` as its literal analogue does, written or held, and with options of both keys;
 * a whole option object, no element step, is the control. Kinds, warnings and checks are the analogue's; both orders.
 */
test("a choice over a list of options takes its literal analogue's word", () => {
  const pairs: readonly (readonly [string, string, string])[] = [
    [
      "a written list",
      'let result: integer = askChoice [{text: "A", value: 2}, {text: "B", value: 2.5}]\nexit',
      'let result: integer = [{text: "A", value: 2}, {text: "B", value: 2.5}][0].value\nexit',
    ],
    [
      "a held list",
      'let opts = [{text: "A", value: 2}, {text: "B", value: 2.5}]\nlet result: integer = askChoice opts\nexit',
      'let opts = [{text: "A", value: 2}, {text: "B", value: 2.5}]\nlet result: integer = opts[0].value\nexit',
    ],
    [
      "a whole option object",
      'let result: integer = askChoice {text: "A", value: 2.5}\nexit',
      'let result: integer = {text: "A", value: 2.5}.value\nexit',
    ],
  ];
  // its outcome, then its diagnostics with their words and its checks
  const record = (source: string, reversed: boolean): string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const run = (): CompactRecord =>
      withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
    const got = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    return [
      got.outcome,
      ...got.diagnostics.map((d) => `${d.kind} ${d.class} ${d.context ?? "-"} @${d.site.offset}`),
      ...got.checks.map(
        (check) =>
          `${check.kind} ${check.target} [${check.against.join(", ")}] @${check.site.offset}`,
      ),
    ];
  };
  const differing: string[] = [];
  for (const reversed of [false, true]) {
    for (const [name, choice, analogue] of pairs)
      if (JSON.stringify(record(choice, reversed)) !== JSON.stringify(record(analogue, reversed)))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record(choice, reversed).join("; ")}`,
        );
    // options of both keys have no single analogue: the same word, by the same element step (their texts of one
    // family, ADR 0021 1.4)
    const mixed = record(
      "let result: integer = askChoice [{text: 1, value: 2}, {text: 2.5}]\nexit",
      reversed,
    );
    if (!mixed.includes("written-target warning-runtime-check member @22"))
      differing.push(`options of both keys${reversed ? " reversed" : ""}: ${mixed.join("; ")}`);
  }
  assert.deepEqual(differing, []);
  assert.ok(
    record(pairs[0]![1], false).includes("written-target warning-runtime-check member @22"),
    "the written list's word is member",
  );
});

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
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "warning-runtime-check",
      ],
    ],
    [
      "an empty range's removal",
      "let xs = (3..1).toList()\nrepeat xs.removeFirst() {}\nexit",
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
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
 * TABLE r4.47 (1), F15, §3.4 (Astra's D1 on #1028): a method without a category answers the runtime's opaque `unknown`
 * on a receiver of a known kind, and on what the core cannot know keeps that value's own reasons, so a chain of such
 * methods stays opaque (the word `unmodelled`), with no external data and no boundary; a modelled method in the chain
 * gives its declared result. Both orders.
 */
test("a chain of methods without a category stays opaque", () => {
  const cases: readonly (readonly [string, string, readonly string[], readonly string[]])[] = [
    [
      "two methods without a category",
      'let n: integer = "  alpha  ".trimStart().trimEnd()\nexit',
      [
        "copy-type n [integer] @17",
        'null-check "  alpha  ".trimStart() [non-null] @17',
        "warning-runtime-check",
      ],
      ["written-target warning-runtime-check unmodelled @17"],
    ],
    [
      "a modelled method, then one without a category",
      'let n: integer = "  alpha  ".uppercase().trimStart()\nexit',
      ["copy-type n [integer] @17", "warning-runtime-check"],
      ["written-target warning-runtime-check unmodelled @17"],
    ],
    [
      "one without a category, then a modelled method",
      'let n: integer = "  alpha  ".trimStart().uppercase()\nexit',
      ["compile-error", 'null-check "  alpha  ".trimStart() [non-null] @17'],
      ["written-target compile-error null @17"],
    ],
    [
      "a receiver of a known kind or an opaque answer",
      'let s = "a"\nlet t = s\nif askBoolean "f" { t = s.trimStart() }\nlet n: integer = t.trimEnd()\nexit',
      // (the opaque answer stored into `t`, decided a text by its start value, owes its check there: A5, C1)
      [
        "copy-type n [integer] @79",
        "copy-type t [string] @46",
        "null-check t [non-null] @79",
        "warning-runtime-check",
      ],
      ["written-target warning-runtime-check unmodelled @79"],
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

/**
 * Admission's rules over stores, literals and fallbacks that the set leaves untested (review r1 of M4 S6), each in both
 * orders with its record, sites written as the text they start at: a declaration's start value decides before an
 * earlier store in a function (ADR 0021 1.6); a literal's element that copies a written binding keeps its written type
 * (A4, ADR 0021 1.3); a value none of whose kinds fits a field's, an element's or an entry's decided type errs (C1, ADR
 * 0021 1.7); a definite misfit is rejected, so a later use sees the decided type (A6), a null into a copy of a written
 * binding and a literal's element of another type included; C10's unknown fallback may fit the receiving written union,
 * and each offending kind of a fallback owes its own check; a fallback whose contract fits asks nothing (§3.3). Review
 * r2: a copied written type checks a literal's other elements by their own kinds (a whole number fits a written
 * integer, a fraction does not); a store none of whose possible kinds fits is rejected too; literals are checked at
 * any depth; a concrete misfit of a fallback is checked against the receiving union too; the lazy defaults of
 * `fileFromBase64`, `decryptText` and `decryptFile` follow C10 (ADR 0021 7.2). Review r4: a copy of a written type is
 * decided at every path of that type, read or not, and admits `null` only where its type, an earlier store or a null
 * element of the literal it stands in does.
 */
test("admission decides from the start value, keeps written copies, rejects every definite misfit, and checks fallbacks per kind", () => {
  const f =
    'function f(flag: boolean): string | boolean {\n  if flag { return "bad" }\n  return false\n}\n';
  const nest = (depth: number, value: string): string =>
    `${"[".repeat(depth)}${value}${"]".repeat(depth)}`;
  const programs: readonly (readonly [
    string,
    string,
    (at: (text: string) => number) => string[],
  ])[] = [
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
      "a written integer copied beside a fraction",
      "let n: integer = 1\nlet xs = [n, 2.5]\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("2.5")}`],
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
    [
      "a deep literal's element of another type",
      `let xs = [${nest(300, "1")}, ${nest(300, '"bad"')}]\nexit`,
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    [
      "a deep literal's element copying a written union",
      `let typed: integer | string = 1\nlet xs = [${nest(300, "typed")}, ${nest(300, '"ok"')}]\nexit`,
      () => ["valid"],
    ],
    [
      "a default's other kind beside the receiving union",
      'function alternate(flag: boolean): string | integer {\n  if flag { return "allowed" }\n  return 2\n}\nlet r: boolean | string = toBoolean("bad", default: alternate(true))\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("toBoolean")}`,
        `written-target warning-runtime-check @${at("alternate(true)")}`,
        `copy-type r [boolean, string] @${at("toBoolean")}`,
        `copy-type alternate.result [boolean, string] @${at("alternate(true)")}`,
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
      "a set whose first element copies a written integer, a later one possibly a fraction",
      "let typed: integer = 1\nlet xs = set[typed, [1, 2.5][1]]\nexit",
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("set[")}`,
        `copy-type xs.element [integer] @${at("set[")}`,
      ],
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
      const got = summary(record);
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});
