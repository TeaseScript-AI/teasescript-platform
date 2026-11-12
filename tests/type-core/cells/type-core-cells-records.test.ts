// The coarse core against its expectation set: each cell's record, the stage 3b records held by name, the comparison
// itself, and the rule-function, follow-up and witness records.

import assert from "node:assert/strict";
import test from "node:test";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  HELD_S10_RECORDS,
  heldBack,
  type FixtureRecord,
} from "../../helpers/type-core/type-core-fixture.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  BOUNDED_ADMISSION_WITNESSES,
  CARRIER_WITNESSES,
  HOT_CANDIDATE_WITNESSES,
} from "../../helpers/type-core/type-core-witnesses.js";
import {
  recordDifferences,
  recordOf,
  type CompactRecord,
} from "../../helpers/type-core-records.js";
import { records, summary } from "../../helpers/type-core/type-core-cells-setup.js";

const asserted = records.filter((record) => heldBack(record) === null);

function analysed(record: FixtureRecord): CompactRecord {
  const request = coreRequest(record.files);
  assert.ok(request !== null, `${record.name}: its files parse and resolve`);
  return compactAnalysis(request);
}

test("the core gives the expected record for every record of the cells it completes", (t) => {
  // the classes held back at the set's revision `8992e5c3…` (r481), so a refresh that moves records between them shows
  const held = new Map<string, number>();
  for (const record of records) {
    const reason = heldBack(record);
    if (reason !== null) held.set(reason, (held.get(reason) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(held), {
    "the adapters' records (S9b)": 3,
    "the route rule's corridor across locations (#1938)": 13,
    "a copy whose source's null arrives through an entry: r4-451's give-up, a check stands (#2497)": 2,
    "a method no member of a receiver's union supports (#2258)": 1,
    "a written optional load's definite number error (#1173, listed in #1938)": 1,
    "a static warning of S9b's otherwise (#1737)": 7,
    "U4's consumer remainder (#2025)": 3,
    "a fixture expectation awaiting its ruling (#2025)": 3,
    "the numeric crossover (#1173, #2025)": 1,
    "operator site awaiting set correction": 1,
    "S9b's F18 copy of a written type as the receiving context": 18,
    "fromJson with files: true outside the slice, and C13's text operand": 2,
    "a known-value error the record lacks (decision 3 on #1072)": 1,
    "C13's warning of a choice value from outside the script the record lacks (#1437)": 3,
  });
  assert.equal(asserted.length, 1_954);
  // (records of one exact input, their files in order, share its analysis; each is compared with its own record)
  const analyses = new Map<string, CompactRecord>();
  const failures = asserted.flatMap((record) => {
    const input = JSON.stringify(record.files);
    const actual = analyses.get(input) ?? analysed(record);
    analyses.set(input, actual);
    const differences = recordDifferences(record.expected, actual);
    return differences.length === 0 ? [] : [`${record.name}: ${differences.join("; ")}`];
  });
  // (D2: every site compares whole, a member read's and an operator's included)
  t.diagnostic(`${asserted.length} records compared by whole sites`);
  assert.deepEqual(failures, []);
});

/**
 * The completeness check of stage 3b's closed hold list (#1073 U6): each held name is a fixture record with an `N` cell,
 * held by its own reason, whose analysis in every mode gives exactly the differences its hold names, and whose
 * differences have its reason's signature. A hold whose cause is repaired, changed or misnamed fails; every other record
 * with an `N` cell is asserted, by the test above.
 */
test("each stage 3b record held by name exists, has an N cell, and differs in every mode exactly as its cause does (#1073 U6)", () => {
  // (each hold's reason found independently of the map that names it, one cause per hold: a record a reviewer or the
  // owner assigned by name, else the one class its differences fall in)
  const assigned = new Map<string, string>([
    ["cp9-cells/r42/guard/holding-path", "U4's consumer remainder (#2025)"],
    ["cp9-cells/r46/guard/branch-holding-path/guarded", "U4's consumer remainder (#2025)"],
    ["cp9-cells/3b/review-early/s2-same-location-compound-loop", "U4's consumer remainder (#2025)"],
    [
      "cp9-cells/r46/guard/arithmetic-unary/guarded",
      "a fixture expectation awaiting its ruling (#2025)",
    ],
    [
      "cp9-cells/3b/invalidation/clear/changed",
      "a fixture expectation awaiting its ruling (#2025)",
    ],
    ["cp9-cells/3b/invalidation/sort/changed", "a fixture expectation awaiting its ruling (#2025)"],
    ["cp9-cells/r49/sharing/record-aliases/guarded", "the numeric crossover (#1173, #2025)"],
    [
      "cp9-cells/r46/m3/astra-m3/routes/method-null-kind",
      "a method no member of a receiver's union supports (#2258)",
    ],
    [
      "cp9-cells/3b/review-late/copies/back-edge",
      "a copy whose source's null arrives through an entry: r4-451's give-up, a check stands (#2497)",
    ],
    [
      "cp9-cells/3b/review-late/copies/entered-label",
      "a copy whose source's null arrives through an entry: r4-451's give-up, a check stands (#2497)",
    ],
  ]);
  const causeOf = (name: string, lines: readonly string[]): string => {
    const named = assigned.get(name);
    if (named !== undefined) return named;
    const required = lines.some((line) => line.startsWith("missing required check "));
    if (required && lines.some((line) => line.startsWith("missing check integer-check ")))
      return "a written optional load's definite number error (#1173, listed in #1938)";
    if (required) return "the route rule's corridor across locations (#1938)";
    if (
      lines.length > 0 &&
      lines.every(
        (line) =>
          line.startsWith("extra diagnostic static warning ") ||
          line === "outcome valid, got warning",
      )
    )
      return "a static warning of S9b's otherwise (#1737)";
    return "no known cause";
  };
  // (the differences as a multiset: the comparison compares entries regardless of their order)
  const sorted = (lines: readonly string[]): string => JSON.stringify([...lines].sort());
  const byName = new Map(records.map((record) => [record.name, record]));
  const wrong: string[] = [];
  for (const [name, hold] of HELD_S10_RECORDS) {
    const record = byName.get(name);
    if (record === undefined) {
      wrong.push(`${name}: no such record`);
      continue;
    }
    if (!record.cells.some((cell) => /^N\d/.test(cell))) wrong.push(`${name}: no N cell`);
    if (heldBack(record) !== hold.reason) wrong.push(`${name}: held by another reason`);
    const cause = causeOf(name, hold.differences);
    if (cause !== hold.reason) wrong.push(`${name}: held as ${hold.reason}, its cause is ${cause}`);
    const request = coreRequest(record.files);
    assert.ok(request !== null, name);
    for (const mode of MODES) {
      const differences = recordDifferences(
        record.expected,
        inMode(mode, () => compactAnalysis(request)),
      );
      if (sorted(differences) !== sorted(hold.differences))
        wrong.push(
          `${name} in ${JSON.stringify(mode)}: ${JSON.stringify(differences)}, its hold names ${JSON.stringify(hold.differences)}`,
        );
    }
  }
  assert.deepEqual(wrong, []);
  assert.equal(HELD_S10_RECORDS.size, 31);
});

test("the record comparison the asserted records rest on reports each part: outcome, sites, context and N10's payload (#1073 U6)", () => {
  // (a record with a required-check payload and an asserted context, its own analysis compared with its record changed
  // in one part at a time: a release by the comparison is only as complete as these parts)
  const record = records.find((entry) => entry.name === "cp9-cells/F15/unknown-member");
  assert.ok(record !== undefined && heldBack(record) === null);
  const actual = analysed(record);
  assert.deepEqual(recordDifferences(record.expected, actual), []);
  const first = record.expected.diagnostics.find(
    (d) => d.requiredCheck !== undefined && d.requiredCheck !== null,
  );
  const contexted = record.expected.diagnostics.find((d) => d.context !== null);
  const payload = first?.requiredCheck;
  assert.ok(payload && contexted);
  const changed = (diagnostics: typeof record.expected.diagnostics) => ({
    ...record.expected,
    diagnostics,
  });
  const parts: Readonly<Record<string, CompactRecord>> = {
    outcome: {
      ...record.expected,
      outcome: record.expected.outcome === "valid" ? "warning" : "valid",
    },
    site: changed(
      record.expected.diagnostics.map((d) =>
        d === first ? { ...d, site: { ...d.site, offset: d.site.offset + 1 } } : d,
      ),
    ),
    context: changed(
      record.expected.diagnostics.map((d) =>
        d === contexted ? { ...d, context: d.context === "branch" ? "loop" : "branch" } : d,
      ),
    ),
    payload: changed(
      record.expected.diagnostics.map((d) =>
        d === first ? { ...d, requiredCheck: { ...payload, missingTests: ["otherwise"] } } : d,
      ),
    ),
  };
  for (const [part, expected] of Object.entries(parts))
    assert.notDeepEqual(recordDifferences(expected, actual), [], part);
});

/**
 * The rule function as the set pins it (`cp9-cells/s6/rule-function/…`): its ten records, each compared
 * whole in both orders, but those `heldBack` names.
 */
test("the core gives the expected record for every rule-function record, in both orders", () => {
  const ruleFunction = records.filter((record) =>
    record.name.startsWith("cp9-cells/s6/rule-function/"),
  );
  assert.equal(ruleFunction.length, 10);
  for (const record of ruleFunction) {
    if (heldBack(record) !== null) continue;
    const request = coreRequest(record.files);
    assert.ok(request !== null, `${record.name}: its files parse and resolve`);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(record.expected, compactAnalysis(request)), [], record.name);
    assert.deepEqual(recordDifferences(record.expected, reversed), [], `${record.name} reversed`);
  }
});

test("the comparison fails a record whose second boundary check is replaced by a copy of its first", () => {
  // the port plan's negative control: one ingress's boundary check lost beside a surviving one must show
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
    // (#1072, V30 §18: a date's year is never null, so its fallback is never used)
    ["static warning @49", "warning"],
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
  ["choice/value-base", 'let o = {text: "A", value: 1}\nrepeat askChoice o {}\nexit\n', ["valid"]],
  [
    "choice/value-store",
    'let o = {text: "A", value: 1}\no.value = 2\nrepeat askChoice o {}\nexit\n',
    ["valid"],
  ],
  ["choice/text-base", "let o = {text: 0}\nrepeat askChoice o {}\nexit\n", ["valid"]],
  ["choice/text-store", "let o = {text: 0}\no.text = 3\nrepeat askChoice o {}\nexit\n", ["valid"]],
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

/**
 * #1026's follow-up: the set's records `cp9-cells/s4/followup/…` (set `716ac7091de2b95e`) in both orders,
 * as their outcome, diagnostics and checks with their sites: temporal fields and calendar parts by their declared
 * results (1), a selection's descendant emptiness (2), held choice options after a store below `value` or `text` (4),
 * clock reads by their declared kind with no boundary (5), and what fits a written place (6). Two records
 * are S6's and left out here: `temporal/year-string-fallback` differs only by C10's error at the fallback and
 * `temporal/year-present-wrong-store` only by A6's error at the store, both admission's; the set's test asserts them.
 */
test("the set's follow-up records give their records in both orders", () => {
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
 * S6-CARRIERS's witnesses, as exact records in both orders:
 * - the first design review's across-function copy (its B2): the function's copy reads its source across X4, the
 *   integer and unknown contract, and owes its own C1; the exact top-level copy owes nothing;
 * - the second design review's reversed copy (its B1): the function's copy comes first, yet the exact top-level copy
 *   decides `box.f`, so the text after it is the error and the function's copy is `later`;
 * - the round-4 span sources (round 4's D1): C9 at the host value's own span through a concatenation, an `otherwise`
 *   (its end the host value's) and a choice, C1 beside it where a later store decides;
 * - the external reviewer's projected copies (R5-F1): repeated, once bound (`stable`, the same records) and with a store
 *   below the copied path between them, whose later copies carry it at `f0` and whose earlier ones are `later`;
 * - Astra's M1 witnesses: a conditional store below the copied path before and between the copies;
 * - Astra's F3 shapes: two choice reads of `root.f` answer at their own nodes, the one after an effectful call by the
 *   call's word; an argument inside `root != null and use(root)` carries the operand's guard into its parameter;
 * - two reads of one key in one literal with a call storing to it between them are two key reads: the
 *   later one's element carries the call's kind, as the same reads in three statements do; so are two with a call
 *   between them that registers a handler storing the key (X7, H9), whose later read takes the contract, as both do
 *   after the registration.
 */
test("the carrier design's witnesses give their exact records, in both orders (S6-CARRIERS)", () => {
  const witnesses = CARRIER_WITNESSES;

  for (const [name, source, text] of witnesses) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});

/**
 * #1188's witnesses, as exact records in both orders (its design note):
 * - rule (a)'s three forms: a rejected value is ignored, so a list whose elements still
 *   disagree after it gets an error of its own (Astra's `rule-a-list`); nothing warns about or checks a rejected value
 *   (`other-written-record`, where the core warned about storing the rejected element into `result` against its type);
 *   and a later store whose live value does not fit the receiving place's decided type errs, against the surviving type
 *   (`new-assignment-error`) or where a rejected list's surviving value meets a place decided otherwise
 *   (`reversed-assignment`);
 * - a whole cycle split by its two rejected copies keeps each member's own contents, so the outer list's error stays
 *   (Astra's recheck r3 F1); a fed cycle whose feeder's store is rejected takes none of the rejected value (her N1);
 * - a merge place deciding by its first copy, beside its second copy in a literal that decides by that copy: the
 *   literal's check, as the meeting is hot only where the literal decides (its design note's (d));
 * - a live nested union, whose outer list now errs where its elements disagree, and whose `grid` errs at its later
 *   element, whose written union holds no boolean, as the current checker's does (#1906; it was a runtime check);
 * - a whole-copy ring whose members decide two properties differently, two of them in a list, with a plain or a written
 *   union decider: the list's rejection in the first pass leaves the ring's last copy a possibility, a warning and its
 *   check (Astra's review B1 of #1311: the ring's shared trie still owes its meetings to the list);
 * - two literals each holding its own `load` or `fromJson` default at the same position beside one shared record, in
 *   lists, sets, dicts and a nested position, in either order of the literals: each literal's contributor is its own
 *   below that position, so the second literal's string and integer still disagree whatever the first holds (Astra's
 *   PR review B1).
 */
test("#1188's witnesses give their exact records, in both orders (rule (a), cycles, containment, contributors)", () => {
  for (const [name, source, text] of HOT_CANDIDATE_WITNESSES) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});

/**
 * The bounded admission repairs' witnesses (#1078, #1194), as exact records in both orders:
 * - A8's conflict paths per class of the elements' contracts (`Contract.classOf`): a narrowed selection, which has no
 *   class, beside an object of another kind, its identity kept apart from every class (Codex r1's B1: a carrier's
 *   identity read like the object's class id, and the error was lost); k method results or conversions of
 *   one class beside an object, the object last (its own error, and the read of the integer element's property) or
 *   first (an error at each result, each its own element); the object between two results of one class; two literals
 *   of one class landing in one place, each with its own error; conversions beside written text, and lists of one class
 *   beside a list of the object, in either order; results beside an object holding host data; objects of one class
 *   each holding the object beside one that differs below it, last or first (an error at each that differs from the
 *   earliest, where one class for every element would lose them);
 * - a written type's element levels, read once per type (#1194): copies of a written type through an optional level,
 *   with a union or an optional element, and of an open element type beside a deep written one, each deep misfit an
 *   error and each fitting store accepted;
 * - the sources a read takes from the copies joined into a place, by the full path of their own stores (#1078): k
 *   copies of one preset, each storing its own property, each read's error at its own copy's store; copies storing one
 *   property and the object above it (the object's other type errs at its store, where it meets the copy: A2,
 *   #1249); a chain of preset copies joined again.
 */
test("the bounded admission repairs' witnesses give their exact records, in both orders (#1078, #1194)", () => {
  for (const [name, source, text] of BOUNDED_ADMISSION_WITNESSES) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});
