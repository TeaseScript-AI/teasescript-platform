import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { withRegexWorkLimit } from "../src/regex-engine.js";
import { run } from "../src/runtime/engine.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import { KNOWN_VALUE_WORK, KnownValues } from "../src/static-evaluation.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// The compiler knows a value that every run gives an expression (`KnownValues`): its value checks then fail where the
// run would, with the runtime's text (IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").

const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

/** The code, place, and message of each diagnostic of `source`. */
function diagnostics(source: string): string[] {
  return compileSource(`${source}\nexit`).diagnostics.map(
    ({ code, message, span }) =>
      `${code} ${span.start.line + 1}:${span.start.column + 1} ${message}`,
  );
}

/** The code and message of the runtime failure of `source`, which compiles. */
function failure(source: string): readonly [string, string] | null {
  const fault = runValidSource(`${source}\nexit`).snapshot.failure;
  return fault === null ? null : [fault.code, fault.message];
}

test("a known value is the value the run gets", () => {
  for (const expression of [
    // Text +, and text with known interpolated parts.
    '"ab" + "cd"',
    '"a${1 + 1}b${2 s}"',
    // `otherwise` gives its left side unless that is null.
    'null otherwise "x"',
    "[1, 2].indexOf(2) otherwise -1",
    // Lists, sets, and dicts with known elements.
    "[1, 2.5, -3]",
    "set[1, 1, 2]",
    'dict{a: 1, "b c": 2}',
    // Conversions, with a default where they give it.
    "toString(1.5 s)",
    'toNumber(" 12 ")',
    'toInteger("-7.9")',
    'toBoolean("true")',
    'toDate("2026-10-04")',
    'toRegex("a+", default: null)',
    'toNumber("x" + "y", default: 5)',
    'toJson(["a", null])',
    'toBase64("hi")',
    // Numeric and angle functions.
    "abs(-3)",
    "pow(2, 10)",
    "round(2.5)",
    "mod(-7, 3)",
    "atan2(1, 1)",
    // List functions.
    "sum([1, 2.5])",
    "median([3, 1, 2])",
    "stddev([1, 2, 3])",
    "percentile([1, 2, 3], 50)",
    "min(3, 1, 2)",
    "max([1 s, 2 s])",
    // Methods of text, lists, sets, and dates that only read them.
    '"  a b ".trim()',
    '"abc".substring(1, 2)',
    '"a,b".split(",")',
    '"aXbx".replace(/x/i, "-")',
    '"abc".capture(/(b)/)',
    '"ab".repeat(3)',
    '"x".padStart(3, "-")',
    "[3, 1, 2].take(2)",
    "[1, 2, 1].count(1)",
    "[1, 2].indexOf(5)",
    "[1, 2].get(5, default: 0)",
    "[1, 2, 2].toSet()",
    "set[1, 2].union([3])",
    '[1, 2].join("-")',
    'toDate("2026-10-04").toISO()',
  ]) {
    const source = `inspect(${expression})\nexit`;
    const compiled = compileSource(source, { builtins: ["inspect"] });
    assert.deepEqual(compiled.diagnostics, [], source);
    let given: SerializableRuntimeValue | undefined;
    run(compiled.plan!, createImmediatePacingRuntimeSnapshot(compiled.plan!), {
      builtins: {
        inspect: (call) => {
          given = call.positional[0];
          return null;
        },
      },
    });
    const statement = parse(source).program.statements[0]!;
    assert.ok(
      statement.kind === "expressionStatement" && statement.expression.kind === "callExpression",
    );
    const known = new KnownValues().known(statement.expression.arguments[0]!.value);
    assert.ok(known !== undefined, expression);
    assert.ok(given !== undefined && serializableEquals(known, given), expression);
  }
});

