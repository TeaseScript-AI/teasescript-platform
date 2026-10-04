import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

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
      "'answer' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
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
      "'count' holds a whole number (integer), so it cannot be set to a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
      "count / 4",
    ],
  ]);
  assert.deepEqual(mismatches("let count: integer = 2.5"), [
    [
      "TSV041",
      "'count' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
      "2.5",
    ],
  ]);
});

test("compound assignment keeps the variable's type", () => {
  assert.deepEqual(mismatches("let count = 1\ncount += 2\ncount -= 1"), []);
  assert.deepEqual(mismatches("let count = 1\ncount += 0.5"), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so '+=' cannot make it a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
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
      "'pause' holds a duration, so a whole number (integer) cannot be subtracted from it. Give the number a unit, such as '2 s'.",
      "2",
    ],
  ]);
  assert.deepEqual(mismatches("let pause = 5 s\npause -= 2 s"), []);
  for (const [target, operator] of [
    ["count", "+="],
    ["items[0]", "-="],
  ])
    for (const operand of ["[2]", 'set["a"]', "{ a: 1 }", "null", "extra"])
      assert.deepEqual(
        mismatches(
          `let count = 1\nlet items = [1]\nlet extra: integer[]? = [2]\n${target} ${operator} ${operand}`,
        ).map(([code, , text]) => [code, text]),
        [["TSV041", operand]],
        `${target} ${operator} ${operand}`,
      );
  assert.deepEqual(
    mismatches('let count = 1\nlet saved = load "count"\ncount += saved\ncount -= saved'),
    [],
  );
  assert.deepEqual(
    mismatches("let items = [1]\nitems[0] += 0.5")[0]?.[1],
    "'items' holds integer values (integer[]), so '+=' cannot make an element a number. To allow fractions, declare it as 'let items: number[] = ...'.",
  );
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
      "'count' holds a whole number (integer) or null, so '+=' cannot make it a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number? = ...'.",
      "0.5",
    ],
  ]);
  assert.deepEqual(
    mismatches(
      'let items: integer[]? = [1]\nitems.add("bad")\nitems[0] += "x"\nfor item in items {\n    item = "x"\n}',
    ).map(([code]) => code),
    ["TSV041", "TSV041", "TSV041"],
  );
  assert.deepEqual(
    mismatches("let items: integer[]? = [1]\nitems.add(2.5)")[0]?.[1],
    "'items' holds integer values (integer[]), so it cannot contain a number. To allow fractions, declare it as 'let items: number[]? = ...'.",
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

/** The code and source text of each diagnostic, for tests whose exact wording is covered elsewhere. */
function codes(source: string): [string, string][] {
  return mismatches(source).map(([code, , text]) => [code, text]);
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

test("a variable that starts as null takes the type of its first non-null value and names both places", () => {
  assert.deepEqual(mismatches('let best = null\nbest = "Ada"\nbest = null\nbest = 5'), [
    [
      "TSV041",
      "'best' holds text (string) or null since line 2, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
      "5",
    ],
  ]);
  // A value the compiler cannot know decides nothing; the first known value does.
  assert.deepEqual(codes('let best = null\nbest = load "best"\nbest = 2\nbest = "x"'), [
    ["TSV041", '"x"'],
  ]);
  // The first value in checking order decides, also when it is assigned inside a function.
  assert.deepEqual(codes('let best = null\nfunction keep {\n    best = 5\n}\nbest = "x"'), [
    ["TSV041", "5"],
  ]);
});

test("an empty list or set takes its element type from the first element, and null elements make it optional", () => {
  assert.deepEqual(mismatches('let items = []\nitems.add(1)\nitems.add("x")'), [
    [
      "TSV041",
      "'items' holds integer values (integer[]) since line 2, so it cannot contain text (string). Use a separate list for values of another type.",
      '"x"',
    ],
  ]);
  assert.deepEqual(codes('let items = []\nitems = ["a"]\nitems[0] = 2'), [["TSV041", "2"]]);
  assert.deepEqual(codes('let tags = set[]\ntags.add("a")\ntags.add(true)'), [["TSV041", "true"]]);
  assert.deepEqual(codes("let marks = [null, 1]\nmarks.add(null)\nmarks.add(2.5)"), [
    ["TSV041", "2.5"],
  ]);
  assert.deepEqual(codes("let marks = [null]\nmarks.add(1)\nmarks.add(null)\nmarks.add(true)"), [
    ["TSV041", "true"],
  ]);
  assert.deepEqual(codes("let groups = [[], [1]]\ngroups.add([2])\ngroups.add([true])"), [
    ["TSV041", "true"],
  ]);
});

test("an object property keeps the type of its first value, and assignment may add a property", () => {
  assert.deepEqual(
    mismatches(
      'let door = { locked: true }\ndoor.locked = "yes"\ndoor.color = "red"\ndoor.color = 5',
    ),
    [
      [
        "TSV041",
        "'door.locked' holds true or false (boolean), so it cannot be set to text (string). Use a separate property for a value of another type.",
        '"yes"',
      ],
      [
        "TSV041",
        "'door.color' holds text (string) since line 3, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
        "5",
      ],
    ],
  );
  assert.deepEqual(codes('let door = { owner: null }\ndoor.owner = "Ada"\ndoor.owner = 3'), [
    ["TSV041", "3"],
  ]);
  assert.deepEqual(codes('let door = { keys: [1] }\ndoor.keys.add("x")'), [["TSV041", '"x"']]);
  assert.deepEqual(codes('let door = { locked: true }\ndoor = { locked: "no", open: 1 }'), [
    ["TSV041", '"no"'],
  ]);
  // Copies keep their own properties: a property added to one is not added to the other.
  assert.deepEqual(codes('let a = { x: 1 }\nlet b = a\nb.y = "b"\na.y = 2'), []);
  assert.deepEqual(
    mismatches('let kept = []\nkept.add({ name: "Ada" })\nkept.add({ name: 1 })')[0]?.[1],
    "Property 'name' of the elements of 'kept' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${1}\".",
  );
  assert.deepEqual(
    mismatches('let kept = [{ name: "Ada" }]\nlet other = { name: 1 }\nkept.add(other)')[0]?.[1],
    "'kept' holds object values (object[]), so its property 'name', which holds text (string), cannot be set to a whole number (integer). Use a separate property for a value of another type.",
  );
});

test("a function's result type comes from its return values, and returns of different types are an error", () => {
  assert.deepEqual(codes('function name {\n    return "Ada"\n}\nlet n = name()\nn = 5'), [
    ["TSV041", "5"],
  ]);
  assert.deepEqual(
    mismatches('function pick(n) {\n    if n > 3 {\n        return "big"\n    }\n    return 1\n}'),
    [
      [
        "TSV044",
        "'pick' returns a whole number (integer) here, but text (string) on line 3. A function returns one type; use a separate function for values of another type.",
        "1",
      ],
    ],
  );
  // Integers and numbers together are numbers; a function that can end without a value has an optional result.
  assert.deepEqual(
    codes(
      "function ratio(n) {\n    if n > 3 {\n        return 1\n    }\n    return 0.5\n}\nlet r = ratio(1)\nr = 2.5",
    ),
    [],
  );
  assert.deepEqual(
    codes(
      'function maybe(flag) {\n    if flag {\n        return 1\n    }\n}\nlet m = maybe(true)\nm = null\nm = "x"',
    ),
    [["TSV041", '"x"']],
  );
  // A function used before its declaration, a recursive function, and a function returning an object.
  assert.deepEqual(codes('let total = later()\nfunction later {\n    return 5\n}\ntotal = "x"'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(
    codes(
      "function fact(n: integer): integer {\n    if n <= 1 {\n        return 1\n    }\n    return n * fact(n - 1)\n}\nlet x = fact(5)\nx = 2.5",
    ),
    [["TSV041", "2.5"]],
  );
  assert.deepEqual(codes('function make {\n    return { hp: 10 }\n}\nlet m = make()\nm.hp = "x"'), [
    ["TSV041", '"x"'],
  ]);
  // An unknown return value decides nothing; values the compiler cannot know are never rejected.
  assert.deepEqual(
    codes('function pass(value) {\n    return value\n}\nlet p = pass(1)\np = "x"'),
    [],
  );
});

test("annotated parameters and results are checked, and a default types a parameter like let", () => {
  assert.deepEqual(mismatches('function shout(times = 1) {\n    say "${times}"\n}\nshout(0.5)'), [
    [
      "TSV041",
      "'shout' takes 'times' as a whole number (integer), so it cannot take a number. Round it with floor(...), round(...), or ceil(...), or declare the parameter as 'times: number = 1'.",
      "0.5",
    ],
  ]);
  assert.deepEqual(
    codes(
      'function greet(name: string, polite = true) {\n    say name\n}\ngreet("Ada", polite: "yes")\ngreet(5)',
    ),
    [
      ["TSV041", '"yes"'],
      ["TSV041", "5"],
    ],
  );
  assert.deepEqual(codes('function f(count: integer = "x") {\n    say "${count}"\n}'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(mismatches("function half(n: integer): integer {\n    return n / 2\n}"), [
    [
      "TSV041",
      "'half' returns integer, so it cannot return a number. Round it with floor(...), round(...), or ceil(...).",
      "n / 2",
    ],
  ]);
  assert.deepEqual(
    mismatches("function f: integer {\n    if chance(50) {\n        return 1\n    }\n}"),
    [
      [
        "TSV041",
        "'f' returns integer, but it can end without returning a value. Add a 'return' at the end. To allow null, declare the result as 'integer?'.",
        "f",
      ],
    ],
  );
  assert.deepEqual(codes("function g: integer {\n    return\n}"), [["TSV041", "return"]]);
  // A loop that only a return leaves ends every path; a parameter without a type or decided default is unknown.
  assert.deepEqual(
    codes("function f: integer {\n    while true {\n        return 1\n    }\n}"),
    [],
  );
  assert.deepEqual(
    codes('function greet(name = null) {\n    say "Hi"\n}\ngreet("Ada")\ngreet(5)'),
    [],
  );
});

test("only integers convert implicitly: division gives a number, and durations need a unit", () => {
  assert.deepEqual(
    mismatches("let n: integer = 2.0")[0]?.[1],
    "'n' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let n: number = ...'.",
  );
  assert.deepEqual(codes("let total = 10\nlet avg: integer = total / 5"), [
    ["TSV041", "total / 5"],
  ]);
  assert.deepEqual(mismatches("let pause: duration = 5\npause = 10\nlet later = pause + 5"), [
    [
      "TSV041",
      "'pause' is declared as duration, so it cannot start as a whole number (integer). Give the number a unit, such as '5 s'.",
      "5",
    ],
    [
      "TSV041",
      "'pause' holds a duration, so it cannot be set to a whole number (integer). Give the number a unit, such as '10 s'.",
      "10",
    ],
    [
      "TSV043",
      "A duration and a number cannot be combined with '+'. Give the number a unit, such as '5 s'.",
      "pause + 5",
    ],
  ]);
  assert.deepEqual(
    mismatches("let title: string = 5")[0]?.[1],
    "'title' is declared as string, so it cannot start as a whole number (integer). To show it as text, write \"${5}\".",
  );
  assert.deepEqual(
    mismatches('let joined = "a" + "b"')[0]?.[1],
    "'+' does not join text. Put the values in one text instead, such as \"${first}${second}\".",
  );
  assert.deepEqual(codes("let sum = true + 1"), [["TSV043", "true + 1"]]);
  // Bare numbers count as seconds in commands that expect a time.
  assert.deepEqual(
    codes('let n = 3\nwait n\nwait n ms\ntimer n\nplayAudio(file: "a.mp3", startAt: n, endAt: 5)'),
    [],
  );
  assert.deepEqual(codes('wait "soon"'), [["TSV043", '"soon"']]);
});

test("conditions and logical operands are true or false, and operators get values they support", () => {
  assert.deepEqual(mismatches("let count = 3\nwhile count {\n    count -= 1\n}"), [
    [
      "TSV043",
      "A condition must be true or false (boolean), but this is a whole number (integer). Compare it instead, such as 'count > 0'.",
      "count",
    ],
  ]);
  assert.deepEqual(
    codes('let names = ["a"]\nif names {\n    say "x"\n}\nlet ok = not 1\nlet both = true and "x"'),
    [
      ["TSV043", "names"],
      ["TSV043", "1"],
      ["TSV043", '"x"'],
    ],
  );
  assert.deepEqual(
    codes(
      'let r = 1..3\nlet q = r + 1\nlet less = "a" < 1\nlet x = 5\nsay x.length\nlet items = [1]\nitems.sort()\nsay items[1.5]',
    ),
    [
      ["TSV043", "r + 1"],
      ["TSV043", '"a" < 1'],
      ["TSV043", "length"],
      ["TSV043", "sort"],
      ["TSV043", "1.5"],
    ],
  );
  assert.deepEqual(codes('let t = timer async 5\nsave t as "k"\nlet c = chance("x")'), [
    ["TSV043", "t"],
    ["TSV043", '"x"'],
  ]);
  // Equality compares values of any kinds, and text compares with text.
  assert.deepEqual(
    codes('let same = 1 == "1"\nlet before = "a" < "b"\nlet longer = 2 s > 1 s'),
    [],
  );
});

test("round, floor, and ceil give whole numbers as V30 section 13 specifies", () => {
  assert.deepEqual(
    sayTexts(
      [
        'say "${round(2.4)} ${round(2.5)} ${round(-2.5)} ${round(0.5)} ${round(-0.5)}"',
        'say "${floor(-2.5)} ${ceil(-2.5)} ${floor(2)} ${ceil(-0.5)}"',
        "let shares: integer = floor(10 / 4)",
        'say "${shares}"',
      ].join("\n"),
    ),
    ["2 3 -3 1 -1", "-3 -2 2 0", "2"],
  );
  assert.deepEqual(codes('let r = round("2")'), [["TSV043", '"2"']]);
  const dynamic = runValidSource(
    'function dynamic(value) {\n    return value\n}\nsay "${round(dynamic("2"))}"',
  );
  assert.equal(dynamic.snapshot.failure?.code, "TSR012");
});

test("an error inside a stored literal or a typed load default is reported once", () => {
  assert.deepEqual(codes('let xs: integer[] = [1 + "a"]'), [["TSV043", '1 + "a"']]);
  assert.deepEqual(codes('let level: integer = load "k" default (1 + "x")'), [
    ["TSV043", '1 + "x"'],
  ]);
});
