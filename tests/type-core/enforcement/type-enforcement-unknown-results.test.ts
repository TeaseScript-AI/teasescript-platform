// A value the compiler cannot know, and an operation of unknown result: rejected only where no result fits the place's
// type.

import assert from "node:assert/strict";
import test from "node:test";
import { runValidSource } from "../../helpers/run-valid-source.js";
import { mismatches, codes, sayTexts } from "../../helpers/type-core/type-enforcement-setup.js";

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

test("an operation on a value the compiler cannot know is rejected where no result fits the place's type", () => {
  const inFunction = (...body: string[]): string =>
    ["function f(x, z) {", ...body.map((line) => `    ${line}`), "}", "f(8, 2)", "exit"].join("\n");
  // '/' gives a number, a duration, or a calendar duration, whatever 'x' holds, and never text.
  assert.deepEqual(mismatches(inFunction("let y: string = x / 4", "say y")), [
    [
      "TSV041",
      "'y' is declared as string, so it cannot start as the result of '/', which is a number or a duration or a calendar duration or an angle. To show it as text, write \"${x / 4}\".",
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
    // A place without a written type keeps the type its values decided.
    ['let y = "a"', "y = x / z", "say y"],
    ['let ys = ["a"]', "ys.add(x * 4)"],
    ['let o = { a: "t" }', "o.a = x / 4", "say o"],
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
    "'f' returns string, so it cannot return the result of '/', which is a number or a duration or a calendar duration or an angle. To show it as text, write \"${x / 4}\".",
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
        "let count = 1",
        "count = x / 4",
        "count += x / 4",
        "let box = { t: null }",
        "box.t = x * 2",
        "let ys = []",
        "ys.add(x / 4)",
        "say ratio",
      ),
    ),
    [],
  );
});

