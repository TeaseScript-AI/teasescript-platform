import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function codes(source: string): [string, string][] {
  return diagnostics(source).map(([code, , text]) => [code, text]);
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

test("a declared union holds values of each member type, and T? is T | null", () => {
  assert.deepEqual(
    sayTexts(
      [
        "let reward: integer | string = 10",
        'reward = "a long break"',
        'say "${reward}"',
        "let picks: (integer | string)[] = []",
        'picks.add(1)\npicks.add("two")',
        'say "${picks.length}"',
        "let maybe: integer | null = null",
        "let same: integer? = maybe",
        'say "${same == null}"',
        "exit",
      ].join("\n"),
    ),
    ["a long break", "2", "true"],
  );
  assert.deepEqual(codes("let reward: integer | string = true\nexit"), [["TSV041", "true"]]);
  assert.deepEqual(codes("let picks: (integer | string)[] = [1, false]\nexit"), [
    ["TSV041", "false"],
  ]);
  // Postfix forms bind tighter than `|`: this is an integer or a list of strings.
  assert.deepEqual(codes('let value: integer | string[] = ["a"]\nvalue = 3\nvalue = "b"\nexit'), [
    ["TSV041", '"b"'],
  ]);
});

test("type names cover null, any list, set, or object, and program-control values", () => {
  assert.deepEqual(
    codes(
      [
        "let anything: list = [1]",
        "let tags: set = set[1]",
        "let record: object = { a: 1 }",
        "let span: range = 1..3",
        "let clock: timer = timer async 5 s",
        "speaker vera {}",
        "let voice: speaker = vera",
        'let music: media = playAudio async "a.mp3"',
        "let nothing: null = null",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    codes('let span: range = 5\nlet voice: speaker = "Vera"\nlet record: object = [1]\nexit'),
    [
      ["TSV041", "5"],
      ["TSV041", '"Vera"'],
      ["TSV041", "[1]"],
    ],
  );
  assert.deepEqual(codes("let flags: integer? set = set[1, null]\nexit"), []);
  for (const name of ["list", "object", "range", "media"])
    assert.equal(compileSource(`let ${name} = 1`).diagnostics[0]?.code, "TSV001", name);
});

test("an operation on a union needs every member to support it, and the message names the test", () => {
  const union = 'let reward: integer | string = 10\nif chance(50) {\n    reward = "long"\n}\n';
  assert.deepEqual(diagnostics(`${union}let points = reward + 1\nexit`), [
    [
      "TSV043",
      "'reward' may be text (string). Check it first: if reward is integer { ... }",
      "reward",
    ],
  ]);
  assert.deepEqual(diagnostics(`${union}let n: integer = reward\nexit`), [
    [
      "TSV041",
      "'n' is declared as integer, so it cannot start as a whole number (integer) or text (string). Check it first: if reward is integer { ... }",
      "reward",
    ],
  ]);
  // Equality, interpolation, and storing into the same or a wider union need no test.
  assert.deepEqual(
    codes(
      `${union}let same = reward == 10\nsay "\${reward}"\nlet wider: integer | string | null = reward\nexit`,
    ),
    [],
  );
  // Members that all support an operation give its result: integer | number is a number.
  assert.deepEqual(codes("let ratio: integer | number = 1\nlet half = ratio / 2\nexit"), []);
  // The test is named also when the other operand is of unknown type.
  assert.deepEqual(
    diagnostics("function f(n: (integer | boolean)?, other) {\n    return n + other\n}\nexit"),
    [
      [
        "TSV043",
        "'n' may be true or false (boolean). Check it first: if n is integer { ... }",
        "n",
      ],
    ],
  );
  // A method on a union receiver takes its arguments as each member would, and the results join.
  const either = (type: string, first: string, second: string) =>
    `function either(flag: boolean): ${type} {\n    if flag {\n        return ${first}\n    }\n    return ${second}\n}\n`;
  const collections = either("integer[] | integer set", "[1]", "set[1]");
  assert.deepEqual(
    codes(`${collections}let r: integer[] | integer set = either(true).union([2.5])\nexit`).map(
      ([code]) => code,
    ),
    ["TSV041"],
  );
  assert.deepEqual(
    codes(`${collections}let r = either(true).union(["x"])\nexit`).map(([code]) => code),
    ["TSV044"],
  );
  assert.deepEqual(
    codes(
      `${either("string | integer[]", '"a"', "[1]")}let found = either(true).contains(1)\nexit`,
    ),
    [["TSV043", "1"]],
  );
  assert.deepEqual(
    codes(
      `${either("integer[] | string[]", "[1]", '["a"]')}let joined = either(true).join(true)\nexit`,
    ),
    [["TSV043", "true"]],
  );
  // A union argument of a set operation may be either collection.
  for (const method of ["union", "intersection", "difference"])
    assert.deepEqual(
      codes(`${collections}let r: integer[] = [1].${method}(either(true))\nexit`),
      [],
      method,
    );
  // min and max need one family: a value that may be a number or a duration names the test.
  assert.deepEqual(
    diagnostics(
      `${either("integer | duration", "1", "1 s")}let value = either(false)\nlet r = min(value, 2)\nexit`,
    ),
    [["TSV043", "'value' may be a duration. Check it first: if value is integer { ... }", "value"]],
  );
  const flag = "let flag: boolean | integer = true\nif chance(50) {\n    flag = 1\n}\n";
  assert.deepEqual(codes(`${flag}if flag {\n    say "x"\n}\nexit`), [["TSV043", "flag"]]);
});

test("a union receiver checks element stores, property writes, compound assignments, and results per member", () => {
  const dynamic = "function dynamic(value) {\n    return value\n}\n";
  // A value of unknown type must fit what every member's elements share, at runtime when the members share some.
  assert.deepEqual(
    codes(`${dynamic}function f(xs: integer[] | string[]) {\n    xs.add(dynamic(true))\n}\nexit`),
    [["TSV043", "xs"]],
  );
  assert.equal(
    runValidSource(
      `${dynamic}function f(xs: (integer | string)[] | (integer | boolean)[]) {\n    xs.add(dynamic("x"))\n}\nf([true])\nexit`,
    ).snapshot.failure?.code,
    "TSR058",
  );
  assert.deepEqual(codes('function f(h: timer | media) {\n    h.volume = "bad"\n}\nexit'), [
    ["TSV043", "h"],
  ]);
  assert.deepEqual(codes("function f(h: timer | media) {\n    h.elapsed = 1 s\n}\nexit"), [
    ["TSV043", "elapsed"],
  ]);
  assert.deepEqual(codes("function f(h: object | timer) {\n    h.display = 1\n}\nexit"), [
    ["TSV041", "1"],
  ]);
  assert.deepEqual(codes('function f(h: object | timer) {\n    h.display = "on"\n}\nexit'), []);
  assert.deepEqual(codes("function f(xs: integer[] | string[]) {\n    xs[0] += 1\n}\nexit"), [
    ["TSV043", "xs[0]"],
  ]);
  // Results of different types stay known, so their later use is checked.
  assert.deepEqual(
    codes("function f(n: number | duration) {\n    let x = n * 2\n    let y = x + 1\n}\nexit"),
    [["TSV043", "x"]],
  );
  assert.deepEqual(
    codes("function f(xs: integer[] | string[]) {\n    let n = xs.first + 1\n}\nexit"),
    [["TSV043", "xs.first"]],
  );
  // A call while a store is evaluated does not bring back a member that the assignment excluded: the store goes to the
  // list that was evaluated.
  const reassigned =
    'let p: integer[] | string[] = [1]\nfunction amount {\n    p = ["x"]\n    return 2\n}\n';
  for (const store of ["p.add(amount())", "p[0] = amount()"])
    assert.deepEqual(codes(`${reassigned}${store}\nexit`), [], store);
  // Lists of different element types share only the empty list, which the runtime check still accepts.
  const nested = `${dynamic}function f(xs: integer[][] | string[][]) {\n    xs.add(dynamic(VALUE))\n}\nf([[1]])\nexit`;
  assert.equal(runValidSource(nested.replace("VALUE", "[true]")).snapshot.failure?.code, "TSR058");
  assert.equal(runValidSource(nested.replace("VALUE", "[]")).snapshot.failure, null);
  // A literal fits the union's list member, also when only a later member takes its nested elements, but not elements
  // of different members at once.
  assert.deepEqual(codes('let xs: (integer | string)[] | boolean = [1, "x"]\nexit'), []);
  assert.deepEqual(codes('let xs: integer[][] | (string | boolean)[][] = [["x", true]]\nexit'), []);
  assert.deepEqual(codes('let xs: integer[] | string[] = [1, "x"]\nexit'), [
    ["TSV044", '[1, "x"]'],
  ]);
});

test("display, choice, and speaker text checks look at every member of a union", () => {
  // A union whose known members cannot be shown at all is an error, as is a mix that needs a test first.
  for (const [source, code] of [
    ["function f(x: integer[] | object) {\n    showButton x\n}\nexit", "TSV040"],
    ['function f(x: object | integer set) {\n    say "${x}"\n}\nexit', "TSV042"],
    ['function f(x: string | object) {\n    say "${[x]}"\n}\nexit', "TSV043"],
    [
      'function f(x: string | integer[]) {\n    let answer = choose { text: "go", value: x }\n}\nexit',
      "TSV043",
    ],
    ["function f(x: string | timer) {\n    let answer = choose x\n}\nexit", "TSV043"],
    [
      "speaker vera {}\nfunction f(voice: speaker | object) {\n    voice.firstName = [1]\n}\nexit",
      "TSV040",
    ],
  ] as const)
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => diagnostic.code),
      [code],
      source,
    );
  // A union of collections gives buttons from either one, so the result has their element type.
  assert.deepEqual(
    codes("function f(x: integer[] | integer set) {\n    let n: integer = choose x\n}\nexit"),
    [],
  );
  assert.deepEqual(
    codes(
      'function f(x: integer[] | integer set) {\n    let selected = choose x\n    say "${selected.length}"\n}\nexit',
    ),
    [["TSV043", "length"]],
  );
  // A list of any values does not admit a mixed literal; its elements need a declared union.
  assert.deepEqual(codes('let values: list = [1, "x"]\nexit'), [["TSV044", '[1, "x"]']]);
  // The elements of a computed list are shown, or give buttons, one at a time.
  for (const source of [
    'function f(xs: (string | object)[]) {\n    say "${xs}"\n}\nexit',
    "function f(xs: string[] | timer[]) {\n    let answer = choose xs\n}\nexit",
  ])
    assert.deepEqual(codes(source), [["TSV043", "xs"]], source);
  // A value that may also be text or null names the test for it.
  for (const [source, test] of [
    ['function f(n: string | object[]) {\n    say "${n}"\n}\nexit', "string"],
    ["function f(n: string | timer[]) {\n    let answer = choose n\n}\nexit", "string"],
    ['function f(n: object[]?) {\n    say "${n}"\n}\nexit', "null"],
    ["function f(n: timer[]?) {\n    let answer = choose n\n}\nexit", "null"],
  ] as const)
    assert.match(
      diagnostics(source)[0]?.[1] ?? "",
      new RegExp(`Check it first: if n is ${test} `),
      source,
    );
  assert.deepEqual(codes("function f(xs: timer[]) {\n    let answer = choose xs\n}\nexit"), [
    ["TSV029", "xs"],
  ]);
});

test("mixed list literals need a declared union, and every other mix points to it", () => {
  assert.deepEqual(diagnostics('let values = ["Level", 2, 3.5]\nexit'), [
    [
      "TSV044",
      "This list mixes text (string) and a whole number (integer). A list holds one type. To keep both, declare a union type, as in 'let values: (string | number)[] = ...'.",
      '["Level", 2, 3.5]',
    ],
  ]);
  assert.deepEqual(
    sayTexts('let values: (string | number)[] = ["Level", 2, 3.5]\nsay "${values.length}"\nexit'),
    ["3"],
  );
  assert.deepEqual(
    diagnostics('let best = null\nbest = "a"\nbest = 5\nexit')[0]?.[1],
    "'best' holds text (string) or null since line 2, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
  );
  assert.deepEqual(
    diagnostics(
      'function pick(n) {\n    if n > 3 {\n        return "big"\n    }\n    return 1\n}\nexit',
    )[0]?.[1],
    "'pick' returns a whole number (integer) here, but text (string) on line 3. To return both, declare the result type, as in 'function pick(...): string | integer'.",
  );
});

test("'|' outside a type points to 'or'", () => {
  assert.deepEqual(diagnostics("let both = true || false"), [
    [
      "TSP037",
      "Use 'or' to combine conditions. '|' only separates the types of a union, as in 'integer | string'.",
      "||",
    ],
  ]);
});
