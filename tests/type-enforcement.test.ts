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
  assert.deepEqual(mismatches("let count: integer = 10\ncount = count / 4"), [
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

test("an unannotated integer variable is a number when one of its assignments can store a non-whole number", () => {
  assert.deepEqual(sayTexts("let speed = 1\nspeed = speed * 1.5\nsay speed"), ["1.5"]);
  assert.deepEqual(sayTexts("let total = 0\ntotal += 0.5\nsay total"), ["0.5"]);
  assert.deepEqual(
    sayTexts('let items = ["a", "b"]\nlet count = 0\ncount += 1\nsay items[count]'),
    ["b"],
  );
  // The variable is a number everywhere, also before the assignment, so an integer-only use names that assignment.
  assert.deepEqual(mismatches("let items = [1, 2]\nlet i = 0\nsay items[i]\ni = i / 2"), [
    [
      "TSV043",
      "A list index must be a whole number (integer), but this is a number. 'i' is a number because line 4 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...).",
      "i",
    ],
  ]);
  assert.deepEqual(mismatches("let speed = 1\nlet steps: integer = speed\nspeed = speed * 1.5"), [
    [
      "TSV041",
      "'steps' is declared as integer, so it cannot start as a number. 'speed' is a number because line 3 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...), or declare it as 'let steps: number = ...'.",
      "speed",
    ],
  ]);
  for (const [source, use] of [
    ["let items = [1, 2]\nlet i = 1\ni = i * 0.5\nlet x = items.removeAt(i)", "i"],
    ['let n = 2\nn = n / 2\nrepeat n {\n    say "x"\n}', "n"],
    ["let items = [1]\nlet x = null\nx = 0\nx = 0.5\nsay items[x]", "x"],
    ["let items = [1]\nfor i in [0] {\n    i = i / 2\n    say items[i]\n}", "i"],
  ] as const)
    assert.deepEqual(codes(source), [["TSV043", use]], source);
  // A variable that takes another widened variable widens too, wherever the assignment is checked.
  assert.deepEqual(codes("let b = 0\nlet a = 1\na = a / 2\nb = a\nlet k: integer = b"), [
    ["TSV041", "b"],
  ]);
  assert.deepEqual(
    codes(
      "let speed = 1\nlet k: integer = speed\nfunction faster {\n    speed = speed * 1.5\n}\nfaster()",
    ),
    [["TSV041", "speed"]],
  );
  // A long chain widens in either order, through arithmetic, a `choose`, a literal read at once, or a function result.
  const names = Array.from({ length: 2_000 }, (_, index) => `v${index}`);
  const declarations = names.map((name) => `let ${name} = 0`).join("\n");
  for (const copy of [
    (name: string) => `${name} + 1`,
    (name: string) => `choose ${name}, 1`,
    (name: string) => `{ n: ${name} }.n`,
    (name: string) => `choose { text: ${name} }`,
    (name: string) => `set[${name}].first`,
    (name: string) => `read_${name}()`,
  ]) {
    const functions = names.map((name) => `function read_${name} {\n    return ${name}\n}`);
    const copies = names.slice(1).map((name, index) => `${names[index]} = ${copy(name)}`);
    for (const order of [copies, [...copies].reverse()])
      assert.deepEqual(
        codes(
          `${declarations}\n${functions.join("\n")}\n${order.join("\n")}\nv1999 = 0.5\nlet k: integer = v0`,
        ),
        [["TSV041", "v0"]],
        copy("v"),
      );
  }
  // Functions that call each other many times share their sources once.
  const calls = Array.from(
    { length: 24 },
    (_, index) => `function f${index + 1} {\n    return f${index}() + f${index}()\n}`,
  );
  assert.deepEqual(codes(`let v = 0\nfunction f0 {\n    return v\n}\n${calls.join("\n")}`), []);
  // A variable whose first value may be null widens to `number?`, and a use through arithmetic names the assignment.
  const nullFirst =
    "let items = [10, 20]\nlet first: integer? = 0\nlet i = null\ni = first\ni = 0.5\n";
  assert.deepEqual(codes(`${nullFirst}say items[i]`), [["TSV043", "i"]]);
  assert.deepEqual(codes(`${nullFirst}let strict: integer? = i`), [["TSV041", "i"]]);
  assert.deepEqual(
    mismatches("let items = [10, 20]\nlet i = 0\nsay items[i + 1]\ni = 0.5")[0]?.[1],
    "A list index must be a whole number (integer), but this is a number. 'i' is a number because line 4 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...).",
  );
  // Assignments in its body widen a parameter's default, but calls never do; properties and elements keep their type.
  assert.deepEqual(
    sayTexts(
      "function half(times = 1) {\n    times = times / 2\n    return times\n}\nsay half(3)\nsay half(2.5)",
    ),
    ["1.5", "1.25"],
  );
  assert.deepEqual(codes("function f(times = 1) {\n    return times\n}\nlet r = f(2.5)"), [
    ["TSV041", "2.5"],
  ]);
  assert.deepEqual(codes("let o = { n: 1 }\no.n = 1.5"), [["TSV041", "1.5"]]);
});

test("compound assignment keeps the variable's type", () => {
  assert.deepEqual(mismatches("let count = 1\ncount += 2\ncount -= 1"), []);
  assert.deepEqual(mismatches("let count: integer = 1\ncount += 0.5"), [
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
  assert.deepEqual(mismatches("let ratios: number[] = [1, 2.5]\nlet marks = [null, 1]"), []);
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
  // An optional whole number may serve as an index or a repeat count, and an optional value as a built-in's argument;
  // only a null value fails at runtime.
  assert.deepEqual(
    codes('let n: integer? = 0\nlet items = [1]\nsay "${items[n]}"\nrepeat n {\n    say "x"\n}'),
    [],
  );
  assert.deepEqual(
    codes(
      'let v: number? = 2.5\nlet r = round(v)\nlet t: string? = "<b>"\nlet e = escapeMarkup(t)',
    ),
    [],
  );
  assert.deepEqual(codes('let t: string? = "a"\nlet r = round(t)'), [["TSV043", "t"]]);
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
  assert.deepEqual(
    mismatches('let door = {}\ndoor.owner = [null, 1][0]\ndoor.owner = "Ada"')[0]?.[1],
    "'door.owner' holds a whole number (integer) or null since line 2, so it cannot be set to text (string). Use a separate property for a value of another type.",
  );
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
      "function fact(n: integer): integer {\n    if n <= 1 {\n        return 1\n    }\n    return n * fact(n - 1)\n}\nlet x: integer = fact(5)\nx = 2.5",
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
      'let r = 1..3\nlet q = r + 1\nlet less = "a" < 1\nlet x = 5\nsay x.length\nlet items = [1]\nitems.noSuchMethod()\nsay items[1.5]',
    ),
    [
      ["TSV043", "r + 1"],
      ["TSV043", '"a" < 1'],
      ["TSV043", "length"],
      ["TSV043", "noSuchMethod"],
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

test("a list or set literal of known types holds one type, also in nested lists and objects", () => {
  assert.deepEqual(mismatches('let values = ["Level", 2, 3.5]'), [
    [
      "TSV044",
      "This list mixes text (string) and a whole number (integer). A list holds one type; keep values of different types in separate lists.",
      '["Level", 2, 3.5]',
    ],
  ]);
  assert.deepEqual(codes('let nested = [[1], ["x"]]\nlet tags = set["a", true]'), [
    ["TSV044", '[[1], ["x"]]'],
    ["TSV044", 'set["a", true]'],
  ]);
  assert.deepEqual(
    mismatches('let people = [{ name: 1 }, { name: "Ada" }]')[0]?.[1],
    "This list mixes objects whose property 'name' holds a whole number (integer) in one and text (string) in another. A list holds one type; keep values of different types in separate lists.",
  );
  // A declared element type checks each element instead, and unknown elements leave the element type unknown.
  assert.deepEqual(
    codes(
      'function pick(value) {\n    return value\n}\nlet mixed = [1, pick("x")]\nmixed.add(true)',
    ),
    [],
  );
});

test("a first null is remembered wherever a first value decides a type", () => {
  assert.deepEqual(
    codes("let door = {}\ndoor.owner = null\ndoor.owner = 1\ndoor.owner = null"),
    [],
  );
  assert.deepEqual(codes("let x = null\nx = [null]\nx[0] = 1"), []);
  assert.deepEqual(
    codes("let items = []\nitems.add(null)\nitems.add(1)\nitems.add(null)\nitems.add(true)"),
    [["TSV041", "true"]],
  );
  // A join keeps a first null from either side; an empty collection that never took null adds nothing.
  for (const [empty, other] of [
    ["[]", "[1]"],
    ["set[]", "set[1]"],
  ] as const) {
    const seen = `let a = ${empty}\na.add(null)\n`;
    assert.deepEqual(codes(`${seen}let b = [a, ${other}]\nb[0].add(null)`), [], empty);
    assert.deepEqual(codes(`${seen}let b = [${other}, a]\nb[1].add(null)`), [], empty);
  }
  assert.deepEqual(codes("let a = [null]\nlet b = [[1], a]\nb[1].add(null)"), []);
  assert.deepEqual(
    codes(
      "let a = []\na.add(null)\nfunction f(flag) {\n    if flag {\n        return a\n    }\n    return [1]\n}\nlet r = f(true)\nr.add(null)",
    ),
    [],
  );
  assert.deepEqual(codes("let a = []\nlet b = [a, [1]]\nb[0].add(null)"), [["TSV041", "null"]]);
});

test("calls never decide parameter types, and an unknown return makes a result unknown", () => {
  assert.deepEqual(
    codes(
      'function get(record = {}) {\n    return record.item\n}\nlet a = get({ item: 1 })\nget({ item: "x" })\nlet b: string = get({ item: 1 })',
    ),
    [],
  );
  assert.deepEqual(
    codes(
      'function f(value) {\n    if chance(50) {\n        return 1\n    }\n    return value\n}\nlet a: string = f("x")',
    ),
    [],
  );
  // A recursive call keeps the declared result type.
  assert.deepEqual(
    codes(
      'function f(n: integer): string {\n    if n == 0 {\n        return "x"\n    }\n    return f(n - 1) + 1\n}\nlet a = f(1)',
    ),
    [["TSV043", "f(n - 1) + 1"]],
  );
});

test("a loop that certainly runs, or ends only through a return, ends the function", () => {
  for (const body of [
    "repeat 1 {\n        return 1\n    }",
    "for n in [1] {\n        return n\n    }",
    "for n in 1..=3 {\n        return n\n    }",
    "while true {\n        return 1\n        break\n    }",
  ])
    assert.deepEqual(codes(`function f: integer {\n    ${body}\n}\nlet a = f()`), [], body);
  assert.deepEqual(codes("function f(n): integer {\n    repeat n {\n        return 1\n    }\n}"), [
    ["TSV041", "f"],
  ]);
});

test("timer ranges and handle members are checked by type, wherever the value comes from", () => {
  assert.deepEqual(codes("let span = 1..=3\nlet t = timer async span"), []);
  assert.deepEqual(
    mismatches(
      "function make {\n    return timer async 1\n}\nlet t = make()\nt.nope()\nt.elapsed = 1 s\nsay t.colour",
    ).map(([code, message, text]) => [code, text, message]),
    [
      ["TSV043", "nope", "Timer handles have no method 'nope'; use pause(), resume(), or stop()."],
      [
        "TSV043",
        "elapsed",
        "Timer handle property 'elapsed' cannot be assigned; assign remaining, display, or repeatDuration.",
      ],
      ["TSV043", "colour", "Timer handles have no property 'colour'."],
    ],
  );
});

test("an object that does not fit adds no properties, and annotated functions run", () => {
  assert.deepEqual(codes('let x = { a: 1 }\nx = { b: true, a: "x" }\nx.b = 1'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(
    sayTexts(
      'function scale(value: number, by: integer = 2): number {\n    return value * by\n}\nsay "${scale(1.5)} ${scale(1, by: 3)}"',
    ),
    ["3 3"],
  );
});

test("a function result, a body, or a copy never changes the types another place keeps", () => {
  // Joining a function's returns copies a stored object's properties instead of changing them.
  assert.deepEqual(
    codes(
      "let objs = [{ a: 1 }, { b: 1 }]\nfunction f(flag) {\n    if flag {\n        return objs[0]\n    }\n    return { c: true }\n}\nlet result = f(true)\nobjs[0].c = 1",
    ),
    [],
  );
  // Every call is checked against the parameters as the whole body uses them, so identical calls agree.
  assert.deepEqual(
    codes("function f(obj = {}) {\n    obj.flag = true\n}\nf({ flag: 1 })\nf({ flag: 1 })"),
    [
      ["TSV041", "1"],
      ["TSV041", "1"],
    ],
  );
  assert.deepEqual(
    codes(
      'function f(opts = { a: 1 }, flag = false) {\n    if flag {\n        opts.b = "x"\n    }\n    let s: string = opts.b\n    return s\n}\nlet given = { a: 2, b: 5 }\nf(given)',
    ),
    [["TSV041", "given"]],
  );
  // A return that mixes types adds nothing to the result's properties.
  assert.deepEqual(
    codes(
      'function f(n) {\n    if n > 1 {\n        return { a: 1 }\n    }\n    if n > 2 {\n        return { b: "x", a: "s" }\n    }\n    return { a: 2, b: 3 }\n}\nlet r = f(1)\nlet s: integer = r.b',
    ),
    [["TSV044", '{ b: "x", a: "s" }']],
  );
  // A copy of a collection that has seen null may still take null.
  for (const empty of ["[]", "set[]"])
    assert.deepEqual(
      codes(`let a = ${empty}\na.add(null)\nlet b = a\nb.add(1)\nb.add(null)`),
      [],
      empty,
    );
  // A converted collection is a new one: in either order, each decides its element type on its own, and a first null
  // stays a first null in both. One already decided keeps its type.
  for (const [empty, convert, decided, nullFirst] of [
    ["[]", "toSet", "[1]", '[null, "x"]'],
    ["set[]", "toList", "set[1]", '[null, "x", null]'],
  ]) {
    for (const stores of ['a.add(1)\nb.add("x")', 'b.add("x")\na.add(1)'])
      assert.deepEqual(
        sayTexts(`let a = ${empty}\nlet b = a.${convert}()\n${stores}\nsay a\nsay b`),
        ["[1]", '["x"]'],
        stores,
      );
    assert.deepEqual(
      sayTexts(
        `let a = ${empty}\na.add(null)\nlet b = a.${convert}()\na.add(1)\nb.add("x")\nb.add(null)\nsay b`,
      ),
      [nullFirst],
    );
    assert.deepEqual(codes(`let a = ${decided}\nlet b = a.${convert}()\nb.add("x")`), [
      ["TSV041", '"x"'],
    ]);
  }
  // A return is the value as it was evaluated: a later statement of the body changes only the place it was read from.
  for (const [setup, read, write] of [
    ["let given = {}", "given", "given.flag = 1"],
    ["let given = {}", "(given)", "given.flag = 1"],
    ["let given = { nest: {} }", "given.nest", "given.nest.flag = 1"],
    ["let given = [{}]", "given[0]", "given[0].flag = 1"],
    ["", "local", "local.flag = 1"],
  ])
    assert.deepEqual(
      sayTexts(
        `${setup}\nfunction f(flag = false) {\n    let local = {}\n    if flag {\n        return ${read}\n    }\n    ${write}\n    return { flag: true }\n}\nsay f(true)\nsay f(false)`,
      ),
      ["{}", "{ flag: true }"],
      read,
    );
  assert.deepEqual(
    codes(
      "let given = { flag: 1 }\nfunction f(flag = false) {\n    if flag {\n        return given\n    }\n    return { flag: true }\n}\nlet result = f(true)",
    ),
    [["TSV044", "{ flag: true }"]],
  );
});

test("arguments are checked as they were evaluated, against the parameters of the whole body", () => {
  // The body and later arguments add properties to the caller's object only after the argument was evaluated.
  const given = "let given = {}\nfunction fill {\n    given.flag = 1\n    return 0\n}\n";
  for (const [parameter, use, call] of [
    ["obj = {}, n = 0", "obj.flag", "f(given)"],
    ["obj = {}, n = 0", "obj.flag", "f(given, fill())"],
    ["obj = {}, n = 0", "obj.flag", "f(holder.given, fill())"],
    ["obj = {}, n = 0", "obj.flag", "f(row[0], fill())"],
    ["obj = { nest: {} }", "obj.nest.flag", "f({ nest: given })"],
    ["items = [{}]", "items[0].flag", "f([given])"],
  ])
    assert.deepEqual(
      sayTexts(
        `${given}let holder = { given: {} }\nlet row = [{}]\nfunction f(${parameter}) {\n    ${use} = true\n    given.flag = 1\n    holder.given.flag = 1\n    row[0].flag = 1\n    return ${use}\n}\nsay "\${${call}}"`,
      ),
      ["true"],
      call,
    );
  // A converted collection is the elements as they were evaluated, also as a part of a literal argument; elements
  // added before the conversion must fit.
  for (const [empty, convert, typed, texts] of [
    ["[]", "toSet", "string set", 'set["s"]'],
    ["set[]", "toList", "string[]", '["s"]'],
  ]) {
    const functions = `let a = ${empty}\nfunction fill {\n    a.add(1)\n    return 0\n}\nfunction f(items: ${typed}, n = 0) {\n    return items.length\n}\nfunction g(obj = { items: ${texts}, tick: 0 }) {\n    return obj.items.length\n}\n`;
    const converted = `a.${convert}()`;
    for (const [call, earlier] of [
      [`f(${converted}, fill())`, `f(${converted})`],
      [`g({ items: ${converted}, tick: fill() })`, `g({ items: ${converted}, tick: 0 })`],
    ]) {
      assert.deepEqual(sayTexts(`${functions}say "\${${call}}"`), ["0"], call);
      assert.deepEqual(
        codes(`${functions}a.add(1)\nlet count = ${earlier}`),
        [["TSV041", converted]],
        earlier,
      );
    }
  }
  // A property the argument already has when it is evaluated must fit.
  assert.deepEqual(
    codes(
      "let given = { flag: 1 }\nfunction f(obj = { nest: {} }) {\n    obj.nest.flag = true\n}\nf({ nest: given })",
    ),
    [["TSV041", "given"]],
  );
  // A call made inside the body, directly or through another function, is checked once the body is complete.
  assert.deepEqual(
    codes(
      "function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return f({ flag: 1 }, 1)\n    }\n    obj.flag = true\n    return obj.flag\n}\nlet result = f()",
    ),
    [["TSV041", "1"]],
  );
  assert.deepEqual(
    codes(
      "function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return g()\n    }\n    obj.flag = true\n    return obj.flag\n}\nfunction g: boolean {\n    return f({ flag: 1 }, 1)\n}\nlet result = f()",
    ),
    [["TSV041", "1"]],
  );
  // A later part of a literal argument does not change an earlier part as it was evaluated.
  assert.deepEqual(
    sayTexts(
      `${given}function f(obj = { nest: {}, tick: 0 }) {\n    obj.nest.flag = true\n    return obj.nest.flag\n}\nsay "\${f({ nest: given, tick: fill() })}"`,
    ),
    ["true"],
  );
  // A call reached while the function's defaults are checked waits for its parameters too, and a list it mixes is
  // reported once, by the parameter that decides it.
  assert.deepEqual(
    codes(
      'function f(n: integer = seed(false)): integer {\n    return n\n}\nfunction seed(recurse = false): integer {\n    if recurse {\n        return f("bad")\n    }\n    return 0\n}\nlet result = f()',
    ),
    [["TSV041", '"bad"']],
  );
  assert.deepEqual(
    codes(
      'function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return f({ items: [1, "a"] }, 1)\n    }\n    obj.items = [1]\n    return true\n}\nf()',
    ),
    [["TSV041", '"a"']],
  );
  // A declared element type decides a literal argument also when the call checks the body first.
  assert.deepEqual(codes('function f(values: integer[]) {\n    say "x"\n}\nf([1, "a"])'), [
    ["TSV041", '"a"'],
  ]);
});

test("a loop that may end through continue can still reach the function's end", () => {
  for (const loop of [
    "repeat 1 {\n        continue\n    }",
    "for n in [1] {\n        continue\n    }",
  ])
    assert.deepEqual(codes(`function f: integer {\n    ${loop}\n}\nlet a: integer = f()`), [
      ["TSV041", "f"],
    ]);
});

test("a choice result has the type of its values, and an option without a written value returns itself", () => {
  assert.deepEqual(codes("let n: integer = choose [5, 10, 15]\nn = 2.5"), [["TSV041", "2.5"]]);
  assert.deepEqual(codes("let n = choose 5, 10\nn = 20"), []);
  assert.deepEqual(codes("let n: integer = choose set[5, 10]\nn = 2.5"), [["TSV041", "2.5"]]);
  // An empty list or set gives no buttons, so its written value is never the result.
  assert.deepEqual(codes('let n: integer = choose 1.5: [], 2: ["Only"]'), []);
  assert.deepEqual(codes('let n: integer = choose 1.5: set[], 2: ["Only"]'), []);
  assert.deepEqual(codes("let n: string = choose 5, 10"), [["TSV041", "choose 5, 10"]]);
  assert.deepEqual(codes('let n = choose 1: "One", 2.5: "Two"\nn = 0.5'), []);
  assert.deepEqual(codes("let d = choose [1 min, 90 seconds]\nd = 5"), [["TSV041", "5"]]);
  assert.deepEqual(codes('let n = choose [{ text: "Five", value: 5 }]\nn = "five"'), [
    ["TSV041", '"five"'],
  ]);
  assert.deepEqual(codes('let pets = ["pet", "toy"]\nlet pick = choose pets\npick = 3'), [
    ["TSV041", "3"],
  ]);
  assert.deepEqual(codes('let answer = choose back: "Back", "Corner"\nanswer = "other"'), []);
  // A `null` value and an optional option keep their types.
  assert.deepEqual(codes('let answer: integer = choose { text: "Nothing", value: null }'), [
    ["TSV041", 'choose { text: "Nothing", value: null }'],
  ]);
  assert.deepEqual(
    codes("let value: integer? = null\nlet answer = choose value\nanswer = null"),
    [],
  );
  // A direct option is the value as it was evaluated: a later option's call does not change it.
  const fill = 'let token = null\nfunction fill {\n    token = 9\n    return "Ready"\n}\n';
  assert.deepEqual(codes(`${fill}let answer: integer? = choose token, fill()`), [
    ["TSV041", "choose token, fill()"],
  ]);
  assert.deepEqual(codes(`${fill}let answer: string? = choose token, fill()`), []);
  // A computed choice object returns its value or text, whose type is not known here.
  assert.deepEqual(
    codes(
      'let option = { text: "Yes" }\nlet answer: string = choose option\nlet other = choose [option]\nsay "${other}"',
    ),
    [],
  );
});
