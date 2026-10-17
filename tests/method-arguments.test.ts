import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** Hides a value's type from the compiler, as an untyped parameter does. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("a list or set method call with arguments it never takes is a compile error", () => {
  const cases: [string, string, string, string][] = [
    [
      "let items = [1]\nitems.add()",
      "TSV020",
      "add() takes 1 argument (value), received 0.",
      "items.add()",
    ],
    [
      "let tags = set[1]\ntags.add(2, 3)",
      "TSV020",
      "add() takes 1 argument (value), received 2.",
      "tags.add(2, 3)",
    ],
    [
      "let items = [1]\nitems.add(value: 2)",
      "TSV022",
      "add() takes its arguments without names. Remove 'value:'.",
      "value",
    ],
    [
      "let items = [1]\nitems.addAll([2], [3])",
      "TSV020",
      "addAll() takes 1 argument (other), received 2.",
      "items.addAll([2], [3])",
    ],
    [
      "let items = [1]\nitems.addAll(other: [2])",
      "TSV022",
      "addAll() takes its arguments without names. Remove 'other:'.",
      "other",
    ],
    [
      "let items = [1]\nitems.remove()",
      "TSV020",
      "remove() takes 1 argument (value), received 0.",
      "items.remove()",
    ],
    [
      "let tags = set[1]\ntags.remove(1, by: 2)",
      "TSV022",
      "remove() takes its arguments without names. Remove 'by:'.",
      "by",
    ],
    [
      "let items = [1]\nlet first = items.removeAt()",
      "TSV020",
      "removeAt() takes 1 argument (index), received 0.",
      "items.removeAt()",
    ],
    [
      "let items = [1]\nlet first = items.removeFirst(at: 0)",
      "TSV022",
      "removeFirst() takes its arguments without names. Remove 'at:'.",
      "at",
    ],
    [
      "let items = [1]\nlet last = items.removeLast(1)",
      "TSV020",
      "removeLast() takes no arguments, received 1.",
      "items.removeLast(1)",
    ],
    [
      "let tags = set[1]\ntags.clear(1)",
      "TSV020",
      "clear() takes no arguments, received 1.",
      "tags.clear(1)",
    ],
    [
      "let items = [1]\nsay items.contains()",
      "TSV020",
      "contains() takes 1 argument (value), received 0.",
      "items.contains()",
    ],
    [
      "let tags = set[1]\nsay tags.contains(value: 1)",
      "TSV022",
      "contains() takes its arguments without names. Remove 'value:'.",
      "value",
    ],
    [
      "let items = [1]\nsay items.toSet(1)",
      "TSV020",
      "toSet() takes no arguments, received 1.",
      "items.toSet(1)",
    ],
    [
      "let tags = set[1]\nsay tags.toList(sorted: true)",
      "TSV022",
      "toList() takes its arguments without names. Remove 'sorted:'.",
      "sorted",
    ],
    // Every member of a union takes the call as the one receiver would (ADR 0021 rule 3.5).
    [
      "function empty(c: integer[] | integer dict) {\n    c.clear(1)\n}",
      "TSV020",
      "clear() takes no arguments, received 1.",
      "c.clear(1)",
    ],
    [
      'function drop(c: integer dict | messageHandle) {\n    c.remove("a", 2)\n}',
      "TSV020",
      "remove() takes 1 argument, or none on a message or permanent button, received 2.",
      'c.remove("a", 2)',
    ],
  ];
  for (const [source, code, message, text] of cases)
    assert.deepEqual(diagnostics(`${source}\nexit`), [[code, message, text]], source);
});

test("a call that no receiver with the method takes is a compile error on a value of unknown type", () => {
  const cases: [string, string, string, string][] = [
    ["v.add()", "TSV020", "add() takes 1 argument (value), received 0.", "v.add()"],
    [
      "v.addAll(other: [1])",
      "TSV022",
      "addAll() takes its arguments without names. Remove 'other:'.",
      "other",
    ],
    ["v.removeAt()", "TSV020", "removeAt() takes 1 argument (index), received 0.", "v.removeAt()"],
    [
      "v.removeLast(1)",
      "TSV020",
      "removeLast() takes no arguments, received 1.",
      "v.removeLast(1)",
    ],
    // A dict's `clear` takes no arguments either.
    ["v.clear(1)", "TSV020", "clear() takes no arguments, received 1.", "v.clear(1)"],
    ["v.toList(1)", "TSV020", "toList() takes no arguments, received 1.", "v.toList(1)"],
    ["v.sort(1)", "TSV020", "sort() takes no arguments, received 1.", "v.sort(1)"],
    ["say v.union()", "TSV020", "union() takes 1 argument (other), received 0.", "v.union()"],
    // A list's `get` takes an index, and a dict's a key, each with a `default:`.
    [
      'say v.get(0, "none")',
      "TSV020",
      "get() takes 1 argument (index or key) and a 'default:', received 2.",
      'v.get(0, "none")',
    ],
    [
      'say v.get(0, default: "none", fallback: "")',
      "TSV022",
      "get() has no parameter 'fallback'. Its only named argument is 'default:'.",
      "fallback",
    ],
    // A message and a permanent button take `remove()` without arguments, and the collections take one.
    [
      "v.remove(1, 2)",
      "TSV020",
      "remove() takes 1 argument, or none on a message or permanent button, received 2.",
      "v.remove(1, 2)",
    ],
    [
      "v.remove(key: 1)",
      "TSV022",
      "remove() takes its arguments without names. Remove 'key:'.",
      "key",
    ],
    // Timers and media, and date and time values, take no arguments for their methods.
    ["v.pause(1)", "TSV020", "pause() takes no arguments, received 1.", "v.pause(1)"],
    [
      "v.stop(now: true)",
      "TSV022",
      "stop() takes its arguments without names. Remove 'now:'.",
      "now",
    ],
    ["say v.toISO(1)", "TSV020", "toISO() takes no arguments, received 1.", "v.toISO(1)"],
  ];
  for (const [statement, code, message, text] of cases)
    assert.deepEqual(
      diagnostics(`function use(v) {\n    ${statement}\n}\nexit`),
      [[code, message, text]],
      statement,
    );
});

