import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

function mismatches(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("a variable keeps its declared or inferred type", () => {
  assert.deepEqual(mismatches('let score: number = "high"'), [
    [
      "TSV041",
      "'score' is declared as number, so it cannot start as text (string). Use a separate variable for a value of another type.",
      '"high"',
    ],
  ]);
  assert.deepEqual(mismatches('let score = 10\nscore = "high"'), [
    [
      "TSV041",
      "'score' holds a whole number (integer), so it cannot be set to text (string). Use a separate variable for a value of another type.",
      '"high"',
    ],
  ]);
  assert.deepEqual(mismatches('let answer = askText "Name?"\nanswer = 5'), [
    [
      "TSV041",
      "'answer' holds text (string), so it cannot be set to a whole number (integer). Use a separate variable for a value of another type.",
      "5",
    ],
  ]);
});

test("integer values widen to number, but not the reverse", () => {
  assert.deepEqual(
    mismatches("let ratio: number = 3\nratio = 2\nratio = ratio / 4\nratio += 1"),
    [],
  );
  assert.deepEqual(mismatches("let count = 10\ncount = count / 4"), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so it cannot be set to a number. To allow fractions, declare it as 'let count: number = ...'.",
      "count / 4",
    ],
  ]);
  assert.deepEqual(mismatches("let count: integer = 2.5"), [
    [
      "TSV041",
      "'count' is declared as integer, so it cannot start as a number. To allow fractions, declare it as 'let count: number = ...'.",
      "2.5",
    ],
  ]);
});

test("compound assignment keeps the variable's type", () => {
  assert.deepEqual(mismatches("let count = 1\ncount += 2\ncount -= 1"), []);
  assert.deepEqual(mismatches("let count = 1\ncount += 0.5"), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so '+=' cannot make it a number. To allow fractions, declare it as 'let count: number = ...'.",
      "0.5",
    ],
  ]);
  assert.deepEqual(mismatches('let count = 1\ncount += "x"'), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so text (string) cannot be added to it. Use a number instead.",
      '"x"',
    ],
  ]);
  assert.deepEqual(mismatches("let pause = 5 s\npause -= 2"), [
    [
      "TSV041",
      "'pause' holds a duration, so a whole number (integer) cannot be subtracted from it. Use a duration such as '2 s' instead.",
      "2",
    ],
  ]);
  assert.deepEqual(mismatches("let pause = 5 s\npause -= 2 s"), []);
});

test("null needs an optional type", () => {
  assert.deepEqual(mismatches("let name: string = null"), [
    [
      "TSV041",
      "'name' is declared as string, so it cannot start as null. To allow null, declare it as 'let name: string? = ...'.",
      "null",
    ],
  ]);
  assert.deepEqual(mismatches('let name: string? = null\nname = "Ada"\nname = null'), []);
});

test("lists keep their element type, and loop variables take it", () => {
  assert.deepEqual(mismatches('let scores = [1, 2]\nscores.add("x")\nscores[0] = "y"'), [
    [
      "TSV041",
      "'scores' holds integer values (integer[]), so it cannot contain text (string). Use a separate list for values of another type.",
      '"x"',
    ],
    [
      "TSV041",
      "'scores' holds integer values (integer[]), so it cannot contain text (string). Use a separate list for values of another type.",
      '"y"',
    ],
  ]);
  assert.deepEqual(mismatches("let ratios = [1, 2.5]\nratios.add(3)"), []);
  assert.deepEqual(mismatches('let names: string set = set[]\nnames.add("Ada")\nnames.add(1)'), [
    [
      "TSV041",
      "'names' holds string values (string set), so it cannot contain a whole number (integer). Use a separate set for values of another type.",
      "1",
    ],
  ]);
  assert.deepEqual(mismatches('for step in 1..=3 {\n    step = "x"\n}'), [
    [
      "TSV041",
      "'step' holds a whole number (integer), so it cannot be set to text (string). Use a separate variable for a value of another type.",
      '"x"',
    ],
  ]);
});