test("a value check sees each known form and fails where the run would, with the runtime's text", () => {
  // Each source, the place and text of its one compile error, and the same source with a value that only the run knows,
  // which fails there with the runtime's code and the same text, or that text and what to do instead.
  for (const [source, place, message, hidden, code] of [
    // Text +, a method of text, `otherwise`, and a variable or global that keeps its first value.
    [
      'say toNumber("a" + "b")',
      "1:14",
      'toNumber(...) cannot convert text (string) "ab" to a number. The text must be a number such as 2.5 or -3.',
      'say toNumber(dynamic("a") + "b")',
      "TSR058",
    ],
    [
      'say ("a" + "bc").substring(5)',
      "1:28",
      "substring() needs 'start' from 0 through 3 (the length of the text), not 5.",
      'say (dynamic("a") + "bc").substring(5)',
      "TSR025",
    ],
    [
      'say toNumber("abc".trim())',
      "1:14",
      'toNumber(...) cannot convert text (string) "abc" to a number. The text must be a number such as 2.5 or -3.',
      'say toNumber(dynamic("abc").trim())',
      "TSR058",
    ],
    [
      'say toNumber(null otherwise "abc")',
      "1:14",
      'toNumber(...) cannot convert text (string) "abc" to a number. The text must be a number such as 2.5 or -3.',
      'say toNumber(dynamic(null) otherwise "abc")',
      "TSR058",
    ],
    [
      "let p = 101\nsay chance(p)",
      "2:12",
      "chance(...) needs a percentage from 0 through 100, not 101.",
      "let p = dynamic(101)\nsay chance(p)",
      "TSR039",
    ],
    [
      "let d = 0\nsay mod(7, d)",
      "2:12",
      "mod(...) has no result: it divides by zero.",
      "let d = dynamic(0)\nsay mod(7, d)",
      "TSR036",
    ],
    [
      "global strictness = 101\nsay chance(strictness)",
      "2:12",
      "chance(...) needs a percentage from 0 through 100, not 101.",
      "global strictness = 101, default: 0\nsay chance(strictness)",
      "TSR039",
    ],
    // A call of a list or temporal function, or a list method, gives its value.
    [
      "say chance(sum([60, 41]))",
      "1:12",
      "chance(...) needs a percentage from 0 through 100, not 101.",
      "say chance(sum([dynamic(60), 41]))",
      "TSR039",
    ],
    [
      'say toNumber(toDate("2026-10-04").toISO())',
      "1:14",
      'toNumber(...) cannot convert text (string) "2026-10-04" to a number. The text must be a number such as 2.5 or -3.',
      'say toNumber(toDate(dynamic("2026-10-04")).toISO())',
      "TSR058",
    ],
    [
      "say stddev([1, 2].take(1))",
      "1:12",
      "stddev(...) needs at least 2 values, but the list has 1.",
      "say stddev([1, 2].take(dynamic(1)))",
      "TSR018",
    ],
    // A list that the compiler knows: a list function's fewest values, and an element of an empty list or set.
    [
      "say [].first",
      "1:5",
      "Cannot read '.first' from an empty list. Check its length first.",
      "say dynamic([]).first",
      "TSR018",
    ],
    [
      "let names = set[]\nsay names.random",
      "2:5",
      "Cannot read 'names.random': 'names' is empty. Check 'names.length' first.",
      "let names = dynamic(set[])\nsay names.random",
      "TSR019",
    ],
    [
      "say sum([])",
      "1:9",
      "sum(...) of an empty list has no result. Check that the list's length is above 0 first.",
      "say sum(dynamic([]))",
      "TSR018",
    ],
    [
      "say stddev([1])",
      "1:12",
      "stddev(...) needs at least 2 values, but the list has 1.",
      "say stddev([dynamic(1)])",
      "TSR018",
    ],
    [
      "let line = linearRegression([1])",
      "1:29",
      "linearRegression(...) needs at least 2 points, but the list has 1.",
      "let line = linearRegression([dynamic(1)])",
      "TSR018",
    ],
  ] as const) {
    assert.deepEqual(diagnostics(source), [`TSV043 ${place} ${message}`], source);
    const [runtimeCode, runtimeMessage] = failure(`${DYNAMIC}${hidden}`) ?? [];
    assert.equal(runtimeCode, code, hidden);
    assert.ok(runtimeMessage?.startsWith(message), `${hidden}: ${runtimeMessage}`);
  }
  // An arithmetic step whose operands are known has no result.
  assert.deepEqual(diagnostics("let big = 1e308\nsay big * 10"), [
    "TSV050 2:5 This calculation gives a number too large to represent. Use smaller values.",
  ]);
});

test("a variable counts as its first value only where no code changes it and its let has run", () => {
  // Each source runs, or fails at runtime only, because the variable may hold another value where it is read.
  for (const [source, said] of [
    // Assigned in a branch, in a loop, in a function, or in a timer block.
    ['let p = 101\nif load("again", default: true) {\n    p = 50\n}\nsay chance(p)', null],
    ["let p = 101\nrepeat 1 {\n    p = 50\n}\nsay chance(p)", null],
    ["let p = 101\nfunction lower {\n    p = 50\n}\nlower()\nsay chance(p)", null],
    ["let p = 101\ntimer async 1 s {\n    p = 50\n}\nsay chance(p)", "TSR039"],
    // Changed in place, reordered, or stored into, also through a function.
    ["let xs = [101]\nxs.add(1)\nsay chance(xs.take(1).first)", "TSR039"],
    ["let xs = [101, 1]\nxs.sort()\nsay chance(sum(xs.take(1)))", null],
    ["let xs = [60, 41]\nfunction lower {\n    xs[0] = 10\n}\nlower()\nsay chance(sum(xs))", null],
    // A parameter is never known.
    ["function f(p) {\n    return chance(p)\n}\nsay f(101)", "TSR039"],
    // A function may run before the let of the code around it.
    ["function f {\n    return chance(p)\n}\nsay f()\nlet p = 101", "TSR070"],
    ["function f(q = chance(p)) {\n    return q\n}\nlet p = 101\nsay f()", "TSR039"],
  ] as const) {
    assert.deepEqual(diagnostics(source), [], source);
    assert.equal(failure(source)?.[0] ?? null, said, source);
  }
});

test("a call is known only when it reads nothing but its known arguments", () => {
  // A draw, a clock read, and a format or zone conversion of the session are known only when the script runs.
  for (const source of [
    "say chance(randomInteger(101..=101))",
    "say toNumber(getDate().toISO())",
    'say toNumber(toDate("2026-10-04").formatDate())',
    'say toNumber(toDateTime("2026-10-04T10:00").toAbsoluteDateTime().toISO())',
    // A conversion with a default gives it, so only text written as a constant is checked (V30 §13).
    'let t = "x" + "y"\nsay toNumber(t, default: 0)',
  ])
    assert.deepEqual(diagnostics(source), [], source);
});

test("a value that needs more work than the compiler gives is not known, which is no error", () => {
  // A regex search past the regex work limit gives no known value.
  const search = 'say toNumber("aaaa".replace(/a/, "b"))';
  assert.deepEqual(diagnostics(search).length, 1);
  assert.deepEqual(
    withRegexWorkLimit(4, () => diagnostics(search)),
    [],
  );
  // Nor does text longer than the known values may take together, which the compiler does not build; the run still
  // fails on it.
  const long = `say toNumber("ab".repeat(${KNOWN_VALUE_WORK}))`;
  assert.deepEqual(diagnostics(long), []);
  assert.equal(failure(long)?.[0], "TSR058");
});
