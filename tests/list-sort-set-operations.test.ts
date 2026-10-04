import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function said(source: string, seed?: number): string[] {
  const result = runValidSource(source, seed);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

function failure(source: string): [string | undefined, string | undefined] {
  const result = runValidSource(source);
  return [result.snapshot.failure?.code, result.snapshot.failure?.message];
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("sort orders numbers, text by code point, and durations in place", () => {
  assert.deepEqual(
    said(
      [
        "let numbers = [3, 1.5, -2, 2]",
        "numbers.sort()",
        'let words = ["b", "B", "adam", "Zoe", "a", "😀", "ｚ"]',
        "words.sort()",
        "let pauses = [2 s, 500 ms, 1 min]",
        "pauses.sort()",
        "let none = []",
        "none.sort()",
        "let one = [7]",
        "one.sort()",
        'say "${numbers.join()} | ${words.join()} | ${pauses.join()} | ${none.length} ${one.join()}"',
      ].join("\n"),
    ),
    ["-2, 1.5, 2, 3 | B, Zoe, a, adam, b, ｚ, 😀 | 500 ms, 2 s, 1 min | 0 7"],
  );
});

test("shuffle reorders in place with the session RNG, drawing once per element after the first", () => {
  const source = (list: string) =>
    [
      `let items = ${list}`,
      "items.shuffle()",
      'say "${items.join()}|${randomInteger(1..=1000000)}"',
    ].join("\n");
  const [shuffled] = said(source("[1, 2, 3, 4, 5]"), 99);
  assert.deepEqual(said(source("[1, 2, 3, 4, 5]"), 99), [shuffled]);
  const [order, draw] = shuffled!.split("|");
  assert.deepEqual(order!.split(", ").sort(), ["1", "2", "3", "4", "5"]);
  // The draws depend only on the length, so a list of other values leaves the same next random number.
  assert.equal(said(source('["a", "b", "c", "d", "e"]'), 99)[0]!.split("|")[1], draw);
  // A list of fewer than two elements draws nothing.
  const untouched = said('say "${randomInteger(1..=1000000)}"', 99)[0];
  assert.equal(said(source("[]"), 99)[0], `|${untouched}`);
  assert.equal(said(source('["only"]'), 99)[0], `only|${untouched}`);
});

test("shuffle is a Fisher-Yates shuffle over the session's random draws", () => {
  // From the last position down, each draw picks the element to swap in from the positions not yet fixed.
  const shuffled = (draws: readonly number[]): [string[], number] => {
    const plan = compileValidPlan(
      'let items = ["a", "b", "c", "d"]\nitems.shuffle()\nsay items.join()',
    );
    const queue = [...draws];
    let calls = 0;
    const result = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
      random: {
        next: () => {
          calls += 1;
          return queue.shift() ?? 0;
        },
      },
    });
    assert.equal(result.snapshot.failure, null);
    return [sayTexts(result), calls];
  };
  assert.deepEqual(shuffled([0, 0, 0]), [["b, c, d, a"], 3]);
  assert.deepEqual(shuffled([0.5, 0, 0.75]), [["d, b, a, c"], 3]);
  assert.deepEqual(shuffled([0.99, 0.99, 0.99]), [["a, b, c, d"], 3]);
});

test("sort, shuffle, and set operations are checkpoint and resume equivalent", () => {
  assertRuntimeResumeEquivalent(
    [
      'let tasks = ["kneel", "crawl", "beg", "wait"]',
      "tasks.shuffle()",
      'say tasks.join(" ")',
      "tasks.sort()",
      'say tasks.join(" ")',
      'say tasks.difference(["beg"]).union(set["rest"]).join(" ")',
    ].join("\n"),
  );
});

test("a prepared element reference follows its element when the list is reordered", () => {
  const source = [
    'let items = [{ name: "first", done: false }, { name: "second", done: false }, { name: "third", done: false }]',
    "function mark {",
    "    items.shuffle()",
    "    return true",
    "}",
    "items[0].done = mark()",
    "for item in items {",
    "    if item.done { say item.name }",
    "}",
  ].join("\n");
  for (const seed of [1, 2, 3, 4]) assert.deepEqual(said(source, seed), ["first"], `seed ${seed}`);
});

