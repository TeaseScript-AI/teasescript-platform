import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

test("objects, lists, sets, and ranges compare by value", () => {
  const cases = [
    ["{ a: 1, b: [1, 2] } == { b: [1, 2], a: 1 }", "true"],
    ['{ a: { b: "x" } } == { a: { b: "x" } }', "true"],
    ["{ a: 1 } == { a: 1, b: 2 }", "false"],
    ["{ a: null } == { b: null }", "false"],
    ["{ a: 1 } != { a: 2 }", "true"],
    ["[1, 2] == [1, 2]", "true"],
    ["[1, 2] == [2, 1]", "false"],
    ["[[1], []] == [[1], []]", "true"],
    ["set[1, 2] == set[2, 1]", "true"],
    ["set[1, 2] == set[1]", "false"],
    ["[1] == set[1]", "false"],
    ["{ a: 1 } == [1]", "false"],
    ["1..3 == 1..3", "true"],
    ["1..3 == 1..=3", "false"],
    ["{ wait: 1 s } == { wait: 1000 ms }", "true"],
    ['{ a: 1 } == "{ a: 1 }"', "false"],
  ] as const;
  for (const [expression, expected] of cases) {
    const result = runValidSource(`say "\${${expression}}"`);
    assert.equal(result.snapshot.failure, null, expression);
    assert.deepEqual(sayTexts(result), [expected], expression);
  }
});

test("each operand of == and != is read when it is evaluated, left to right", () => {
  const cases = [
    ['let items = [1]\nsay "${items == [items.removeAt(0)]}"', "true"],
    [
      'let items = [1]\nfunction take {\n    return items.removeAt(0)\n}\nsay "${items == [take()]}"',
      "true",
    ],
    ['let items = [1, 2]\nsay "${items != [items.removeFirst(), 2]}"', "false"],
    ['let items = [1]\nsay "${[items.removeAt(0)] == items}"', "false"],
  ] as const;
  for (const [source, expected] of cases) {
    const result = runValidSource(source);
    assert.equal(result.snapshot.failure, null, source);
    assert.deepEqual(sayTexts(result), [expected], source);
    assertRuntimeResumeEquivalent(source);
  }
});

test("list contains and remove find an object by value", () => {
  const result = runValidSource(
    [
      "let offenses = [",
      '    { label: "late", text: "I was late" },',
      '    { label: "rude", text: "I was rude" },',
      '    { label: "late", text: "I was late" }',
      "]",
      'offenses.remove({ text: "I was late", label: "late" })',
      'say "${offenses.length} ${offenses[0].label} ${offenses[1].label}"',
      'say "${offenses.contains({ label: "rude", text: "I was rude" })}"',
      'offenses.remove({ label: "rude" })',
      'say "${offenses.length}"',
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["2 rude late", "true", "2"]);
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "developerWarning" ? [event.code] : [])),
    ["TSW002"],
  );
});

