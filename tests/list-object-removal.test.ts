import assert from "node:assert/strict";
import test from "node:test";

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

test("removeAt removes the element at an index and shifts later elements", () => {
  const result = runValidSource(
    [
      'let items = ["key", { name: "map" }, "potion"]',
      "items.removeAt(1)",
      'say "${items.length} ${items[1]}"',
      "items.removeAt(items.length - 1)",
      "items.removeAt(0)",
      'say "${items.length}"',
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["2 potion", "0"]);
});

test("removeAt rejects an index that indexing would reject", () => {
  const cases = [
    ['let items = ["a"]\nitems.removeAt(1)', "TSR025", "List index 1 is outside the valid range."],
    [
      'let items = ["a"]\nitems.removeAt(-1)',
      "TSR025",
      "List index -1 is outside the valid range.",
    ],
    ["let items = []\nitems.removeAt(0)", "TSR025", "List index 0 is outside the valid range."],
    ['let items = ["a"]\nitems.removeAt(0.5)', "TSR024", "A list index must be an integer."],
    ['let items = ["a"]\nitems.removeAt("0")', "TSR024", "A list index must be an integer."],
    [
      'let items = ["a"]\nitems.removeAt()',
      "TSR028",
      "Expected 1 positional argument(s), received 0.",
    ],
    ["let items = set[1]\nitems.removeAt(0)", "TSR016", "Unsupported method 'removeAt'."],
  ] as const;
  for (const [source, code, message] of cases) {
    const failure = runValidSource(source).snapshot.failure;
    assert.deepEqual([failure?.code, failure?.message], [code, message], source);
  }
});

test("removal by value and position is checkpoint and resume equivalent", () => {
  assertRuntimeResumeEquivalent(
    [
      "let offenses = [",
      '    { label: "late", text: "I was late" },',
      '    { label: "rude", text: "I was rude" },',
      '    { label: "lazy", text: "I was lazy" }',
      "]",
      'offenses.remove({ label: "rude", text: "I was rude" })',
      'say "${offenses.length}"',
      "offenses.removeAt(0)",
      'say "${offenses[0].label} ${offenses == [{ text: "I was lazy", label: "lazy" }]}"',
    ].join("\n"),
  );
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
