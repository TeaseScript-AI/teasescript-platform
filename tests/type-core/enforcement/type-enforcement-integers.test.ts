// Whole numbers and numbers: an integer widens to number, never the reverse, and integer-only uses take whole-number
// values.

import assert from "node:assert/strict";
import test from "node:test";
import { runValidSource } from "../../helpers/run-valid-source.js";
import { mismatches, codes, sayTexts } from "../../helpers/type-core/type-enforcement-setup.js";

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
  for (const [source, use, code] of [
    ["let items = [1, 2]\nlet i = 1\ni = i * 0.5\nlet x = items.removeAt(i)\nexit", "i", "TSV043"],
    ['let n = 2\nn = n / 2\nrepeat n {\n    say "x"\n}\nexit', "n", "TSV011"],
    ["let items = [1]\nlet x = null\nx = 0\nx = 0.5\nsay items[x]\nexit", "x", "TSV043"],
    ["let items = [1]\nfor i in [0] {\n    i = i / 2\n    say items[i]\n}\nexit", "i", "TSV043"],
  ] as const)
    assert.deepEqual(codes(source), [[code, use]], source);
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
  // A long chain widens in either order through every way a number flows on: arithmetic, a join such as `askChoice`, a
  // part of a collection or object built from it, a method that returns an element, and a function's result.
  const names = Array.from({ length: 2_000 }, (_, index) => `v${index}`);
  const declarations = names.map((name) => `let ${name} = 0`).join("\n");
  for (const copy of [
    (name: string) => `${name} + 1`,
    (name: string) => `askChoice ${name}, 1`,
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
      "TSV035",
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
      ["TSV036", "n"],
    ],
  );
  assert.deepEqual(codes('wait "soon"\nexit'), [["TSV043", '"soon"']]);
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
  assert.equal(dynamic.snapshot.failure?.code, "TSV043");
});

test("a for-loop, randomInteger, wait, or timer range takes whole-number bounds, a switch case range any number", () => {
  // V30 §6: a bound that may hold a fraction is an error, never truncated.
  assert.deepEqual(mismatches('let count = 5\nfor i in 1..=count / 2 {\n    say "${i}"\n}\nexit'), [
    [
      "TSV010",
      "A 'for' loop needs a range of whole numbers, but its end is a number. Round the bounds with the floor, round or ceil function first.",
      "count / 2",
    ],
  ]);
  assert.deepEqual(mismatches("let n = 4\nlet r = randomInteger((0..n))\nn = n / 2\nexit"), [
    [
      "TSV010",
      "randomInteger(range) needs a range of whole numbers, but its end is a number. 'n' is a number because line 3 can store a non-whole number in it. Round the bounds with the floor, round or ceil function first.",
      "n",
    ],
  ]);
  assert.deepEqual(
    codes(
      'let low: number = 1\nfor i in low..2.0 {\n    say "${i}"\n}\nlet r = randomInteger(low..=6)\nexit',
    ),
    [
      ["TSV010", "low"],
      ["TSV010", "2.0"],
      ["TSV010", "low"],
    ],
  );
  // A wait or timer range counts whole units.
  assert.deepEqual(mismatches("let n = 17 / 2\nwait (1..n) s\nexit"), [
    [
      "TSV010",
      "A wait needs a range of whole numbers, but its end is a number. Round the bounds with the floor, round or ceil function first.",
      "n",
    ],
  ]);
  assert.deepEqual(
    codes(
      'let n = 17 / 2\ntimer (1..=n) s\nlet t = timer async (n..10) min {\n    say "late"\n}\nexit',
    ),
    [
      ["TSV010", "n"],
      ["TSV010", "n"],
    ],
  );
  assert.equal(
    mismatches("let n = 17 / 2\ntimer (1..=n) s\nexit")[0]?.[1].startsWith(
      "A timer needs a range of whole numbers",
    ),
    true,
  );
  // As for `for`, the type decides, not the value it holds when the script runs (V30 §6).
  for (const use of ['for i in 1..=n {\n    say "${i}"\n}', "wait (1..=n) s"])
    assert.deepEqual(codes(`let n: number = 2\n${use}\nexit`), [["TSV010", "n"]], use);
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