test("handles, speakers, and a typed load default keep their types", () => {
  assert.deepEqual(
    mismatches('speaker mistress { name: "Mistress" }\nlet voice = mistress\nvoice = "x"')[0]?.[0],
    "TSV041",
  );
  assert.deepEqual(mismatches("let clock = timer async 5\nclock = 3")[0]?.[0], "TSV041");
  assert.deepEqual(mismatches('let level: integer = load "level" default "high"'), [
    [
      "TSV041",
      "'level' is declared as integer, so it cannot start as text (string). Use a separate variable for a value of another type.",
      '"high"',
    ],
  ]);
});

test("a list or set literal is checked element by element against a known element type", () => {
  assert.deepEqual(mismatches('let names: string[] = ["a", 1]'), [
    [
      "TSV041",
      "'names' holds string values (string[]), so it cannot contain a whole number (integer). Use a separate list for values of another type.",
      "1",
    ],
  ]);
  assert.deepEqual(mismatches('let scores = [1, 2]\nscores = ["a", 3]')[0]?.[2], '"a"');
  assert.deepEqual(mismatches('let tags: string set = set["a", 2]')[0]?.[2], "2");
  assert.deepEqual(
    mismatches('let mixed = ["Level", 2, 3.5]\nlet ratios: number[] = [1, 2.5]'),
    [],
  );
});

test("optional types keep their non-null type in operations, elements, and loops", () => {
  assert.deepEqual(mismatches("let count: integer? = 1\ncount += 0.5"), [
    [
      "TSV041",
      "'count' holds a whole number (integer) or null, so '+=' cannot make it a number. To allow fractions, declare it as 'let count: number? = ...'.",
      "0.5",
    ],
  ]);
  assert.deepEqual(
    mismatches(
      'let items: integer[]? = [1]\nitems.add("bad")\nitems[0] += "x"\nfor item in items {\n    item = "x"\n}',
    ).map(([code]) => code),
    ["TSV041", "TSV041", "TSV041"],
  );
});

test("number times duration is a duration, and a media cue's own handle keeps its type", () => {
  assert.deepEqual(mismatches('let pause = 2 * (1 s)\npause = "x"')[0]?.[0], "TSV041");
  assert.deepEqual(
    mismatches('let music = playAudio async "music.mp3" {\n    at 1 s { music = 1 }\n}')[0]?.[0],
    "TSV041",
  );
});

test("null suggestions name only annotations that exist", () => {
  assert.deepEqual(
    mismatches("let items = []\nitems = null")[0]?.[1],
    "'items' holds a list, so it cannot be set to null. Use a separate variable for null.",
  );
  assert.deepEqual(
    mismatches("let items = [1]\nitems = null")[0]?.[1],
    "'items' holds a list (integer[]), so it cannot be set to null. To allow null, declare it as 'let items: integer[]? = ...'.",
  );
});

test("an optional operand and a parenthesized method keep their checks", () => {
  assert.deepEqual(mismatches('let count = 1\nlet text: string? = "x"\ncount += text'), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so text (string) or null cannot be added to it. Use a number instead.",
      "text",
    ],
  ]);
  assert.deepEqual(mismatches('let items = [1]\n(items.add)("x")'), [
    [
      "TSV041",
      "'items' holds integer values (integer[]), so it cannot contain text (string). Use a separate list for values of another type.",
      '"x"',
    ],
  ]);
  assert.deepEqual(mismatches('let tags = set["a"]\n(tags.add)(1)')[0]?.[0], "TSV041");
  assert.deepEqual(mismatches("let count = 1\nlet extra: integer? = 2\ncount += extra"), []);
});

test("function bodies check assignments to script variables", () => {
  assert.deepEqual(
    mismatches('let count = 0\nfunction reset {\n    count = "none"\n}')[0]?.[0],
    "TSV041",
  );
});

test("values the compiler cannot know are not rejected at compile time", () => {
  assert.deepEqual(
    mismatches(
      [
        "function pick(value) {",
        "    return value",
        "}",
        "let count = 0",
        'count = pick("x")',
        'count = load "count"',
        'let stored: integer = load "stored"',
      ].join("\n"),
    ),
    [],
  );
});

test("type inference handles deeply nested expressions without native recursion", () => {
  const source = `let total = ${Array.from({ length: 20_000 }, () => "1").join(" + ")}\ntotal = 2`;
  assert.deepEqual(compileSource(source).diagnostics, []);
});