test("an operation of unknown result is rejected where a later value decides a type that no result fits", () => {
  const inFunction = (...body: string[]): string =>
    ["function f(x) {", ...body.map((line) => `    ${line}`), "}", "f(8)", "exit"].join("\n");
  // The store fails whenever it runs, so it is reported as if the deciding value came first, naming that value's line.
  assert.deepEqual(
    mismatches(inFunction("let ys = []", "ys.add(x / 4)", 'ys.add("a")', "say ys")),
    [
      [
        "TSV041",
        "'ys' holds string values (string[]) since line 4, so it cannot contain the result of '/', which is a number or a duration or a calendar duration or an angle. To show it as text, write \"${x / 4}\".",
        "x / 4",
      ],
    ],
  );
  for (const body of [
    ["let ys = []", "ys.addAll([x / 4])", 'ys.add("a")'],
    ["let ys = []", 'ys = [x / 4, "a"]'],
    ["let ys = [null]", "ys[0] = x / 4", 'ys.add("a")'],
    ["let d = dict {}", 'd["k"] = x / 4', 'd["j"] = "a"'],
    ["let s = set[]", "s.add(x / 4)", 's.add("a")'],
    ["let y = null", "y = x / 4", "y = true"],
    ["let o = { a: null }", "o.a = x / 4", 'o.a = "t"'],
    ["let o = { a: null }", "o = { a: x / 4 }", 'o.a = "t"'],
    ["let ys = [{ a: null }]", "ys[0].a = x / 4", 'ys[0].a = "t"'],
    ["let ys = []", "for y in ys {", "    y = x / 4", "}", 'ys.add("a")'],
    // Code that does not run is checked as well, as it is when the deciding value comes first.
    ["let ys = []", "if false {", "    ys.add(x / 4)", "}", 'ys.add("a")'],
  ])
    assert.deepEqual(codes(inFunction(...body, "say 1")), [["TSV041", "x / 4"]], body.join("; "));
  // A body checked at the call that needs its result comes before the caller's later value in checking order.
  assert.deepEqual(
    codes(
      'let ys = []\nfunction g(x) {\n    ys.add(x / 4)\n    return 1\n}\nfunction f(x) {\n    let n = g(x)\n    ys.add("a")\n    say n\n}\nf(8)\nexit',
    ),
    [["TSV041", "x / 4"]],
  );
  // A type that a result may fit, such as a whole number that '/' may give, or a place no value decides, leaves the
  // store to the check when it runs.
  assert.deepEqual(
    sayTexts(
      inFunction(
        "let ys = []",
        "ys.add(x / 4)",
        "ys.add(1)",
        "let y = null",
        "y = x / 4",
        "y = 1.5",
        "let o = { a: null }",
        "o.a = x / 4",
        "say ys",
        "say y",
        "say o",
      ),
    ),
    ["[2, 1]", "1.5", "{ a: 2 }"],
  );
  assert.deepEqual(
    mismatches(inFunction("let spans = []", "spans.add(x * 2)", "spans.add(3 s)", "say spans")),
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

test("an operation of unknown result keeps the types it can give, also inside another operation or a compound assignment", () => {
  const inFunction = (...body: string[]): string =>
    ["function f(x, z) {", ...body.map((line) => `    ${line}`), "}", "f(8, 2)", "exit"].join("\n");
  // `x / 4` gives a number or a duration, so adding `z` to it never gives text either.
  assert.deepEqual(mismatches(inFunction("let y: string = (x / 4) + z", "say y")), [
    [
      "TSV041",
      "'y' is declared as string, so it cannot start as the result of '+', which is a number or a duration or a calendar duration or an angle. To show it as text, put the whole calculation inside \"${\" and \"}\".",
      "(x / 4) + z",
    ],
  ]);
  for (const declaration of ['let y: string = "a"', 'let y = "a"'])
    assert.deepEqual(
      mismatches(inFunction(declaration, "y += x / 4", "say y")),
      [
        [
          "TSV041",
          "'y' holds text (string), so the result of '/', which is a number or a duration or a calendar duration or an angle, cannot be added to it. Put the result in the text instead, as in 'y += \"${x / 4}\"'.",
          "x / 4",
        ],
      ],
      declaration,
    );
  // No member of a union of collections can hold it.
  assert.deepEqual(mismatches(inFunction("let ys: string[] | boolean[] = [x / 4]", "say ys")), [
    [
      "TSV041",
      "'ys' is declared as string[] | boolean[], so it cannot contain the result of '/', which is a number or a duration or a calendar duration or an angle. To show it as text, write \"${x / 4}\".",
      "x / 4",
    ],
  ]);
  assert.match(
    mismatches(inFunction("let zs: boolean[] | date[] = [x / 4]", "say zs"))[0]?.[1] ?? "",
    /cannot contain the result of '\/'.* Change the type of 'zs' so its elements can hold that result\.$/u,
  );
  // What an inner operation can give works with nothing the other operand may be, so the operation always fails.
  assert.deepEqual(mismatches(inFunction('say (x / 4) + "!"')), [
    [
      "TSV043",
      "'+' joins text only with other text, not with a number or a duration or a calendar duration or an angle. Put the value in the text instead, as in \"${value}!\".",
      '(x / 4) + "!"',
    ],
  ]);
  assert.deepEqual(mismatches(inFunction('say -(x + "a")')), [
    [
      "TSV043",
      "'-' needs a number, a duration, or an angle, but this is text (string).",
      '-(x + "a")',
    ],
  ]);
  // An operand that already failed has its own message, and the operations, stores, and compound assignments around
  // it add none.
  for (const failing of [
    'say ("a" * x) * (z + "a")',
    'say (z + "a") * ("a" * x)',
    'say (("a" * x) * (z + "a")) + 1',
    'let s: string = (("a" * x) * (z + "a")) + 1',
    'let t: string = "a"\nt += (("a" * x) * (z + "a")) + 1',
    'let ys: string[][] | boolean[][] = [[(("a" * x) * (z + "a")) + 1]]',
  ])
    assert.deepEqual(
      mismatches(inFunction(...failing.split("\n"))).map(([code, , text]) => [code, text]),
      [["TSV043", '"a" * x']],
      failing,
    );
  // Nested literals are checked against what the members' elements hold at their depth.
  assert.deepEqual(
    mismatches(inFunction("let ys: string[][] | boolean[][] = [[x / 4]]", "say ys")),
    [
      [
        "TSV041",
        "'ys' is declared as string[][] | boolean[][], so it cannot contain the result of '/', which is a number or a duration or a calendar duration or an angle. To show it as text, write \"${x / 4}\".",
        "x / 4",
      ],
    ],
  );
  for (const store of [
    "let ys: (string dict)[] | (boolean dict)[] = [dict{ a: x / 4 }]",
    "let ys: (string set)[] | (boolean set)[] = [set[x / 4]]",
    "let ys: boolean[][] | date[][] = [[true], [x / 4]]",
  ])
    assert.deepEqual(
      mismatches(inFunction(store, "say ys")).map(([code]) => code),
      ["TSV041"],
      store,
    );
  // A member that holds only null holds no result of an operation either.
  for (const members of ["null[] | string[]", "string[] | null[]"])
    assert.deepEqual(
      mismatches(inFunction(`let ys: ${members} = [x / 4]`, "say ys")).map(([code, , text]) => [
        code,
        text,
      ]),
      [["TSV041", "x / 4"]],
      members,
    );
  // Below a member that may hold anything, such as `list`, nothing is proven to fail: the report names the leaf that
  // no member holds.
  assert.deepEqual(
    mismatches(
      inFunction(
        "let ys: (list | (string[] set))[] | (string[][] | (date[] set))[] = [[[x / 4]], set[[z / 2]]]",
        "say ys",
      ),
    )
      .filter(([code]) => code === "TSV041")
      .map(([, , text]) => text),
    ["z / 2"],
  );
  // A result that may fit is checked when the script runs.
  assert.deepEqual(
    mismatches(
      inFunction(
        "let text: string = x + z",
        "let whole: integer = 1",
        "whole += x / 4",
        "let ratio: number = 1",
        "ratio -= (x * 2) / z",
        "let span: duration = 1 s",
        "span += x * z",
        'let more: string = "a"',
        "more += x",
        "say (x / 4) * (z / 2)",
        "let rows: number[][] | string[][] = [[x / 4]]",
        "let maybe: null[] | number[] = [x / 4]",
        "say text",
      ),
    ),
    [],
  );
});