test("a call that some receiver with the method takes compiles, and its receiver checks it when it runs", () => {
  // A message takes `remove()`, a list `remove(value)`, and a dict `remove(key)`.
  const removed = [
    'let line = say "Gone", instant',
    'let kept = say "Kept", instant',
    "let names = dynamic([1, 2])",
    "dynamic(line).remove()",
    "names.remove(2)",
    "function removeFrom(c: integer[] | messageHandle) {",
    "    c.remove()",
    "}",
    "removeFrom(kept)",
    "function removeKey(c: integer dict | messageHandle) {",
    '    return c.remove("a")',
    "}",
    "say names",
    "say removeKey(dict{ a: 7 })",
    "exit",
  ].join("\n");
  const result = runValidSource(`${DYNAMIC}${removed}`);
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["Gone", "Kept", "[1]", "7"]);
  assert.deepEqual(
    result.snapshot.liveMessages.map((message) => [message.sourceText, message.removed === true]),
    [
      ["Gone", true],
      ["Kept", true],
    ],
  );
  const failure = runValidSource(`${DYNAMIC}dynamic([1]).remove()\nexit`).snapshot.failure;
  assert.deepEqual(
    [failure?.code, failure?.message],
    ["TSR028", "remove() takes one argument, but this call has none."],
  );
});

test("correct calls compile and run on known receivers and on values of unknown type", () => {
  const script = (wrap: (name: string) => string) =>
    [
      DYNAMIC,
      "let numbers = [3, 1, 2]",
      "let tags = set[1, 2]",
      "let scores = dict{ a: 1, b: 2 }",
      'let line = say "Shown", instant',
      'let button = showPermanentButton "Press" {\n}',
      'let tick = timer async 10 s { say "tick" }',
      'let day = toDate("2026-01-02")',
      `let n = ${wrap("numbers")}`,
      `let t = ${wrap("tags")}`,
      `let d = ${wrap("scores")}`,
      "n.add(4)",
      "n.addAll([5, 6])",
      "n.remove(3)",
      "let a = n.removeAt(0)",
      "let b = n.removeFirst()",
      "let c = n.removeLast()",
      "n.shuffle()",
      "n.sort()",
      "n.reverse()",
      "t.add(3)",
      "t.remove(1)",
      'd.remove("a")',
      "say n",
      "say n.toSet().toList()",
      "say t.toList()",
      "say n.union(t)",
      'say "${a} ${b} ${c} ${n.contains(4)} ${t.contains(3)} ${d.contains("a")}"',
      `say "\${n.get(9, default: 0)} \${d.get("b", default: 0)} \${${wrap("day")}.toISO()}"`,
      `${wrap("tick")}.pause()`,
      `${wrap("tick")}.resume()`,
      `${wrap("tick")}.stop()`,
      `${wrap("line")}.remove()`,
      `${wrap("button")}.remove()`,
      "n.clear()",
      "t.clear()",
      "d.clear()",
      'say "${n.length} ${t.toList().length} ${d.contains("b")}"',
      "exit",
    ].join("\n");
  for (const wrap of [(name: string) => name, (name: string) => `dynamic(${name})`]) {
    const result = runValidSource(script(wrap));
    assert.equal(result.snapshot.failure, null, wrap("receiver"));
    assert.deepEqual(
      sayTexts(result),
      [
        "Shown",
        "[5, 4]",
        "[5, 4]",
        "[2, 3]",
        "[5, 4, 2, 3]",
        "1 2 6 true true false",
        "0 2 2026-01-02",
        "0 0 false",
      ],
      wrap("receiver"),
    );
  }
});
