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

test("integer values widen to number, but not the reverse", () => {
  assert.deepEqual(
    mismatches("let ratio: number = 3\nratio = 2\nratio = ratio / 4\nratio += 1\nexit"),
    [],
  );
  assert.deepEqual(mismatches("let count: integer = 10\ncount = count / 4\nexit"), [
    [
      "TSV041",
      "'count' holds a whole number (integer), so it cannot be set to a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
      "count / 4",
    ],
  ]);
  assert.deepEqual(mismatches("let count: integer = 2.5\nexit"), [
    [
      "TSV041",
      "'count' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let count: number = ...'.",
      "2.5",
    ],
  ]);
});

test("an unannotated integer variable is a number when one of its assignments can store a non-whole number", () => {
  assert.deepEqual(sayTexts("let speed = 1\nspeed = speed * 1.5\nsay speed\nexit"), ["1.5"]);
  assert.deepEqual(sayTexts("let total = 0\ntotal += 0.5\nsay total\nexit"), ["0.5"]);
  assert.deepEqual(
    sayTexts('let items = ["a", "b"]\nlet count = 0\ncount += 1\nsay items[count]\nexit'),
    ["b"],
  );
  // The variable is a number everywhere, also before the assignment, so an integer-only use names that assignment.
  assert.deepEqual(mismatches("let items = [1, 2]\nlet i = 0\nsay items[i]\ni = i / 2\nexit"), [
    [
      "TSV043",
      "A list index must be a whole number (integer), but this is a number. 'i' is a number because line 4 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...).",
      "i",
    ],
  ]);
  assert.deepEqual(
    mismatches("let speed = 1\nlet steps: integer = speed\nspeed = speed * 1.5\nexit"),
    [
      [
        "TSV041",
        "'steps' is declared as integer, so it cannot start as a number. 'speed' is a number because line 3 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...), or declare it as 'let steps: number = ...'.",
        "speed",
      ],
    ],
  );
  for (const [source, use] of [
    ["let items = [1, 2]\nlet i = 1\ni = i * 0.5\nlet x = items.removeAt(i)\nexit", "i"],
    ['let n = 2\nn = n / 2\nrepeat n {\n    say "x"\n}\nexit', "n"],
    ["let items = [1]\nlet x = null\nx = 0\nx = 0.5\nsay items[x]\nexit", "x"],
    ["let items = [1]\nfor i in [0] {\n    i = i / 2\n    say items[i]\n}\nexit", "i"],
  ] as const)
    assert.deepEqual(codes(source), [["TSV043", use]], source);
  // A variable that takes another widened variable widens too, wherever the assignment is checked.
  assert.deepEqual(codes("let b = 0\nlet a = 1\na = a / 2\nb = a\nlet k: integer = b\nexit"), [
    ["TSV041", "b"],
  ]);
  assert.deepEqual(
    codes(
      "let speed = 1\nlet k: integer = speed\nfunction faster {\n    speed = speed * 1.5\n}\nfaster()\nexit",
    ),
    [["TSV041", "speed"]],
  );
  // A long chain widens in either order through every way a number flows on: arithmetic, a join such as `choose`, a
  // part of a collection or object built from it, a method that returns an element, and a function's result.
  const names = Array.from({ length: 2_000 }, (_, index) => `v${index}`);
  const declarations = names.map((name) => `let ${name} = 0`).join("\n");
  for (const copy of [
    (name: string) => `${name} + 1`,
    (name: string) => `choose ${name}, 1`,
    (name: string) => `{ n: ${name} }.n`,
    (name: string) => `[${name}].removeFirst()`,
    (name: string) => `read_${name}().first`,
  ]) {
    const functions = names.map((name) => `function read_${name} {\n    return [${name}]\n}`);
    const copies = names.slice(1).map((name, index) => `${names[index]} = ${copy(name)}`);
    for (const order of [copies, [...copies].reverse()])
      assert.deepEqual(
        codes(
          `${declarations}\n${functions.join("\n")}\n${order.join("\n")}\nv1999 = 0.5\nlet k: integer = v0\nexit`,
        ),
        [["TSV041", "v0"]],
        copy("v"),
      );
  }
  // A value that derives from many variables keeps every one, so the changing one may come after all others.
  const stable = Array.from({ length: 16 }, (_, index) => `s${index}`);
  const sums = names
    .slice(1, 500)
    .map((name, index) => `${names[index]} = ${[...stable, name].join(" + ")}`);
  assert.deepEqual(
    codes(
      `${declarations}\n${stable.map((name) => `let ${name} = 0`).join("\n")}\n${sums.join("\n")}\nv499 = 0.5\nlet k: integer = v0\nexit`,
    ),
    [["TSV041", "v0"]],
  );
  // A variable's first value counts as well: a chain of variables each starting as the next one widens at once.
  const firsts = names.slice(1).map((name, index) => `let first_${names[index]} = ${name}`);
  const fromFirsts = names.slice(1).map((_, index) => `${names[index]} = first_${names[index]}`);
  assert.deepEqual(
    codes(
      `${declarations}\n${firsts.join("\n")}\n${fromFirsts.reverse().join("\n")}\nv1999 = 0.5\nlet k: integer = v0\nexit`,
    ),
    [["TSV041", "v0"]],
  );
  // What a number derives from never makes types differ: numbers from different variables share one element type, and
  // messages name the plain type.
  assert.deepEqual(
    codes(
      "let a = 1\nlet b = 2\nlet both = [a, b, 1]\nboth.add(a + b)\nlet c: integer = both.first\nexit",
    ),
    [],
  );
  assert.deepEqual(
    mismatches("let a = 1\nlet s: string = a + 1\nexit")[0]?.[1],
    mismatches("let s: string = 1 + 1\nexit")[0]?.[1],
  );
  // Functions that call each other many times compile at once.
  const calls = Array.from(
    { length: 24 },
    (_, index) => `function f${index + 1} {\n    return f${index}() + f${index}()\n}`,
  );
  assert.deepEqual(
    codes(`let v = 0\nfunction f0 {\n    return v\n}\n${calls.join("\n")}\nexit`),
    [],
  );
  // A variable whose first value may be null widens to `number?`, and a use through arithmetic names the assignment.
  const nullFirst =
    "let items = [10, 20]\nlet first: integer? = 0\nlet i = null\ni = first\ni = 0.5\n";
  assert.deepEqual(codes(`${nullFirst}say items[i]\nexit`), [["TSV043", "i"]]);
  assert.deepEqual(codes(`${nullFirst}let strict: integer? = i\nexit`), [["TSV041", "i"]]);
  assert.deepEqual(
    mismatches("let items = [10, 20]\nlet i = 0\nsay items[i + 1]\ni = 0.5\nexit")[0]?.[1],
    "A list index must be a whole number (integer), but this is a number. 'i' is a number because line 4 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...).",
  );
  // Assignments in its body widen a parameter's default, but calls never do.
  assert.deepEqual(
    sayTexts(
      "function half(times = 1) {\n    times = times / 2\n    return times\n}\nsay half(3)\nsay half(2.5)\nexit",
    ),
    ["1.5", "1.25"],
  );
  assert.deepEqual(codes("function f(times = 1) {\n    return times\n}\nlet r = f(2.5)\nexit"), [
    ["TSV041", "2.5"],
  ]);
});