test("set operations return a new collection of the receiver's kind with each element once", () => {
  assert.deepEqual(
    said(
      [
        'let mine = ["collar", "gag", "cuffs", "gag"]',
        'let yours = ["cuffs", "collar", "rope", "rope"]',
        'say "${mine.intersection(yours).join()} | ${mine.union(yours).join()} | ${mine.difference(yours).join()}"',
        'say "${mine.union(set["rope", "gag"]).join()} | ${mine.join()} | ${yours.join()}"',
        "let numbers = set[1, 2, 3]",
        'say "${numbers.intersection([3, 2, 9]).toList().join()} | ${numbers.union(set[4, 1]).toList().join()} | ${numbers.difference([1]).toList().join()} | ${numbers.length}"',
        "let objects = [{ n: 1 }, { n: 2 }, { n: 1 }]",
        'say "${objects.intersection([{ n: 2 }]).length} ${objects.union([{ n: 3 }]).length} ${objects.difference([{ n: 1 }])[0].n}"',
        "let pauses = [1 s, 2 s]",
        "say pauses.difference([1000 ms]).join()",
      ].join("\n"),
    ),
    [
      "collar, cuffs | collar, gag, cuffs, rope | gag",
      "collar, gag, cuffs, rope | collar, gag, cuffs, gag | cuffs, collar, rope, rope",
      "2, 3 | 1, 2, 3, 4 | 2, 3 | 3",
      "1 3 2",
      "2 s",
    ],
  );
});

test("misuse the compiler can see is a compile error", () => {
  const cases: [string, string, string, string][] = [
    [
      "let flags = [true, false]\nflags.sort()",
      "TSV043",
      "sort() sorts numbers, text, or durations, not true or false (boolean).",
      "sort",
    ],
    [
      "let tags = set[1, 2]\ntags.shuffle()",
      "TSV043",
      "A set keeps its insertion order, so it has no shuffle(). Copy it into a list with toList() first.",
      "shuffle",
    ],
    [
      "let items = [1]\nitems.sort(1)",
      "TSV020",
      "sort() takes no arguments, received 1.",
      "items.sort(1)",
    ],
    [
      "let items = [1]\nsay items.union()",
      "TSV020",
      "union() takes 1 argument (other), received 0.",
      "items.union()",
    ],
    [
      "let items = [1]\nsay items.union(5)",
      "TSV043",
      "union() needs a list or a set, not a whole number (integer).",
      "5",
    ],
    [
      "let tags = set[1]\nsay tags.union([{ n: 1 }])",
      "TSV006",
      "A set holds only text, numbers, true or false, date and time values, or null, so it cannot hold an object.",
      "[{ n: 1 }]",
    ],
    [
      "let tags = set[]\nsay tags.union([1 s])",
      "TSV006",
      "A set holds only text, numbers, true or false, date and time values, or null, so it cannot hold a duration.",
      "[1 s]",
    ],
    [
      'let items = [1]\nsay items.union(["x"])',
      "TSV044",
      "union() would mix a whole number (integer) and text (string). A list holds one type; to keep both, declare a union type, as in 'let items: (integer | string)[] = ...'.",
      'items.union(["x"])',
    ],
    [
      'say set[1].union(set["x"])',
      "TSV044",
      "union() would mix a whole number (integer) and text (string). A set holds one type; to keep both, declare a union type, as in 'let values: (integer | string) set = ...'.",
      'set[1].union(set["x"])',
    ],
  ];
  for (const [source, code, message, text] of cases)
    assert.deepEqual(diagnostics(source), [[code, message, text]], source);
  assert.deepEqual(
    diagnostics(
      "let counts: integer[] = [3, 1]\nlet both: number[] = counts.union([2.5])\nlet same: integer[] = counts.intersection(set[1])",
    ),
    [],
  );
});

test("values the compiler cannot know are checked at runtime", () => {
  assert.deepEqual(failure(`${DYNAMIC}let items = dynamic([1])\nitems.add("a")\nitems.sort()`), [
    "TSR060",
    "sort() needs elements of one kind, but this list has numbers and text.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let items = dynamic([true])\nitems.sort()`), [
    "TSR060",
    "sort() sorts numbers, text, or durations, not true or false (boolean).",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let items = [1]\nsay items.union(dynamic(5))`), [
    "TSR060",
    "union() needs a list or a set, not a number.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let tags = set[1]\nsay tags.union(dynamic([[1]]))`), [
    "TSR032",
    "Sets may contain only string, boolean, integer, number, date, time, datetime, timestamp, or null values.",
  ]);
});
