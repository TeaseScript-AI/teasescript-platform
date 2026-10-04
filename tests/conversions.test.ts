import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function said(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

/** Runs `source` with host globals, whose values the compiler cannot know. */
function runWithGlobals(source: string, globals: Record<string, string | number | boolean | null>) {
  const plan = compileValidPlan(source, { globals: Object.keys(globals) });
  return run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("conversions turn text into numbers and true or false, and scalars into text", () => {
  assert.deepEqual(
    said(
      [
        'say "${toNumber("2.5")} ${toNumber(" -4 ")} ${toNumber("1e3")} ${toNumber(".5")} ${toNumber("-0")} ${toNumber(7)}"',
        'say "${toInteger(2.7)} ${toInteger(-2.7)} ${toInteger("2.7")} ${toInteger("-2.7")} ${toInteger("12")} ${toInteger(-0.5)}"',
        'say "${toBoolean("true")} ${toBoolean(" false ")} ${toBoolean(false)}"',
        'say "[${toString("text")}] [${toString(2.5)}] [${toString(-0)}] [${toString(true)}] [${toString(null)}] [${toString(90 seconds)}]"',
        'say toString(3).padStart(3, "0")',
      ].join("\n"),
    ),
    [
      "2.5 -4 1000 0.5 0 7",
      "2 -2 2 -2 12 0",
      "true false false",
      "[text] [2.5] [0] [true] [null] [1 min 30 s]",
      "003",
    ],
  );
});

test("round ties away from zero, floor rounds down, and ceil rounds up", () => {
  assert.deepEqual(
    said(
      [
        'say "${round(2.4)} ${round(2.5)} ${round(-2.5)} ${round(0.5)} ${round(-0.5)} ${round(-0.4)} ${round(7)}"',
        'say "${floor(2.7)} ${floor(-2.5)} ${ceil(2.1)} ${ceil(-2.5)} ${floor(10 / 4)}"',
      ].join("\n"),
    ),
    ["2 3 -3 1 -1 0 7", "2 -3 3 -2 2"],
  );
});

test("default: is the result only when a value the compiler cannot know does not convert", () => {
  const result = runWithGlobals(
    [
      'say "${toNumber(word, default: 0)} ${toNumber(digits, default: 0)} ${toInteger(word, default: -1)}"',
      'say "${toBoolean(word, default: false)} ${toBoolean(flag, default: false)} ${toNumber(missing, default: 1.5)}"',
    ].join("\n"),
    { word: "many", digits: "42", flag: "true", missing: null },
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["0 42 -1", "false true 1.5"]);
});

test("conversions and rounding have static result types", () => {
  assert.deepEqual(
    diagnostics(
      [
        'let amount: number = toNumber("2.5")',
        'let count: integer = toInteger("3") + round(2.5) + floor(2.5) + ceil(2.5)',
        "let shown: string = toString(count)",
        'let ready: boolean = toBoolean("true")',
        'let text = "4"',
        "let widened: number = toNumber(text, default: 0)",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(diagnostics('let count: integer = toNumber("2")'), [
    [
      "TSV041",
      "'count' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
      'toNumber("2")',
    ],
  ]);
});

test("conversions the compiler can prove invalid and misused arguments are compile errors", () => {
  const cases: [string, string, string, string][] = [
    [
      'say toNumber("hello")',
      "TSV043",
      'toNumber(...) cannot convert "hello"; the text must be a number such as 2.5 or -3.',
      '"hello"',
    ],
    [
      'say toInteger("${2} apples", default: 0)',
      "TSV043",
      'toInteger(...) cannot convert "2 apples"; the text must be a number such as 2.5 or -3.',
      '"${2} apples"',
    ],
    [
      'say toBoolean("yes")',
      "TSV043",
      'toBoolean(...) cannot convert "yes"; the text must be "true" or "false".',
      '"yes"',
    ],
    ["say toNumber(null)", "TSV043", "toNumber(...) converts text and numbers, not null.", "null"],
    [
      "say toNumber(true)",
      "TSV043",
      "toNumber(...) converts text and numbers, not true or false (boolean).",
      "true",
    ],
    [
      "let pause = 5 s\nsay toInteger(pause)",
      "TSV043",
      "toInteger(...) converts text and numbers, not a duration. Divide a duration by a unit instead, such as value / 1 s.",
      "pause",
    ],
    [
      "let count = 1\nsay toBoolean(count)",
      "TSV043",
      "toBoolean(...) converts text and true or false (boolean), not a whole number (integer). Compare the number instead, such as value != 0.",
      "count",
    ],
    [
      "say toString([1, 2])",
      "TSV043",
      "toString(...) cannot convert a list (integer[]); use .join() to combine its elements as text.",
      "[1, 2]",
    ],
    [
      "say toString(set[1, 2])",
      "TSV043",
      "toString(...) cannot convert a set (integer set); use .toList().join() to combine its elements as text.",
      "set[1, 2]",
    ],
    [
      "say toString(1..3)",
      "TSV043",
      "toString(...) converts text, numbers, true or false, null, durations, and date and time values, not a range.",
      "1..3",
    ],
    [
      'say toNumber("5", default: "0")',
      "TSV043",
      "toNumber(...) needs a number as its default:, not text (string).",
      '"0"',
    ],
    [
      'say toInteger("5", default: 0.5)',
      "TSV043",
      "toInteger(...) needs a whole number (integer) as its default:, not a number.",
      "0.5",
    ],
    [
      "say toString(5, default: null)",
      "TSV043",
      "toString(...) needs text (string) as its default:, not null.",
      "null",
    ],
    [
      'say toNumber("5", fallback: 0)',
      "TSV022",
      "toNumber(...) has no parameter 'fallback'; its only named argument is default:.",
      "fallback",
    ],
    [
      "say toNumber()",
      "TSV020",
      "toNumber(...) takes 1 argument (value), received 0.",
      "toNumber()",
    ],
    [
      'say round("2.5")',
      "TSV043",
      "round(...) needs a number, not text (string). Convert text with toNumber(...) first.",
      '"2.5"',
    ],
    [
      "say floor(2, 3)",
      "TSV020",
      "floor(...) takes 1 argument (value), received 2.",
      "floor(2, 3)",
    ],
    ["say ceil(2, to: 1)", "TSV022", "ceil(...) takes no named arguments; remove 'to:'.", "to"],
  ];
  for (const [source, code, message, text] of cases)
    assert.deepEqual(diagnostics(source), [[code, message, text]], source);
});

test("values that do not convert at runtime raise errors that name the fix", () => {
  const cases: [string, Record<string, string | number | boolean | null>, string, string][] = [
    [
      "say toNumber(value)",
      { value: "many" },
      "TSR058",
      'toNumber(...) cannot convert text (string) "many" to a number. Give a fallback with default: if the value may not convert.',
    ],
    [
      "say toInteger(value)",
      { value: true },
      "TSR058",
      "toInteger(...) cannot convert true or false (boolean) to a whole number (integer). Give a fallback with default: if the value may not convert.",
    ],
    [
      "say toBoolean(value)",
      { value: "yes" },
      "TSR058",
      'toBoolean(...) cannot convert text (string) "yes" to true or false (boolean). Give a fallback with default: if the value may not convert.',
    ],
    [
      "say toNumber(value)",
      { value: "1e400" },
      "TSR058",
      'toNumber(...) cannot convert text (string) "1e400" to a number. Give a fallback with default: if the value may not convert.',
    ],
    [
      "say toNumber(value, default: fallback)",
      { value: "1", fallback: "0" },
      "TSR058",
      "toNumber(...) needs a number as its default:, not text (string).",
    ],
    [
      "say round(value)",
      { value: "2.5" },
      "TSR059",
      "round(...) needs a number, not text (string). Convert text with toNumber(...) first.",
    ],
  ];
  for (const [source, globals, code, message] of cases) {
    const result = runWithGlobals(source, globals);
    assert.deepEqual(
      [result.snapshot.failure?.code, result.snapshot.failure?.message],
      [code, message],
      `${source} ${JSON.stringify(globals)}`,
    );
    const call = source.replace(/^say /u, "");
    assert.deepEqual(
      [result.snapshot.failure?.span.start.offset, result.snapshot.failure?.span.end.offset],
      [4, 4 + call.length],
      source,
    );
  }
  const list = runValidSource(
    "function dynamic(value) { return value }\nsay toString(dynamic([1]))",
  );
  assert.deepEqual(
    [list.snapshot.failure?.code, list.snapshot.failure?.message],
    [
      "TSR058",
      "toString(...) cannot convert a list to text (string). Give a fallback with default: if the value may not convert.",
    ],
  );
});

test("a conversion checks its value as it was evaluated, before later arguments run", () => {
  for (const [declaration, read, change] of [
    ["let value = null", "value", "value = [1]"],
    ["let box = { value: null }", "box.value", "box.value = [1]"],
  ])
    assert.deepEqual(
      said(
        [
          declaration,
          "function fallback {",
          `    ${change}`,
          '    return "fallback"',
          "}",
          `say toString(${read}, default: fallback())`,
        ].join("\n"),
      ),
      ["null"],
    );
});

test("conversions are checkpoint and resume equivalent", () => {
  assertRuntimeResumeEquivalent(
    [
      'let entries = "3, 1.5, x, 4".split(", ")',
      "let total = 0.0",
      "for entry in entries {",
      "    total += toNumber(entry, default: 0)",
      "}",
      'say "${round(total)} ${floor(total)} ${toInteger(total)} ${toString(total).length}"',
    ].join("\n"),
  );
});
