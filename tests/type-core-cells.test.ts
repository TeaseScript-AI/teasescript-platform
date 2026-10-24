import assert from "node:assert/strict";
import test from "node:test";

import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture, type FixtureRecord } from "./helpers/type-core-fixture.js";
import { recordDifferences, type CompactRecord } from "./helpers/type-core-records.js";

/**
 * The coarse core against its independent expectation set (checkpoint 9, TABLE §10.2, §10.5; the port plan's §3.1):
 * per record the outcome, the diagnostics as (kind, class, site, asserted context) and the checks as (kind, target,
 * required kinds, boundary, site) multisets. The step that builds the core's analysis (M4 S4) completes the cells
 * below; a record is asserted when every cell it tests is among them. Admission (A2–A9), the boundary checks of
 * external data (C9), fallbacks and defaults (C10), saves (C8), loads (F18, F19), the adapters' cell (C13), the
 * budget's fallback (B1), stage 3b (§13), and the cells and work families that measure admission (F28, S5, S6, P1, H8;
 * W3, W5, W15, W26) join with their steps.
 */
const COMPLETED: ReadonlySet<string> = new Set([
  // the transfers (§2)
  ...["F1", "F1a", "F2", "F3", "F4", "F5", "F5a", "F6", "F7a", "F7b", "F7c", "F8", "F9", "F10"],
  ...["F11", "F12", "F13", "F14", "F16", "F17a", "F17b", "F19a", "F20", "F21", "F22", "F23", "F24"],
  ...["F25", "F26a", "F26b", "F27a", "F27b", "F27c"],
  // the reads (§3): the exact path, the contract with its guard mark, the quiet path, the context words
  ...["X1", "X2", "X3", "X4", "X5", "X6", "X7", "R", "§3.2", "§3.3", "§3.4"],
  // the consumers (§4), C1 and C7 against written types
  ...["C1", "C2", "C3", "C4", "C5", "C5a", "C5b", "C5c", "C6", "C7", "C11", "C12"],
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
    "the boundary check of an `askChoice` result stored into a written place (C9)",
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
];

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