test("elements and properties of an unannotated variable widen to number like the variable", () => {
  for (const [source, said] of [
    ["let prices = [1, 2]\nprices.add(2.5)\nsay prices\nexit", "[1, 2, 2.5]"],
    ["let marks = set[1]\nmarks.add(0.5)\nsay marks\nexit", "[1, 0.5]"],
    ["let hero = { score: 0 }\nhero.score = 2.5\nsay hero\nexit", "{ score: 2.5 }"],
    ["let hero = { score: 0 }\nhero.score += 0.5\nsay hero\nexit", "{ score: 0.5 }"],
    ["let xs = []\nxs.add(1)\nxs[0] = 0.5\nsay xs\nexit", "[0.5]"],
    ["let rows = [{ n: 1 }]\nrows.first.n = 1.5\nsay rows\nexit", "[{ n: 1.5 }]"],
    ["let game = { scores: [1] }\ngame.scores.add(1.5)\nsay game\nexit", "{ scores: [1, 1.5] }"],
    ["let p = {}\np.bonus = 1\np = { bonus: 1.5 }\nsay p\nexit", "{ bonus: 1.5 }"],
    [
      "function f(items = [1]) {\n    items.add(1.5)\n    return items\n}\nsay f([2.5])\nexit",
      "[2.5, 1.5]",
    ],
  ] as const)
    assert.deepEqual(sayTexts(source), [said], source);
  // The widened type holds everywhere, so an integer-only use before the assignment is an error.
  assert.deepEqual(
    codes(
      'let prices = [1, 2]\nlet items = ["a", "b"]\nsay items[prices[0]]\nprices.add(2.5)\nexit',
    ),
    [["TSV043", "prices[0]"]],
  );
  assert.deepEqual(
    codes("let hero = { score: 0 }\nlet k: integer = hero.score\nhero.score = 2.5\nexit"),
    [["TSV041", "hero.score"]],
  );
  // So is a property that storing a whole object adds, before the assignment that widens it.
  assert.deepEqual(
    codes(
      "let record = { a: 1 }\nlet other = { a: 1, b: 2 }\nrecord = other\nlet k: integer = record.b\nrecord.b = 1.5\nexit",
    ),
    [["TSV041", "record.b"]],
  );
  // A value that is not a literal widens what it is stored in as well, and a chain of parts widens in one more check.
  assert.deepEqual(sayTexts("let p = { n: 1 }\nlet q = { n: 1.5 }\np = q\nsay p.n\nexit"), ["1.5"]);
  assert.deepEqual(sayTexts("let p = [1]\nlet q = [1.5]\np = q\nsay p\nexit"), ["[1.5]"]);
  const parts = Array.from({ length: 1_000 }, (_, index) => `let v${index} = { n: 0 }`);
  const links = Array.from({ length: 999 }, (_, index) => `v${index}.n = v${index + 1}.n + 1`);
  assert.deepEqual(
    codes(
      `${parts.join("\n")}\n${links.reverse().join("\n")}\nv999.n = 0.5\nlet k: integer = v0.n\nexit`,
    ),
    [["TSV041", "v0.n"]],
  );
  // A chain of whole collections copied into each other widens in one more check.
  const lists = Array.from({ length: 800 }, (_, index) => `let c${index} = [1]`);
  const copies = Array.from({ length: 799 }, (_, index) => `c${index} = c${index + 1}`);
  assert.deepEqual(
    codes(`${lists.join("\n")}\n${copies.join("\n")}\nc799 = [1.5]\nlet k: integer[] = c0\nexit`),
    [["TSV041", "c0"]],
  );
  // A part read under a test that keeps it whole does not widen what stores it.
  assert.deepEqual(
    codes(
      "let p = [1]\nlet k = { n: 0 }\nif p is integer[] {\n    k.n = p.first\n}\nlet strict: integer = k.n\np.add(1.5)\nexit",
    ),
    [],
  );
  // Also where the elements may be null: a whole copy or one element stays whole, but a number test keeps it widening.
  for (const [test, copy, check] of [
    ["integer?[]", "q = p", "let k: integer?[] = q"],
    ["integer?[]", "r.n = p.first", "let k: integer? = r.n"],
    ["number?[]", "q = p", "let k: integer?[] = q"],
  ] as const)
    assert.deepEqual(
      codes(
        `let p = [null, 1]\nlet q = [null]\nlet r = { n: null }\nif p is ${test} {\n    ${copy}\n}\n${check}\np.add(1.5)\nexit`,
      ),
      test === "number?[]"
        ? [
            ["TSV046", "p is number?[]"],
            ["TSV041", "q"],
          ]
        : [],
      `${test} ${copy}`,
    );
  // A write that widens a narrowed list ends what the test knew about its elements.
  assert.deepEqual(
    codes(
      'let names = ["a", "b"]\nlet p = [1]\nif p is integer[] {\n    p.add(1.5)\n    say names[p.last]\n}\nexit',
    ),
    [["TSV043", "p.last"]],
  );
  // A widened copy never changes the original, also through an optional type or a function result.
  assert.deepEqual(
    codes(
      "function f(xs: integer[]? = [1]) {\n    let copied = xs\n    if copied != null {\n        copied.add(1.5)\n    }\n    return xs\n}\nlet r = f([2.5])\nexit",
    ),
    [["TSV041", "2.5"]],
  );
  assert.deepEqual(
    codes(
      "function f(flag: boolean) {\n    if flag {\n        return [1]\n    }\n}\nlet a = f(true)\nif a != null {\n    a.add(1.5)\n}\nlet b: integer[]? = f(true)\nexit",
    ),
    [],
  );
  // A declared integer collection stays strict, and a copy widens on its own.
  assert.deepEqual(codes("let prices: integer[] = [1]\nprices.add(2.5)\nexit"), [
    ["TSV041", "2.5"],
  ]);
  assert.deepEqual(codes("let ids: integer set = set[1]\nids.add(2.5)\nexit"), [["TSV041", "2.5"]]);
  assert.deepEqual(codes("let a = [1]\nlet b = a\nb.add(1.5)\nlet k: integer[] = a\nexit"), []);
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
      "'step' holds a whole number (integer), so it cannot be set to text (string). To allow both, declare it as 'let step: integer | string = ...'.",
      '"x"',
    ],
  ]);
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
  for (const body of ['say "${items[n]}"', 'say "${n + 1}"', 'repeat n {\n        say "x"\n    }'])
    assert.deepEqual(
      mismatches(nullable.replace("BODY", body)),
      [["TSV043", "'n' may be null. Check it first: if n != null { ... }", "n"]],
      body,
    );
  assert.deepEqual(mismatches(nullable.replace("BODY", "let m: integer = n")), [
    [
      "TSV041",
      "'m' is declared as integer, so it cannot start as a whole number (integer) or null. Check it first: if n != null { ... }",
      "n",
    ],
  ]);
  assert.deepEqual(
    codes(nullable.replace("BODY", 'if n != null {\n        say "${items[n]} ${n + 1}"\n    }')),
    [],
  );
  assert.deepEqual(mismatches("function f(v: number?) {\n    return round(v)\n}\nexit"), [
    ["TSV043", "'v' may be null. Check it first: if v != null { ... }", "v"],
  ]);
  assert.deepEqual(codes('let t: string? = "a"\nlet r = round(t)\nexit'), [["TSV043", "t"]]);
  // Also beside an operand of unknown type, as a timer range, or as the receiver of a new property.
  for (const source of [
    "function f(n: integer?, other) {\n    return n + other\n}\nexit",
    "function f(n: integer?) {\n    return n + n\n}\nexit",
    // Text joins other text, so beside an operand of unknown type only null needs a check.
    "function f(n: string?, other) {\n    return n + other\n}\nexit",
    "function f(n: range?) {\n    timer async n s\n}\nexit",
  ])
    assert.deepEqual(
      mismatches(source).map(([code, message]) => [code, message]),
      [["TSV043", "'n' may be null. Check it first: if n != null { ... }"]],
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

test("an optional operand and a parenthesized method keep their checks", () => {
  assert.deepEqual(
    mismatches(
      'function maybeText: string? {\n    return "x"\n}\nlet count = 1\nlet text = maybeText()\ncount += text\nexit',
    ),
    [
      [
        "TSV041",
        "'count' holds a whole number (integer), so text (string) or null cannot be added to it. Use a number instead.",
        "text",
      ],
    ],
  );
  assert.deepEqual(mismatches('let items = [1]\n(items.add)("x")\nexit'), [
    [
      "TSV041",
      "'items' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'let items: (integer | string)[] = ...'.",
      '"x"',
    ],
  ]);
  assert.deepEqual(mismatches('let tags = set["a"]\n(tags.add)(1)\nexit')[0]?.[0], "TSV041");
  assert.deepEqual(mismatches("let count = 1\nlet extra: integer? = 2\ncount += extra\nexit"), []);
});

test("a set compares its members with ==, and only objects and handles take properties", () => {
  // A set compares any value, and checks a value the compiler cannot know when the script runs.
  assert.deepEqual(
    sayTexts(
      'let s = set[1, null]\ns.add(2)\nsay "${s.contains("x")}"\ns.remove(null)\nsay s\nexit',
    ),
    ["false", "[1, 2]"],
  );
  for (const source of [
    "let n = 1\nn.value = true\nexit",
    "let xs = [1]\nxs.length = 2\nexit",
    "let xs = [1]\nxs.first = 2\nexit",
  ])
    assert.deepEqual(
      codes(source).map(([code]) => code),
      ["TSV043"],
      source,
    );
  assert.deepEqual(mismatches("let xs = [1]\nxs.length = 2\nexit"), [
    [
      "TSV043",
      "Only objects, speakers, and timer, media, and message handles have properties to assign, but this is a list (integer[]).",
      "xs",
    ],
  ]);
  assert.deepEqual(sayTexts("let o = { value: 1 }\no.value = 2\nsay o\nexit"), ["{ value: 2 }"]);
  // A value known to be null has no members, and a conversion goes only from a list to a set or back.
  for (const [source, text] of [
    ["function nothing {\n    return null\n}\nnothing().value = true\nexit", "nothing()"],
    ["let s = set[]\ns.add(1).value = true\nexit", "s.add(1)"],
    ["function nothing {\n    return null\n}\nsay nothing().value\nexit", "value"],
    ["function nothing {\n    return null\n}\nnothing().clear()\nexit", "clear"],
    ["let s = set[1]\nlet converted = s.toSet()\nexit", "toSet"],
    ["let xs = [1]\nlet converted = xs.toList()\nexit", "toList"],
  ] as const)
    assert.deepEqual(codes(source), [["TSV043", text]], source);
  assert.deepEqual(sayTexts("let xs = [1, 1, 2]\nsay xs.toSet().toList()\nexit"), ["[1, 2]"]);
  assert.deepEqual(sayTexts("let o = null\no = { value: 1 }\no.value = 2\nsay o\nexit"), [
    "{ value: 2 }",
  ]);
});

test("a function called before a script variable is declared is checked once the variable has its type", () => {
  // The first call skips the store; the body is checked against the variable when every script variable is typed.
  const early = (body: string, declaration: string, use: string) =>
    codes(
      `function change(active = false) {\n    if active {\n        ${body}\n    }\n}\nchange()\n${declaration}\nchange(true)\n${use}\nexit`,
    );
  assert.deepEqual(early('score = "wrong"', "let score = 1", "say score + 1"), [
    ["TSV041", '"wrong"'],
  ]);
  assert.deepEqual(early('items.add("wrong")', "let items = [1]", "say items[0] + 1"), [
    ["TSV041", '"wrong"'],
  ]);
  assert.deepEqual(early('item.value = "wrong"', "let item = { value: 1 }", "say item.value + 1"), [
    ["TSV041", '"wrong"'],
  ]);
  // A non-whole number widens the variable, so an integer-only use is reported.
  assert.deepEqual(
    early("index = index / 2", "let index = 1\nlet items = [10, 20]", "say items[index]"),
    [["TSV043", "index"]],
  );
  // A valid store runs.
  assert.deepEqual(
    sayTexts(
      "function change(active = false) {\n    if active {\n        score = 2\n    }\n}\nchange()\nlet score = 1\nchange(true)\nsay score + 1\nexit",
    ),
    ["3"],
  );
});

test("function bodies check assignments to script variables", () => {
  assert.deepEqual(
    mismatches('let count = 0\nfunction reset {\n    count = "none"\n}\nexit')[0]?.[0],
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
        'count = load "co" + "unt", default: 0',
        'let stored: integer = load "st" + "ored", default: 0',
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("an operation on a value the compiler cannot know is rejected where no result fits a written type", () => {
  const inFunction = (...body: string[]): string =>
    ["function f(x, z) {", ...body.map((line) => `    ${line}`), "}", "f(8, 2)", "exit"].join("\n");
  // '/' gives a number, a duration, or a calendar duration, whatever 'x' holds, and never text.
  assert.deepEqual(mismatches(inFunction("let y: string = x / 4", "say y")), [
    [
      "TSV041",
      "'y' is declared as string, so it cannot start as the result of '/', which is a number or a duration or a calendar duration. To show it as text, write \"${x / 4}\".",
      "x / 4",
    ],
  ]);
  for (const body of [
    ['let y: string = "a"', "y = x / z", "say y"],
    ["let y: string? = -x", "say y"],
    ["let y: boolean = x % 4", "say y"],
    ["let items: string[] = []", "items.add(x * 4)"],
    ["g(x - 4)"],
    ["let y: string = (x / 4) + 1", "say y"],
  ])
    assert.deepEqual(
      mismatches(`function g(s: string) {\n    say s\n}\n${inFunction(...body)}`).map(
        ([code]) => code,
      ),
      ["TSV041"],
      body.join("; "),
    );
  // A longer calculation is named in words, and another place is offered the type '/' gives for numbers.
  assert.match(
    mismatches(inFunction("let y: string = (x / 4) + 1", "say y"))[0]?.[1] ?? "",
    /which is a number\. To show it as text, put the whole calculation inside "\$\{" and "\}"\.$/u,
  );
  assert.match(
    mismatches(inFunction("let y: boolean = x / 4", "say y"))[0]?.[1] ?? "",
    /To allow both, declare it as 'let y: boolean \| number = \.\.\.'\.$/u,
  );
  assert.equal(
    mismatches("function f(x): string {\n    return x / 4\n}\nsay f(8)\nexit")[0]?.[1],
    "'f' returns string, so it cannot return the result of '/', which is a number or a duration or a calendar duration. To show it as text, write \"${x / 4}\".",
  );
  // A result that may fit is checked when the script runs: a number may be whole, and '+' joins texts or lists.
  assert.deepEqual(
    mismatches(
      inFunction(
        "let whole: integer = x / 4",
        "let ratio: number = x / z",
        "let span: duration = x * 2",
        'let text: string = x + "!"',
        "let joined: list = x + [1]",
        "let day: date = x + 1 calendar day",
        "let either: string | number = x / 4",
        "say ratio",
      ),
    ),
    [],
  );
});

test("a union of collections takes an operation result that one of its members can hold, in either order", () => {
  // The member that holds the value is known only when the script runs, which checks the value then.
  const run = (...body: string[]): string[] => {
    const source = [
      "function f(x) {",
      ...body.map((line) => `    ${line}`),
      "}",
      "f(8)",
      "exit",
    ].join("\n");
    assert.deepEqual(mismatches(source), [], source);
    const result = runValidSource(source);
    assert.equal(result.snapshot.failure, null, source);
    return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  };
  for (const members of ["string[] | number[]", "number[] | string[]"])
    assert.deepEqual(run(`let ys: ${members} = [x / 4]`, "say ys"), ["[2]"], members);
  assert.deepEqual(run("let ys: string set | number set = set[x / 4]", "say ys"), ["[2]"]);
  assert.deepEqual(run("let ys: string dict | number dict = dict{ a: x / 4 }", "say ys"), [
    'dict{ "a": 2 }',
  ]);
  assert.deepEqual(
    run("let rows: string[][] | number[][] = [[1.5]]", "rows.add([x / 4])", "say rows"),
    ["[[1.5], [2]]"],
  ); // A parameter is not narrowed by a start value, so each member of its union is checked.
  for (const members of ["string[][] | number[][]", "number[][] | string[][]"])
    assert.deepEqual(
      mismatches(
        [
          `function g(rows: ${members}, x) {`,
          "    rows.add([x / 4])",
          "    rows.addAll([[x / 4]])",
          "}",
          "exit",
        ].join("\n"),
      ),
      [],
      members,
    );
});

test("type inference handles deeply nested expressions without native recursion", () => {
  const source = `let total = ${Array.from({ length: 20_000 }, () => "1").join(" + ")}\ntotal = 2\nexit`;
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
  assert.deepEqual(mismatches('let best = null\nbest = "Ada"\nbest = null\nbest = 5\nexit'), [
    [
      "TSV041",
      "'best' holds text (string) or null since line 2, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
      "5",
    ],
  ]);
  // A value the compiler cannot know decides nothing; the first known value does.
  assert.deepEqual(
    codes('let best = null\nbest = load "be" + "st", default: null\nbest = 2\nbest = "x"\nexit'),
    [["TSV041", '"x"']],
  );
  // The first value in checking order decides, also when it is assigned inside a function.
  assert.deepEqual(codes('let best = null\nfunction keep {\n    best = 5\n}\nbest = "x"\nexit'), [
    ["TSV041", "5"],
  ]);
  // A read before that value in checking order, here of an element in a function body, sees the decided type too.
  assert.deepEqual(
    sayTexts(
      'let marks = [null]\nfunction doubled {\n    let mark = marks[0]\n    if mark != null {\n        return mark * 2\n    }\n    return 0\n}\nsay "${doubled()}"\nmarks[0] = 4\nsay "${doubled()}"\nexit',
    ),
    ["0", "8"],
  );
  // The same store decides it, so a later store of another type is reported as without the read.
  const conflicting = (read: string) =>
    mismatches(`let box = { best: null }\n${read}\nbox.best = 5\nbox.best = "a"\nexit`);
  assert.deepEqual(conflicting("let seen = box.best"), [
    [
      "TSV041",
      "'box.best' holds a whole number (integer) or null since line 3, so it cannot be set to text (string). Use a separate property for a value of another type.",
      '"a"',
    ],
  ]);
  assert.deepEqual(conflicting("let seen = 0"), conflicting("let seen = box.best"));
  // A store of a place that is still undecided itself decides by that place, along a whole chain at once.
  assert.deepEqual(
    codes(
      'let o = { a: null, b: null, c: null }\nlet first = o.a\no.a = o.b\no.b = o.c\no.c = 5\no.a = "x"\nexit',
    ),
    [["TSV041", '"x"']],
  );
  // A decided part brings what later stores widen in it, also for a copy taken before.
  assert.deepEqual(
    codes(
      "let a = []\nfunction f {\n    let b = a\n    if b.length > 0 {\n        let k: integer = b[0].n\n        say k\n    }\n}\nf()\na.add({ n: 1 })\na[0].n = 0.5\nf()\nexit",
    ),
    [["TSV041", "b[0].n"]],
  );
  // A value the compiler cannot know, here an untyped parameter, decides nothing: a read before it is not narrowed to
  // null, and a known place checks it when the store runs.
  const unknownStore = (argument: string) =>
    `let box = { t: null }\nfunction setT(t) {\n    box.t = t\n}\nfunction show {\n    let v = box.t\n    let o = 0\n    if v != null {\n        o = v\n    }\n    say "\${o}"\n}\nshow()\nsetT(${argument})\nshow()\nexit`;
  assert.deepEqual(sayTexts(unknownStore("5")), ["0", "5"]);
  assert.equal(runValidSource(unknownStore('"high"')).snapshot.failure?.code, "TSR058");
  // Also when the unknown value replaces the whole object, or arrives through a function's result, alone or joined
  // with a known value.
  for (const [store, read] of [
    ["box = t", "box.t"],
    ["box.t = t", "get()"],
    ["box.t = t", "known(true)"],
    ["box.t = t", "[box.t, 9][0]"],
  ] as const) {
    const source = (argument: string) =>
      `let box = { t: null }\nfunction setT(t) {\n    ${store}\n}\nfunction get {\n    return box.t\n}\nfunction known(flag) {\n    if flag {\n        return box.t\n    }\n    return 9\n}\nfunction show {\n    let v = ${read}\n    let o: integer = 0\n    if v != null {\n        o = v\n    }\n    say o\n}\nshow()\nsetT(${argument})\nshow()\nexit`;
    const argument =
      store === "box = t" ? (value: string) => `{ t: ${value} }` : (value: string) => value;
    assert.deepEqual(sayTexts(source(argument("5"))), ["0", "5"], store);
    assert.equal(
      runValidSource(source(argument('"high"'))).snapshot.failure?.code,
      "TSR058",
      store,
    );
  }
  // A place that holds itself is never decided further, so the check ends.
  assert.deepEqual(
    codes("let a = []\na.add(a)\nlet b = { n: null }\nlet c = b.n\nb.n = b\nexit"),
    [],
  );
});

test("an empty list or set takes its element type from the first element, and null elements make it optional", () => {
  assert.deepEqual(mismatches('let items = []\nitems.add(1)\nitems.add("x")\nexit'), [
    [
      "TSV041",
      "'items' holds integer values (integer[]) since line 2, so it cannot contain text (string). To allow both, declare it as 'let items: (integer | string)[] = ...'.",
      '"x"',
    ],
  ]);
  assert.deepEqual(codes('let items = []\nitems = ["a"]\nitems[0] = 2\nexit'), [["TSV041", "2"]]);
  assert.deepEqual(codes('let tags = set[]\ntags.add("a")\ntags.add(true)\nexit'), [
    ["TSV041", "true"],
  ]);
  assert.deepEqual(codes('let marks = [null, 1]\nmarks.add(null)\nmarks.add("x")\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(
    codes("let marks = [null]\nmarks.add(1)\nmarks.add(null)\nmarks.add(true)\nexit"),
    [["TSV041", "true"]],
  );
  assert.deepEqual(codes("let groups = [[], [1]]\ngroups.add([2])\ngroups.add([true])\nexit"), [
    ["TSV041", "true"],
  ]);
});

test("an object property keeps the type of its first value, and assignment may add a property", () => {
  assert.deepEqual(
    mismatches(
      'let door = { locked: true }\ndoor.locked = "yes"\ndoor.color = "red"\ndoor.color = 5\nexit',
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
  assert.deepEqual(codes('let door = { owner: null }\ndoor.owner = "Ada"\ndoor.owner = 3\nexit'), [
    ["TSV041", "3"],
  ]);
  assert.deepEqual(
    mismatches('let door = {}\ndoor.owner = [null, 1][0]\ndoor.owner = "Ada"\nexit')[0]?.[1],
    "'door.owner' holds a whole number (integer) or null since line 2, so it cannot be set to text (string). Use a separate property for a value of another type.",
  );
  assert.deepEqual(codes('let door = { keys: [1] }\ndoor.keys.add("x")\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(codes('let door = { locked: true }\ndoor = { locked: "no", open: 1 }\nexit'), [
    ["TSV041", '"no"'],
  ]);
  // Copies keep their own properties: a property added to one is not added to the other.
  assert.deepEqual(codes('let a = { x: 1 }\nlet b = a\nb.y = "b"\na.y = 2\nexit'), []);
  assert.deepEqual(
    mismatches('let kept = []\nkept.add({ name: "Ada" })\nkept.add({ name: 1 })\nexit')[0]?.[1],
    "Property 'name' of the elements of 'kept' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${1}\".",
  );
  assert.deepEqual(
    mismatches(
      'let kept = [{ name: "Ada" }]\nlet other = { name: 1 }\nkept.add(other)\nexit',
    )[0]?.[1],
    "'kept' holds object values (object[]), so its property 'name', which holds text (string), cannot be set to a whole number (integer). Use a separate property for a value of another type.",
  );
});

test("a function's result type comes from its return values, and returns of different types are an error", () => {
  assert.deepEqual(codes('function name {\n    return "Ada"\n}\nlet n = name()\nn = 5\nexit'), [
    ["TSV041", "5"],
  ]);
  assert.deepEqual(
    mismatches(
      'function pick(n) {\n    if n > 3 {\n        return "big"\n    }\n    return 1\n}\nexit',
    ),
    [
      [
        "TSV044",
        "'pick' returns a whole number (integer) here, but text (string) on line 3. To return both, declare the result type, as in 'function pick(...): string | integer'.",
        "1",
      ],
    ],
  );
  // Integers and numbers together are numbers; a function that can end without a value has an optional result.
  assert.deepEqual(
    codes(
      "function ratio(n) {\n    if n > 3 {\n        return 1\n    }\n    return 0.5\n}\nlet r = ratio(1)\nr = 2.5\nexit",
    ),
    [],
  );
  assert.deepEqual(
    codes(
      'function maybe(flag) {\n    if flag {\n        return 1\n    }\n}\nlet m = maybe(true)\nm = null\nm = "x"\nexit',
    ),
    [["TSV041", '"x"']],
  );
  // A function used before its declaration, a recursive function, and a function returning an object.
  assert.deepEqual(
    codes('let total = later()\nfunction later {\n    return 5\n}\ntotal = "x"\nexit'),
    [["TSV041", '"x"']],
  );
  assert.deepEqual(
    codes(
      "function fact(n: integer): integer {\n    if n <= 1 {\n        return 1\n    }\n    return n * fact(n - 1)\n}\nlet x: integer = fact(5)\nx = 2.5\nexit",
    ),
    [["TSV041", "2.5"]],
  );
  assert.deepEqual(
    codes('function make {\n    return { hp: 10 }\n}\nlet m = make()\nm.hp = "x"\nexit'),
    [["TSV041", '"x"']],
  );
  // An unknown return value decides nothing; values the compiler cannot know are never rejected.
  assert.deepEqual(
    codes('function pass(value) {\n    return value\n}\nlet p = pass(1)\np = "x"\nexit'),
    [],
  );
});

test("annotated parameters and results are checked, and a default types a parameter like let", () => {
  assert.deepEqual(
    mismatches('function shout(times = 1) {\n    say "${times}"\n}\nshout(0.5)\nexit'),
    [
      [
        "TSV041",
        "'shout' takes 'times' as a whole number (integer), so it cannot take a number. Round it with floor(...), round(...), or ceil(...), or declare the parameter as 'times: number = 1'.",
        "0.5",
      ],
    ],
  );
  assert.deepEqual(
    codes(
      'function greet(name: string, polite = true) {\n    say name\n}\ngreet("Ada", polite: "yes")\ngreet(5)\nexit',
    ),
    [
      ["TSV041", '"yes"'],
      ["TSV041", "5"],
    ],
  );
  assert.deepEqual(codes('function f(count: integer = "x") {\n    say "${count}"\n}\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(mismatches("function half(n: integer): integer {\n    return n / 2\n}\nexit"), [
    [
      "TSV041",
      "'half' returns integer, so it cannot return a number. Round it with floor(...), round(...), or ceil(...).",
      "n / 2",
    ],
  ]);
  assert.deepEqual(
    mismatches("function f: integer {\n    if chance(50) {\n        return 1\n    }\n}\nexit"),
    [
      [
        "TSV041",
        "'f' returns integer, but it can end without returning a value. Add a 'return' at the end. To allow null, declare the result as 'integer?'.",
        "f",
      ],
    ],
  );
  assert.deepEqual(codes("function g: integer {\n    return\n}\nexit"), [["TSV041", "return"]]);
  // A loop that only a return leaves ends every path; a parameter without a type or decided default is unknown.
  assert.deepEqual(
    codes("function f: integer {\n    while true {\n        return 1\n    }\n}\nexit"),
    [],
  );
  assert.deepEqual(
    codes('function greet(name = null) {\n    say "Hi"\n}\ngreet("Ada")\ngreet(5)\nexit'),
    [],
  );
});

test("only integers convert implicitly: division gives a number, and durations need a unit", () => {
  assert.deepEqual(
    mismatches("let n: integer = 2.0\nexit")[0]?.[1],
    "'n' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let n: number = ...'.",
  );
  assert.deepEqual(codes("let total = 10\nlet avg: integer = total / 5\nexit"), [
    ["TSV041", "total / 5"],
  ]);
  assert.deepEqual(mismatches("let pause: duration = 5\npause = 10\nlet later = pause + 5\nexit"), [
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
    mismatches("let title: string = 5\nexit")[0]?.[1],
    "'title' is declared as string, so it cannot start as a whole number (integer). To show it as text, write \"${5}\".",
  );
  assert.deepEqual(
    mismatches('let joined = "Score: " + 5\nexit')[0]?.[1],
    "'+' joins text only with other text, not with a whole number (integer). Put the value in the text instead, as in \"Score: ${5}\".",
  );
  assert.deepEqual(codes("let total = true + 1\nexit"), [["TSV043", "true + 1"]]);
  // A number in a command that expects a time needs a unit; after `wait` and a short `timer` it may follow the number.
  assert.deepEqual(
    codes(
      'let n = 3\nwait n s\nwait n ms\ntimer n s\nplayAudio(file: "a.mp3", startAt: n * 1 s, endAt: 5 s)\nexit',
    ),
    [],
  );
  assert.deepEqual(
    codes('let n = 3\nwait n\ntimer n\nplayAudio(file: "a.mp3", startAt: n, endAt: 5 s)\nexit'),
    [
      ["TSV043", "n"],
      ["TSV043", "n"],
      ["TSV043", "n"],
    ],
  );
  assert.deepEqual(codes('wait "soon"\nexit'), [["TSV043", '"soon"']]);
});

test("conditions and logical operands are true or false, and operators get values they support", () => {
  assert.deepEqual(mismatches("let count = 3\nwhile count {\n    count -= 1\n}\nexit"), [
    [
      "TSV043",
      "A condition must be true or false (boolean), but this is a whole number (integer). Compare it instead, such as 'count > 0'.",
      "count",
    ],
  ]);
  assert.deepEqual(
    codes(
      'let names = ["a"]\nif names {\n    say "x"\n}\nlet ok = not 1\nlet both = true and "x"\nexit',
    ),
    [
      ["TSV043", "names"],
      ["TSV043", "1"],
      ["TSV043", '"x"'],
    ],
  );
  assert.deepEqual(
    codes(
      'let r = 1..3\nlet q = r + 1\nlet less = "a" < 1\nlet x = 5\nsay x.length\nlet items = [1]\nitems.noSuchMethod()\nsay items[1.5]\nexit',
    ),
    [
      ["TSV043", "r + 1"],
      ["TSV043", '"a" < 1'],
      ["TSV043", "length"],
      ["TSV043", "noSuchMethod"],
      ["TSV043", "1.5"],
    ],
  );
  assert.deepEqual(codes('let t = timer async 5 s\nsave t as "k"\nlet c = chance("x")\nexit'), [
    ["TSV043", "t"],
    ["TSV043", '"x"'],
  ]);
  // Equality compares values of any kinds, and text compares with text. Values of different types are never equal, so
  // such a comparison only warns (ADR 0021 rule 4.5).
  assert.deepEqual(
    codes('let same = 1 == "1"\nlet before = "a" < "b"\nlet longer = 2 s > 1 s\nexit'),
    [["TSV046", '1 == "1"']],
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
        "exit",
      ].join("\n"),
    ),
    ["2 3 -3 1 -1", "-3 -2 2 0", "2"],
  );
  assert.deepEqual(codes('let r = round("2")\nexit'), [["TSV043", '"2"']]);
  const dynamic = runValidSource(
    'function dynamic(value) {\n    return value\n}\nsay "${round(dynamic("2"))}"\nexit',
  );
  assert.equal(dynamic.snapshot.failure?.code, "TSR059");
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

test("a first null is remembered wherever a first value decides a type", () => {
  assert.deepEqual(
    codes("let door = {}\ndoor.owner = null\ndoor.owner = 1\ndoor.owner = null\nexit"),
    [],
  );
  assert.deepEqual(codes("let x = null\nx = [null]\nx[0] = 1\nexit"), []);
  assert.deepEqual(
    codes("let items = []\nitems.add(null)\nitems.add(1)\nitems.add(null)\nitems.add(true)\nexit"),
    [["TSV041", "true"]],
  );
  // A join keeps a first null from either side; an empty collection that never took null adds nothing.
  for (const [empty, other] of [
    ["[]", "[1]"],
    ["set[]", "set[1]"],
  ] as const) {
    const seen = `let a = ${empty}\na.add(null)\n`;
    assert.deepEqual(codes(`${seen}let b = [a, ${other}]\nb[0].add(null)\nexit`), [], empty);
    assert.deepEqual(codes(`${seen}let b = [${other}, a]\nb[1].add(null)\nexit`), [], empty);
  }
  assert.deepEqual(codes("let a = [null]\nlet b = [[1], a]\nb[1].add(null)\nexit"), []);
  assert.deepEqual(
    codes(
      "let a = []\na.add(null)\nfunction f(flag) {\n    if flag {\n        return a\n    }\n    return [1]\n}\nlet r = f(true)\nr.add(null)\nexit",
    ),
    [],
  );
  assert.deepEqual(codes("let a = []\nlet b = [a, [1]]\nb[0].add(null)\nexit"), [
    ["TSV041", "null"],
  ]);
});

test("calls never decide parameter types, and an unknown return makes a result unknown", () => {
  assert.deepEqual(
    codes(
      'function get(record = {}) {\n    return record.item\n}\nlet a = get({ item: 1 })\nget({ item: "x" })\nlet b: string = get({ item: 1 })\nexit',
    ),
    [],
  );
  assert.deepEqual(
    codes(
      'function f(value) {\n    if chance(50) {\n        return 1\n    }\n    return value\n}\nlet a: string = f("x")\nexit',
    ),
    [],
  );
  // A recursive call keeps the declared result type.
  assert.deepEqual(
    codes(
      'function f(n: integer): string {\n    if n == 0 {\n        return "x"\n    }\n    return f(n - 1) + 1\n}\nlet a = f(1)\nexit',
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
    assert.deepEqual(codes(`function f: integer {\n    ${body}\n}\nlet a = f()\nexit`), [], body);
  assert.deepEqual(
    codes("function f(n): integer {\n    repeat n {\n        return 1\n    }\n}\nexit"),
    [["TSV041", "f"]],
  );
});

test("timer ranges and handle members are checked by type, wherever the value comes from", () => {
  assert.deepEqual(codes("let span = 1..=3\nlet t = timer async span s\nexit"), []);
  assert.deepEqual(
    mismatches(
      "function make {\n    return timer async 1 s\n}\nlet t = make()\nt.nope()\nt.elapsed = 1 s\nsay t.colour\nexit",
    ).map(([code, message, text]) => [code, text, message]),
    [
      ["TSV043", "nope", "Timer handles have no method 'nope'. Use pause(), resume(), or stop()."],
      [
        "TSV043",
        "elapsed",
        "Timer handle property 'elapsed' cannot be assigned. You can assign remaining, display, or repeatDuration.",
      ],
      ["TSV043", "colour", "Timer handles have no property 'colour'."],
    ],
  );
});

test("a for-loop, randomInteger, wait, or timer range takes whole-number bounds, a switch case range any number", () => {
  // V30 §6: a bound that may hold a fraction is an error, never truncated.
  assert.deepEqual(mismatches('let count = 5\nfor i in 1..=count / 2 {\n    say "${i}"\n}\nexit'), [
    [
      "TSV043",
      "A for-loop range bound must be a whole number (integer), but this is a number. Round it with floor(...), round(...), or ceil(...).",
      "count / 2",
    ],
  ]);
  assert.deepEqual(mismatches("let n = 4\nlet r = randomInteger((0..n))\nn = n / 2\nexit"), [
    [
      "TSV043",
      "A randomInteger range bound must be a whole number (integer), but this is a number. 'n' is a number because line 3 can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...).",
      "n",
    ],
  ]);
  assert.deepEqual(
    codes(
      'let low: number = 1\nfor i in low..2.0 {\n    say "${i}"\n}\nlet r = randomInteger(low..=6)\nexit',
    ),
    [
      ["TSV043", "low"],
      ["TSV043", "2.0"],
      ["TSV043", "low"],
    ],
  );
  // A wait or timer range counts whole units.
  assert.deepEqual(mismatches("let n = 17 / 2\nwait (1..n) s\nexit"), [
    [
      "TSV043",
      "A wait range bound must be a whole number (integer), but this is a number. Round it with floor(...), round(...), or ceil(...).",
      "n",
    ],
  ]);
  assert.deepEqual(
    codes(
      'let n = 17 / 2\ntimer (1..=n) s\nlet t = timer async (n..10) min {\n    say "late"\n}\nexit',
    ),
    [
      ["TSV043", "n"],
      ["TSV043", "n"],
    ],
  );
  assert.equal(
    mismatches("let n = 17 / 2\ntimer (1..=n) s\nexit")[0]?.[1].startsWith("A timer range bound"),
    true,
  );
  // Rounded bounds run; a switch case range matches a fraction; a bound the compiler cannot know is checked at runtime.
  assert.deepEqual(
    sayTexts('let count = 5\nfor i in 1..=floor(count / 2) {\n    say "${i}"\n}\nexit'),
    ["1", "2"],
  );
  assert.deepEqual(
    sayTexts(
      'let v = 3.7\nswitch v {\n    case 0..4 {\n        say "low"\n    }\n    case 4..=10 {\n        say "high"\n    }\n}\nexit',
    ),
    ["low"],
  );
  assert.deepEqual(
    codes(
      'function count(n) {\n    for i in 1..=n {\n        say "${i}"\n    }\n    wait (1..n) s\n}\ncount(2.5)\nexit',
    ),
    [],
  );
});

test("an object that does not fit adds no properties, and annotated functions run", () => {
  assert.deepEqual(codes('let x = { a: 1 }\nx = { b: true, a: "x" }\nx.b = 1\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(
    sayTexts(
      'function scale(value: number, by: integer = 2): number {\n    return value * by\n}\nsay "${scale(1.5)} ${scale(1, by: 3)}"\nexit',
    ),
    ["3 3"],
  );
});

test("a function result, a body, or a copy never changes the types another place keeps", () => {
  // Joining a function's returns copies a stored object's properties instead of changing them.
  assert.deepEqual(
    codes(
      "let objs = [{ a: 1 }, { b: 1 }]\nfunction f(flag) {\n    if flag {\n        return objs[0]\n    }\n    return { c: true }\n}\nlet result = f(true)\nobjs[0].c = 1\nexit",
    ),
    [],
  );
  // Every call is checked against the parameters as the whole body uses them, so identical calls agree.
  assert.deepEqual(
    codes("function f(obj = {}) {\n    obj.flag = true\n}\nf({ flag: 1 })\nf({ flag: 1 })\nexit"),
    [
      ["TSV041", "1"],
      ["TSV041", "1"],
    ],
  );
  assert.deepEqual(
    codes(
      'function f(opts = { a: 1 }, flag = false) {\n    if flag {\n        opts.b = "x"\n    }\n    let s: string = opts.b\n    return s\n}\nlet given = { a: 2, b: 5 }\nf(given)\nexit',
    ),
    [["TSV041", "given"]],
  );
  // A return that mixes types adds nothing to the result's properties.
  assert.deepEqual(
    codes(
      'function f(n) {\n    if n > 1 {\n        return { a: 1 }\n    }\n    if n > 2 {\n        return { b: "x", a: "s" }\n    }\n    return { a: 2, b: 3 }\n}\nlet r = f(1)\nlet s: integer = r.b\nexit',
    ),
    [["TSV044", '{ b: "x", a: "s" }']],
  );
  // A copy of a collection that has seen null may still take null.
  for (const empty of ["[]", "set[]"])
    assert.deepEqual(
      codes(`let a = ${empty}\na.add(null)\nlet b = a\nb.add(1)\nb.add(null)\nexit`),
      [],
      empty,
    );
  // A converted collection is a new one with its source's type, because it holds what the source held when it was
  // converted: in either order, a value of another type fits neither (ADR 0021 rule 1.2). Their values stay apart,
  // and a first null stays a first null in both. One already decided keeps its type.
  for (const [empty, convert, decided, nullFirst] of [
    ["[]", "toSet", "[1]", "[null, 2]"],
    ["set[]", "toList", "set[1]", "[null, 2, null]"],
  ]) {
    for (const stores of ['a.add(1)\nb.add("x")', 'b.add("x")\na.add(1)'])
      assert.deepEqual(
        mismatches(`let a = ${empty}\nlet b = a.${convert}()\n${stores}\nexit`).map(
          ([code, message, text]) => [code, message.includes("'b' was copied from 'a'"), text],
        ),
        [["TSV041", true, '"x"']],
        stores,
      );
    assert.deepEqual(
      sayTexts(`let a = ${empty}\nlet b = a.${convert}()\na.add(1)\nb.add(2)\nsay a\nsay b\nexit`),
      ["[1]", "[2]"],
    );
    assert.deepEqual(
      sayTexts(
        `let a = ${empty}\na.add(null)\nlet b = a.${convert}()\na.add(1)\nb.add(2)\nb.add(null)\nsay b\nexit`,
      ),
      [nullFirst],
    );
    assert.deepEqual(codes(`let a = ${decided}\nlet b = a.${convert}()\nb.add("x")\nexit`), [
      ["TSV041", '"x"'],
    ]);
  }
  // A timer block checked after the conversion may fill the source before the conversion runs.
  assert.deepEqual(
    codes(
      'let a = []\ntimer async 1 s { a.add(1) }\nwait 2 s\nlet b = a.toSet()\nb.add("x")\nexit',
    ),
    [["TSV041", '"x"']],
  );
  // A mismatch in a copy, or in a part of one, names the variable it was copied from, also when the copy was taken
  // through an index, a function, or a literal, but not for a copy or a part that its own first value decided. Around a
  // cycle of copies, the first value in checking order decides.
  const copyNotes = (source: string) =>
    mismatches(source).map(([code, message, text]) => [
      code,
      /'\w+' was copied from '(\w+)'/u.exec(message)?.[1] ?? null,
      text,
    ]);
  for (const copy of ["let b = a[0]", "let b = first()", "let b = { n: a[0] }.n"])
    assert.deepEqual(
      copyNotes(
        `let a = [[]]\nfunction first {\n    return a[0]\n}\n${copy}\na[0].add(1)\nb.add("x")\nexit`,
      ),
      [["TSV041", "a", '"x"']],
      copy,
    );
  for (const store of ['b.add({ n: "x" })', 'let c = { n: "x" }\nb.add(c)', 'b += [{ n: "x" }]'])
    assert.deepEqual(
      copyNotes(`let a = []\nlet b = a\na.add({ n: 1 })\n${store}\nexit`).map(([code, source]) => [
        code,
        source,
      ]),
      [[store.startsWith("b +=") ? "TSV044" : "TSV041", "a"]],
      store,
    );
  assert.deepEqual(
    copyNotes('let a = []\nlet b = a\na.add({ n: 1 })\nb[0].m = "x"\nb[0].m = 2\nexit'),
    [["TSV041", null, "2"]],
  );
  assert.deepEqual(copyNotes('let a = 1\nlet b = a\nb = 0.5\nb = "x"\nexit'), [
    ["TSV041", null, '"x"'],
  ]);
  assert.deepEqual(
    copyNotes('let a = []\nlet b = a\na = b\na.add(1)\nb.add("x")\na.add(true)\nexit'),
    [
      ["TSV041", "a", '"x"'],
      ["TSV041", null, "true"],
    ],
  );
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
        `${setup}\nfunction f(flag = false) {\n    let local = {}\n    if flag {\n        return ${read}\n    }\n    ${write}\n    return { flag: true }\n}\nsay f(true)\nsay f(false)\nexit`,
      ),
      ["{}", "{ flag: true }"],
      read,
    );
  assert.deepEqual(
    codes(
      "let given = { flag: 1 }\nfunction f(flag = false) {\n    if flag {\n        return given\n    }\n    return { flag: true }\n}\nlet result = f(true)\nexit",
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
        `${given}let holder = { given: {} }\nlet row = [{}]\nfunction f(${parameter}) {\n    ${use} = true\n    given.flag = 1\n    holder.given.flag = 1\n    row[0].flag = 1\n    return ${use}\n}\nsay "\${${call}}"\nexit`,
      ),
      ["true"],
      call,
    );
  // A converted collection has its source's element type, also as a part of a literal argument: elements added before
  // the conversion or by a later argument must fit (ADR 0021 rule 1.2).
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
      assert.deepEqual(codes(`${functions}say "\${${call}}"\nexit`), [["TSV041", converted]], call);
      assert.deepEqual(
        codes(`${functions}a.add(1)\nlet count = ${earlier}\nexit`),
        [["TSV041", converted]],
        earlier,
      );
    }
  }
  // A property the argument already has when it is evaluated must fit.
  assert.deepEqual(
    codes(
      "let given = { flag: 1 }\nfunction f(obj = { nest: {} }) {\n    obj.nest.flag = true\n}\nf({ nest: given })\nexit",
    ),
    [["TSV041", "given"]],
  );
  // A call made inside the body, directly or through another function, is checked once the body is complete.
  assert.deepEqual(
    codes(
      "function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return f({ flag: 1 }, 1)\n    }\n    obj.flag = true\n    return obj.flag\n}\nlet result = f()\nexit",
    ),
    [["TSV041", "1"]],
  );
  assert.deepEqual(
    codes(
      "function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return g()\n    }\n    obj.flag = true\n    return obj.flag\n}\nfunction g: boolean {\n    return f({ flag: 1 }, 1)\n}\nlet result = f()\nexit",
    ),
    [["TSV041", "1"]],
  );
  // A later part of a literal argument does not change an earlier part as it was evaluated.
  assert.deepEqual(
    sayTexts(
      `${given}function f(obj = { nest: {}, tick: 0 }) {\n    obj.nest.flag = true\n    return obj.nest.flag\n}\nsay "\${f({ nest: given, tick: fill() })}"\nexit`,
    ),
    ["true"],
  );
  // A call reached while the function's defaults are checked waits for its parameters too, and a list it mixes is
  // reported once, by the parameter that decides it.
  assert.deepEqual(
    codes(
      'function f(n: integer = seed(false)): integer {\n    return n\n}\nfunction seed(recurse = false): integer {\n    if recurse {\n        return f("bad")\n    }\n    return 0\n}\nlet result = f()\nexit',
    ),
    [["TSV041", '"bad"']],
  );
  assert.deepEqual(
    codes(
      'function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return f({ items: [1, "a"] }, 1)\n    }\n    obj.items = [1]\n    return true\n}\nf()\nexit',
    ),
    [["TSV041", '"a"']],
  );
  // A declared element type decides a literal argument also when the call checks the body first.
  assert.deepEqual(codes('function f(values: integer[]) {\n    say "x"\n}\nf([1, "a"])\nexit'), [
    ["TSV041", '"a"'],
  ]);
});

test("a loop that may end through continue can still reach the function's end", () => {
  for (const loop of [
    "repeat 1 {\n        continue\n    }",
    "for n in [1] {\n        continue\n    }",
  ])
    assert.deepEqual(codes(`function f: integer {\n    ${loop}\n}\nlet a: integer = f()\nexit`), [
      ["TSV041", "f"],
    ]);
});

test("a choice result has the type of its values, and an option without a written value returns itself", () => {
  assert.deepEqual(codes("let n: integer = choose [5, 10, 15]\nn = 2.5\nexit"), [
    ["TSV041", "2.5"],
  ]);
  assert.deepEqual(codes("let n = choose 5, 10\nn = 20\nexit"), []);
  assert.deepEqual(codes("let n: integer = choose set[5, 10]\nn = 2.5\nexit"), [["TSV041", "2.5"]]);
  // An empty list or set gives no buttons, so its written value is never the result.
  assert.deepEqual(codes('let n: integer = choose 1.5: [], 2: ["Only"]\nexit'), []);
  assert.deepEqual(codes('let n: integer = choose 1.5: set[], 2: ["Only"]\nexit'), []);
  assert.deepEqual(codes("let n: string = choose 5, 10\nexit"), [["TSV041", "choose 5, 10"]]);
  assert.deepEqual(codes('let n = choose 1: "One", 2.5: "Two"\nn = 0.5\nexit'), []);
  assert.deepEqual(codes("let d = choose [1 min, 90 seconds]\nd = 5\nexit"), [["TSV041", "5"]]);
  assert.deepEqual(codes('let n = choose [{ text: "Five", value: 5 }]\nn = "five"\nexit'), [
    ["TSV041", '"five"'],
  ]);
  assert.deepEqual(codes('let pets = ["pet", "toy"]\nlet pick = choose pets\npick = 3\nexit'), [
    ["TSV041", "3"],
  ]);
  assert.deepEqual(codes('let answer = choose back: "Back", "Corner"\nanswer = "other"\nexit'), []);
  // A `null` value and an optional option keep their types.
  assert.deepEqual(codes('let answer: integer = choose { text: "Nothing", value: null }\nexit'), [
    ["TSV041", 'choose { text: "Nothing", value: null }'],
  ]);
  assert.deepEqual(
    codes("let value: integer? = null\nlet answer = choose value\nanswer = null\nexit"),
    [],
  );
  // A direct option is the value as it was evaluated: a later option's call does not change it.
  const fill = 'let token = null\nfunction fill {\n    token = 9\n    return "Ready"\n}\n';
  assert.deepEqual(codes(`${fill}let answer: integer? = choose token, fill()\nexit`), [
    ["TSV041", "choose token, fill()"],
  ]);
  assert.deepEqual(codes(`${fill}let answer: string? = choose token, fill()\nexit`), []);
  // A computed choice object returns its value or text, whose type is not known here.
  assert.deepEqual(
    codes(
      'let option = { text: "Yes" }\nlet answer: string = choose option\nlet other = choose [option]\nsay "${other}"\nexit',
    ),
    [],
  );
});

test("a message handle has one text property, takes text, and stays out of text, storage, and start values", () => {
  const codes = (source: string) =>
    mismatches(`let line = say "Waiting", instant\n${source}\nexit`).map(([code, message]) => [
      code,
      message,
    ]);
  assert.deepEqual(
    codes('let shown: string = line.text\nline.text = "Ready"\nline.text += "."'),
    [],
  );
  assert.deepEqual(codes("line.text = 5"), [
    [
      "TSV041",
      "'line.text' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
    ],
  ]);
  assert.deepEqual(codes('line.text -= "."'), [
    ["TSV041", "'line.text' holds text (string), so text (string) cannot be subtracted from it."],
  ]);
  for (const [source, message] of [
    [
      'line.color = "red"',
      "Message handles have no property 'color'. Use the text property.",
    ] as const,
    ["say line.speaker", "Message handles have no property 'speaker'. Use the text property."],
    [
      "line.stop()",
      "Message handles have no method 'stop'. Change the message with its text property.",
    ],
  ] as const)
    assert.deepEqual(codes(source), [["TSV043", message]], source);
  assert.equal(codes('say "${line}"')[0]?.[0], "TSV042");
  assert.equal(codes("say toString(line)")[0]?.[0], "TSV043");
  assert.match(codes('save [line] as "k"')[0]?.[1] ?? "", /cannot be saved.*text property/u);
  assert.deepEqual(codes('save line.text as "status"'), []);
  assert.equal(codes('let other: string = say "x"')[0]?.[0], "TSV041");
  // `message` stays an ordinary name; `messageHandle` is the type's.
  assert.deepEqual(mismatches("let message = 1\nsay message\nexit"), []);
  assert.equal(mismatches("let messageHandle = 1\nexit")[0]?.[0], "TSV001");
  // Showing a message is an effect that start values and parameter defaults cannot have.
  assert.equal(mismatches('global greeting = say "Hi"\nexit')[0]?.[0], "TSV055");
  assert.equal(mismatches('speaker vera {\n    displayName: say "Hi"\n}\nexit')[0]?.[0], "TSV055");
  assert.equal(mismatches('function f(m = say "Hi") {\n}\nexit')[0]?.[0], "TSV032");
  // A handle that may be null is checked first, and a nullable global can take one later.
  assert.match(
    mismatches('function f(m: messageHandle?) {\n    m.text = "z"\n}\nexit')[0]?.[1] ?? "",
    /may be null/u,
  );
  assert.deepEqual(
    mismatches(
      'global status: messageHandle? = null\nstatus = say "Ready", instant\nif status != null {\n    status.text = "Set"\n}\nexit',
    ).filter(([code]) => code !== "TSV046"),
    [],
  );
});

test("a say statement that calls skippable or unskippable names the forms that show the text", () => {
  assert.deepEqual(mismatches('say unskippable("Hi")\nexit'), [
    [
      "TSV018",
      "Unknown function 'unskippable'. To say a message unskippable, write its text without parentheses, as in 'say unskippable \"Hi\"'. Only a say used as a value, such as 'let line = say unskippable (\"Hi\", instant)', takes its text in parentheses.",
      "unskippable",
    ],
  ]);
  // A function of that name keeps being called, as before, also one the host provides.
  assert.deepEqual(
    mismatches('function unskippable(text) {\n    return text\n}\nsay unskippable("Hi")\nexit'),
    [],
  );
  for (const name of ["skippable", "unskippable"])
    assert.deepEqual(
      compileSource(`say ${name}("Hi"), instant\nexit`, { builtins: [name] }).diagnostics,
      [],
    );
  // The call is checked as any other.
  assert.deepEqual(
    mismatches("say unskippable(a: 1, a: 2)\nexit").map(([code]) => code),
    ["TSV023", "TSV018"],
  );
});