test("removeAt, removeFirst, and removeLast remove and return an element", () => {
  const result = runValidSource(
    [
      'let tasks = ["wash", "feed", "walk", "sleep", "read"]',
      "let first = tasks.removeFirst()",
      "let middle = tasks.removeAt(1)",
      "let last = tasks.removeLast()",
      'say "${first} ${middle} ${last} ${tasks[0]} ${tasks[1]}"',
      "tasks.removeAt(tasks.length - 1)",
      "tasks.removeFirst()",
      'say "${tasks.length}"',
      'let offenses = [{ label: "late" }, { label: "rude" }]',
      "let picked = offenses.removeAt(1)",
      'say "${picked.label} ${offenses.length}"',
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["wash walk read feed sleep", "0", "rude 1"]);
});

test("removal fails at runtime for an invalid index or an empty list", () => {
  const cases = [
    ['let items = ["a"]\nitems.removeAt(1)', "TSR025", "List index 1 is outside the valid range."],
    [
      'let items = ["a"]\nlet index = 0 - 1\nitems.removeAt(index)',
      "TSR025",
      "List index -1 is outside the valid range.",
    ],
    ["let items = []\nitems.removeAt(0)", "TSR025", "List index 0 is outside the valid range."],
    [
      'function dynamic(value) {\n    return value\n}\nlet items = ["a"]\nitems.removeAt(dynamic(1 / 2))',
      "TSR024",
      "A list index must be an integer.",
    ],
    [
      "let items = []\nitems.removeFirst()",
      "TSR018",
      "Cannot call removeFirst() on an empty list. Check that the list's length is above 0 first.",
    ],
    [
      'let items = ["a"]\nitems.removeLast()\nlet gone = items.removeLast()',
      "TSR018",
      "Cannot call removeLast() on an empty list. Check that the list's length is above 0 first.",
    ],
    [
      'let items = ["a"]\nitems.removeAt()',
      "TSR028",
      "Expected 1 positional argument(s), received 0.",
    ],
    [
      "function dynamic(value) {\n    return value\n}\nlet items = dynamic(set[1])\nitems.removeAt(0)",
      "TSR016",
      "Unsupported method 'removeAt'.",
    ],
  ] as const;
  for (const [source, code, message] of cases) {
    const failure = runValidSource(source).snapshot.failure;
    assert.deepEqual([failure?.code, failure?.message], [code, message], source);
  }
});

test("the compiler reports a list index it can see is invalid", () => {
  const negative =
    "TSV045 A list index cannot be negative. The first element is at index 0, and the last at length - 1.";
  const fractional =
    "TSV043 A list index must be a whole number (integer), but this is a number. Round it with floor(...), round(...), or ceil(...).";
  const text = "TSV043 A list index is a whole number (integer), but this is text (string).";
  const boolean =
    "TSV043 A list index is a whole number (integer), but this is true or false (boolean).";
  const cases = [
    ["items.removeAt(-1)", negative],
    ["items.removeAt(0.5)", fractional],
    ['items.removeAt("0")', text],
    ["say items[-1]", negative],
    ["say items[1 / 2]", fractional],
    ["items[-(1)] = 2", negative],
    ['let index: string = "0"\nitems.removeAt(index)', text],
    ["let flag = true\nsay items[flag]", boolean],
    ['let name = "a"\nitems[name] = 2', text],
    ["items.removeAt(1 < 2)", boolean],
    ["items.removeAt(1.0)", fractional],
    ["let index: number = 0\nsay items[index]", fractional],
    ["let s = set[1]\ns.removeAt(0)", "TSV043 Sets have no method 'removeAt'."],
    ["function remove(index: integer?) {\n    items.removeAt(index)\n}", null],
  ] as const;
  for (const [statement, expected] of cases) {
    const diagnostics = compileSource(`let items = [1]\n${statement}`).diagnostics;
    assert.deepEqual(
      diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`),
      expected === null ? [] : [expected],
      statement,
    );
  }
});

test("a removed element has the static type of the list's elements", () => {
  const cases = [
    'let next = [1, 2].removeFirst()\nnext = "x"',
    "let last: string = [1, 2].removeLast()",
    'let items = [1]\nitems.add(["x"].removeAt(0))',
  ];
  for (const source of cases) {
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => diagnostic.code),
      ["TSV041"],
      source,
    );
  }
});

test("removal by value and position is checkpoint and resume equivalent", () => {
  assertRuntimeResumeEquivalent(
    [
      "let offenses = [",
      '    { label: "late", text: "I was late" },',
      '    { label: "rude", text: "I was rude" },',
      '    { label: "lazy", text: "I was lazy" },',
      '    { label: "loud", text: "I was loud" }',
      "]",
      'offenses.remove({ label: "rude", text: "I was rude" })',
      'say "${offenses.length}"',
      "let gone = offenses.removeAt(0)",
      "let newest = offenses.removeLast()",
      'say "${gone.label} ${newest.label} ${offenses == [{ text: "I was lazy", label: "lazy" }]}"',
      'say "${offenses.removeFirst().label} ${offenses.length}"',
    ].join("\n"),
  );
});

test("structural equality stops at a scalar mismatch before visiting nested values", () => {
  // Only the length of these payloads may be read; visiting an element throws.
  const unvisited = <T>(length: number): T[] =>
    new Proxy<T[]>([], {
      get: (_target, key) => {
        if (key === "length") return length;
        throw new Error(`Visited payload member ${String(key)}.`);
      },
    });
  const payloads: SerializableRuntimeValue[] = [
    { kind: "list", items: unvisited(4096) },
    { kind: "set", items: unvisited(4096) },
    { kind: "object", properties: unvisited(4096) },
  ];
  for (const payload of payloads) {
    const record = (id: number): SerializableRuntimeValue => ({
      kind: "object",
      properties: [
        { name: "payload", value: payload },
        { name: "id", value: id },
      ],
    });
    assert.equal(serializableEquals(record(1), record(2)), false);
  }
});

test("structural equality compares deeply nested values without native recursion", () => {
  const depth = 100_000;
  const nested = (): SerializableRuntimeValue => {
    let value: SerializableRuntimeValue = 1;
    for (let level = 0; level < depth; level += 1) value = { kind: "list", items: [value] };
    return value;
  };
  assert.equal(serializableEquals(nested(), nested()), true);
});
