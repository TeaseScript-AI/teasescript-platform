// A place keeps its declared or inferred type: variables, elements, optional types, handles, literals and choice
// results, the fix that writes another type, and type inference over deeply nested expressions.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../../../src/compiler.js";
import { mismatches, codes, sayTexts } from "../../helpers/type-core/type-enforcement-setup.js";

test("a variable keeps its declared or inferred type", () => {
  assert.deepEqual(mismatches('let score: number = "high"\nexit'), [
    [
      "TSV041",
      "'score' is declared as number, so it cannot start as text (string). To allow both, declare it as 'let score: number | string = ...'.",
      '"high"',
    ],
  ]);
  assert.deepEqual(mismatches('let score = 10\nscore = "high"\nexit'), [
    [
      "TSV041",
      "'score' holds a whole number (integer), so it cannot be set to text (string). To allow both, declare it as 'let score: integer | string = ...'.",
      '"high"',
    ],
  ]);
  assert.deepEqual(mismatches('let answer = askText "Name?"\nanswer = 5\nexit'), [
    [
      "TSV041",
      "'answer' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
      "5",
    ],
  ]);
});

test("compound assignment keeps the variable's type", () => {
  assert.deepEqual(mismatches("let count = 1\ncount += 2\ncount -= 1\nexit"), []);
  assert.deepEqual(mismatches("let count: integer = 1\ncount += 0.5\nexit"), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so '+=' cannot make it a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
      "0.5",
    ],
  ]);
  assert.deepEqual(mismatches('let count = 1\ncount += "x"\nexit'), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so text (string) cannot be added to it. Use a number instead.",
      '"x"',
    ],
  ]);
  assert.deepEqual(mismatches("let pause = 5 s\npause -= 2\nexit"), [
    [
      "TSV041",
      "'pause' holds a duration, so a whole number (integer) cannot be subtracted from it. Give the number a unit, such as '2 s'.",
      "2",
    ],
  ]);
  assert.deepEqual(mismatches("let pause = 5 s\npause -= 2 s\nexit"), []);
  for (const [target, operator] of [
    ["count", "+="],
    ["items[0]", "-="],
  ])
    for (const operand of ["[2]", 'set["a"]', "{ a: 1 }", "null", "extra"])
      assert.deepEqual(
        mismatches(
          `let count = 1\nlet items = [1]\nlet extra: integer[]? = [2]\n${target} ${operator} ${operand}\nexit`,
        ).map(([code, , text]) => [code, text]),
        [["TSV041", operand]],
        `${target} ${operator} ${operand}`,
      );
  assert.deepEqual(
    mismatches(
      'let count = 1\nlet saved = load "co" + "unt", default: null\ncount += saved\ncount -= saved\nexit',
    ),
    [],
  );
  assert.deepEqual(
    mismatches("let items: integer[] = [1]\nitems[0] += 0.5\nexit")[0]?.[1],
    "'items' holds integer values (integer[]), so '+=' cannot make an element a number. To allow fractions, declare it as 'let items: number[] = ...'.",
  );
});

test("null needs an optional type", () => {
  assert.deepEqual(mismatches("let name: string = null\nexit"), [
    [
      "TSV041",
      "'name' is declared as string, so it cannot start as null. To allow null, declare it as 'let name: string? = ...'.",
      "null",
    ],
  ]);
  assert.deepEqual(mismatches('let name: string? = null\nname = "Ada"\nname = null\nexit'), []);
});

test("lists keep their element type, and loop variables take it", () => {
  assert.deepEqual(mismatches('let scores = [1, 2]\nscores.add("x")\nscores[0] = "y"\nexit'), [
    [
      "TSV041",
      "'scores' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'let scores: (integer | string)[] = ...'.",
      '"x"',
    ],
    [
      "TSV041",
      "'scores' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'let scores: (integer | string)[] = ...'.",
      '"y"',
    ],
  ]);
  assert.deepEqual(mismatches("let ratios = [1, 2.5]\nratios.add(3)\nexit"), []);
  assert.deepEqual(
    mismatches('let names: string set = set[]\nnames.add("Ada")\nnames.add(1)\nexit'),
    [
      [
        "TSV041",
        "'names' holds string values (string set), so it cannot contain a whole number (integer). To allow both, declare it as 'let names: (string | integer) set = ...'.",
        "1",
      ],
    ],
  );
  assert.deepEqual(mismatches('for step in 1..=3 {\n    step = "x"\n}\nexit'), [
    [
      "TSV041",
      // No type can be written for a loop variable.
      "'step' holds a whole number (integer), so it cannot be set to text (string). Use a separate variable for a value of another type.",
      '"x"',
    ],
  ]);
});

test("a fix writes another type where the place declares its type, and the code it suggests compiles", () => {
  // A parameter is declared in its function's parameter list (V30 §11), with its default, also after another default.
  assert.deepEqual(
    mismatches(
      [
        "function f(xs = [1], n = 1, m = null) {",
        '    xs.add("a")',
        "    n = null",
        '    xs = xs + ["b"]',
        '    m = askChoice 1, "c"',
        "}",
        "f()",
        "function g(xs: integer[], a = 1, k: integer = 2) {",
        "    k = 2.5",
        "}",
        'g(["d"])',
        "g([1], 1, 3.5)",
        'global gs: integer[] = ["e"]',
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV041",
        "'gs' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'global gs: (integer | string)[] = ...'.",
        '"e"',
      ],
      [
        "TSV041",
        "'xs' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare the parameter as 'xs: (integer | string)[] = ...'.",
        '"a"',
      ],
      [
        "TSV041",
        "'n' holds a whole number (integer), so it cannot be set to null. To allow null, declare the parameter as 'n: integer? = 1'.",
        "null",
      ],
      [
        "TSV044",
        "'+' would mix a whole number (integer) and text (string). A list holds one type. To keep both, declare the parameter as 'xs: (integer | string)[] = ...'.",
        'xs + ["b"]',
      ],
      [
        "TSV044",
        "This askChoice returns a whole number (integer) or text (string). A place keeps one type. To keep both, declare the parameter as 'm: integer | string = ...'.",
        'askChoice 1, "c"',
      ],
      [
        "TSV041",
        "'k' holds a whole number (integer), so it cannot be set to a number. Round it with floor(...), round(...), or ceil(...), or declare the parameter as 'k: number = 2'.",
        "2.5",
      ],
      [
        "TSV041",
        "'xs' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare the parameter as 'xs: (integer | string)[]'.",
        '"d"',
      ],
      [
        "TSV041",
        "'g' takes 'k' as a whole number (integer), so it cannot take a number. Round it with floor(...), round(...), or ceil(...), or declare the parameter as 'k: number = 2'.",
        "3.5",
      ],
    ],
  );
  assert.deepEqual(
    codes(
      [
        'function f(xs: (integer | string)[] = [1], n: integer? = 1, m: integer | string = "") {',
        '    xs.add("a")',
        "    n = null",
        '    xs = xs + ["b"]',
        '    m = askChoice 1, "c"',
        "}",
        "f()",
        "function g(xs: (integer | string)[], a = 1, k: number = 2) {",
        "    k = 2.5",
        "}",
        'g(["d"])',
        "g([1], 1, 3.5)",
        'global gs: (integer | string)[] = ["e"]',
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("a place with no declaration to change, a property, a loop variable, a dict's computed list or a media handle, gets a fix without one, and a property given a typed first value takes both types", () => {
  // A property has no written type (V30 §15, §37), so its first value gives it one. A loop variable, a property that a
  // dict computes (V30 §40), whose change is also lost with the copy (owner decision O3), and a media block's own handle
  // have no declaration to change.
  assert.deepEqual(
    mismatches(
      [
        "let door = { keys: [1] }",
        'door.keys.add("x")',
        "speaker vera { items: [1] }",
        'vera.items.add("x")',
        "for xs in [[1]] {",
        '    xs.add("y")',
        "}",
        "let d = dict{ a: 1 }",
        "d.keys.add(2)",
        'let music = playAudio async "music.mp3" {',
        "    at 1 s { music = 1 }",
        "}",
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV041",
        "'door.keys' holds integer values (integer[]), so it cannot contain text (string). To allow both, give 'door.keys' a first value of type (integer | string)[], such as a variable declared with that type.",
        '"x"',
      ],
      [
        "TSV041",
        "'vera.items' holds integer values (integer[]), so it cannot contain text (string). To allow both, give 'vera.items' a first value of type (integer | string)[], such as a variable declared with that type.",
        '"x"',
      ],
      [
        "TSV041",
        "'xs' holds integer values (integer[]), so it cannot contain text (string). Use a separate list for values of another type.",
        '"y"',
      ],
      [
        "TSV041",
        "'d.keys' holds string values (string[]), so it cannot contain a whole number (integer). Use a separate list for values of another type.",
        "2",
      ],
      [
        "TSV067",
        "This changes a copy that no variable holds: 'd.keys' gives a new list each time, so the change is lost. Change the dict itself, as in 'd[key] = value' or 'd.remove(key)'.",
        "d.keys",
      ],
      [
        "TSV041",
        "'music' holds a media handle, so it cannot be set to a whole number (integer). Use a separate variable for a value of another type.",
        "1",
      ],
    ],
  );
  assert.deepEqual(
    sayTexts(
      [
        "let keys: (integer | string)[] = [1]",
        "let door = { keys: keys }",
        'door.keys.add("x")',
        "global items: (integer | string)[] = [1]",
        "speaker vera { items: items }",
        'vera.items.add("x")',
        'say "${door.keys.length} ${vera.items.length}"',
        "exit",
      ].join("\n"),
    ),
    ["2 2"],
  );
});

test("handles, speakers, and a typed load default keep their types", () => {
  assert.deepEqual(
    mismatches(
      'speaker mistress { name: "Mistress" }\nlet voice = mistress\nvoice = "x"\nexit',
    )[0]?.[0],
    "TSV041",
  );
  assert.deepEqual(mismatches("let clock = timer async 5 s\nclock = 3\nexit")[0]?.[0], "TSV041");
  assert.deepEqual(mismatches('let level: integer = load "level", default: "high"\nexit'), [
    [
      "TSV041",
      "'level' is declared as integer, so it cannot start as text (string). To allow both, declare it as 'let level: integer | string = ...'.",
      '"high"',
    ],
  ]);
  // A load assigned to an existing place checks its default as well, as if the default were assigned.
  assert.deepEqual(
    mismatches('let count: integer = 0\ncount = load "count", default: "none"\nexit'),
    [
      [
        "TSV041",
        "'count' holds a whole number (integer), so it cannot be set to text (string). To allow both, declare it as 'let count: integer | string = ...'.",
        '"none"',
      ],
    ],
  );
  assert.deepEqual(
    mismatches('let tally = { n: 1 }\ntally.n = load "n", default: "x"\nexit')[0]?.[2],
    '"x"',
  );
  assert.deepEqual(
    mismatches('let marks = [1]\nmarks[0] = load "m", default: "x"\nexit')[0]?.[2],
    '"x"',
  );
  assert.deepEqual(mismatches('let count = 0\ncount = load "count", default: 2.5\nexit'), []);
});

test("a list or set literal is checked element by element against a known element type", () => {
  assert.deepEqual(mismatches('let names: string[] = ["a", 1]\nexit'), [
    [
      "TSV041",
      "'names' holds string values (string[]), so it cannot contain a whole number (integer). To allow both, declare it as 'let names: (string | integer)[] = ...'.",
      "1",
    ],
  ]);
  assert.deepEqual(mismatches('let scores = [1, 2]\nscores = ["a", 3]\nexit')[0]?.[2], '"a"');
  assert.deepEqual(mismatches('let tags: string set = set["a", 2]\nexit')[0]?.[2], "2");
  assert.deepEqual(mismatches("let ratios: number[] = [1, 2.5]\nlet marks = [null, 1]\nexit"), []);
});

test("optional types keep their non-null type in operations, elements, and loops", () => {
  assert.deepEqual(mismatches("let count: integer? = 1\ncount += 0.5\nexit"), [
    [
      "TSV041",
      "'count' holds a whole number (integer) or null, so '+=' cannot make it a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number? = ...'.",
      "0.5",
    ],
  ]);
  assert.deepEqual(
    mismatches(
      'let items: integer[]? = [1]\nitems.add("bad")\nitems[0] += "x"\nfor item in items {\n    item = "x"\n}\nexit',
    ).map(([code]) => code),
    ["TSV041", "TSV041", "TSV041"],
  );
  assert.deepEqual(
    mismatches("let items: integer[]? = [1]\nitems.add(2.5)\nexit")[0]?.[1],
    "'items' holds integer values (integer[]), so it cannot contain a number. To allow fractions, declare it as 'let items: number[]? = ...'.",
  );
  // A possibly null value is used only after a check, which narrows it (owner decision on #504 Q1).
  const nullable = "let items = [1]\nfunction f(n: integer?) {\n    BODY\n}\nexit";
  for (const [body, code] of [
    ['say "${items[n]}"', "TSV043"],
    ['say "${n + 1}"', "TSV043"],
    ['repeat n {\n        say "x"\n    }', "TSV011"],
  ] as const)
    assert.deepEqual(
      mismatches(nullable.replace("BODY", body)),
      [
        [
          code,
          "'n' must be checked for null before it is used here: its type is 'integer?' (line 2). Check it first: if n != null { ... }, or give a fallback: n otherwise 0",
          "n",
        ],
      ],
      body,
    );
  assert.deepEqual(mismatches(nullable.replace("BODY", "let m: integer = n")), [
    [
      "TSV041",
      "'m' is declared as integer, so it cannot start as a whole number (integer) or null. Check it first: if n != null { ... }, or give a fallback: n otherwise 0",
      "n",
    ],
  ]);
  assert.deepEqual(
    codes(nullable.replace("BODY", 'if n != null {\n        say "${items[n]} ${n + 1}"\n    }')),
    [],
  );
  assert.deepEqual(mismatches("function f(v: number?) {\n    return round(v)\n}\nexit"), [
    [
      "TSV043",
      "'v' must be checked for null before it is used here: its type is 'number?' (line 1). Check it first: if v != null { ... }, or give a fallback: v otherwise 0",
      "v",
    ],
  ]);
  assert.deepEqual(codes('let t: string? = "a"\nlet r = round(t)\nexit'), [["TSV043", "t"]]);
  // Also beside an operand of unknown type, as a timer range, or as the receiver of a new property. The fallback the
  // message names is of the value's type, or a placeholder for a type without a short literal (owner decision on #850).
  for (const [source, fallback, code, type] of [
    ["function f(n: integer?, other) {\n    return n + other\n}\nexit", "0", "TSV043", "integer?"],
    ["function f(n: integer?) {\n    return n + n\n}\nexit", "0", "TSV043", "integer?"],
    // Text joins other text, so beside an operand of unknown type only null needs a check.
    ["function f(n: string?, other) {\n    return n + other\n}\nexit", '""', "TSV043", "string?"],
    ["function f(n: range?) {\n    timer async n s\n}\nexit", "...", "TSV043", "range?"],
  ] as const)
    assert.deepEqual(
      mismatches(source).map(([code, message]) => [code, message]),
      [
        [
          code,
          `'n' must be checked for null before it is used here: its type is '${type}' (line 1). Check it first: if n != null { ... }, or give a fallback: n otherwise ${fallback}`,
        ],
      ],
      source,
    );
  assert.deepEqual(codes("let box = null\nbox = {}\nfunction f {\n    box.extra = 1\n}\nexit"), [
    ["TSV043", "box"],
  ]);
  // A member that no value could combine with is reported as it is, not as a missing check.
  assert.deepEqual(
    mismatches("function f(n: boolean?, other) {\n    return n + other\n}\nexit")[0]?.[0],
    "TSV043",
  );
  assert.match(
    mismatches("function f(n: boolean?, other) {\n    return n + other\n}\nexit")[0]?.[1] ?? "",
    /cannot combine true or false/,
  );
});

test("number times duration is a duration, and a media cue's own handle keeps its type", () => {
  assert.deepEqual(mismatches('let pause = 2 * (1 s)\npause = "x"\nexit')[0]?.[0], "TSV041");
  assert.deepEqual(
    mismatches(
      'let music = playAudio async "music.mp3" {\n    at 1 s { music = 1 }\n}\nexit',
    )[0]?.[0],
    "TSV041",
  );
});

test("null suggestions name only annotations that exist", () => {
  assert.deepEqual(
    mismatches("let items = []\nitems = null\nexit")[0]?.[1],
    "'items' holds a list, so it cannot be set to null. Use a separate variable for null.",
  );
  assert.deepEqual(
    mismatches("let items = [1]\nitems = null\nexit")[0]?.[1],
    "'items' holds a list (integer[]), so it cannot be set to null. To allow null, declare it as 'let items: integer[]? = ...'.",
  );
});

test("type inference handles deeply nested expressions without native recursion", () => {
  const source = `let total = ${Array.from({ length: 20_000 }, () => "1").join(" + ")}\ntotal = 2\nexit`;
  assert.deepEqual(compileSource(source).diagnostics, []);
});

test("an error inside a stored literal or a typed load default is reported once", () => {
  assert.deepEqual(codes('let xs: integer[] = [1 + "a"]\nexit'), [["TSV043", '1 + "a"']]);
  assert.deepEqual(codes('let level: integer = load "k", default: (1 + "x")\nexit'), [
    ["TSV043", '1 + "x"'],
  ]);
});

test("a list or set literal of known types holds one type, also in nested lists and objects", () => {
  assert.deepEqual(mismatches('let values = ["Level", 2, 3.5]\nexit'), [
    [
      "TSV044",
      "This list mixes text (string) and a whole number (integer). A list holds one type. To keep both, declare a union type, as in 'let values: (string | number)[] = ...'.",
      '["Level", 2, 3.5]',
    ],
  ]);
  assert.deepEqual(codes('let nested = [[1], ["x"]]\nlet tags = set["a", true]\nexit'), [
    ["TSV044", '[[1], ["x"]]'],
    ["TSV044", 'set["a", true]'],
  ]);
  assert.deepEqual(
    mismatches('let people = [{ name: 1 }, { name: "Ada" }]\nexit')[0]?.[1],
    "This list mixes objects whose property 'name' holds a whole number (integer) in one and text (string) in another. A list holds one type. Give 'name' one type in every element.",
  );
  // A declared element type checks each element instead, and unknown elements leave the element type unknown.
  assert.deepEqual(
    codes(
      'function pick(value) {\n    return value\n}\nlet mixed = [1, pick("x")]\nmixed.add(true)\nexit',
    ),
    [],
  );
});

test("a choice result has the type of its values, and an option without a written value returns itself", () => {
  assert.deepEqual(codes("let n: integer = askChoice [5, 10, 15]\nn = 2.5\nexit"), [
    ["TSV041", "2.5"],
  ]);
  assert.deepEqual(codes("let n = askChoice 5, 10\nn = 20\nexit"), []);
  assert.deepEqual(codes("let n: integer = askChoice set[5, 10]\nn = 2.5\nexit"), [
    ["TSV041", "2.5"],
  ]);
  // An empty list or set gives no buttons, so its written value is never the result.
  assert.deepEqual(codes('let n: integer = askChoice 1.5: [], 2: ["Only"]\nexit'), []);
  assert.deepEqual(codes('let n: integer = askChoice 1.5: set[], 2: ["Only"]\nexit'), []);
  assert.deepEqual(codes("let n: string = askChoice 5, 10\nexit"), [["TSV041", "askChoice 5, 10"]]);
  assert.deepEqual(codes('let n = askChoice 1: "One", 2.5: "Two"\nn = 0.5\nexit'), []);
  assert.deepEqual(codes("let d = askChoice [1 min, 90 seconds]\nd = 5\nexit"), [["TSV041", "5"]]);
  assert.deepEqual(codes('let n = askChoice [{ text: "Five", value: 5 }]\nn = "five"\nexit'), [
    ["TSV041", '"five"'],
  ]);
  assert.deepEqual(codes('let pets = ["pet", "toy"]\nlet pick = askChoice pets\npick = 3\nexit'), [
    ["TSV041", "3"],
  ]);
  assert.deepEqual(
    codes('let answer = askChoice back: "Back", "Corner"\nanswer = "other"\nexit'),
    [],
  );
  // A `null` value and an optional option keep their types.
  assert.deepEqual(
    codes('let answer: integer = askChoice { text: "Nothing", value: null }\nexit'),
    [["TSV041", 'askChoice { text: "Nothing", value: null }']],
  );
  assert.deepEqual(
    codes("let value: integer? = null\nlet answer = askChoice value\nanswer = null\nexit"),
    [],
  );
  // A direct option is the value as it was evaluated: a later option's call does not change it.
  const fill = 'let token = null\nfunction fill {\n    token = 9\n    return "Ready"\n}\n';
  assert.deepEqual(codes(`${fill}let answer: integer? = askChoice token, fill()\nexit`), [
    ["TSV041", "askChoice token, fill()"],
  ]);
  assert.deepEqual(codes(`${fill}let answer: string? = askChoice token, fill()\nexit`), []);
  // A computed choice object returns its value or text, whose type is not known here.
  assert.deepEqual(
    codes(
      'let option = { text: "Yes" }\nlet answer: string = askChoice option\nlet other = askChoice [option]\nsay "${other}"\nexit',
    ),
    [],
  );
});
